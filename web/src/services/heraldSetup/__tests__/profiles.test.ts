import { describe, expect, it, vi } from 'vitest';
import {
  applyProfileSettings,
  availableProfiles,
  environmentSuggestion,
  gradeEcho,
  profileSettings,
  suggestProfile,
  type ProfileTargets,
} from '../profiles';
import type { AudioEnvironment } from '../../voice/audioEnvironment';

const env = (output: AudioEnvironment['output'], input: AudioEnvironment['input'] = 'unknown', extra: Partial<AudioEnvironment> = {}): AudioEnvironment => ({
  output, input, aec: 'browser', ...extra,
});

describe('gradeEcho', () => {
  it('grades by ERLE; residual speech always fails; 0 dB means not measured', () => {
    expect(gradeEcho(null)).toBe('unmeasured');
    expect(gradeEcho({ erleDb: 0, residualSpeechDetected: false })).toBe('unmeasured');
    expect(gradeEcho({ erleDb: 32, residualSpeechDetected: false })).toBe('good');
    expect(gradeEcho({ erleDb: 20, residualSpeechDetected: false })).toBe('good');
    expect(gradeEcho({ erleDb: 14, residualSpeechDetected: false })).toBe('marginal');
    expect(gradeEcho({ erleDb: 6, residualSpeechDetected: false })).toBe('poor');
    expect(gradeEcho({ erleDb: 40, residualSpeechDetected: true })).toBe('poor');
    expect(gradeEcho({ erleDb: NaN, residualSpeechDetected: false })).toBe('unmeasured');
  });
});

describe('profileSettings', () => {
  it('headphones: interrupt on, hands-free left to the user, full replies optional', () => {
    const s = profileSettings('headphones', { echo: null });
    expect(s.input.interrupt).toBe(true);
    expect(s.input.handsFree).toBe('keep');
    expect(s.voice.spokenLength).toBe('short');
    expect(profileSettings('headphones', { echo: null, fullReplies: true }).voice.spokenLength).toBe('full');
    expect(s.gamingMode).toBe(false);
  });

  it('desk: interrupt only with a passing echo check; push-to-talk (hands-free off); short replies', () => {
    const unmeasured = profileSettings('desk', { echo: null });
    expect(unmeasured.input.interrupt).toBe(false);
    expect(unmeasured.input.handsFree).toBe('off');
    expect(unmeasured.voice.spokenLength).toBe('short');
    expect(unmeasured.notes[0]).toMatch(/until the echo check passes/);

    const good = profileSettings('desk', { echo: { erleDb: 28, residualSpeechDetected: false } });
    expect(good.input.interrupt).toBe(true);
    expect(good.input.sensitivity).toBe('low');

    const poor = profileSettings('desk', { echo: { erleDb: 25, residualSpeechDetected: true } });
    expect(poor.input.interrupt).toBe(false);
    expect(poor.notes[0]).toMatch(/Headphones fix that/);

    expect(profileSettings('desk', { echo: { erleDb: 12, residualSpeechDetected: false } }).input.interrupt).toBe(false);
  });

  it('gaming: tones only, no reminders, hotkey on, hands-free off, gaming flag', () => {
    const s = profileSettings('gaming', { echo: { erleDb: 40, residualSpeechDetected: false } });
    expect(s.voice.chimeOn).toBe(true);
    expect(s.voice.remind).toBe(false);
    expect(s.voice.spokenLength).toBe('short');
    expect(s.input.interrupt).toBe(false);
    expect(s.input.handsFree).toBe('off');
    expect(s.input.spaceToTalk).toBe(false);
    expect(s.native.globalShortcuts).toBe(true);
    expect(s.gamingMode).toBe(true);
  });

  it('phone: earbud button, ducking, phone mic, brief replies, interrupt on', () => {
    const s = profileSettings('phone', { echo: null });
    expect(s.native.earbudButton).toBe(true);
    expect(s.native.duckOthers).toBe(true);
    expect(s.micPreference).toBe('builtin');
    expect(s.voice.spokenLength).toBe('short');
    expect(s.input.interrupt).toBe(true);
  });

  it("phone turns the built-in-mic-with-Bluetooth setting back on; 'auto' leaves it alone", () => {
    const off = targets({ builtInMicWithBluetooth: false }, 'android');
    applyProfileSettings(profileSettings('phone', { echo: null }), off);
    expect(off.input.setPref).toHaveBeenCalledWith('builtInMicWithBluetooth', true);
    const desk = targets({ builtInMicWithBluetooth: false });
    applyProfileSettings(profileSettings('desk', { echo: null }), desk);
    expect(desk.input.setPref).not.toHaveBeenCalledWith('builtInMicWithBluetooth', expect.anything());
  });
});

function targets(over: Partial<ProfileTargets['current']> = {}, platform: ProfileTargets['platform'] = 'desktop') {
  const t = {
    voice: { setVoiceOn: vi.fn(), setChimeOn: vi.fn(), setRemind: vi.fn(), setSpokenLength: vi.fn() },
    input: { setPref: vi.fn(), setHandsFree: vi.fn() },
    native: { setPref: vi.fn() },
    current: {
      voiceOn: true, chimeOn: true, remind: true, spokenLength: 'short' as const,
      interrupt: false, interruptExplicit: false, sensitivity: 'normal' as const,
      reviewBeforeSend: false, spaceToTalk: true, handsFree: false,
      globalShortcuts: true, earbudButton: true, duckOthers: true,
      ...over,
    },
    platform,
  };
  return t;
}

describe('applyProfileSettings', () => {
  it('sets only what differs, and always makes interrupt explicit', () => {
    const t = targets({ interrupt: true, interruptExplicit: false });
    applyProfileSettings(profileSettings('headphones', { echo: null }), t);
    expect(t.input.setPref).toHaveBeenCalledWith('interrupt', true);
    expect(t.voice.setChimeOn).not.toHaveBeenCalled(); // unchanged: no test tone
    expect(t.voice.setVoiceOn).not.toHaveBeenCalled();
    expect(t.input.setHandsFree).not.toHaveBeenCalled(); // headphones never turns hands-free on or off
  });

  it('gaming from hands-free on a desktop app: hands-free off, reminders off, no Space to talk', () => {
    const t = targets({ handsFree: true, interrupt: true, interruptExplicit: true, globalShortcuts: false });
    applyProfileSettings(profileSettings('gaming', { echo: null }), t);
    expect(t.input.setHandsFree).toHaveBeenCalledWith(false);
    expect(t.voice.setRemind).toHaveBeenCalledWith(false);
    expect(t.input.setPref).toHaveBeenCalledWith('interrupt', false);
    expect(t.input.setPref).toHaveBeenCalledWith('spaceToTalk', false);
    expect(t.native.setPref).toHaveBeenCalledWith('globalShortcuts', true);
  });

  it('native prefs only on their platform', () => {
    const browser = targets({ globalShortcuts: false, earbudButton: false }, 'browser');
    applyProfileSettings(profileSettings('gaming', { echo: null }), browser);
    expect(browser.native.setPref).not.toHaveBeenCalled();

    const phone = targets({ earbudButton: false, duckOthers: false }, 'android');
    applyProfileSettings(profileSettings('phone', { echo: null }), phone);
    expect(phone.native.setPref).toHaveBeenCalledWith('earbudButton', true);
    expect(phone.native.setPref).toHaveBeenCalledWith('duckOthers', true);
    expect(phone.native.setPref).not.toHaveBeenCalledWith('globalShortcuts', expect.anything());
  });

  it('full replies option on headphones sets the spoken length', () => {
    const t = targets();
    applyProfileSettings(profileSettings('headphones', { echo: null, fullReplies: true }), t);
    expect(t.voice.setSpokenLength).toHaveBeenCalledWith('full');
  });
});

describe('follow-up window per profile', () => {
  it('on for Headphones and Phone + earbuds, off for Gaming and Desk speakers', () => {
    expect(profileSettings('headphones', { echo: null }).input.followUp).toBe(true);
    expect(profileSettings('phone', { echo: null }).input.followUp).toBe(true);
    expect(profileSettings('gaming', { echo: null }).input.followUp).toBe(false);
    expect(profileSettings('desk', { echo: { erleDb: 30, residualSpeechDetected: false } }).input.followUp).toBe(false);
  });

  it('applying a profile makes the choice explicit (automatic -> on/off), and leaves a matching value alone', () => {
    const auto = targets({ followUp: null });
    applyProfileSettings(profileSettings('gaming', { echo: null }), auto);
    expect(auto.input.setPref).toHaveBeenCalledWith('followUp', false);
    const on = targets({ followUp: true });
    applyProfileSettings(profileSettings('headphones', { echo: null }), on);
    expect(on.input.setPref).not.toHaveBeenCalledWith('followUp', expect.anything());
    const was = targets({ followUp: true });
    applyProfileSettings(profileSettings('desk', { echo: null }), was);
    expect(was.input.setPref).toHaveBeenCalledWith('followUp', false);
  });
});

describe('availableProfiles', () => {
  it('phones and tablets get Phone; computers get Gaming', () => {
    expect(availableProfiles('android')).toEqual(['phone', 'headphones', 'desk']);
    expect(availableProfiles('ios')).toContain('phone');
    expect(availableProfiles('desktop')).toEqual(['headphones', 'desk', 'gaming']);
    expect(availableProfiles('browser', true)).toContain('phone');
  });
});

describe('suggestProfile / environmentSuggestion', () => {
  it('maps outputs to profiles, keeping Gaming across headset changes', () => {
    expect(suggestProfile(env('headphones'), 'desktop', 'desk')).toBe('headphones');
    expect(suggestProfile(env('bluetooth-headphones'), 'android', null)).toBe('phone');
    expect(suggestProfile(env('speakers'), 'desktop', 'headphones')).toBe('desk');
    expect(suggestProfile(env('headphones'), 'desktop', 'gaming')).toBe('gaming');
    expect(suggestProfile(env('speakers'), 'browser', 'gaming')).toBe('gaming');
    expect(suggestProfile(env('unknown'), 'desktop', 'desk')).toBeNull();
  });

  it('suggests on a change only, never on the first reading', () => {
    const base = { current: 'desk' as const, platform: 'desktop' as const, dismissed: [] };
    expect(environmentSuggestion({ ...base, prev: null, next: env('headphones') })).toBeNull();
    const s = environmentSuggestion({ ...base, prev: env('speakers'), next: env('headphones', 'headset', { outputLabel: 'AirPods Pro' }) });
    expect(s?.profile).toBe('headphones');
    expect(s?.message).toBe('AirPods Pro connected. Switch to the Headphones profile?');
    // Same environment again: nothing.
    expect(environmentSuggestion({ ...base, prev: env('headphones'), next: env('headphones') })).toBeNull();
  });

  it('no suggestion when it already matches, cannot tell, or was dismissed', () => {
    expect(environmentSuggestion({ prev: env('speakers'), next: env('headphones'), current: 'headphones', platform: 'desktop', dismissed: [] })).toBeNull();
    expect(environmentSuggestion({ prev: env('speakers'), next: env('unknown'), current: 'desk', platform: 'desktop', dismissed: [] })).toBeNull();
    const first = environmentSuggestion({ prev: env('speakers'), next: env('headphones'), current: 'desk', platform: 'desktop', dismissed: [] })!;
    expect(environmentSuggestion({ prev: env('speakers'), next: env('headphones'), current: 'desk', platform: 'desktop', dismissed: [first.key] })).toBeNull();
  });

  it('unplugging headphones suggests Desk speakers', () => {
    const s = environmentSuggestion({ prev: env('headphones'), next: env('speakers'), current: 'headphones', platform: 'desktop', dismissed: [] });
    expect(s?.profile).toBe('desk');
    expect(s?.message).toBe('Playing through speakers. Switch to the Desk speakers profile?');
  });
});
