import { ActionManager } from '../src/herald/actions';
import type { HeraldAction } from '../src/herald/protocol';
import type { SessionSource } from '../src/herald/session-source';
import {
  checkVoiceConfirm,
  deriveConfirmPhrase,
  matchesConfirmPhrase,
  MAX_VOICE_ATTEMPTS,
  rejectionMessage,
  type VoiceConfirmCheck,
} from '../src/herald/voice-confirm';
import { classifyAction } from '../src/herald/danger';

const NOW = 1_000_000;

function check(over: Partial<VoiceConfirmCheck> = {}): VoiceConfirmCheck {
  return {
    now: NOW,
    phrase: 'confirm deploy',
    claimed: 'confirm deploy',
    isActiveDevice: true,
    transcript: {
      streamId: 's1',
      text: 'Confirm deploy.',
      captureStartAt: NOW - 3000,
      endedAt: NOW - 500,
      consumed: false,
    },
    spoken: [
      {
        text: "That's a deploy to prod — say 'confirm deploy' to go ahead.",
        startAt: NOW - 9000,
        endAt: NOW - 5000,
      },
    ],
    speechEndAt: NOW - 5000,
    ...over,
  };
}

describe('confirm phrases', () => {
  it('derives the keyword from the most salient danger rule', () => {
    const v = classifyAction({
      userText: 'tell deploy to ship it to prod',
      payload: 'go ahead and deploy to prod',
      sessionName: 'out4',
    });
    expect(deriveConfirmPhrase({ kind: 'send_input', ruleIds: v.ruleIds, sessionName: 'out4' })).toBe(
      'confirm deploy'
    );
    expect(
      deriveConfirmPhrase({ kind: 'send_input', ruleIds: ['destructive'], sessionName: 'x' })
    ).toBe('confirm delete');
    expect(deriveConfirmPhrase({ kind: 'interrupt', sessionName: 'Docs' })).toBe('confirm interrupt');
    expect(deriveConfirmPhrase({ kind: 'spawn_session', sessionName: 'companion' })).toBe(
      'confirm launch'
    );
    expect(deriveConfirmPhrase({ kind: 'cush_command', cushOp: 'serve', sessionName: 'x' })).toBe(
      'confirm share'
    );
    // Only the assistant's flag: a generic word, still never a bare "yes".
    expect(deriveConfirmPhrase({ kind: 'send_input', ruleIds: [], sessionName: 'x' })).toBe(
      'confirm send'
    );
  });

  it('a clash with another pending card adds the session name (numbers spelled out)', () => {
    expect(
      deriveConfirmPhrase({
        kind: 'send_input',
        ruleIds: ['deploy'],
        sessionName: 'Out4',
        taken: ['confirm deploy'],
      })
    ).toBe('confirm deploy out four');
  });

  it('matches what Whisper writes, but only the exact phrase', () => {
    expect(matchesConfirmPhrase('Confirm deploy.', 'confirm deploy')).toBe(true);
    expect(matchesConfirmPhrase('Okay, confirm deploy please', 'confirm deploy')).toBe(true);
    expect(matchesConfirmPhrase('Hey Jarvis, confirm deployed', 'confirm deploy')).toBe(true);
    expect(matchesConfirmPhrase('conform deploy', 'confirm deploy')).toBe(true);
    expect(matchesConfirmPhrase('confirm deploy out for', 'confirm deploy out four')).toBe(true);
    // Bare affirmations never confirm.
    for (const bare of ['yes', 'yeah do it', 'do it', 'go ahead', 'confirm', 'yes confirm', 'confirmed'])
      expect(matchesConfirmPhrase(bare, 'confirm deploy')).toBe(false);
    // Herald's own sentence (or a piece of it) is not the phrase.
    expect(matchesConfirmPhrase("say confirm deploy to go ahead", 'confirm deploy')).toBe(false);
    expect(matchesConfirmPhrase("That's a deploy to prod, say confirm deploy", 'confirm deploy')).toBe(
      false
    );
    expect(matchesConfirmPhrase('confirm push', 'confirm deploy')).toBe(false);
    expect(matchesConfirmPhrase('confirm deploy and push', 'confirm deploy')).toBe(false);
  });
});

describe('checkVoiceConfirm', () => {
  it('accepts the phrase spoken after Herald finished, on the active device', () => {
    expect(checkVoiceConfirm(check())).toBeNull();
  });

  it('rejects the wrong phrase and a bare yes', () => {
    expect(
      checkVoiceConfirm(check({ transcript: { ...check().transcript!, text: 'confirm push' } }))
    ).toBe('mismatch');
    expect(checkVoiceConfirm(check({ transcript: { ...check().transcript!, text: 'yes' } }))).toBe(
      'mismatch'
    );
  });

  it("the daemon's own transcript decides: a client claim alone confirms nothing", () => {
    expect(checkVoiceConfirm(check({ transcript: null }))).toBe('no_transcript');
    expect(
      checkVoiceConfirm(check({ transcript: { ...check().transcript!, text: 'what is up' } }))
    ).toBe('mismatch');
    // ...and a client that claims something else is not believed either.
    expect(checkVoiceConfirm(check({ claimed: 'confirm push' }))).toBe('mismatch');
  });

  it('rejects a used or stale transcript', () => {
    expect(checkVoiceConfirm(check({ transcript: { ...check().transcript!, consumed: true } }))).toBe(
      'no_transcript'
    );
    expect(
      checkVoiceConfirm(check({ transcript: { ...check().transcript!, endedAt: NOW - 60_000 } }))
    ).toBe('stale_transcript');
  });

  it("rejects audio captured while Herald was still saying the phrase (its own echo)", () => {
    expect(
      checkVoiceConfirm(
        check({
          speechEndAt: NOW - 1000,
          transcript: { ...check().transcript!, captureStartAt: NOW - 2500 },
        })
      )
    ).toBe('during_speech');
  });

  it('runs the echo filter over speech around the capture window', () => {
    // Playback estimate says Herald finished just before, but the transcript is
    // exactly what it said in that tail: treated as echo.
    expect(
      checkVoiceConfirm(
        check({
          spoken: [{ text: 'Confirm deploy.', startAt: NOW - 4000, endAt: NOW - 3200 }],
          speechEndAt: NOW - 3200,
        })
      )
    ).toBe('echo');
  });

  it('only the active device may confirm', () => {
    expect(checkVoiceConfirm(check({ isActiveDevice: false }))).toBe('not_active_device');
  });

  it('rejection messages tell the user what to do next', () => {
    expect(rejectionMessage('mismatch', 'confirm deploy', 2)).toMatch(/say "confirm deploy"/i);
    expect(rejectionMessage('mismatch', 'confirm deploy', 0)).toMatch(/card on screen/);
    expect(rejectionMessage('during_speech', 'confirm deploy', 1)).toMatch(/finish/);
  });
});

describe('ActionManager voice confirmation', () => {
  function source(): SessionSource {
    return {
      serverId: 'local',
      listSessions: jest.fn(async () => []),
      getRecentTranscript: jest.fn(async () => ({ lastUserPrompt: null, assistantTurns: [] })),
      getLiveChoice: jest.fn(async () => null),
      sessionExists: jest.fn(async () => true),
      sendText: jest.fn(async () => true),
      sendChoice: jest.fn(async () => true),
    };
  }
  let mgr: ActionManager;
  let now = NOW;
  const audits: Array<{ event: string; trigger: string }> = [];
  let src: SessionSource;
  beforeEach(() => {
    now = NOW;
    audits.length = 0;
    src = source();
    mgr = new ActionManager({
      getSource: () => src,
      echoDelayMs: 50,
      hardConfirmTtlMs: 60_000,
      now: () => now,
      onChange: () => {},
      onSent: () => {},
      audit: (event, _a, trigger) => audits.push({ event, trigger }),
    });
  });
  afterEach(() => mgr.dispose());

  const hard = () =>
    mgr.create({
      tier: 'hard_confirm',
      reasons: ['your request involves: deploy'],
      kind: 'send_input',
      serverId: 'local',
      sessionId: 'out4',
      sessionName: 'Out4',
      payload: 'deploy it',
      readback: 'Out4: "deploy it"',
      meta: { ruleIds: ['deploy'] },
    });

  it('hard_confirm cards get a distinct phrase and three tries', () => {
    const a = hard();
    expect(a.confirmPhrase).toBe('confirm deploy');
    expect(a.voiceAttemptsLeft).toBe(MAX_VOICE_ATTEMPTS);
    const b = hard();
    expect(b.confirmPhrase).toBe('confirm deploy out four');
    const echo = mgr.create({
      tier: 'echo',
      reasons: [],
      kind: 'send_input',
      serverId: 'local',
      sessionId: 'docs',
      sessionName: 'Docs',
      payload: 'hi',
      readback: 'Docs: hi',
      meta: {},
    });
    expect(echo.confirmPhrase).toBeUndefined();
  });

  it('an accepted voice confirm sends and is audited as voice', async () => {
    const a = hard();
    const r = await mgr.confirmByVoice(a.id, () => null);
    expect(r.ok).toBe(true);
    expect(r.action.status).toBe('sent');
    expect(src.sendText).toHaveBeenCalledTimes(1);
    expect(audits).toContainEqual({ event: 'confirmed', trigger: 'voice' });
  });

  it('three failed tries, then on-screen only (the tap still works)', async () => {
    const a = hard();
    for (let i = 0; i < MAX_VOICE_ATTEMPTS; i++) {
      const r = await mgr.confirmByVoice(a.id, () => 'mismatch');
      expect(r.ok).toBe(false);
    }
    expect(mgr.get(a.id)!.voiceAttemptsLeft).toBe(0);
    const r = await mgr.confirmByVoice(a.id, () => null);
    expect(r).toMatchObject({ ok: false, rejection: 'too_many_attempts' });
    expect(src.sendText).not.toHaveBeenCalled();
    expect(audits.filter((x) => x.event === 'voice_rejected')).toHaveLength(4);
    const tapped = await mgr.confirm(a.id);
    expect(tapped.status).toBe('sent');
  });

  it('a passive device does not use up a try', async () => {
    const a = hard();
    await mgr.confirmByVoice(a.id, () => 'not_active_device');
    expect(mgr.get(a.id)!.voiceAttemptsLeft).toBe(MAX_VOICE_ATTEMPTS);
  });

  it('expired, resolved and echo-tier actions are refused', async () => {
    const a = hard();
    now = NOW + 61_000;
    expect(await mgr.confirmByVoice(a.id, () => null)).toMatchObject({ ok: false, rejection: 'expired' });
    now = NOW;
    const b = hard();
    mgr.cancel(b.id);
    expect(await mgr.confirmByVoice(b.id, () => null)).toMatchObject({
      ok: false,
      rejection: 'not_pending',
    });
    const e = mgr.create({
      tier: 'echo',
      reasons: [],
      kind: 'send_input',
      serverId: 'local',
      sessionId: 'docs',
      sessionName: 'Docs',
      payload: 'hi',
      readback: 'Docs: hi',
      meta: {},
    });
    expect(await mgr.confirmByVoice(e.id, () => null)).toMatchObject({
      ok: false,
      rejection: 'not_hard_confirm',
    });
    expect(src.sendText).not.toHaveBeenCalled();
  });

  it('escalating an echo card gives it a phrase', () => {
    const e = mgr.create({
      tier: 'echo',
      reasons: [],
      kind: 'interrupt',
      serverId: 'local',
      sessionId: 'docs',
      sessionName: 'Docs',
      payload: 'Ctrl+C',
      readback: 'Interrupting Docs',
      meta: {},
    });
    const up = mgr.escalate(e.id, 'flagged') as HeraldAction;
    expect(up.confirmPhrase).toBe('confirm interrupt');
  });
});

// ---------------------------------------------------------------------------
// Evidence recorded by the voice service, and the service-level flow

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HeraldVoiceService } from '../src/herald/voice/service';
import { HeraldService, HeraldRequestError } from '../src/herald/service';
import { HeraldStore } from '../src/herald/store';
import type { ResolvedHeraldConfig } from '../src/herald/config';
import type { LlmChatResult, LlmProvider } from '../src/herald/llm/provider';
import type { AuditEntry } from '../src/audit-log';
import { snap } from './herald-helpers';

describe('voice service evidence', () => {
  function voice(now: () => number) {
    const client = {
      baseUrl: 'http://x',
      health: jest.fn(async () => null),
      tts: jest.fn(async () => ({ pcm: Buffer.alloc(4), sampleRate: 24000, synthMs: 5, audioMs: 2000 })),
      stt: jest.fn(async () => ({ text: 'Confirm deploy.', audioMs: 800, sttMs: 30 })),
      wake: jest.fn(),
      dropWake: jest.fn(async () => undefined),
    } as never;
    return new HeraldVoiceService({ client, sendEvent: () => {}, now });
  }

  it('records what was transcribed and when Herald is estimated to stop talking', async () => {
    let t = 100_000;
    const v = voice(() => t);
    await v.synthesize('c1', { text: "That's a deploy to prod — say 'confirm deploy' to go ahead." });
    await v.synthesize('c1', { text: 'Second sentence.' });
    let ev = v.voiceEvidence('c1');
    expect(ev.spoken).toHaveLength(2);
    // Queued playback: the second sentence starts when the first ends.
    expect(ev.speechEndAt).toBe(100_000 + 4000);
    t += 1000;
    v.startStream('c1', { streamId: 's1', purpose: 'stt', sampleRate: 16000 });
    v.pushAudio('c1', { streamId: 's1', seq: 0, pcm: Buffer.alloc(3200).toString('base64') });
    t += 500;
    await v.endStream('c1', { streamId: 's1', action: 'transcribe' });
    ev = v.voiceEvidence('c1', 's1');
    expect(ev.transcript).toMatchObject({ streamId: 's1', text: 'Confirm deploy.', consumed: false });
    // The stream began while Herald was still (estimated) talking.
    expect(ev.transcript!.captureStartAt).toBeLessThan(ev.speechEndAt);
    v.consumeTranscript('c1', 's1');
    expect(v.voiceEvidence('c1', 's1').transcript!.consumed).toBe(true);
    // A barge-in / stop cuts the estimate to now.
    v.cancelTts('c1');
    expect(v.voiceEvidence('c1').speechEndAt).toBe(t);
    v.clientGone('c1');
    expect(v.voiceEvidence('c1')).toEqual({ transcript: null, spoken: [], speechEndAt: 0 });
  });
});

describe('HeraldService voice confirmation', () => {
  let dir: string;
  let svc: HeraldService | null = null;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herald-vc-'));
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    svc?.shutdown();
    svc = null;
    fs.rmSync(dir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  function setup(evidence: { text: string; captureStartAt: number; endedAt: number }, active = 'c1') {
    const source = {
      serverId: 'local',
      listSessions: jest.fn(async () => [snap({ sessionId: 'out4', sessionName: 'Out4', projectPath: '/x/out4' })]),
      getRecentTranscript: jest.fn(async () => ({ lastUserPrompt: null, assistantTurns: [] })),
      getLiveChoice: jest.fn(async () => null),
      sessionExists: jest.fn(async () => true),
      sendText: jest.fn(async () => true),
      sendChoice: jest.fn(async () => true),
    };
    const steps: Array<Partial<LlmChatResult>> = [
      {
        toolCalls: [{ id: 't', name: 'propose_input', arguments: '{"session":"Out4","text":"deploy to prod"}' }],
        stopReason: 'tool_calls',
      },
      { text: "That's a deploy to prod — say 'confirm deploy' to go ahead." },
    ];
    const provider: LlmProvider = {
      name: 'fake',
      model: 'f',
      async chat(r) {
        const s = steps.shift() || { text: 'ok' };
        if (s.text) r.onText(s.text);
        return { text: '', toolCalls: [], stopReason: 'end', usage: {}, ...s } as LlmChatResult;
      },
    };
    const consumed: string[] = [];
    const audits: AuditEntry[] = [];
    svc = new HeraldService({
      config: {
        featureEnabled: true,
        displayName: 'Herald',
        provider: 'openai_compatible',
        baseUrl: 'http://x/v1',
        model: 'm',
        echoDelayMs: 30,
        requestTimeoutMs: 5000,
        maxTokens: 700,
        stateDir: dir,
        apiKey: null,
        brainConfigured: true,
      } as ResolvedHeraldConfig,
      provider,
      sources: [source as unknown as SessionSource],
      store: new HeraldStore(dir, 5),
      broadcast: () => {},
      audit: (a) => audits.push(a),
      pollIntervalMs: 60_000,
      toolbox: null,
      activeClientId: () => active,
      voiceEvidence: () => ({
        transcript: { streamId: 's1', consumed: false, ...evidence },
        spoken: [],
        speechEndAt: Date.now() - 10_000,
      }),
      consumeTranscript: (_c, s) => consumed.push(s),
    });
    return { svc, source, consumed, audits };
  }

  const origin = (clientId: string) => ({ addr: '', clientId, isLocal: true, tls: false, origin: null });

  async function propose(s: HeraldService) {
    await s.start();
    s.send('tell Out4 to deploy to prod');
    for (let i = 0; i < 300 && s.getState().busy; i++) await new Promise((r) => setTimeout(r, 5));
    const a = s.getState().actions.find((x) => x.status === 'pending')!;
    expect(a.tier).toBe('hard_confirm');
    expect(a.confirmPhrase).toBe('confirm deploy');
    return a;
  }

  it('the right phrase from the active device sends; the audit says voice', async () => {
    const now = Date.now();
    const { svc: s, source, consumed, audits } = setup({ text: 'Confirm deploy.', captureStartAt: now - 2000, endedAt: now });
    const a = await propose(s);
    const out = await s.confirm(a.id, 'confirm', origin('c1'), { method: 'voice', phrase: 'confirm deploy', clientId: 'c1' });
    expect(out.status).toBe('sent');
    expect(source.sendText).toHaveBeenCalledWith('out4', 'deploy to prod', expect.any(String));
    expect(consumed).toEqual(['s1']);
    const conf = audits.find((x) => x.action === 'herald_action_confirmed')!;
    expect(conf.payload).toMatchObject({ method: 'voice', confirmPhrase: 'confirm deploy' });
  });

  it('a bare "yes" is refused with the phrase to say', async () => {
    const now = Date.now();
    const { svc: s, source } = setup({ text: 'Yes.', captureStartAt: now - 2000, endedAt: now });
    const a = await propose(s);
    await expect(
      s.confirm(a.id, 'confirm', origin('c1'), { method: 'voice', phrase: 'yes', clientId: 'c1' })
    ).rejects.toThrow(/say "confirm deploy"/i);
    expect(source.sendText).not.toHaveBeenCalled();
    expect(s.getState().actions.find((x) => x.id === a.id)!.voiceAttemptsLeft).toBe(2);
  });

  it('a device that is not the active one cannot confirm', async () => {
    const now = Date.now();
    const { svc: s, source } = setup({ text: 'confirm deploy', captureStartAt: now - 2000, endedAt: now }, 'other');
    const a = await propose(s);
    const err = await s
      .confirm(a.id, 'confirm', origin('c1'), { method: 'voice', phrase: 'confirm deploy', clientId: 'c1' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(HeraldRequestError);
    expect(err.message).toMatch(/active device/);
    expect(source.sendText).not.toHaveBeenCalled();
    // The tap still works.
    expect((await s.confirm(a.id, 'confirm', origin('c1'))).status).toBe('sent');
  });
});
