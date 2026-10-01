/**
 * Deterministic danger classifier for Herald actions.
 *
 * PURE: no I/O, no clock, no model involvement. The LLM may ESCALATE a tier
 * (requestedConfirm) but can never lower the tier this function assigns.
 *
 * Danger is detected from both sides:
 *   - what the user asked for (their utterance + the exact payload to be sent), and
 *   - what the session is asking (pending question + the selected option's text),
 * plus the target itself (a session/project named "prod", "deploy", AJ's box, ...).
 *
 * Batches are never classified as a unit: each member of a multi-session request
 * is classified on its own, so "tell them all to go ahead" lets the safe members
 * echo while any dangerous member is split out to hard-confirm. The user's
 * utterance is shared by every member, so danger in what they SAID still
 * hard-confirms the whole batch.
 *
 * Negation is deliberately NOT parsed: "don't deploy yet" still hard-confirms.
 * A false hard-confirm costs one tap; a false echo can ship to production.
 */

import type { HeraldActionTier } from './protocol';

export interface ClassifyInput {
  /** The user's most recent utterance to Herald (what they actually said). */
  userText: string;
  /** The exact text / option label that would be sent to the session. */
  payload: string;
  /** The question the session is currently asking, if any (may include tool detail). */
  pendingQuestion?: string | null;
  /** Options offered by the pending prompt, if it is a choice prompt. */
  pendingOptions?: Array<{ label: string; description?: string }> | null;
  sessionName: string;
  /** Working directory / project path of the session. */
  project?: string | null;
  /** The model asked for explicit confirmation (can only raise the tier). */
  requestedConfirm?: boolean;
}

export interface ClassifyResult {
  tier: HeraldActionTier;
  reasons: string[];
  /** Rule ids that fired, most specific source first (drives the voice-confirm keyword). */
  ruleIds?: string[];
}

interface Rule {
  id: string;
  re: RegExp;
}

// Word-ish boundaries that also treat '-', '_', '/', '.' as separators so
// "prod-db", "deploy_script" and "git/push" all match.
const B = '(?:^|[^a-z0-9])';
const E = '(?=$|[^a-z0-9])';
const w = (alts: string) => new RegExp(`${B}(?:${alts})${E}`, 'i');

const ACTION_RULES: Rule[] = [
  {
    id: 'deploy',
    re: w('deploy(?:s|ed|ing|ment)?|redeploy(?:s|ed|ing)?|ship(?:\\s+it)?|rollout|roll\\s+out'),
  },
  {
    id: 'release',
    re: w(
      'release(?:s|d)?|releasing|tag(?:ging)?\\s+(?:a\\s+)?(?:release|version)|bump\\s+(?:the\\s+)?version'
    ),
  },
  {
    id: 'publish',
    re: w(
      'publish(?:es|ed|ing)?|npm\\s+publish|upload(?:s|ed|ing)?\\s+to\\s+(?:the\\s+)?(?:store|play|testflight|app\\s+store)'
    ),
  },
  { id: 'push', re: w('push(?:es|ed|ing)?|git\\s+push') },
  {
    id: 'force',
    re: /(?:^|[^a-z0-9])(?:force(?:d|s|fully)?|forcing)(?=$|[^a-z0-9])|--force(?:-with-lease)?\b|\s-f\s*$/i,
  },
  {
    id: 'no-verify',
    re: /--no-verify|no[\s-]verify|skip(?:ping)?\s+(?:the\s+)?(?:pre-?commit\s+)?hooks?/i,
  },
  {
    id: 'destructive',
    re: w(
      'delete(?:s|d)?|deleting|remove(?:s|d)?|removing|rm|rmdir|drop(?:s|ped|ping)?|wipe(?:s|d)?|wiping|' +
        'reset(?:s|ting)?|destroy(?:s|ed|ing)?|truncate(?:s|d)?|truncating|purge(?:s|d)?|purging|erase(?:s|d)?|erasing|' +
        'nuke(?:s|d)?|overwrite(?:s|n)?|overwriting|clobber|shred|unlink|prune(?:s|d)?|git\\s+clean|revert(?:s|ed|ing)?|rollback|roll\\s+back'
    ),
  },
  {
    id: 'history-rewrite',
    re: w(
      'rebase(?:s|d)?|rebasing|amend(?:s|ed|ing)?|squash(?:es|ed|ing)?|merge(?:s|d)?|merging|cherry-?pick'
    ),
  },
  { id: 'migrate', re: w('migrat(?:e|es|ed|ing|ion|ions)') },
  {
    id: 'lifecycle',
    re: w(
      'restart(?:s|ed|ing)?|reboot(?:s|ed|ing)?|stop(?:s|ped|ping)?|kill(?:s|ed|ing)?|pkill|killall|shut\\s*down|shutdown|systemctl|launchctl|kickstart'
    ),
  },
  {
    id: 'production',
    re: w(
      'prod|production|live\\s+(?:site|server|env(?:ironment)?|db|database)|main\\s+branch|master\\s+branch'
    ),
  },
  {
    id: 'remote-host',
    re: w(
      "aj|aj's|ajs|ajconnor|mac[\\s-]?mini|buddy[\\s-]?mac|hexinas|nas|remote\\s+(?:host|box|server|machine)|ssh|scp|rsync|" +
        'server\\s+box|100\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}|[a-z0-9-]+\\.cush\\.rocks'
    ),
  },
  {
    id: 'secrets',
    re: w(
      'secrets?|credentials?|passwords?|passwd|api[\\s_-]?keys?|private[\\s_-]?keys?|ssh[\\s_-]?keys?|keys?\\s+file|keychain|' +
        'tokens?|\\.env|env\\s+file|1password|infisical|op\\s+item|certificates?|cert\\s+rotation'
    ),
  },
  { id: 'privilege', re: w('sudo|chmod|chown|root\\s+access|iptables|ufw|firewall') },
  {
    id: 'irreversible',
    re: /irreversibl[ey]|cannot\s+be\s+undone|can't\s+be\s+undone|permanent(?:ly)?|no\s+undo|point\s+of\s+no\s+return|billing|charge\s+(?:the\s+)?card|payment/i,
  },
];

// Target-level rules: the session/project itself is sensitive.
const TARGET_RULES: Rule[] = [
  { id: 'production', re: w('prod|production') },
  { id: 'deploy', re: w('deploy(?:s|ment)?|release|infra') },
  { id: 'remote-host', re: w("aj|aj's|ajconnor|mac[\\s-]?mini|buddy[\\s-]?mac|hexinas") },
];

const LABELS: Record<string, string> = {
  deploy: 'deploy',
  release: 'release',
  publish: 'publish',
  push: 'push',
  force: 'force',
  'no-verify': 'skips verification hooks',
  destructive: 'delete / reset / destroy',
  'history-rewrite': 'rewrites or merges git history',
  migrate: 'migration',
  lifecycle: 'restart / stop / kill',
  production: 'production',
  'remote-host': 'remote host',
  secrets: 'secrets / credentials',
  privilege: 'privileged system change',
  irreversible: 'irreversible',
};

function scan(text: string, rules: Rule[]): string[] {
  if (!text) return [];
  const hits: string[] = [];
  for (const r of rules) {
    if (r.re.test(text)) hits.push(r.id);
  }
  return hits;
}

function norm(s: string | null | undefined): string {
  return (s || '').replace(/\s+/g, ' ').trim();
}

/** Find the pending option the payload selects (by label, or "option N"/"N"). */
export function findSelectedOption(
  payload: string,
  options: Array<{ label: string; description?: string }> | null | undefined
): { label: string; description?: string } | null {
  if (!options || options.length === 0) return null;
  const p = norm(payload).toLowerCase();
  const exact = options.find((o) => norm(o.label).toLowerCase() === p);
  if (exact) return exact;
  const num = p.match(/^(?:option\s*)?#?(\d{1,2})\.?$/);
  if (num) {
    const idx = parseInt(num[1], 10) - 1;
    if (idx >= 0 && idx < options.length) return options[idx];
  }
  return null;
}

export function classifyAction(input: ClassifyInput): ClassifyResult {
  const reasons: string[] = [];
  const seen = new Set<string>();
  const ruleIds: string[] = [];
  const add = (reason: string, id?: string) => {
    if (id && !ruleIds.includes(id)) ruleIds.push(id);
    if (!seen.has(reason)) {
      seen.add(reason);
      reasons.push(reason);
    }
  };

  const requestText = `${norm(input.userText)}\n${norm(input.payload)}`;
  for (const id of scan(requestText, ACTION_RULES)) {
    add(`your request involves: ${LABELS[id]}`, id);
  }

  const selected = findSelectedOption(input.payload, input.pendingOptions);
  const questionText = [
    norm(input.pendingQuestion),
    selected ? norm(selected.label) : '',
    selected ? norm(selected.description) : '',
  ]
    .filter(Boolean)
    .join('\n');
  for (const id of scan(questionText, ACTION_RULES)) {
    add(`the session's question involves: ${LABELS[id]}`, id);
  }

  const targetText = `${norm(input.sessionName)}\n${norm(input.project)}`;
  for (const id of scan(targetText, TARGET_RULES)) {
    add(`target session is sensitive: ${LABELS[id]}`, id);
  }

  if (input.requestedConfirm) {
    add('flagged for confirmation by the assistant');
  }

  return { tier: reasons.length > 0 ? 'hard_confirm' : 'echo', reasons, ruleIds };
}

/** Tier ordering helper: returns the stricter of two tiers. */
export function stricterTier(a: HeraldActionTier, b: HeraldActionTier): HeraldActionTier {
  return a === 'hard_confirm' || b === 'hard_confirm' ? 'hard_confirm' : 'echo';
}

// ---------------------------------------------------------------------------
// cush-tools commands

export interface CushClassifyInput {
  op: 'extend' | 'close' | 'serve' | 'tunnel' | 'drop';
  name: string;
  /** close: the tool was opened by Herald itself. */
  openedByHerald?: boolean;
  /** serve: exactly what gets exposed (stated in the reasons). */
  exposure?: string;
  /** tunnel: local port. */
  port?: number;
  /** Extra facts to surface on the card (registry hits, .git, partial scan). */
  warnings?: string[];
  requestedConfirm?: boolean;
}

/**
 * Tier for a cush-tools command. PURE and table-driven:
 *
 *   extend <name>                          echo
 *   close <name>  (opened by Herald)       echo
 *   close <name>  (anything else)          hard_confirm
 *   serve <dir> <name>                     hard_confirm (publishes files)
 *   tunnel <port> <name>                   hard_confirm
 *   drop <name>                            hard_confirm
 *
 * Anything else never reaches here (validateCushCommand refuses it), and an
 * unknown op is hard_confirm as a last line of defense. Warnings and the model's
 * confirm flag can only raise the tier.
 */
export function classifyCushCommand(input: CushClassifyInput): ClassifyResult {
  const reasons: string[] = [];
  const url = `https://${input.name}.tunnel.cush.rocks`;
  switch (input.op) {
    case 'extend':
      break;
    case 'close':
      if (!input.openedByHerald)
        reasons.push(
          `${input.name} was not opened by Herald; closing it cuts off anyone using ${url}`
        );
      break;
    case 'serve':
      reasons.push(`publishes files: ${input.exposure || `a folder at ${url}`}`);
      break;
    case 'tunnel':
      reasons.push(
        `exposes whatever is listening on local port ${input.port ?? '?'} to anyone with ${url}`
      );
      break;
    case 'drop':
      reasons.push(`anyone with ${url} can upload files to this machine`);
      break;
    default:
      reasons.push('unrecognized cush-tools operation');
  }
  reasons.push(...(input.warnings || []));
  if (input.requestedConfirm) reasons.push('flagged for confirmation by the assistant');
  return { tier: reasons.length > 0 ? 'hard_confirm' : 'echo', reasons };
}

// ---------------------------------------------------------------------------
// Session control

/**
 * Interrupt (Ctrl+C) a running session: echo. Stopping a turn loses only the
 * in-flight work, and the countdown leaves time to cancel. The model's confirm
 * flag can raise it.
 */
export function classifyInterrupt(input: { requestedConfirm?: boolean }): ClassifyResult {
  return input.requestedConfirm
    ? {
        tier: 'hard_confirm',
        reasons: ['flagged for confirmation by the assistant'],
        ruleIds: ['interrupt'],
      }
    : { tier: 'echo', reasons: [], ruleIds: [] };
}

/**
 * Starting a new Claude Code session: ALWAYS hard_confirm. It runs unattended
 * in bypass-permissions mode (the same path the app uses), so it can edit files
 * and run commands without asking. Danger in the first prompt adds reasons.
 */
export function classifySpawn(input: {
  dir: string;
  userText: string;
  firstPrompt: string;
  requestedConfirm?: boolean;
}): ClassifyResult {
  const inner = classifyAction({
    userText: input.userText,
    payload: input.firstPrompt,
    sessionName: '',
    project: input.dir,
  });
  const reasons = [
    `starts a new Claude Code session in ${input.dir} that runs with permissions bypassed (no approval prompts)`,
    ...inner.reasons,
  ];
  if (input.requestedConfirm) reasons.push('flagged for confirmation by the assistant');
  return { tier: 'hard_confirm', reasons, ruleIds: ['spawn', ...(inner.ruleIds || [])] };
}
