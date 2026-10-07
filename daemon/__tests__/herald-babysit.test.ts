import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HeraldService } from '../src/herald/service';
import { HeraldStore, sanitizeState } from '../src/herald/store';
import type { ResolvedHeraldConfig } from '../src/herald/config';
import { parseHeraldConfigBlock, resolveHeraldConfig } from '../src/herald/config';
import type { HeraldBabysit, HeraldEvent } from '../src/herald/protocol';
import {
  LocalSessionSource,
  MAX_PANE_CAPTURES,
  type PendingChoice,
  type SessionSnapshot,
  type SessionSource,
} from '../src/herald/session-source';
import { LlmChatRequest, LlmChatResult, LlmError, LlmProvider } from '../src/herald/llm/provider';
import { buildAnthropicRequest } from '../src/herald/llm/anthropic';
import { DEFAULT_PRICING, fallbackRates, UsageMeter } from '../src/herald/usage';
import { InboxTracker } from '../src/herald/inbox';
import { ActionManager } from '../src/herald/actions';
import {
  BabysitTracker,
  ANSWERED_SUPPRESS_MS,
  HOLD_MAX_MS,
  GONE_AFTER_MS,
  GONE_RECHECK_MS,
  isPermissionChoice,
  MISSING_POLLS,
  promptOf,
  SETTLE_CHOICE_MS,
  SETTLE_TEXT_MS,
} from '../src/herald/babysit/tracker';
import {
  basisInBrief,
  decideBabysit,
  isContinueCase,
  judgeDecision,
  neverHits,
  type BabysitBrain,
  type BabysitDecideInput,
} from '../src/herald/babysit/decider';
import { BabysitError, BABYSIT_PREFIX, parseBabysitSpec } from '../src/herald/babysit/manager';
import { sanitizeBabysits } from '../src/herald/babysit/types';
import { registerHeraldHandlers } from '../src/handlers/herald';
import type { AuditEntry } from '../src/audit-log';
import { snap } from './herald-helpers';

type Step = Partial<LlmChatResult> & { emit?: string; throws?: Error; wait?: () => Promise<void> };

function scripted(steps: Step[]): LlmProvider & { calls: LlmChatRequest[] } {
  const calls: LlmChatRequest[] = [];
  return {
    name: 'fake',
    model: 'fake-1',
    calls,
    async chat(r) {
      calls.push(r);
      const s = steps.shift() || { emit: '{"decision":"escalate","option":null,"text":null,"basis":"","reason":"no script"}' };
      if (s.wait) await s.wait();
      if (s.throws) throw s.throws;
      if (s.emit) r.onText(s.emit);
      return { text: s.emit || '', toolCalls: [], stopReason: 'end', usage: {}, ...s } as LlmChatResult;
    },
  };
}

async function waitFor(cond: () => boolean, ms = 3000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const say = (o: Record<string, unknown>): Step => ({
  emit: JSON.stringify({ option: null, text: null, basis: '', reason: 'because', ...o }),
});
const CONTINUE = say({ decision: 'answer', text: 'Yes, continue.', basis: 'continue' });

const choice: PendingChoice = {
  question: 'Which database should I use?',
  options: [{ label: 'SQLite' }, { label: 'Postgres' }],
  multiSelect: false,
  signature: 'sig-db',
};
const permission: PendingChoice = {
  question: 'Do you want to proceed?',
  options: [{ label: 'Yes' }, { label: "Yes, and don't ask again for this session" }, { label: 'No' }],
  multiSelect: false,
  signature: 'sig-perm',
};

const working = (over: Partial<SessionSnapshot> = {}) => snap({ sessionId: 'out4', sessionName: 'Out4', status: 'working', ...over });
const asking = (turn: string, text = 'Step one is done. Want me to continue with the next step?', over: Partial<SessionSnapshot> = {}) =>
  snap({ sessionId: 'out4', sessionName: 'Out4', status: 'idle', lastTurnKey: turn, lastTurnGist: text, ...over });

const brief = (over: Partial<HeraldBabysit> = {}): HeraldBabysit => ({
  id: 'b1',
  serverId: 'local',
  sessionId: 'out4',
  sessionName: 'Out4',
  goal: 'get the release build passing',
  direction: 'prefer the smallest change; use SQLite for storage',
  createdAt: 1000,
  expiresAt: 1000 + 60 * 60_000,
  maxAnswers: 20,
  answersUsed: 0,
  escalations: 0,
  status: 'active',
  log: [],
  ...over,
});

const noAsk = { hasOpenAsk: () => false };

// ---------------------------------------------------------------------------

describe('babysit tracker', () => {
  it('keys a choice by signature + turn and a text ending by its turn', () => {
    const a = promptOf(snap({ sessionId: 's', status: 'waiting', pendingChoice: choice, lastTurnKey: 't1' }));
    const b = promptOf(snap({ sessionId: 's', status: 'waiting', pendingChoice: choice, lastTurnKey: 't2' }));
    const c = promptOf(snap({ sessionId: 's', status: 'waiting', pendingChoice: { ...choice, signature: 'other' }, lastTurnKey: 't1' }));
    if (!('prompt' in a) || !('prompt' in b) || !('prompt' in c)) throw new Error('expected prompts');
    expect(a.prompt.kind).toBe('choice');
    expect(a.prompt.key).not.toBe(b.prompt.key); // a new turn re-asking is a new occurrence
    expect(a.prompt.key).not.toBe(c.prompt.key); // two boxes of one multi-question turn differ
    expect(a.prompt.hash).toBe(b.prompt.hash); // ...but it is the same question (loop detection)

    const t = promptOf(asking('t9', 'All set. Shall I move on'));
    if (!('prompt' in t)) throw new Error('expected a prompt');
    // No question mark needed: the turn ended and the session is waiting.
    expect(t.prompt).toMatchObject({ kind: 'text', turnKey: 't9', multiSelect: false });
    expect(t.prompt.question).toContain('Shall I move on');
  });

  it('never reports permission prompts, pending approvals, working or closed sessions', () => {
    expect(isPermissionChoice(permission)).toBe(true);
    expect(isPermissionChoice({ ...choice, question: 'Do you want to make this edit to app.ts?', options: [{ label: 'Yes' }, { label: 'No' }] })).toBe(true);
    expect(isPermissionChoice({ ...choice, question: 'Trust the files in this folder?', options: [{ label: 'Yes, I accept' }, { label: 'No, exit' }] })).toBe(true);
    expect(isPermissionChoice(choice)).toBe(false);
    expect(promptOf(snap({ sessionId: 's', status: 'waiting', pendingChoice: permission }))).toEqual({ skip: 'permission' });
    expect(
      promptOf(
        snap({ sessionId: 's', status: 'waiting', pendingChoice: choice, pendingApproval: { tool: 'Bash', detail: 'rm -rf x', toolUseId: 'tu1' } })
      )
    ).toEqual({ skip: 'approval' });
    expect(promptOf(snap({ sessionId: 's', status: 'working', lastTurnKey: 't', lastTurnGist: 'x' }))).toEqual({ skip: 'working' });
    expect(promptOf(snap({ sessionId: 's', inactive: true }))).toEqual({ skip: 'closed' });
    expect(promptOf(snap({ sessionId: 's' }))).toEqual({ skip: 'none' });
  });

  it('waits for a prompt to be stable for a poll (and the settle time) before reporting it once', () => {
    const t = new BabysitTracker();
    t.start(brief(), working());
    expect(t.update([asking('t1')], 2000, noAsk)).toEqual([]); // first sight: settling
    expect(t.update([asking('t1')], 2000 + SETTLE_TEXT_MS - 1, noAsk)).toEqual([]); // not long enough
    const ev = t.update([asking('t1')], 2000 + SETTLE_TEXT_MS, noAsk);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ type: 'prompt', prompt: { kind: 'text', turnKey: 't1' } });
    // Being decided: never reported twice.
    expect(t.update([asking('t1')], 60_000, noAsk)).toEqual([]);
    // A prompt that changes while settling starts over.
    expect(t.update([asking('t2')], 61_000, noAsk)).toEqual([]);
    expect(t.update([working()], 62_000, noAsk)).toEqual([]);
    expect(t.update([asking('t2')], 63_000, noAsk)).toEqual([]);
    expect(t.update([asking('t2')], 63_000 + SETTLE_TEXT_MS, noAsk)).toHaveLength(1);
  });

  it('skips the prompt that was on screen when the brief started, handled ones, and sessions with an open ask', () => {
    const t = new BabysitTracker();
    t.start(brief(), asking('t0'));
    expect(t.update([asking('t0')], 2000, noAsk)).toEqual([]);
    expect(t.update([asking('t0')], 99_000, noAsk)).toEqual([]);

    const withAsk = { hasOpenAsk: (k: string) => k === 'local:out4' };
    expect(t.update([asking('t1')], 100_000, withAsk)).toEqual([]);
    expect(t.update([asking('t1')], 120_000, withAsk)).toEqual([]);
    // The ask closed: it is picked up from scratch (settles first).
    expect(t.update([asking('t1')], 121_000, noAsk)).toEqual([]);
    const ev = t.update([asking('t1')], 121_000 + SETTLE_TEXT_MS, noAsk);
    expect(ev).toHaveLength(1);
    if (ev[0].type !== 'prompt') throw new Error('expected a prompt');
    t.resolve('local:out4', ev[0].prompt.key, 'answered', 130_000);
    expect(t.update([asking('t1')], 140_000, noAsk)).toEqual([]);
    expect(t.get('local:out4')!.handled).toContain(ev[0].prompt.key);
  });

  it('reports a multi-select box (to escalate) and a choice after the shorter settle time', () => {
    const t = new BabysitTracker();
    t.start(brief(), working());
    const multi = snap({ sessionId: 'out4', status: 'waiting', lastTurnKey: 't1', pendingChoice: { ...choice, multiSelect: true } });
    t.update([multi], 5000, noAsk);
    const ev = t.update([multi], 5000 + SETTLE_CHOICE_MS, noAsk);
    expect(ev[0]).toMatchObject({ type: 'prompt', prompt: { kind: 'choice', multiSelect: true } });
  });

  it('ends a brief on its time limit; a missing session is only ever a candidate', () => {
    const t = new BabysitTracker();
    t.start(brief({ expiresAt: 10_000 }), working());
    expect(t.update([working()], 9_999, noAsk)).toEqual([]);
    expect(t.update([working()], 10_000, noAsk)).toMatchObject([{ type: 'end', reason: 'expired' }]);
    expect(t.list()[0]).toMatchObject({ status: 'ended', endReason: 'expired', endedAt: 10_000 });
    expect(t.update([working()], 11_000, noAsk)).toEqual([]);

    // Production, 2026-10-06: the watcher listed a live session as closed
    // ("inactive") for one listing while it rebuilt its tmux maps, and that one
    // listing ended the brief as session_gone. One listing proves nothing.
    const c = new BabysitTracker();
    c.start(brief(), working());
    expect(c.update([working({ inactive: true })], 2000, noAsk)).toEqual([]);
    expect(c.update([], 3000, noAsk)).toEqual([]);
    expect(c.update([working()], 4000, noAsk)).toEqual([]);
    expect(c.stillMissing('local:out4')).toBe(false);
    expect(c.list()[0].status).toBe('active');

    // Many fast polls without the session are not a sustained absence either.
    const g = new BabysitTracker();
    g.start(brief(), working());
    for (let i = 0; i < MISSING_POLLS * 3; i++) expect(g.update([], 2000 + i, noAsk)).toEqual([]);
    // Nor is a long gap covered by too few listings, or by listings that failed.
    const f = new BabysitTracker();
    f.start(brief(), working());
    expect(f.update([], 2000, noAsk)).toEqual([]);
    expect(f.update([], 2000 + GONE_AFTER_MS * 2, noAsk)).toEqual([]);
    const failing = { ...noAsk, listingOk: () => false };
    for (let i = 0; i < 20; i++) expect(f.update([], 2000 + GONE_AFTER_MS * (3 + i), failing)).toEqual([]);
    expect(f.stillMissing('local:out4')).toBe(true);

    // Sustained: a `gone` candidate (the brief stays active), raised again later.
    let at = 2000;
    for (let i = 0; i < 14; i++) expect(g.update([working({ inactive: true })], (at += 4000), noAsk)).toEqual([]);
    at = 2000 + GONE_AFTER_MS;
    expect(g.update([], at, noAsk)).toMatchObject([{ type: 'gone' }]);
    expect(g.list()[0].status).toBe('active');
    expect(g.update([], at + 4000, noAsk)).toEqual([]);
    expect(g.update([], at + GONE_RECHECK_MS, noAsk)).toMatchObject([{ type: 'gone' }]);
    // Seen again: everything resets.
    expect(g.update([working()], at + GONE_RECHECK_MS + 1, noAsk)).toEqual([]);
    expect(g.stillMissing('local:out4')).toBe(false);
    expect(g.update([], at + GONE_RECHECK_MS * 3, noAsk)).toEqual([]);
  });

  it('inbox hold: held while deciding (at most 20 s), suppressed once answered, shown once escalated', () => {
    const t = new BabysitTracker();
    t.start(brief(), working());
    expect(t.inboxHold(asking('t1'), 2000)).toBeNull(); // not seen yet
    t.update([asking('t1')], 2000, noAsk);
    expect(t.inboxHold(asking('t1'), 2500)).toBe('hold');
    const ev = t.update([asking('t1')], 2000 + SETTLE_TEXT_MS, noAsk);
    expect(t.inboxHold(asking('t1'), 2000 + HOLD_MAX_MS - 1)).toBe('hold');
    expect(t.inboxHold(asking('t1'), 2000 + HOLD_MAX_MS)).toBeNull(); // a slow decision never hides it for long
    if (ev[0].type !== 'prompt') throw new Error('expected a prompt');
    t.resolve('local:out4', ev[0].prompt.key, 'answered', 30_000);
    expect(t.inboxHold(asking('t1'), 31_000)).toBe('suppress');
    // Another session, or an unbabysat one, is never held.
    expect(t.inboxHold(snap({ sessionId: 'other', lastTurnKey: 't1', lastTurnGist: 'x' }), 31_000)).toBeNull();

    const e = new BabysitTracker();
    e.start(brief(), working());
    e.update([asking('t1')], 2000, noAsk);
    const ev2 = e.update([asking('t1')], 9000, noAsk);
    if (ev2[0].type !== 'prompt') throw new Error('expected a prompt');
    e.resolve('local:out4', ev2[0].prompt.key, 'escalated', 9500);
    expect(e.inboxHold(asking('t1'), 9600)).toBeNull();

    // Live finding: the answer that reaches the cap ends the brief in the same
    // breath. Its question was still answered, so it stays hidden (it used to
    // flash up as "is asking", with a tone, until the session moved on).
    t.end('local:out4', 'max_answers', 30_000);
    expect(t.inboxHold(asking('t1'), 31_000)).toBe('suppress');
    expect(t.inboxHold(asking('t2'), 31_000)).toBeNull(); // the next question is the user's
    expect(t.inboxHold(asking('t1'), 30_000 + ANSWERED_SUPPRESS_MS)).toBeNull();
    t.update([asking('t1')], 30_000 + ANSWERED_SUPPRESS_MS, noAsk);
    expect(t.inboxHold(asking('t1'), 31_000)).toBeNull(); // forgotten after the window
    // A brief that ends any other way hides nothing.
    const x = new BabysitTracker();
    x.start(brief(), working());
    x.update([asking('t1')], 2000, noAsk);
    x.end('local:out4', 'stopped', 2500);
    expect(x.inboxHold(asking('t1'), 2600)).toBeNull();
  });

  it('persisted briefs are validated: junk, far-future and long-ended ones are dropped', () => {
    const now = 5_000_000;
    const good = { brief: brief({ createdAt: now - 1000, expiresAt: now + 60_000, answersUsed: 3 }), baselineKey: 't:x', handled: ['a', 7], answered: ['h'], lastAnswer: 'sqlite' };
    const out = sanitizeBabysits(
      [
        good,
        { brief: { ...brief(), goal: '' } },
        { brief: brief({ id: 'far', sessionId: 's2', createdAt: now, expiresAt: now + 1000 * 60 * 60 * 1000 }) },
        { brief: brief({ id: 'old', sessionId: 's3', status: 'ended', endedAt: now - 2 * 60 * 60 * 1000, createdAt: 1, expiresAt: 2 }) },
        { brief: brief({ id: 'evil', sessionId: 's4', createdAt: now, expiresAt: now + 1000, maxAnswers: 9999, log: [{ at: 1, question: 'q', answer: 'a', kind: 'nope' as never }] }), extra: 'dropped' },
        'nope',
      ],
      now
    );
    expect(out.map((r) => r.brief.id)).toEqual(['b1', 'evil']);
    expect(out[0]).toMatchObject({ baselineKey: 't:x', handled: ['a'], answered: ['h'], lastAnswer: 'sqlite', brief: { answersUsed: 3 } });
    expect(out[1].brief.maxAnswers).toBe(50);
    expect(out[1].brief.log).toEqual([]);
    expect(out[1]).not.toHaveProperty('extra');
    expect(sanitizeBabysits({}, now)).toEqual([]);
    // The configured time limit is kept when sane, dropped when not.
    const withMinutes = (minutes: unknown) =>
      sanitizeBabysits([{ brief: { ...brief({ createdAt: now - 1000, expiresAt: now + 60_000 }), minutes } }], now)[0].brief;
    expect(withMinutes(45).minutes).toBe(45);
    expect(withMinutes(0)).not.toHaveProperty('minutes');
    expect(withMinutes(99_999)).not.toHaveProperty('minutes');
    expect(withMinutes('45')).not.toHaveProperty('minutes');
  });
});

// ---------------------------------------------------------------------------

describe('babysit decider', () => {
  const textPrompt = (q = 'Step one is done. Want me to continue with the next step?') => {
    const p = promptOf(asking('t1', q));
    if (!('prompt' in p)) throw new Error('expected a prompt');
    return p.prompt;
  };
  const choicePrompt = (c: PendingChoice = choice) => {
    const p = promptOf(snap({ sessionId: 'out4', status: 'waiting', pendingChoice: c, lastTurnKey: 't1' }));
    if (!('prompt' in p)) throw new Error('expected a prompt');
    return p.prompt;
  };
  const input = (over: Partial<BabysitDecideInput> = {}): BabysitDecideInput => ({
    brief: brief(),
    prompt: textPrompt(),
    sessionName: 'Out4',
    projectPath: '/home/u/src/out4',
    latest: 'Step one is done. Want me to continue with the next step?',
    ...over,
  });
  const brain = (p: LlmProvider | null, over: Partial<BabysitBrain> = {}) => {
    const usage: unknown[] = [];
    const b: BabysitBrain = { provider: p, skipReason: () => null, onUsage: (u) => usage.push(u), ...over };
    return { b, usage };
  };

  it('answers a plain "continue?" (text, sent through the model override, metered)', async () => {
    const p = scripted([{ ...CONTINUE, usage: { inputTokens: 900, outputTokens: 80 } }]);
    const { b, usage } = brain(p, { model: 'claude-sonnet-5-5', effort: 'medium' });
    const v = await decideBabysit(b, input());
    expect(v).toMatchObject({ kind: 'answer', continueCase: true, basis: 'continue', answer: { text: 'Yes, continue.' } });
    expect(p.calls).toHaveLength(1);
    expect(p.calls[0]).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'medium', tools: [], toolChoice: 'none' });
    expect(p.calls[0].messages[0]).toMatchObject({ role: 'user' });
    expect((p.calls[0].messages[0] as { text: string }).text).toContain('get the release build passing');
    expect(usage).toEqual([{ inputTokens: 900, outputTokens: 80 }]);
  });

  it('answers a choice the brief covers, quoting the brief', () => {
    const v = judgeDecision(
      JSON.stringify({ decision: 'answer', option: 1, text: null, basis: 'use SQLite for storage', reason: 'the brief says SQLite' }),
      input({ prompt: choicePrompt() })
    );
    expect(v).toMatchObject({ kind: 'answer', continueCase: false, answer: { optionIndex: 0, label: 'SQLite' }, basis: 'use SQLite for storage' });
  });

  it('a basis that is not in the brief becomes an escalation that keeps the suggestion', () => {
    const v = judgeDecision(
      JSON.stringify({ decision: 'answer', option: 2, text: null, basis: 'the user prefers Postgres', reason: 'x' }),
      input({ prompt: choicePrompt() })
    );
    expect(v).toMatchObject({ kind: 'escalate', why: 'basis', tier: 'echo', suggestion: { optionIndex: 1, label: 'Postgres' } });
    // "continue" is checked against the texts, not taken on the model's word.
    const fake = judgeDecision(
      JSON.stringify({ decision: 'answer', option: 2, text: null, basis: 'continue', reason: 'x' }),
      input({ prompt: choicePrompt() })
    );
    expect(fake).toMatchObject({ kind: 'escalate', why: 'basis' });
    const notContinue = judgeDecision(
      JSON.stringify({ decision: 'answer', option: null, text: 'Yes, continue, and also drop the old tables.', basis: 'continue', reason: 'x' }),
      input()
    );
    expect(notContinue.kind).toBe('escalate');
    const otherQuestion = judgeDecision(
      JSON.stringify({ decision: 'answer', option: null, text: 'Yes, continue.', basis: 'continue', reason: 'x' }),
      input({ prompt: textPrompt('I can use Postgres or SQLite here. Which one do you prefer?') })
    );
    expect(otherQuestion).toMatchObject({ kind: 'escalate', why: 'basis' });
  });

  it('a danger hit is escalated as a hard-confirm card, never sent', () => {
    const risky: PendingChoice = {
      question: 'Ready to ship. What next?',
      options: [{ label: 'Deploy to production now' }, { label: 'Wait' }],
      multiSelect: false,
      signature: 'sig-risk',
    };
    const v = judgeDecision(
      JSON.stringify({ decision: 'answer', option: 1, text: null, basis: 'get the release build passing', reason: 'x' }),
      input({ prompt: choicePrompt(risky) })
    );
    expect(v).toMatchObject({ kind: 'escalate', why: 'danger', tier: 'hard_confirm', suggestion: { optionIndex: 0 } });
    if (v.kind !== 'escalate') throw new Error('expected an escalation');
    expect(v.reasons.length).toBeGreaterThan(0);
    expect(v.ruleIds).toEqual(expect.arrayContaining(['deploy']));
    // Free text too: the answer itself is scanned.
    const t = judgeDecision(
      JSON.stringify({ decision: 'answer', option: null, text: 'Yes, force push it to main.', basis: 'get the release build passing', reason: 'x' }),
      input()
    );
    expect(t).toMatchObject({ kind: 'escalate', why: 'danger', tier: 'hard_confirm' });
    // The model's own escalation carries the classifier's tier as well.
    const m = judgeDecision(JSON.stringify({ decision: 'escalate', option: 1, text: null, basis: '', reason: 'risky' }), input({ prompt: choicePrompt(risky) }));
    expect(m).toMatchObject({ kind: 'escalate', why: 'model', tier: 'hard_confirm' });
  });

  it('"never decide" notes win over a brief that would otherwise cover it', () => {
    expect(neverHits('anything about the database schema', 'Which database should I use? SQLite')).toEqual(['database']);
    expect(neverHits('pricing', 'Which database should I use?')).toEqual([]);
    expect(neverHits(undefined, 'anything')).toEqual([]);
    const v = judgeDecision(
      JSON.stringify({ decision: 'answer', option: 1, text: null, basis: 'use SQLite for storage', reason: 'x' }),
      input({ prompt: choicePrompt(), brief: brief({ never: 'anything about the database' }) })
    );
    expect(v).toMatchObject({ kind: 'escalate', why: 'never', suggestion: { optionIndex: 0 } });
  });

  it('brain down or over budget: escalates with no suggestion and no model call', async () => {
    const p = scripted([CONTINUE]);
    const { b, usage } = brain(p, { skipReason: () => 'monthly budget used up' });
    const v = await decideBabysit(b, input());
    expect(v).toMatchObject({ kind: 'escalate', why: 'brain_down' });
    expect(v).not.toHaveProperty('suggestion');
    expect(p.calls).toHaveLength(0);
    expect(usage).toEqual([]);
    expect(await decideBabysit(brain(null).b, input())).toMatchObject({ kind: 'escalate', why: 'brain_down' });
    const failing = scripted([{ throws: new LlmError('rate_limited', 'slow down') }]);
    expect(await decideBabysit(brain(failing).b, input())).toMatchObject({ kind: 'escalate', why: 'brain_down' });
    const crashing = scripted([{ throws: new Error('boom') }]);
    expect(await decideBabysit(brain(crashing).b, input())).toMatchObject({ kind: 'escalate', why: 'error' });
  });

  it('a reply that does not parse, is cut off, refused or malformed escalates with no suggestion', async () => {
    for (const raw of ['Sure, I will continue.', '{"decision": "answer", ', '{"decision":"approve"}', '[1,2]']) {
      const v = judgeDecision(raw, input());
      expect(v.kind).toBe('escalate');
      expect(v).not.toHaveProperty('suggestion');
    }
    for (const stopReason of ['refusal', 'max_tokens', 'tool_calls'] as const) {
      const p = scripted([{ ...CONTINUE, stopReason }]);
      expect(await decideBabysit(brain(p).b, input())).toMatchObject({ kind: 'escalate', why: 'parse' });
    }
    // An option that is not offered, text for a choice box, or an overlong answer.
    expect(judgeDecision(JSON.stringify({ decision: 'answer', option: 7, basis: 'continue' }), input({ prompt: choicePrompt() }))).toMatchObject({ kind: 'escalate', why: 'invalid' });
    expect(judgeDecision(JSON.stringify({ decision: 'answer', text: 'SQLite', basis: 'use SQLite for storage' }), input({ prompt: choicePrompt() }))).toMatchObject({ kind: 'escalate', why: 'invalid' });
    expect(judgeDecision(JSON.stringify({ decision: 'answer', text: 'x'.repeat(400), basis: 'continue' }), input())).toMatchObject({ kind: 'escalate', why: 'invalid' });
  });

  it('"done" ends without an answer; helpers behave', () => {
    expect(judgeDecision(JSON.stringify({ decision: 'done', reason: 'All tests pass and the build is green.' }), input())).toEqual({
      kind: 'done',
      reason: 'All tests pass and the build is green.',
    });
    expect(basisInBrief('"prefer the smallest change"', brief())).toBe(true);
    expect(basisInBrief('Prefer the SMALLEST change.', brief())).toBe(true);
    expect(basisInBrief('change', brief())).toBe(false); // one word is not a quote
    expect(basisInBrief('prefer the biggest change', brief())).toBe(false);
    expect(basisInBrief('nothing about that', brief({ never: 'nothing about that' }))).toBe(false); // "never" is not a basis
    expect(isContinueCase(textPrompt('Phase 1 is finished. Next I will wire the API.'), { text: 'Continue.', label: 'Continue.' })).toBe(true);
    expect(isContinueCase(textPrompt(), { text: 'No, stop here.', label: 'No, stop here.' })).toBe(false);
    // Live finding: the real model echoes where to carry on to ("Yes, continue with step 2.").
    const step2 = textPrompt('Step 1 is done. Want me to continue with step 2?');
    for (const text of ['Yes, continue with step 2.', 'Yes, please continue with step 2', 'Continue to step 2.', 'Yes, go ahead with the next step.', 'Proceed with phase 2'])
      expect(isContinueCase(step2, { text, label: text })).toBe(true);
    // ...but never to somewhere the question did not name, and never with an instruction attached.
    for (const text of ['Yes, continue with step 5.', 'Yes, continue with step 2 and delete the old data.', 'Continue with the deploy', 'Yes, continue but use Postgres'])
      expect(isContinueCase(step2, { text, label: text })).toBe(false);
    const yesNo: PendingChoice = { question: 'Continue with phase 2?', options: [{ label: 'Yes, continue' }, { label: 'No, stop' }], multiSelect: false, signature: 's' };
    expect(isContinueCase(choicePrompt(yesNo), { optionIndex: 0, label: 'Yes, continue' })).toBe(true);
    expect(isContinueCase(choicePrompt(yesNo), { optionIndex: 1, label: 'No, stop' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('babysit plumbing', () => {
  it('the Anthropic request takes the per-call effort; the meter prices a second model at its own rate', () => {
    const base = { system: 's', messages: [{ role: 'user' as const, text: 'q' }], tools: [], toolChoice: 'none' as const, maxTokens: 100 };
    expect(buildAnthropicRequest('claude-sonnet-5-5', { ...base, effort: 'medium' })).toMatchObject({
      model: 'claude-sonnet-5-5',
      output_config: { effort: 'medium' },
    });
    expect(buildAnthropicRequest('claude-haiku-4-5', base)).not.toHaveProperty('output_config');

    const m = new UsageMeter(undefined, { model: 'claude-haiku-4-5', now: () => Date.UTC(2026, 9, 5) });
    expect(m.recordRequest({ inputTokens: 1_000_000 })).toBeCloseTo(1);
    expect(m.recordRequest({ inputTokens: 1_000_000, outputTokens: 100_000 }, 'claude-sonnet-5-5')).toBeCloseTo(3);
    expect(m.summary().month).toMatchObject({ requests: 2, inputTokens: 2_000_000 });
    expect(m.summary().month.costUsd).toBeCloseTo(4);
  });

  it('a babysit model with no price entry is never free: it is charged the dearest known rate and counts toward the budget', () => {
    const m = new UsageMeter(undefined, {
      model: 'claude-haiku-4-5',
      now: () => Date.UTC(2026, 9, 5),
      configBudgetUsd: 2,
    });
    expect(m.pricingFor('claude-sonnet-5-5').exact).toBe(true);
    expect(m.pricingFor('claude-next-9')).toEqual({ exact: false, rates: DEFAULT_PRICING['claude-sonnet-5-5'] });
    // Sonnet's rate ($2 in), not $0.
    expect(m.recordRequest({ inputTokens: 1_000_000 }, 'claude-next-9')).toBeCloseTo(2);
    expect(m.overBudget()).toBe(true);
    expect(m.takeNotice()).toBe('budget_exceeded');

    // The main model's own (overridden) rate wins when it is the dearest.
    const table = { ...DEFAULT_PRICING, 'big-main': { input: 30, output: 150, cacheWrite5m: 37.5, cacheWrite1h: 60, cacheRead: 3 } };
    expect(fallbackRates(table)).toBe(table['big-main']);
    const big = new UsageMeter(undefined, { model: 'big-main', pricing: table, now: () => Date.UTC(2026, 9, 5) });
    expect(big.recordRequest({ outputTokens: 1_000_000 }, 'claude-next-9')).toBeCloseTo(150);
    expect(fallbackRates({})).toBeNull();
  });

  it('config: babysit_model defaults to Sonnet 5.5 for the anthropic provider only', () => {
    const env = { ANTHROPIC_API_KEY: 'k' } as NodeJS.ProcessEnv;
    expect(resolveHeraldConfig(parseHeraldConfigBlock({ provider: 'anthropic' }), env).babysitModel).toBe('claude-sonnet-5-5');
    expect(resolveHeraldConfig(parseHeraldConfigBlock({ provider: 'anthropic', babysit_model: ' claude-haiku-4-5 ' }), env).babysitModel).toBe('claude-haiku-4-5');
    expect(resolveHeraldConfig(parseHeraldConfigBlock({ base_url: 'http://x/v1', model: 'q' }), env).babysitModel).toBeUndefined();
  });

  it('babysat sessions are always inside the pane-capture set', async () => {
    const sessions = Array.from({ length: MAX_PANE_CAPTURES + 4 }, (_, i) => ({
      id: `s${i}`,
      name: `s${i}`,
      projectPath: '/p',
      status: 'idle' as const,
      lastActivity: 1000 - i, // s0 is the most recent, the last ones the oldest
    }));
    const captured: string[] = [];
    const src = new LocalSessionSource({
      watcher: { getServerSummary: async () => ({ sessions }), getMessages: () => [] },
      injector: { sendInput: async () => true, sendChoice: async () => true, checkSessionExists: async () => true },
      sessionNames: { getAll: () => ({}) },
      capturePane: async (name) => {
        captured.push(name);
        return '';
      },
    });
    await src.listSessions();
    const oldest = `s${MAX_PANE_CAPTURES + 3}`;
    expect(captured).toHaveLength(MAX_PANE_CAPTURES);
    expect(captured).not.toContain(oldest);
    captured.length = 0;
    src.setPinnedSessions([oldest]);
    await src.listSessions();
    expect(captured).toHaveLength(MAX_PANE_CAPTURES);
    expect(captured).toContain(oldest);
  });

  it('inbox: a held item shows once released; a suppressed one never does; babysit items are silent tallies', () => {
    const inbox = new InboxTracker();
    let mode: 'hold' | 'suppress' | null = 'hold';
    const hook = () => mode;
    inbox.update([working()], 1); // primes
    expect(inbox.update([asking('t1', 'Done with step one.')], 2, undefined, hook)).toBe(false);
    expect(inbox.list()).toEqual([]);
    expect(inbox.update([asking('t1', 'Done with step one.')], 3, undefined, hook)).toBe(false);
    mode = null; // escalated: shown at once, although the transition was two polls ago
    expect(inbox.update([asking('t1', 'Done with step one.')], 4, undefined, hook)).toBe(true);
    expect(inbox.list()).toMatchObject([{ priority: 'finished', headline: 'Out4 finished: Done with step one.' }]);

    // Answered: the next turn's note is suppressed for good.
    inbox.update([working()], 5, undefined, hook);
    mode = 'hold';
    inbox.update([asking('t2', 'Done with step two.')], 6, undefined, hook);
    mode = 'suppress';
    inbox.update([asking('t2', 'Done with step two.')], 7, undefined, hook);
    mode = null;
    inbox.update([asking('t2', 'Done with step two.')], 8, undefined, hook);
    expect(inbox.list()).toEqual([]);

    // A live choice box is held too, then shown.
    const box = snap({ sessionId: 'out4', sessionName: 'Out4', status: 'waiting', pendingChoice: choice, lastTurnKey: 't3' });
    mode = 'hold';
    inbox.update([box], 9, undefined, hook);
    expect(inbox.list()).toEqual([]);
    mode = null;
    inbox.update([box], 10, undefined, hook);
    expect(inbox.list()).toMatchObject([{ priority: 'blocked' }]);

    const item = { serverId: 'local', sessionId: 'out4', sessionName: 'Out4', babysit: { babysitId: 'b1', status: 'active' as const, answers: 0, escalations: 0 } };
    expect(inbox.setBabysitItems([{ ...item, key: 'b1:0:active', headline: 'Babysitting Out4: 0 answers sent', quiet: true }], 11)).toBe(true);
    const first = inbox.list().find((i) => i.babysit)!;
    expect(first).toMatchObject({ priority: 'progress', heard: true }); // nothing to report yet
    inbox.setBabysitItems([{ ...item, key: 'b1:1:active', headline: 'Babysitting Out4: 1 answer sent', quiet: false, babysit: { ...item.babysit, answers: 1 } }], 12);
    const tally = inbox.list().filter((i) => i.babysit);
    expect(tally).toHaveLength(1); // one chip per brief
    expect(tally[0]).toMatchObject({ heard: false, headline: 'Babysitting Out4: 1 answer sent', babysit: { answers: 1 } });
    // The session working again, or finishing, never removes it.
    inbox.update([working()], 13);
    inbox.update([asking('t4', 'More done.')], 14);
    expect(inbox.list().filter((i) => i.babysit)).toHaveLength(1);
    inbox.setBabysitItems([], 15);
    expect(inbox.list().filter((i) => i.babysit)).toHaveLength(0);
  });

  it('a suggested action never arms a countdown and survives a store round trip as expired', async () => {
    jest.useFakeTimers();
    try {
      const changes: string[] = [];
      const sendText = jest.fn(async () => true);
      const am = new ActionManager({
        getSource: () =>
          ({ sessionExists: async () => true, getLiveChoice: async () => null, sendText } as unknown as SessionSource),
        echoDelayMs: 50,
        onChange: (a) => changes.push(a.status),
        onSent: () => {},
        audit: () => {},
      });
      const a = am.create({
        tier: 'echo', reasons: [], kind: 'send_input', serverId: 'local', sessionId: 'out4', sessionName: 'Out4',
        payload: 'Yes, continue.', readback: 'Out4: "Yes, continue."', meta: {}, suggested: true, babysitId: 'b1', suggestedWhy: 'your call',
      });
      expect(a).toMatchObject({ suggested: true, babysitId: 'b1', suggestedWhy: 'your call', tier: 'echo' });
      expect(a.autoSendAt).toBeUndefined();
      jest.advanceTimersByTime(60_000);
      expect(sendText).not.toHaveBeenCalled();
      expect(am.get(a.id)!.status).toBe('pending');
      const kept = sanitizeState({ messages: [], heard: [], actions: [am.get(a.id)] }, 5).actions[0];
      expect(kept).toMatchObject({ suggested: true, babysitId: 'b1', suggestedWhy: 'your call', status: 'expired' });
      // ...and expires like a hard-confirm card instead of sending.
      jest.advanceTimersByTime(11 * 60_000);
      expect(am.get(a.id)!.status).toBe('expired');
      expect(sendText).not.toHaveBeenCalled();
      am.dispose();
    } finally {
      jest.useRealTimers();
    }
  });

  it('parseBabysitSpec bounds and clamps', () => {
    expect(parseBabysitSpec({ sessionId: 'out4', goal: '  ship   it  ' })).toEqual({ serverId: 'local', sessionId: 'out4', goal: 'ship it', minutes: 120, maxAnswers: 20 });
    expect(parseBabysitSpec({ sessionId: 'out4', goal: 'ship it', minutes: 1, maxAnswers: 500, never: 'pricing', direction: '' })).toMatchObject({ minutes: 5, maxAnswers: 50, never: 'pricing' });
    for (const bad of [{}, { sessionId: 'x' }, { sessionId: 'x', goal: 'a' }, { sessionId: 'x', goal: 'g'.repeat(501) }, { sessionId: 'x', goal: 'ship it', minutes: 'ten' }, { sessionId: 3, goal: 'ship it' }]) {
      expect(() => parseBabysitSpec(bad)).toThrow(BabysitError);
    }
  });

  it('WS handlers: payload codes, and the dispatch gate on narrowed credentials', async () => {
    const sent: any[] = [];
    const setBabysit = jest.fn(async (p: any) => {
      if (!p?.goal) throw new BabysitError('bad_request', 'goal is required');
      return { babysit: { id: 'b1' } };
    });
    const stopBabysit = jest.fn(() => ({ stopped: [] }));
    const ctx: any = {
      herald: { setBabysit, stopBabysit },
      config: { listeners: [{ port: 9877, token: 't', tls: false }] },
      send: (_ws: unknown, r: unknown) => sent.push(r),
      requireRemoteCapability: jest.fn(() => 'dispatch is not enabled for this origin'),
    };
    const h = registerHeraldHandlers(ctx);
    const client: any = { id: 'c1', ws: {}, isLocal: true, listenerPort: 9877, origin: null };
    await h.herald_babysit_set(client, { sessionId: 'out4', goal: 'ship it' }, 'a');
    await h.herald_babysit_set(client, { sessionId: 'out4' }, 'b');
    await h.herald_babysit_stop(client, { sessionId: 'out4' }, 'c');
    expect(sent[0]).toEqual({ type: 'herald_babysit_set', success: true, payload: { babysit: { id: 'b1' } }, requestId: 'a' });
    expect(sent[1]).toEqual({ type: 'herald_babysit_set', success: false, error: 'goal is required', payload: { code: 'bad_request' }, requestId: 'b' });
    expect(sent[2]).toEqual({ type: 'herald_babysit_stop', success: true, payload: { stopped: [] }, requestId: 'c' });
    expect(ctx.requireRemoteCapability).not.toHaveBeenCalled();

    const narrowed = { ...client, originCredential: { name: 'remote' } };
    await h.herald_babysit_set(narrowed, { sessionId: 'out4', goal: 'ship it' }, 'd');
    await h.herald_babysit_stop(narrowed, {}, 'e');
    expect(ctx.requireRemoteCapability).toHaveBeenCalledWith(narrowed, 'dispatch');
    expect(sent[3]).toMatchObject({ success: false, payload: { code: 'forbidden' }, requestId: 'd' });
    expect(sent[4]).toMatchObject({ success: false, payload: { code: 'forbidden' }, requestId: 'e' });
    expect(setBabysit).toHaveBeenCalledTimes(2);

    const none: any[] = [];
    const h2 = registerHeraldHandlers({ ...ctx, herald: null, send: (_w: unknown, r: unknown) => none.push(r) });
    await h2.herald_babysit_set(client, {}, 'f');
    expect(none[0]).toMatchObject({ success: false, payload: { code: 'unavailable' } });
  });
});

// ---------------------------------------------------------------------------

describe('babysit in HeraldService', () => {
  let dir: string;
  let services: HeraldService[] = [];
  let clock: number;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herald-babysit-'));
    clock = 1_700_000_000_000;
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    for (const s of services) s.shutdown();
    services = [];
    fs.rmSync(dir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  const cfg = (over: Partial<ResolvedHeraldConfig> = {}): ResolvedHeraldConfig => ({
    featureEnabled: true,
    displayName: 'Herald',
    provider: 'openai_compatible',
    baseUrl: 'http://spark:8000/v1',
    model: 'qwen3',
    echoDelayMs: 80,
    requestTimeoutMs: 5000,
    maxTokens: 700,
    stateDir: '/tmp/herald-test-unused',
    apiKey: null,
    brainConfigured: true,
    ...over,
  });

  function fakeSource(initial: SessionSnapshot[]) {
    const holder = { sessions: initial, unreadable: false };
    const src = {
      serverId: 'local',
      holder,
      pinned: [] as string[],
      listSessions: jest.fn(async (): Promise<SessionSnapshot[]> => holder.sessions),
      getRecentTranscript: jest.fn(async () => ({
        lastUserPrompt: { role: 'user' as const, text: 'make the release build pass', at: 1 },
        assistantTurns: [{ role: 'assistant' as const, text: 'Working on it.', at: 2 }],
      })),
      getLiveChoice: jest.fn(async (id: string): Promise<PendingChoice | null> => {
        if (holder.unreadable) throw new Error(`could not read ${id}'s screen to re-check it`);
        return holder.sessions.find((s) => s.sessionId === id)?.pendingChoice || null;
      }),
      sessionExists: jest.fn(async () => true),
      sendText: jest.fn(async (..._a: unknown[]) => true),
      sendChoice: jest.fn(async (..._a: unknown[]) => true),
      setPinnedSessions: jest.fn((ids: string[]) => {
        src.pinned = ids;
      }),
    };
    return src as typeof src & SessionSource;
  }

  function make(
    provider: LlmProvider | null,
    source: SessionSource,
    opts: { config?: ResolvedHeraldConfig; autoSend?: boolean } = {}
  ) {
    const events: HeraldEvent[] = [];
    const audits: AuditEntry[] = [];
    const svc = new HeraldService({
      config: opts.config ?? cfg(),
      provider,
      sources: [source],
      store: new HeraldStore(dir, 10),
      broadcast: (e) => events.push(e),
      audit: (a) => audits.push(a),
      pollIntervalMs: 10 * 60_000,
      now: () => clock,
      babysit: { autoSend: opts.autoSend ?? true, settleMs: { choice: 0, text: 0 } },
    });
    services.push(svc);
    return { svc, events, audits };
  }

  /** Two polls (a prompt must be stable for one), then wait for the decision and what it kicked. */
  async function tick(svc: HeraldService) {
    await svc.poll();
    clock += 1000;
    await svc.poll();
    await svc.settleBabysit();
    await svc.poll();
    await svc.settleBabysit();
  }

  async function started(steps: Step[], opts: { autoSend?: boolean; config?: ResolvedHeraldConfig; spec?: Record<string, unknown> } = {}) {
    const src = fakeSource([working()]);
    const p = scripted(steps);
    const made = make(p, src, opts);
    await made.svc.start();
    await made.svc.poll();
    const { babysit } = await made.svc.setBabysit({ sessionId: 'out4', goal: 'get the release build passing', direction: 'use SQLite for storage', ...opts.spec });
    return { ...made, src, p, babysit };
  }

  const heraldLines = (svc: HeraldService) => svc.getState().messages.filter((m) => m.role === 'herald');

  /** Poll every 4 s for `ms` of wall clock, letting existence checks finish. */
  async function pollFor(svc: HeraldService, ms: number) {
    for (let t = 0; t < ms; t += 4000) {
      clock += 4000;
      await svc.poll();
      await svc.settleBabysit();
    }
  }

  it('a live session listed as closed, missing, or behind a failing listing never ends its brief (production 2026-10-06)', async () => {
    // The id the web sends for a session is its tmux name, which is Herald's id.
    const live = working({ sessionId: 'companion-out4-muee37av', tmuxName: 'companion-out4-muee37av' });
    const src = fakeSource([live]);
    const { svc, audits } = make(scripted([CONTINUE]), src);
    await svc.start();
    await svc.poll();
    const { babysit } = await svc.setBabysit({ sessionId: 'companion-out4-muee37av', serverId: 'local', goal: 'get this ready and on staging' });
    expect(babysit.sessionId).toBe('companion-out4-muee37av');

    // One listing caught the watcher mid-rebuild: the session shows as closed.
    src.holder.sessions = [{ ...live, inactive: true }];
    await pollFor(svc, 4000);
    src.holder.sessions = [live];
    await pollFor(svc, 8000);
    expect(svc.getState().babysits![0].status).toBe('active');
    expect(src.sessionExists).not.toHaveBeenCalled();

    // The listing fails for ten minutes: not one miss is counted.
    src.listSessions.mockRejectedValue(new Error('tmux is busy'));
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await pollFor(svc, 10 * 60_000);
    expect(src.sessionExists).not.toHaveBeenCalled();
    src.listSessions.mockImplementation(async () => src.holder.sessions);

    // Listed as closed for ten minutes while tmux still has it: checked, never ended.
    src.holder.sessions = [{ ...live, inactive: true }];
    await pollFor(svc, 10 * 60_000);
    expect(src.sessionExists).toHaveBeenCalledWith('companion-out4-muee37av');
    // The existence check itself failing is not "gone" either.
    src.sessionExists.mockRejectedValue(new Error('spawn EAGAIN'));
    src.holder.sessions = [];
    await pollFor(svc, 5 * 60_000);
    expect(svc.getState().babysits![0]).toMatchObject({ status: 'active' });
    expect(audits.filter((a) => a.action === 'herald_babysit_end')).toEqual([]);
    expect(src.pinned).toEqual(['companion-out4-muee37av']);

    // Back in the listing: answered as usual.
    src.sessionExists.mockResolvedValue(true);
    src.holder.sessions = [{ ...asking('t1'), sessionId: live.sessionId, tmuxName: live.tmuxName }];
    await tick(svc);
    expect(src.sendText).toHaveBeenCalledTimes(1);
    expect(svc.getState().babysits![0]).toMatchObject({ status: 'active', answersUsed: 1 });
  });

  it('ends as session_gone only after a sustained absence that the existence check confirms', async () => {
    const { svc, src, audits } = await started([CONTINUE]);
    src.holder.sessions = [];
    src.sessionExists.mockResolvedValue(false);
    await pollFor(svc, 40_000);
    expect(src.sessionExists).not.toHaveBeenCalled();
    expect(svc.getState().babysits![0].status).toBe('active');
    await pollFor(svc, 40_000);
    expect(src.sessionExists).toHaveBeenCalledWith('out4');
    expect(svc.getState().babysits![0]).toMatchObject({ status: 'ended', endReason: 'session_gone' });
    expect(audits.filter((a) => a.action === 'herald_babysit_end')).toMatchObject([{ payload: { reason: 'session_gone' } }]);
    expect(src.pinned).toEqual([]);
  });

  it('auto-answers a "continue?" once: prefixed text, quiet log line, counters, audit, no ask link', async () => {
    const { svc, src, p, events, audits, babysit } = await started([CONTINUE]);
    expect(babysit).toMatchObject({ sessionId: 'out4', sessionName: 'Out4', status: 'active', answersUsed: 0, maxAnswers: 20 });
    expect(babysit.expiresAt).toBe(clock + 120 * 60_000);
    expect(src.pinned).toEqual(['out4']);
    expect(events.some((e) => e.kind === 'babysits' && e.babysits.length === 1)).toBe(true);

    src.holder.sessions = [asking('t1')];
    await tick(svc);
    expect(p.calls).toHaveLength(1);
    expect(src.sendText).toHaveBeenCalledTimes(1);
    expect(src.sendText.mock.calls[0].slice(0, 2)).toEqual(['out4', `${BABYSIT_PREFIX} Yes, continue.`]);

    const b = svc.getState().babysits![0];
    expect(b).toMatchObject({ answersUsed: 1, escalations: 0, status: 'active' });
    expect(b.log).toMatchObject([{ kind: 'answered', answer: 'Yes, continue.' }]);
    const lines = heraldLines(svc);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ quiet: true, sessionRefs: [{ sessionId: 'out4' }] });
    expect(lines[0].text).toMatch(/^Out4 asked: ".*continue.*" I answered: "Yes, continue\."\.$/);
    expect(audits.filter((a) => a.action === 'herald_babysit_answer')).toMatchObject([{ result: { ok: true }, payload: { basis: 'continue', answersUsed: 1 } }]);
    // The "finished" note for that turn never shows; the tally is one silent item.
    const inbox = svc.getState().inbox;
    expect(inbox.filter((i) => !i.babysit)).toEqual([]);
    expect(inbox.filter((i) => i.babysit)).toMatchObject([{ priority: 'progress', headline: 'Babysitting Out4: 1 answer sent', babysit: { answers: 1, status: 'active' } }]);
    expect(svc.buildSnapshot(src.holder.sessions)).toMatch(/Babysitting \(you answer[^\n]*\n- Out4: goal "get the release build passing"; 1 of 20 answers sent/);

    // Same prompt on later polls: nothing more is decided or sent.
    await tick(svc);
    await tick(svc);
    expect(p.calls).toHaveLength(1);
    expect(src.sendText).toHaveBeenCalledTimes(1);
  });

  it('answers a choice the brief covers through sendChoice, after re-reading the live box', async () => {
    const { svc, src } = await started([say({ decision: 'answer', option: 1, basis: 'use SQLite for storage' })]);
    src.holder.sessions = [snap({ sessionId: 'out4', sessionName: 'Out4', status: 'waiting', pendingChoice: choice, lastTurnKey: 't1' })];
    await tick(svc);
    expect(src.getLiveChoice).toHaveBeenCalledWith('out4');
    expect(src.sendChoice).toHaveBeenCalledTimes(1);
    expect(src.sendChoice.mock.calls[0]).toEqual(['out4', 0, 2, false]);
    expect(src.sendText).not.toHaveBeenCalled();
    expect(svc.getState().babysits![0].log).toMatchObject([{ kind: 'answered', answer: 'SQLite' }]);
    expect(svc.getState().inbox.filter((i) => i.priority === 'blocked')).toEqual([]);
  });

  it('never answers a permission box or a pending approval (no model call at all)', async () => {
    const { svc, src, p } = await started([CONTINUE, CONTINUE]);
    src.holder.sessions = [snap({ sessionId: 'out4', sessionName: 'Out4', status: 'waiting', pendingChoice: permission, lastTurnKey: 't1' })];
    await tick(svc);
    src.holder.sessions = [
      snap({ sessionId: 'out4', sessionName: 'Out4', status: 'waiting', lastTurnKey: 't2', lastTurnGist: 'Running it. Continue?', pendingApproval: { tool: 'Bash', detail: 'npm test', toolUseId: 'tu9' } }),
    ];
    await tick(svc);
    expect(p.calls).toHaveLength(0);
    expect(src.sendText).not.toHaveBeenCalled();
    expect(src.sendChoice).not.toHaveBeenCalled();
    // It stays the user's: the normal "needs approval" item shows at once.
    expect(svc.getState().inbox.filter((i) => i.priority === 'blocked')).toHaveLength(1);
    expect(svc.getState().babysits![0]).toMatchObject({ answersUsed: 0, escalations: 0 });
  });

  it('escalates with a one-tap suggested card (no countdown); sending it is the user\'s act', async () => {
    const { svc, src, audits } = await started([say({ decision: 'answer', option: 2, basis: 'the user likes Postgres', reason: 'Postgres scales better.' })]);
    src.holder.sessions = [snap({ sessionId: 'out4', sessionName: 'Out4', status: 'waiting', pendingChoice: choice, lastTurnKey: 't1' })];
    await tick(svc);
    expect(src.sendChoice).not.toHaveBeenCalled();
    const st = svc.getState();
    expect(st.inbox.filter((i) => i.priority === 'blocked')).toMatchObject([{ headline: 'Out4 is asking: Which database should I use?' }]);
    const card = st.actions.find((a) => a.suggested)!;
    expect(card).toMatchObject({ status: 'pending', tier: 'echo', kind: 'answer_choice', payload: 'Postgres', babysitId: st.babysits![0].id });
    expect(card.autoSendAt).toBeUndefined();
    expect(card.suggestedWhy).toMatch(/does not clearly cover/);
    const line = heraldLines(svc).find((m) => m.actionIds?.includes(card.id))!;
    expect(line).toMatchObject({ quiet: true });
    expect(st.babysits![0]).toMatchObject({ answersUsed: 0, escalations: 1 });
    expect(st.babysits![0].log).toMatchObject([{ kind: 'escalated', answer: 'Postgres' }]);
    expect(audits.some((a) => a.action === 'herald_babysit_escalate')).toBe(true);
    expect(svc.buildSnapshot(src.holder.sessions)).toMatch(/your suggested answer for a babysat session; it waits for the user to press Send/);

    // Nothing sends by itself, however long it waits.
    await new Promise((r) => setTimeout(r, 200));
    expect(src.sendChoice).not.toHaveBeenCalled();
    const sentCard = await svc.confirm(card.id, 'confirm', { addr: '', clientId: 'c1', isLocal: true, tls: false, origin: null });
    expect(sentCard.status).toBe('sent');
    expect(src.sendChoice.mock.calls[0]).toEqual(['out4', 1, 2, false]);
    const b = svc.getState().babysits![0];
    expect(b.answersUsed).toBe(0); // the user's send does not use up Herald's answers
    expect(b.log.map((e) => e.kind)).toEqual(['escalated', 'user']);
  });

  it('a risky option becomes a hard-confirm suggestion and is never sent', async () => {
    const risky: PendingChoice = { question: 'Build is green. What next?', options: [{ label: 'Deploy to production now' }, { label: 'Stop here' }], multiSelect: false, signature: 'sig-risk' };
    const { svc, src } = await started([say({ decision: 'answer', option: 1, basis: 'get the release build passing' })]);
    src.holder.sessions = [snap({ sessionId: 'out4', sessionName: 'Out4', status: 'waiting', pendingChoice: risky, lastTurnKey: 't1' })];
    await tick(svc);
    expect(src.sendChoice).not.toHaveBeenCalled();
    const card = svc.getState().actions.find((a) => a.suggested)!;
    expect(card).toMatchObject({ tier: 'hard_confirm', status: 'pending', payload: 'Deploy to production now', confirmPhrase: 'confirm deploy' });
    expect(card.reasons.length).toBeGreaterThan(0);
    // The question goes away (the user answered in the terminal): the card is taken down.
    src.holder.sessions = [working()];
    await tick(svc);
    expect(svc.getState().actions.find((a) => a.id === card.id)!.status).toBe('cancelled');
  });

  it('the answer cap ends the brief', async () => {
    const { svc, src, p } = await started([CONTINUE, CONTINUE, CONTINUE], { spec: { maxAnswers: 2 } });
    for (const turn of ['t1', 't2', 't3']) {
      src.holder.sessions = [asking(turn, `Finished ${turn}. Want me to continue with the next step?`)];
      await tick(svc);
      if (turn === 't2') {
        // The capping answer was sent: its question must not surface as "is asking".
        expect(svc.getState().babysits![0].status).toBe('ended');
        await svc.poll();
        expect(svc.getState().inbox.filter((i) => !i.babysit)).toEqual([]);
      }
      src.holder.sessions = [working()];
      await tick(svc);
    }
    expect(src.sendText).toHaveBeenCalledTimes(2);
    expect(p.calls).toHaveLength(2);
    const b = svc.getState().babysits![0];
    expect(b).toMatchObject({ status: 'ended', endReason: 'max_answers', answersUsed: 2 });
    expect(heraldLines(svc).some((m) => /ended: I've used all 2 answers/.test(m.text) && m.quiet)).toBe(true);
    expect(src.pinned).toEqual([]);
  });

  it('the time limit ends the brief; nothing is decided afterwards', async () => {
    const { svc, src, p } = await started([CONTINUE], { spec: { minutes: 10 } });
    clock += 10 * 60_000 + 1;
    src.holder.sessions = [asking('t1')];
    await tick(svc);
    expect(svc.getState().babysits![0]).toMatchObject({ status: 'ended', endReason: 'expired' });
    expect(p.calls).toHaveLength(0);
    expect(src.sendText).not.toHaveBeenCalled();
    // An ended brief hides nothing: the session's own note shows as usual.
    await tick(svc);
    expect(svc.getState().inbox.some((i) => i.babysit?.status === 'ended')).toBe(true);
  });

  it('a question that comes straight back after the answer ends the brief as a loop', async () => {
    const same = 'I could not find the config. Want me to continue?';
    const { svc, src, p } = await started([CONTINUE, CONTINUE]);
    src.holder.sessions = [asking('t1', same)];
    await tick(svc);
    src.holder.sessions = [working()];
    await tick(svc);
    src.holder.sessions = [asking('t2', same)];
    await tick(svc);
    expect(src.sendText).toHaveBeenCalledTimes(1);
    expect(p.calls).toHaveLength(2);
    expect(svc.getState().babysits![0]).toMatchObject({ status: 'ended', endReason: 'loop', answersUsed: 1 });
    expect(heraldLines(svc).some((m) => /asked the same thing again/.test(m.text))).toBe(true);
  });

  it('the same non-continue answer twice in a row is a loop too', async () => {
    const box = (sig: string, turn: string) =>
      snap({ sessionId: 'out4', sessionName: 'Out4', status: 'waiting', lastTurnKey: turn, pendingChoice: { ...choice, question: `Storage for ${sig}?`, signature: sig } });
    const pick = say({ decision: 'answer', option: 1, basis: 'use SQLite for storage' });
    const { svc, src } = await started([pick, { ...pick }]);
    src.holder.sessions = [box('a', 't1')];
    await tick(svc);
    src.holder.sessions = [working()];
    await tick(svc);
    src.holder.sessions = [box('b', 't2')];
    await tick(svc);
    expect(src.sendChoice).toHaveBeenCalledTimes(1);
    expect(svc.getState().babysits![0]).toMatchObject({ status: 'ended', endReason: 'loop' });
  });

  it('the user answering first wins: the decision is dropped at send time', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { svc, src, p } = await started([{ ...CONTINUE, wait: () => gate }]);
    src.holder.sessions = [asking('t1')];
    await svc.poll();
    clock += 1000;
    await svc.poll();
    await waitFor(() => p.calls.length === 1); // the decision is now waiting on the model
    src.holder.sessions = [working()]; // the user typed an answer in the terminal
    release();
    await svc.settleBabysit();
    await tick(svc);
    expect(src.sendText).not.toHaveBeenCalled();
    expect(svc.getState().babysits![0]).toMatchObject({ answersUsed: 0, status: 'active' });
  });

  it('a new turn while deciding, a choice box appearing, or an unreadable screen: nothing is typed', async () => {
    // The session moved to another turn.
    let release!: () => void;
    let gate = new Promise<void>((r) => (release = r));
    const a = await started([{ ...CONTINUE, wait: () => gate }]);
    a.src.holder.sessions = [asking('t1')];
    await a.svc.poll();
    clock += 1000;
    await a.svc.poll();
    await waitFor(() => a.p.calls.length === 1);
    a.src.holder.sessions = [asking('t2', 'A different question now?')];
    release();
    await a.svc.settleBabysit();
    expect(a.src.sendText).not.toHaveBeenCalled();
    a.svc.shutdown();

    // An unreadable pane fails closed (and no blind retry card is sent either).
    // (Same state dir: the brief above was persisted and is edited in place, so use a new turn.)
    gate = Promise.resolve();
    const b = await started([CONTINUE]);
    b.src.holder.sessions = [asking('u1')];
    b.src.holder.unreadable = true;
    await tick(b.svc);
    expect(b.src.sendText).not.toHaveBeenCalled();
    expect(b.svc.getState().babysits![0]).toMatchObject({ answersUsed: 0, escalations: 1 });
    expect(b.audits.some((x) => x.action === 'herald_babysit_answer' && x.result.ok === false)).toBe(true);
  });

  it('a failed delivery is brought to the user, not retried', async () => {
    const { svc, src } = await started([CONTINUE]);
    src.sendText.mockResolvedValueOnce(false);
    src.holder.sessions = [asking('t1')];
    await tick(svc);
    await tick(svc);
    expect(src.sendText).toHaveBeenCalledTimes(1);
    expect(svc.getState().babysits![0]).toMatchObject({ answersUsed: 0, escalations: 1 });
    expect(svc.getState().inbox.some((i) => !i.babysit && i.sessionId === 'out4')).toBe(true);
  });

  it('"done" ends the brief and tells the user; a multi-select box is escalated without a model call', async () => {
    const { svc, src } = await started([say({ decision: 'done', reason: 'The release build passes and all tests are green.' })]);
    src.holder.sessions = [asking('t1', 'The release build passes and all tests are green.')];
    await tick(svc);
    expect(src.sendText).not.toHaveBeenCalled();
    expect(svc.getState().babysits![0]).toMatchObject({ status: 'ended', endReason: 'done' });
    expect(heraldLines(svc).some((m) => /^Out4 says the goal is done: The release build passes/.test(m.text))).toBe(true);

    const m = await started([CONTINUE]);
    m.src.holder.sessions = [snap({ sessionId: 'out4', sessionName: 'Out4', status: 'waiting', lastTurnKey: 't1', pendingChoice: { ...choice, multiSelect: true } })];
    await tick(m.svc);
    expect(m.p.calls).toHaveLength(0);
    expect(m.src.sendChoice).not.toHaveBeenCalled();
    expect(m.svc.getState().babysits![0]).toMatchObject({ escalations: 1 });
    expect(m.svc.getState().actions.filter((x) => x.suggested)).toEqual([]);
  });

  it('over budget: fails closed (escalates, no model call, no send)', async () => {
    const { svc, src, p } = await started([CONTINUE]);
    svc.setBudget(0.01);
    // Spend past the cap on the main model's meter.
    (svc as unknown as { usage: UsageMeter }).usage = new UsageMeter(
      { day: '2000-01-01', monthKey: '2000-01', today: {} as never, month: {} as never, budgetOverrideUsd: 0.000001 },
      { model: 'qwen3', now: () => clock, pricing: { qwen3: { input: 1, output: 1, cacheWrite5m: 1, cacheWrite1h: 1, cacheRead: 1 } } }
    );
    (svc as unknown as { usage: UsageMeter }).usage.recordRequest({ inputTokens: 1000 });
    expect(svc.getUsage().overBudget).toBe(true);
    src.holder.sessions = [asking('t1')];
    await tick(svc);
    expect(p.calls).toHaveLength(0);
    expect(src.sendText).not.toHaveBeenCalled();
    expect(svc.getState().babysits![0]).toMatchObject({ answersUsed: 0, escalations: 1 });
    expect(svc.getState().actions.filter((a) => a.suggested)).toEqual([]); // no suggestion without a brain
    expect(svc.getState().inbox.some((i) => !i.babysit && i.sessionId === 'out4')).toBe(true);
  });

  it('decisions are metered on the babysit model (anthropic provider)', async () => {
    const step = { ...CONTINUE, usage: { inputTokens: 1_000_000, outputTokens: 0 } };
    const config = cfg({ provider: 'anthropic', model: 'claude-haiku-4-5', babysitModel: 'claude-sonnet-5-5' });
    const { svc, src, p } = await started([step], { config });
    src.holder.sessions = [asking('t1')];
    await tick(svc);
    expect(p.calls[0]).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'medium' });
    expect(svc.getUsage().month.costUsd).toBeCloseTo(2); // Sonnet's input rate, not Haiku's
    expect(svc.getUsage().month.turns).toBe(0); // not a conversation turn
  });

  it('sandbox (suggest only): never sends, offers the answer on a card instead', async () => {
    const { svc, src, babysit } = await started([CONTINUE, CONTINUE], { autoSend: false });
    expect(babysit.autoSend).toBe(false);
    src.holder.sessions = [asking('t1')];
    await tick(svc);
    await tick(svc);
    expect(src.sendText).not.toHaveBeenCalled();
    expect(src.sendChoice).not.toHaveBeenCalled();
    const st = svc.getState();
    expect(st.babysits![0]).toMatchObject({ answersUsed: 0, escalations: 1, autoSend: false });
    const card = st.actions.find((a) => a.suggested)!;
    expect(card).toMatchObject({ kind: 'send_input', payload: 'Yes, continue.', tier: 'echo', status: 'pending' });
    expect(card.autoSendAt).toBeUndefined();
    expect(svc.buildSnapshot(src.holder.sessions)).toMatch(/on this server you only suggest answers/);
    // The user sends it: plain text (it is their answer), and no ask link is opened.
    await svc.confirm(card.id, 'confirm', { addr: '', clientId: 'c1', isLocal: true, tls: false, origin: null });
    expect(src.sendText.mock.calls[0].slice(0, 2)).toEqual(['out4', 'Yes, continue.']);
    expect((svc as unknown as { asks: { list(): unknown[] } }).asks.list()).toEqual([]);
  });

  it('the sandbox default comes from COMPANION_SANDBOX, overridable with HERALD_BABYSIT_AUTOSEND', async () => {
    const env = { ...process.env };
    try {
      const build = async () => {
        const src = fakeSource([working()]);
        const svc = new HeraldService({ config: cfg(), provider: scripted([]), sources: [src], store: new HeraldStore(fs.mkdtempSync(path.join(dir, 's-')), 10), broadcast: () => {}, audit: () => {}, pollIntervalMs: 600_000 });
        services.push(svc);
        await svc.start();
        await svc.poll();
        return (await svc.setBabysit({ sessionId: 'out4', goal: 'ship it' })).babysit;
      };
      delete process.env.COMPANION_SANDBOX;
      delete process.env.HERALD_BABYSIT_AUTOSEND;
      expect((await build()).autoSend).toBeUndefined();
      process.env.COMPANION_SANDBOX = '1';
      expect((await build()).autoSend).toBe(false);
      process.env.HERALD_BABYSIT_AUTOSEND = '1';
      expect((await build()).autoSend).toBeUndefined();
    } finally {
      process.env = env;
    }
  });

  it('state survives a store reload: counters, the handled prompt and the expiry', async () => {
    const first = await started([CONTINUE]);
    first.src.holder.sessions = [asking('t1')];
    await tick(first.svc);
    const before = first.svc.getState().babysits![0];
    expect(before.answersUsed).toBe(1);
    first.svc.shutdown();

    const src = fakeSource([asking('t1')]);
    const p = scripted([CONTINUE, CONTINUE]);
    const { svc } = make(p, src);
    await svc.start();
    const after = svc.getState().babysits![0];
    expect(after).toMatchObject({ id: before.id, answersUsed: 1, expiresAt: before.expiresAt, status: 'active', goal: before.goal });
    expect(after.log).toHaveLength(1);
    expect(src.pinned).toEqual(['out4']);
    // The prompt it already answered is not answered again after the restart...
    await tick(svc);
    await tick(svc);
    expect(p.calls).toHaveLength(0);
    expect(src.sendText).not.toHaveBeenCalled();
    // ...but the next one is.
    src.holder.sessions = [working()];
    await tick(svc);
    src.holder.sessions = [asking('t2', 'Step two is done. Shall I proceed with step three?')];
    await tick(svc);
    expect(src.sendText).toHaveBeenCalledTimes(1);
    expect(svc.getState().babysits![0].answersUsed).toBe(2);
  });

  it('set / edit / stop: validation codes, in-place edit, stop by session and all', async () => {
    const { svc, src, events, audits, babysit } = await started([]);
    await expect(svc.setBabysit({ sessionId: 'nope', goal: 'ship it' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(svc.setBabysit({ sessionId: 'out4' })).rejects.toMatchObject({ code: 'bad_request' });
    await expect(svc.setBabysit({ sessionId: 'out4', goal: 'ship it', serverId: 'mars' })).rejects.toMatchObject({ code: 'not_found' });

    clock += 5000;
    const edited = (await svc.setBabysit({ sessionId: 'out4', goal: 'ship the hotfix', never: 'pricing', minutes: 30, maxAnswers: 5 })).babysit;
    expect(edited).toMatchObject({ id: babysit.id, goal: 'ship the hotfix', never: 'pricing', maxAnswers: 5, minutes: 30, expiresAt: clock + 30 * 60_000, createdAt: babysit.createdAt });
    expect(edited.direction).toBeUndefined();
    expect(svc.getState().babysits).toHaveLength(1);
    expect(audits.filter((a) => a.action === 'herald_babysit_set')).toHaveLength(2);

    expect(svc.stopBabysit({ sessionId: 'other' })).toEqual({ stopped: [] });
    expect(() => svc.stopBabysit({ sessionId: '' })).toThrow(BabysitError);
    const n = events.length;
    const { stopped } = svc.stopBabysit({ sessionId: 'out4' });
    expect(stopped).toMatchObject([{ id: babysit.id, status: 'ended', endReason: 'stopped' }]);
    expect(events.slice(n).some((e) => e.kind === 'babysits' && e.babysits[0].status === 'ended')).toBe(true);
    expect(src.pinned).toEqual([]);
    expect(heraldLines(svc)).toEqual([]); // the user stopped it: nothing to announce
    // Stopped: a later question is the user's again.
    src.holder.sessions = [asking('t1')];
    await tick(svc);
    expect(src.sendText).not.toHaveBeenCalled();
    // A new brief replaces the ended one; stop-all ends it.
    const again = (await svc.setBabysit({ sessionId: 'out4', goal: 'ship it again' })).babysit;
    expect(again.id).not.toBe(babysit.id);
    expect(svc.getState().babysits).toHaveLength(1);
    expect(svc.stopBabysit({}).stopped).toHaveLength(1);
  });

  it('without a brain a brief cannot start', async () => {
    const src = fakeSource([working()]);
    const { svc } = make(null, src, { config: { ...cfg(), brainConfigured: false, disabledReason: 'Brain not configured' } });
    await svc.start();
    await expect(svc.setBabysit({ sessionId: 'out4', goal: 'ship it' })).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('the brain starts a brief only through a hard-confirm card ("confirm babysit"), stops and reports it by tool', async () => {
    const call = (name: string, args: Record<string, unknown>): Step => ({
      toolCalls: [{ id: `tc-${name}`, name, arguments: JSON.stringify(args) }],
      stopReason: 'tool_calls',
    });
    const src = fakeSource([working()]);
    const p = scripted([
      call('propose_babysit', { session: 'Out4', goal: 'get the release build passing', direction: 'prefer the smallest change', minutes: 60 }),
      { emit: "That's babysitting Out4: say 'confirm babysit' to go ahead." },
      call('babysit_status', {}),
      { emit: 'I am babysitting Out4.' },
      call('stop_babysit', { session: 'Out4' }),
      { emit: 'Okay, Out4 is yours again.' },
    ]);
    const { svc } = make(p, src);
    await svc.start();
    await svc.poll();
    const idle = async () => {
      const t0 = Date.now();
      while (svc.getState().busy) {
        if (Date.now() - t0 > 3000) throw new Error('turn did not finish');
        await new Promise((r) => setTimeout(r, 5));
      }
    };
    svc.send('babysit Out4 until the release build passes, prefer the smallest change, for an hour');
    await idle();
    const card = svc.getState().actions[0];
    expect(card).toMatchObject({ kind: 'babysit_start', tier: 'hard_confirm', status: 'pending', confirmPhrase: 'confirm babysit', payload: 'get the release build passing', sessionId: 'out4' });
    expect(card.autoSendAt).toBeUndefined();
    expect(svc.getState().babysits).toEqual([]); // nothing runs until confirmed

    const done = await svc.confirm(card.id, 'confirm', { addr: '', clientId: 'c1', isLocal: true, tls: false, origin: null });
    expect(done.status).toBe('sent');
    const b = svc.getState().babysits![0];
    expect(b).toMatchObject({ sessionId: 'out4', goal: 'get the release build passing', direction: 'prefer the smallest change', status: 'active', expiresAt: clock + 60 * 60_000 });
    expect(done.babysitId).toBe(b.id);
    expect(heraldLines(svc).some((m) => /^Babysitting Out4 for an hour: I'll answer its simple questions, up to 20/.test(m.text))).toBe(true);

    svc.send('what are you babysitting?');
    await idle();
    const statusResult = p.calls[3].messages.find((m) => m.role === 'tool') as { content: string };
    expect(JSON.parse(statusResult.content).babysitting).toMatchObject([{ session: 'Out4', answers_sent: '0 of 20', time_left: '1h' }]);

    svc.send('stop babysitting Out4');
    await idle();
    expect(svc.getState().babysits![0]).toMatchObject({ status: 'ended', endReason: 'stopped' });
    // The specs are static: the cached prompt prefix does not move with the briefs.
    expect(JSON.stringify(p.calls[0].tools)).toBe(JSON.stringify(p.calls[4].tools));
    expect(p.calls[0].system).toBe(p.calls[4].system);
  });

  it('"brief me" gets one line for the tally', async () => {
    const { svc, src, p } = await started([CONTINUE, { emit: 'I answered Out4 once.' }]);
    src.holder.sessions = [asking('t1')];
    await tick(svc);
    src.holder.sessions = [working()];
    await tick(svc);
    svc.send("what's up", { intent: 'brief' });
    const t0 = Date.now();
    while (svc.getState().busy && Date.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 5));
    const turn = p.calls[1].messages[p.calls[1].messages.length - 1] as { text: string };
    const lines = turn.text.split('\n').filter((l) => l.startsWith('- [babysitting]'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/Babysitting Out4: 1 answer sent/);
    expect(svc.getState().inbox.find((i) => i.babysit)!.heard).toBe(true);
  });
});
