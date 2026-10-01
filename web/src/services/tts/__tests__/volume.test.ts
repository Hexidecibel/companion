import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_VOLUME,
  VOLUME_MAX,
  busGains,
  clampVolume,
  heraldVolumeStore,
  matchVolumePhrase,
  parseSpokenNumber,
  parseVolume,
  stepVolume,
  volumePercent,
  webSpeechVolume,
} from '../volume';
import { matchVolumeCommand } from '../../voice/voiceCommands';
import { routeVoiceTranscript, type VoiceCommandActions } from '../../voice/voiceCommandRouter';

describe('volume math', () => {
  it('clamps to 0..150 % and rounds', () => {
    expect(clampVolume(2)).toBe(1.5);
    expect(clampVolume(-1)).toBe(0);
    expect(clampVolume(0.854)).toBe(0.85);
    expect(clampVolume(Number.NaN)).toBe(1);
    expect(volumePercent(1.15)).toBe(115);
  });

  it('steps by 15 %, stops at the limits, never steps down to silence', () => {
    expect(stepVolume(1, 1)).toBe(1.15);
    expect(stepVolume(1, -1)).toBe(0.85);
    expect(stepVolume(1.45, 1)).toBe(1.5);
    expect(stepVolume(1.5, 1)).toBeNull();
    let v = 1;
    const seen: number[] = [];
    for (let i = 0; i < 12; i++) {
      const n = stepVolume(v, -1);
      if (n === null) break;
      seen.push(n);
      v = n;
    }
    expect(seen).toEqual([0.85, 0.7, 0.55, 0.4, 0.25, 0.1]);
    expect(stepVolume(0.1, -1)).toBeNull();
    // Below the floor (set by "volume 5"): quieter does nothing, louder works.
    expect(stepVolume(0.05, -1)).toBeNull();
    expect(stepVolume(0, 1)).toBe(0.15);
  });

  it('bus gains: the voice gain is the volume; tones follow the voice by default', () => {
    expect(busGains(DEFAULT_VOLUME)).toEqual({ voice: 1, tones: 1 });
    expect(busGains({ voice: 0.8, tones: 1, tonesFollowVoice: true })).toEqual({ voice: 0.8, tones: 0.8 });
    expect(busGains({ voice: 1.5, tones: 0.5, tonesFollowVoice: true })).toEqual({ voice: 1.5, tones: 0.75 });
    expect(busGains({ voice: 0.8, tones: 0.6, tonesFollowVoice: false })).toEqual({ voice: 0.8, tones: 0.6 });
  });

  it('Web Speech cannot boost', () => {
    expect(webSpeechVolume({ ...DEFAULT_VOLUME, voice: 1.4 })).toBe(1);
    expect(webSpeechVolume({ ...DEFAULT_VOLUME, voice: 0.6 })).toBe(0.6);
  });

  it('parses stored values defensively', () => {
    expect(parseVolume(null)).toEqual(DEFAULT_VOLUME);
    expect(parseVolume('nope')).toEqual(DEFAULT_VOLUME);
    expect(parseVolume(JSON.stringify({ voice: 9, tones: 'x', tonesFollowVoice: false }))).toEqual({ voice: VOLUME_MAX, tones: 1, tonesFollowVoice: false });
  });
});

describe('volume store', () => {
  beforeEach(() => {
    localStorage.clear();
    heraldVolumeStore.reset();
  });

  it('persists per device and notifies', () => {
    const l = vi.fn();
    heraldVolumeStore.subscribe(l);
    heraldVolumeStore.setVoice(0.8);
    expect(heraldVolumeStore.get().voice).toBe(0.8);
    expect(JSON.parse(localStorage.getItem('herald_volume')!)).toMatchObject({ voice: 0.8 });
    expect(l).toHaveBeenCalledTimes(1);
    heraldVolumeStore.setVoice(0.8); // unchanged: no event
    expect(l).toHaveBeenCalledTimes(1);
    heraldVolumeStore.reset();
    expect(heraldVolumeStore.get().voice).toBe(0.8);
  });

  it('works when storage throws', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    heraldVolumeStore.setVoice(1.2);
    expect(heraldVolumeStore.get().voice).toBe(1.2);
    spy.mockRestore();
  });
});

describe('volume voice commands', () => {
  it.each([
    ['Louder.', { kind: 'step', dir: 1 }],
    ['louder please', { kind: 'step', dir: 1 }],
    ['Volume up', { kind: 'step', dir: 1 }],
    ['Hey Jarvis, turn it up.', { kind: 'step', dir: 1 }],
    ['Quieter', { kind: 'step', dir: -1 }],
    ['Softer.', { kind: 'step', dir: -1 }],
    ['Volume down.', { kind: 'step', dir: -1 }],
    ['Herald, a bit quieter', { kind: 'step', dir: -1 }],
    ['Volume 50.', { kind: 'set', value: 0.5 }],
    ['Volume 50%', { kind: 'set', value: 0.5 }],
    ['volume fifty', { kind: 'set', value: 0.5 }],
    ['Set the volume to 80 percent', { kind: 'set', value: 0.8 }],
    ['volume one hundred and twenty', { kind: 'set', value: 1.2 }],
    ['Volume 150', { kind: 'set', value: 1.5 }],
    ['Max volume', { kind: 'set', value: 1.5 }],
    ['Normal volume', { kind: 'set', value: 1 }],
  ])('%s', (text, cmd) => {
    expect(matchVolumeCommand(text)).toEqual(cmd);
  });

  it.each([
    'turn up the logging',
    'turn up the log level on Out4',
    "what's the volume on the build",
    'volume 500',
    'volume of the logs is too high',
    'louder than the build server',
    'quiet', // that is STOP
    'stop',
    'the deploy is louder than expected',
  ])('not a volume command: %s', (text) => {
    expect(matchVolumeCommand(text)).toBeNull();
  });

  it('spoken numbers', () => {
    expect(parseSpokenNumber(['eighty', 'five'])).toBe(85);
    expect(parseSpokenNumber(['a', 'hundred'])).toBe(100);
    expect(parseSpokenNumber(['70'])).toBe(70);
    expect(parseSpokenNumber(['loud'])).toBeNull();
    expect(matchVolumePhrase('volume')).toBeNull();
  });

  function actions(over: Partial<VoiceCommandActions> = {}): VoiceCommandActions {
    return {
      stop: vi.fn(), repeat: vi.fn(() => true), goOn: vi.fn(() => true), stepRate: vi.fn(), expectBriefing: vi.fn(),
      sendIntent: vi.fn(), undo: vi.fn(), notice: vi.fn(), volume: vi.fn(), ...over,
    };
  }

  it('the router runs volume locally and never sends it to the brain', () => {
    const a = actions();
    expect(routeVoiceTranscript('Louder.', a)).toEqual({ command: 'volume', send: null });
    expect(a.volume).toHaveBeenCalledWith({ kind: 'step', dir: 1 });
    expect(routeVoiceTranscript('volume 50', a)).toEqual({ command: 'volume', send: null });
    expect(a.volume).toHaveBeenLastCalledWith({ kind: 'set', value: 0.5 });
  });

  it('"turn up the logging" goes to the brain untouched', () => {
    const a = actions();
    expect(routeVoiceTranscript('Turn up the logging', a)).toEqual({ command: null, send: 'Turn up the logging' });
    expect(a.volume).not.toHaveBeenCalled();
    expect(a.sendIntent).not.toHaveBeenCalled();
  });

  it('"quiet" is still STOP', () => {
    const a = actions();
    expect(routeVoiceTranscript('Quiet!', a).command).toBe('stop');
    expect(a.stop).toHaveBeenCalled();
    expect(a.volume).not.toHaveBeenCalled();
  });
});
