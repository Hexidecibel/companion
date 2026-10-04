import {
  analyzeFailure,
  commandCore,
  inputKey,
  isLongCommand,
  isPollingCommand,
  normalizeText,
  readPane,
} from '../normalize';
import { registerStuckHandlers } from '../../handlers/stuck';
import { StuckDetector } from '../detector';
import { StuckSettingsStore } from '../store';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('normalizeText', () => {
  it('strips numbers, paths, timestamps, ids and ANSI', () => {
    expect(normalizeText('\u001b[31mFAIL\u001b[0m /home/u/proj/src/api.test.ts:41:7 (12 ms)')).toBe(
      'FAIL api.test.ts:#:# (# ms)'
    );
    expect(normalizeText('at 2026-10-03T10:11:12.345Z run 9f8e7d6c5b4a took 10:11:12')).toBe(
      'at <ts> run <hex> took <t>'
    );
    expect(normalizeText('id 123e4567-e89b-12d3-a456-426614174000')).toBe('id <id>');
    expect(normalizeText('a   b\n\tc')).toBe('a b c');
  });
});

describe('commands', () => {
  it('commandCore drops setup steps and output filters', () => {
    expect(commandCore('cd /p && source ~/.nvm/nvm.sh && npm test 2>&1 | tail -40')).toBe(
      'npm test'
    );
    expect(commandCore('NODE_ENV=test npx jest api 2>&1 | grep -v x | head -5')).toBe(
      'npx jest api'
    );
    expect(commandCore('git status')).toBe('git status');
  });
  it('inputKey keeps numbers (different ranges are different calls)', () => {
    expect(inputKey('Bash', { command: "sed -n '1,50p' a" })).not.toBe(
      inputKey('Bash', { command: "sed -n '51,100p' a" })
    );
    expect(inputKey('Read', { file_path: '/a', offset: 1, description: 'x' })).toBe(
      inputKey('Read', { offset: 1, file_path: '/a' })
    );
  });
  it('classifies polling and long commands', () => {
    expect(isPollingCommand('sleep 30 && gh run view 1')).toBe(true);
    expect(isPollingCommand('git status')).toBe(false);
    expect(isLongCommand('npm run build')).toBe(true);
    expect(isLongCommand('cargo tauri android build')).toBe(true);
    expect(isLongCommand('curl -s http://x')).toBe(false);
  });
});

describe('analyzeFailure', () => {
  it('a failing test through `| tail` (exit 0) is a failure, keyed per test', () => {
    const f = analyzeFailure(
      'Bash',
      { command: 'npm test | tail' },
      'FAIL src/a.test.ts\n  ✕ adds (3 ms)\n  ● math › adds\n',
      false
    );
    expect(f.failed).toBe(true);
    expect(f.keys.map((k) => k.label)).toEqual(['src/a.test.ts', 'adds', 'math › adds']);
  });
  it('a passing run is not', () => {
    expect(
      analyzeFailure(
        'Bash',
        { command: 'npm test' },
        'PASS src/a.test.ts\n  ✓ adds (3 ms)\nTests: 1 passed',
        false
      ).failed
    ).toBe(false);
  });
  it('a failing command with nothing recognisable gets a command key', () => {
    const f = analyzeFailure(
      'Bash',
      { command: 'cd /p && ./run.sh 2>&1 | tail -5' },
      'Exit code 2\nboom happened at 12:00:01',
      true
    );
    expect(f.keys).toHaveLength(1);
    expect(f.keys[0].type).toBe('command');
    expect(f.keys[0].label).toBe('./run.sh');
  });
  it('a user rejection is neither failure nor success', () => {
    const f = analyzeFailure(
      'Bash',
      {},
      "The user doesn't want to proceed with this tool use.",
      true
    );
    expect(f).toMatchObject({ failed: false, rejected: true });
  });
});

describe('readPane', () => {
  it('ignores the spinner line (rotating verbs and timers)', () => {
    const a = readPane(
      '⏺ Bash(npm run e2e)\n  ⎿  Running…\n\n✻ Simmering… (3m 2s · esc to interrupt)\n❯ \n  ⏵⏵ bypass permissions on'
    );
    const b = readPane(
      '⏺ Bash(npm run e2e)\n  ⎿  Running…\n\n✶ Flibbertigibbeting… (9m 40s · esc to interrupt)\n❯ \n  ⏵⏵ bypass permissions on'
    );
    expect(a.hash).toBe(b.hash);
    expect(a.alive).toBe(true);
    expect(a.prompt).toBe(false);
  });
  it('sees new output as a change, and a shell prompt as not alive', () => {
    const a = readPane('⏺ Bash(make)\n  ⎿  compiling a.c\n❯ \n  ⏵⏵ bypass');
    const b = readPane('⏺ Bash(make)\n  ⎿  compiling b.c\n  linking\n❯ \n  ⏵⏵ bypass');
    expect(a.hash).not.toBe(b.hash);
    expect(readPane('user@host:~/p$ ').alive).toBe(false);
  });
});

describe('stuck WS handlers', () => {
  function ctx(withDetector = true) {
    const sent: Array<{ type: string; success: boolean; payload?: unknown; error?: string }> = [];
    const det = withDetector
      ? new StuckDetector({
          watcher: { on: () => undefined, getSessions: () => [], getMessages: () => [] },
          settings: new StuckSettingsStore(fs.mkdtempSync(path.join(os.tmpdir(), 'stuck-h-'))),
          tickMs: 0,
        })
      : null;
    const c = {
      stuck: det,
      send: (
        _ws: unknown,
        r: { type: string; success: boolean; payload?: unknown; error?: string }
      ) => sent.push(r),
      requireRemoteCapability: () => 'dispatch not allowed',
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { h: registerStuckHandlers(c as any), sent, det };
  }
  const client = { id: 'c1', ws: {} } as never;

  it('stuck_list / settings / snooze / bad requests answer with the same type', async () => {
    const { h, sent } = ctx();
    await h.stuck_list(client, {}, 'r1');
    expect(sent[0]).toMatchObject({
      type: 'stuck_list',
      success: true,
      payload: { findings: [], settings: { enabled: true } },
    });
    await h.stuck_set_settings(client, { settings: { noProgressMin: 45 } }, 'r2');
    expect(sent[1]).toMatchObject({ success: true, payload: { settings: { noProgressMin: 45 } } });
    await h.stuck_snooze(client, { sessionId: 'out4', minutes: 30 }, 'r3');
    expect(sent[2]).toMatchObject({ type: 'stuck_snooze', success: true });
    await h.stuck_snooze(client, { sessionId: 'out4', kind: 'nope' }, 'r4');
    expect(sent[3]).toMatchObject({ success: false, payload: { code: 'bad_request' } });
    await h.stuck_dismiss(client, { findingId: 'out4|loop|x' }, 'r5');
    expect(sent[4]).toMatchObject({ success: false, payload: { code: 'not_found' } });
    await h.stuck_interrupt(client, { sessionId: 'gone' }, 'r6');
    expect(sent[5]).toMatchObject({ success: false, payload: { code: 'unknown_session' } });
  });

  it('narrowed credentials need dispatch to ask or interrupt', async () => {
    const { h, sent } = ctx();
    await h.stuck_ask({ id: 'c', ws: {}, originCredential: {} } as never, { findingId: 'x' }, 'r');
    expect(sent[0]).toMatchObject({ success: false, payload: { code: 'bad_request' } });
  });

  it('no detector: unavailable', async () => {
    const { h, sent } = ctx(false);
    await h.stuck_list(client, {}, 'r');
    expect(sent[0]).toMatchObject({ success: false, payload: { code: 'unavailable' } });
  });
});
