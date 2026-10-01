import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HeraldService } from '../src/herald/service';
import { HeraldStore, sanitizeState } from '../src/herald/store';
import { resolveHeraldConfig } from '../src/herald/config';
import type { HeraldEvent } from '../src/herald/protocol';
import type { SessionSnapshot, SessionSource } from '../src/herald/session-source';
import { sanitizePronunciations, MAX_PRONUNCIATIONS } from '../src/herald/pronunciations';
import { normalizeSpokenVersions, recentVersions, versionsIn } from '../src/herald/voice/versions';
import { snap } from './herald-helpers';

describe('versionsIn / recentVersions', () => {
  it('finds semver-like and v-prefixed versions, without the v', () => {
    expect(versionsIn('Bumped to 2.0.7, tagged v2.28.0 and v3.1; Python 3.12 stays.')).toEqual(['2.0.7', '2.28.0', '3.1']);
    expect(versionsIn('release 1.4 is out, version 0.9 too')).toEqual(['1.4', '0.9']);
  });

  it('ignores decimals, IPs, paths and words with digits', () => {
    expect(versionsIn('93.5 percent at 192.168.1.17 in lib/2.0.7/x and build-2.0.7, a.1.2.3')).toEqual([]);
  });

  it('recentVersions: newest text first, distinct, bounded', () => {
    expect(recentVersions(['now on 2.0.7', 'was 2.0.6 then 2.0.7', '', 'v1.0.0'])).toEqual(['2.0.7', '2.0.6', '1.0.0']);
    const many = Array.from({ length: 20 }, (_, i) => `v1.${i}.0`);
    expect(recentVersions(many, 8)).toHaveLength(8);
  });
});

describe('normalizeSpokenVersions', () => {
  const known = ['2.0.7', '2.28.0', '1.4'];

  it.each([
    ['Is two point oh point seven out yet?', 'Is 2.0.7 out yet?'],
    ['Ship 2 point 0 point 7 to the phone', 'Ship 2.0.7 to the phone'],
    ['did two oh seven build', 'did 2.0.7 build'],
    ['bump it to 2 0 7', 'bump it to 2.0.7'],
    ['bump it to two-oh-seven', 'bump it to 2.0.7'],
    ['what about two or seven times', 'what about 2.0.7 times'],
    ['Is 2, 0.7 on the phone?', 'Is 2.0.7 on the phone?'],
    ['version two point twenty-eight is live', 'version 2.28.0 is live'],
    ['version two point twenty eight point oh is live', 'version 2.28.0 is live'],
    ['V2.28 shipped', 'V2.28.0 shipped'],
    ['release one point four', 'release 1.4'],
    ['the 2.07 build', 'the 2.0.7 build'],
  ])('%j -> %j', (heard, fixed) => {
    expect(normalizeSpokenVersions(heard, known)).toBe(fixed);
  });

  it.each([
    'Run two or three tests',
    'one or two things',
    'It took two point five seconds',
    'two seven',
    'I have 207 files',
    'Set the timeout to 2.5',
    'four point oh',
  ])('leaves %j alone (no known version spelled)', (heard) => {
    expect(normalizeSpokenVersions(heard, known)).toBe(heard);
  });

  it('already right, or nothing known: untouched', () => {
    expect(normalizeSpokenVersions('Is 2.0.7 out?', known)).toBe('Is 2.0.7 out?');
    expect(normalizeSpokenVersions('two point oh point seven', [])).toBe('two point oh point seven');
    expect(normalizeSpokenVersions('', known)).toBe('');
  });

  it('"or" counts only where a version has a zero and single-digit parts', () => {
    expect(normalizeSpokenVersions('one or two', ['1.2.3'])).toBe('one or two');
    expect(normalizeSpokenVersions('one or two', ['1.0.2'])).toBe('1.0.2');
    expect(normalizeSpokenVersions('twelve or two', ['12.0.2'])).toBe('twelve or two');
  });

  it('never cuts through a written number', () => {
    expect(normalizeSpokenVersions('2.0.7 is out', ['2.0'])).toBe('2.0.7 is out');
  });
});

describe('sanitizePronunciations (daemon)', () => {
  it('trims, bounds, drops junk and duplicates (last wins)', () => {
    expect(sanitizePronunciations([{ from: ' Out4 ', to: 'Out for' }, { from: 'out4', to: 'Out four' }, { from: '', to: 'x' }, 'x', null])).toEqual([
      { from: 'out4', to: 'Out four' },
    ]);
    expect(sanitizePronunciations('nope')).toEqual([]);
    expect(sanitizePronunciations(Array.from({ length: 80 }, (_, i) => ({ from: `w${i}`, to: 'y' })))).toHaveLength(MAX_PRONUNCIATIONS);
  });

  it('store sanitizeState keeps a clean list and drops a bad one', () => {
    const ok = sanitizeState({ version: 1, messages: [], heard: [], actions: [], pronunciations: [{ from: 'k8s', to: 'kates' }] }, 0);
    expect(ok.pronunciations).toEqual([{ from: 'k8s', to: 'kates' }]);
    const bad = sanitizeState({ version: 1, messages: [], heard: [], actions: [], pronunciations: 'x' }, 0);
    expect(bad.pronunciations).toBeUndefined();
  });
});

function fakeSource(sessions: SessionSnapshot[]): SessionSource {
  return {
    serverId: 'local',
    listSessions: jest.fn(async () => sessions),
    getRecentTranscript: jest.fn(async () => ({ lastUserPrompt: null, assistantTurns: [] })),
    getLiveChoice: jest.fn(async () => null),
    sessionExists: jest.fn(async () => true),
    sendText: jest.fn(async () => true),
    sendChoice: jest.fn(async () => true),
  } as unknown as SessionSource;
}

describe('HeraldService: pronunciations and STT hints', () => {
  let dir: string;
  const services: HeraldService[] = [];
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herald-hints-'));
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    for (const s of services.splice(0)) s.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  function make(sessions: SessionSnapshot[] = []) {
    const events: HeraldEvent[] = [];
    const config = { ...resolveHeraldConfig(undefined, {}), stateDir: dir };
    const svc = new HeraldService({
      config,
      provider: null,
      sources: [fakeSource(sessions)],
      store: new HeraldStore(dir, 5),
      broadcast: (e) => events.push(e),
      audit: () => {},
      pollIntervalMs: 60_000,
      toolbox: null,
    });
    services.push(svc);
    return { svc, events };
  }

  it('setPronunciations: cleaned, in state, broadcast once, persisted across a restart', async () => {
    const { svc, events } = make();
    await svc.start();
    expect(svc.getState().pronunciations).toEqual([]);
    const r = svc.setPronunciations([{ from: ' Kokoro ', to: 'ko-ko-ro' }, { from: '', to: 'x' }]);
    expect(r.pronunciations).toEqual([{ from: 'Kokoro', to: 'ko-ko-ro' }]);
    expect(svc.getState().pronunciations).toEqual([{ from: 'Kokoro', to: 'ko-ko-ro' }]);
    expect(events.filter((e) => e.kind === 'pronunciations')).toHaveLength(1);
    svc.setPronunciations([{ from: 'Kokoro', to: 'ko-ko-ro' }]); // unchanged: no event
    expect(events.filter((e) => e.kind === 'pronunciations')).toHaveLength(1);
    expect(() => svc.setPronunciations('nope')).toThrow(/array/);
    svc.shutdown();
    services.length = 0;
    const again = make();
    await again.svc.start();
    expect(again.svc.getState().pronunciations).toEqual([{ from: 'Kokoro', to: 'ko-ko-ro' }]);
  });

  it('sttHints: versions from session text and the user words join the vocabulary', async () => {
    const { svc } = make([
      snap({ sessionId: 'out4', sessionName: 'Out4', lastActivity: 9, lastTurnGist: 'Bumped the app to 2.0.7 and built the APK.' }),
      snap({ sessionId: 'docs', sessionName: 'Docs', lastActivity: 5, currentActivity: 'Tagging v2.28.0' }),
    ]);
    await svc.start();
    await svc.poll();
    svc.setPronunciations([{ from: 'k8s', to: 'kates' }]);
    const h = svc.sttHints();
    expect(h.versions).toEqual(['2.0.7', '2.28.0']);
    expect(h.prompt).toMatch(/Versions: 2\.0\.7, 2\.28\.0\./);
    expect(h.hotwords).toMatch(/2\.0\.7/);
    expect(h.prompt).toMatch(/k8s/);
    expect(h.prompt.length).toBeLessThanOrEqual(600);
  });

  it('sttHints without versions keeps the old shape', async () => {
    const { svc } = make([snap({ sessionId: 'x', sessionName: 'Out4' })]);
    await svc.start();
    await svc.poll();
    const h = svc.sttHints();
    expect(h.versions).toEqual([]);
    expect(h.prompt).not.toMatch(/Versions:/);
  });
});
