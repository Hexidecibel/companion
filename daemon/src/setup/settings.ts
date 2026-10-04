/**
 * Wizard settings <-> config file. Reading derives SetupSettings from the live
 * config; writing validates a patch and applies it to the RAW config JSON so
 * every key the wizard does not manage is preserved untouched.
 */
import type { DaemonConfig } from '../types';
import type {
  HeraldProviderChoice,
  NotificationsChoice,
  PairingPolicy,
  SetupSettings,
  SetupSettingsPatch,
} from './protocol';
import { SETUP_LIMITS } from './protocol';
import { normalizeRoots } from './dirs';

export class SettingsError extends Error {}

export function heraldChoice(block: DaemonConfig['herald']): HeraldProviderChoice {
  if (!block || block.enabled === false) return 'off';
  return block.provider === 'anthropic' ? 'anthropic' : 'openai_compatible';
}

export function pairingPolicy(cfg: Pick<DaemonConfig, 'pairing' | 'pairingAllowPublic'>): PairingPolicy {
  if (cfg.pairing === false) return 'off';
  return cfg.pairingAllowPublic === true ? 'anywhere' : 'lan';
}

export function readSettings(
  cfg: DaemonConfig,
  displayName: string,
  notifications: NotificationsChoice
): SetupSettings {
  const h = cfg.herald;
  return {
    name: displayName,
    projectRoots: cfg.projectRoots ?? [],
    tmuxSession: cfg.tmuxSession,
    mdnsEnabled: cfg.mdnsEnabled,
    pairing: pairingPolicy(cfg),
    herald: {
      provider: heraldChoice(h),
      baseUrl: typeof h?.base_url === 'string' ? h.base_url : '',
      model: typeof h?.model === 'string' ? h.model : '',
    },
    notifications,
  };
}

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

export function cleanServerName(v: unknown): string {
  if (typeof v !== 'string') throw new SettingsError('name must be text');
  // eslint-disable-next-line no-control-regex
  const n = v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (!n) throw new SettingsError('The name is empty');
  if (n.length > SETUP_LIMITS.nameMaxLength) throw new SettingsError('The name is too long');
  return n;
}

export interface PatchOutcome {
  restartNeeded: boolean;
  heraldChanged: boolean;
  notifications?: NotificationsChoice;
}

/**
 * Validate `patch` and apply it to `raw` (snake_case file JSON). Throws
 * SettingsError before touching anything when a field is invalid.
 */
export function applySettingsPatch(
  raw: Record<string, unknown>,
  patchIn: unknown,
  home: string
): PatchOutcome {
  const patch = obj(patchIn) as SetupSettingsPatch;
  const ops: Array<() => void> = [];
  const out: PatchOutcome = { restartNeeded: false, heraldChanged: false };

  if (patch.name !== undefined) {
    const name = cleanServerName(patch.name);
    ops.push(() => {
      raw.name = name;
    });
    // The mDNS advertisement carries the name: re-announced on the next start.
    if (raw.mdns_enabled !== false) out.restartNeeded = true;
  }
  if (patch.projectRoots !== undefined) {
    let roots: string[];
    try {
      roots = normalizeRoots(patch.projectRoots, home);
    } catch (err) {
      throw new SettingsError((err as Error).message);
    }
    ops.push(() => {
      raw.project_roots = roots;
    });
  }
  if (patch.tmuxSession !== undefined) {
    const t = patch.tmuxSession;
    if (typeof t !== 'string' || !/^[A-Za-z0-9_-]+$/.test(t) || t.length > SETUP_LIMITS.tmuxSessionMaxLength) {
      throw new SettingsError('tmux session names use letters, digits, - and _ only');
    }
    ops.push(() => {
      raw.tmux_session = t;
    });
    out.restartNeeded = true;
  }
  if (patch.mdnsEnabled !== undefined) {
    if (typeof patch.mdnsEnabled !== 'boolean') throw new SettingsError('mdnsEnabled must be true or false');
    const v = patch.mdnsEnabled;
    ops.push(() => {
      raw.mdns_enabled = v;
    });
    out.restartNeeded = true;
  }
  if (patch.pairing !== undefined) {
    const p = patch.pairing;
    if (p !== 'lan' && p !== 'anywhere' && p !== 'off') throw new SettingsError('pairing must be lan, anywhere or off');
    ops.push(() => {
      raw.pairing = p !== 'off';
      raw.pairing_allow_public = p === 'anywhere';
    });
  }
  if (patch.herald !== undefined) {
    const h = obj(patch.herald);
    const provider = h.provider;
    if (provider !== undefined && provider !== 'anthropic' && provider !== 'openai_compatible' && provider !== 'off') {
      throw new SettingsError('herald.provider must be anthropic, openai_compatible or off');
    }
    let baseUrl: string | undefined;
    if (h.baseUrl !== undefined) {
      if (typeof h.baseUrl !== 'string' || h.baseUrl.length > SETUP_LIMITS.urlMaxLength) {
        throw new SettingsError('baseUrl is not valid');
      }
      baseUrl = h.baseUrl.trim().replace(/\/+$/, '');
      if (baseUrl) {
        let u: URL;
        try {
          u = new URL(baseUrl);
        } catch {
          throw new SettingsError('baseUrl must be an http(s) URL');
        }
        if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new SettingsError('baseUrl must be an http(s) URL');
        if (u.username || u.password) throw new SettingsError('Put keys in the secret field, not in the URL');
      }
    }
    let model: string | undefined;
    if (h.model !== undefined) {
      if (typeof h.model !== 'string' || h.model.length > SETUP_LIMITS.modelMaxLength || !/^[\w.:/@+-]*$/.test(h.model)) {
        throw new SettingsError('model is not valid');
      }
      model = h.model.trim();
    }
    if (provider === 'openai_compatible') {
      const existing = obj(raw.herald);
      const effUrl = baseUrl ?? (typeof existing.base_url === 'string' ? existing.base_url : '');
      const effModel = model ?? (typeof existing.model === 'string' ? existing.model : '');
      if (!effUrl || !effModel) throw new SettingsError('A local model needs its base URL and model name');
    }
    ops.push(() => {
      const block = { ...obj(raw.herald) };
      if (provider === 'off') {
        block.enabled = false;
      } else if (provider) {
        if (block.enabled === false) delete block.enabled;
        block.provider = provider;
      }
      if (baseUrl !== undefined) {
        if (baseUrl) block.base_url = baseUrl;
        else delete block.base_url;
      }
      if (model !== undefined) {
        if (model) block.model = model;
        else delete block.model;
      }
      raw.herald = block;
    });
    out.heraldChanged = true;
  }
  if (patch.notifications !== undefined) {
    if (patch.notifications !== 'browser' && patch.notifications !== 'off') {
      throw new SettingsError('notifications must be browser or off');
    }
    out.notifications = patch.notifications;
  }
  for (const op of ops) op();
  return out;
}
