/**
 * Setup profiles: one named choice per device that sets the many voice knobs
 * at once. Everything here is pure (no React, no storage), so the mapping is
 * unit tested; `useHeraldSetup` applies it through the existing setters.
 *
 *   headphones  Herald cannot hear itself: interrupt on, hands-free allowed.
 *   desk        Speakers: interrupt only when the echo check passed; push-to-talk; short replies.
 *   gaming      Tones only, hotkey / mouse trigger, hands-free off (Discord), short replies.
 *   phone       Earbuds: earbud button, brief replies, ducking, phone mic.
 *
 * Reply length on the hub (`verbosity`) is shared by every device, so profiles
 * never touch it; they set this device's spoken length, and voice turns are
 * already brief under the default `auto`.
 */
import type { AudioEnvironment } from '../voice/audioEnvironment';
import type { NativePlatform } from '../../utils/platform';

export type ProfileId = 'headphones' | 'desk' | 'gaming' | 'phone';

export const PROFILE_IDS: readonly ProfileId[] = ['headphones', 'desk', 'gaming', 'phone'];

export function isProfileId(v: unknown): v is ProfileId {
  return typeof v === 'string' && (PROFILE_IDS as readonly string[]).includes(v);
}

export interface ProfileInfo {
  id: ProfileId;
  name: string;
  /** One line under the name in pickers. */
  tagline: string;
  /** What it does, in the order a user cares about. */
  bullets: string[];
}

export const PROFILES: Record<ProfileId, ProfileInfo> = {
  headphones: {
    id: 'headphones',
    name: 'Headphones',
    tagline: 'Talk over Herald any time. Hands-free works well.',
    bullets: ['Interrupt by talking', 'Hands-free "Hey Jarvis" allowed', 'Short spoken replies (full replies optional)'],
  },
  desk: {
    id: 'desk',
    name: 'Desk speakers',
    tagline: 'Speakers and a desk mic. Push-to-talk, no self-echo.',
    bullets: ['Hold to talk', 'Interrupt only if the echo check passes', 'Short spoken replies'],
  },
  gaming: {
    id: 'gaming',
    name: 'Gaming',
    tagline: 'Headset and Discord. Tones only, one button to talk.',
    bullets: ['Tones for news, nothing spoken unasked', 'Hotkey or mouse button to talk', 'Hands-free off (Discord hears your mic)', 'Short spoken replies'],
  },
  phone: {
    id: 'phone',
    name: 'Phone + earbuds',
    tagline: 'Tap an earbud to talk. Music ducks while Herald speaks.',
    bullets: ['Earbud tap talks to Herald', 'Brief spoken replies', 'Other audio ducks', 'Phone mic for clearer speech'],
  },
};

/** Profiles that make sense on this build. Phone is for phones and tablets; gaming for computers. */
export function availableProfiles(platform: NativePlatform, mobileBrowser = false): ProfileId[] {
  if (platform === 'android' || platform === 'ios' || mobileBrowser) return ['phone', 'headphones', 'desk'];
  return ['headphones', 'desk', 'gaming'];
}

// ---------------------------------------------------------------------------
// Echo check

export interface EchoCheck {
  erleDb: number;
  residualSpeechDetected: boolean;
  /** When it was measured (epoch ms). */
  at: number;
}

export type EchoGrade = 'good' | 'marginal' | 'poor' | 'unmeasured';

/** Echo return loss enhancement needed before talking over Herald is safe. */
export const ERLE_GOOD_DB = 20;
export const ERLE_MARGINAL_DB = 10;

/**
 * Grade an echo measurement. Residual speech always fails: Whisper would hear
 * words. A 0 dB result with no residual means nothing was measured (no audio
 * path yet), which is neither a pass nor a fail.
 */
export function gradeEcho(r: Pick<EchoCheck, 'erleDb' | 'residualSpeechDetected'> | null): EchoGrade {
  if (!r || !Number.isFinite(r.erleDb)) return 'unmeasured';
  if (r.residualSpeechDetected) return 'poor';
  if (r.erleDb <= 0) return 'unmeasured';
  if (r.erleDb >= ERLE_GOOD_DB) return 'good';
  if (r.erleDb >= ERLE_MARGINAL_DB) return 'marginal';
  return 'poor';
}

// ---------------------------------------------------------------------------
// Settings mapping

export interface ProfileSettings {
  voice: {
    voiceOn: boolean;
    chimeOn: boolean;
    /** Replay the tone for an unheard block. */
    remind: boolean;
    spokenLength: 'short' | 'full';
  };
  input: {
    interrupt: boolean;
    sensitivity: 'low' | 'normal' | 'high';
    reviewBeforeSend: boolean;
    spaceToTalk: boolean;
    /** 'off' turns hands-free off; 'keep' leaves the user's choice (turning it ON needs a click for the mic prompt). */
    handsFree: 'off' | 'keep';
  };
  native: {
    globalShortcuts: boolean;
    earbudButton: boolean;
    /** Duck other audio while Herald speaks (mobile). */
    duckOthers: boolean;
  };
  /** Other features read this: no proactive speech, no bring-to-front, no overlay unless opted in. */
  gamingMode: boolean;
  /**
   * Mic hint for the audio layer: the phone's own mic avoids the Bluetooth
   * call-quality profile. 'builtin' turns on the voice-input setting "Use
   * built-in mic with Bluetooth headphones" (`builtInMicWithBluetooth`, on by
   * default); 'auto' leaves the user's choice alone.
   */
  micPreference: 'auto' | 'builtin';
  /** Plain-language notes about choices the profile made (shown after applying). */
  notes: string[];
}

export interface ProfileContext {
  /** Last echo check on this device. */
  echo: Pick<EchoCheck, 'erleDb' | 'residualSpeechDetected'> | null;
  /** Headphones: read whole replies aloud. */
  fullReplies?: boolean;
}

export function profileSettings(id: ProfileId, ctx: ProfileContext): ProfileSettings {
  const base: ProfileSettings = {
    voice: { voiceOn: true, chimeOn: true, remind: true, spokenLength: 'short' },
    input: { interrupt: false, sensitivity: 'normal', reviewBeforeSend: false, spaceToTalk: true, handsFree: 'keep' },
    native: { globalShortcuts: true, earbudButton: true, duckOthers: true },
    gamingMode: false,
    micPreference: 'auto',
    notes: [],
  };
  switch (id) {
    case 'headphones':
      return {
        ...base,
        voice: { ...base.voice, spokenLength: ctx.fullReplies ? 'full' : 'short' },
        input: { ...base.input, interrupt: true },
      };
    case 'desk': {
      const grade = gradeEcho(ctx.echo);
      const interrupt = grade === 'good';
      const notes = interrupt
        ? ['Echo check passed: you can talk over Herald.']
        : grade === 'unmeasured'
          ? ['Interrupt is off until the echo check passes (Device check).']
          : ['Interrupt is off: Herald can hear itself through these speakers. Headphones fix that.'];
      return {
        ...base,
        // A noisy desk (fans, keyboard) should not cut Herald off.
        input: { ...base.input, interrupt, sensitivity: interrupt ? 'low' : 'normal', handsFree: 'off' },
        notes,
      };
    }
    case 'gaming':
      return {
        ...base,
        voice: { ...base.voice, remind: false, spokenLength: 'short' },
        // Discord hears the same mic, and teammates talking must never cut Herald off.
        input: { ...base.input, interrupt: false, spaceToTalk: false, handsFree: 'off' },
        native: { ...base.native, globalShortcuts: true },
        gamingMode: true,
        notes: ['Hands-free is off so Discord calls never wake Herald. Use the hotkey or mouse button.'],
      };
    case 'phone':
      return {
        ...base,
        voice: { ...base.voice, spokenLength: 'short' },
        input: { ...base.input, interrupt: true, spaceToTalk: false },
        native: { ...base.native, earbudButton: true, duckOthers: true },
        micPreference: 'builtin',
      };
  }
}

/** The setters a profile is applied through (the existing hooks' own). */
export interface ProfileTargets {
  voice: {
    setVoiceOn: (on: boolean) => void;
    setChimeOn: (on: boolean) => void;
    setRemind: (on: boolean) => void;
    setSpokenLength: (v: 'short' | 'full') => void;
  };
  input: {
    setPref: (key: 'interrupt' | 'sensitivity' | 'reviewBeforeSend' | 'spaceToTalk' | 'builtInMicWithBluetooth', value: boolean | 'low' | 'normal' | 'high') => void;
    setHandsFree: (on: boolean) => void;
  };
  native: {
    setPref: (key: 'globalShortcuts' | 'earbudButton' | 'duckOthers', value: boolean) => void;
  };
  /** Current values: unchanged ones are not re-set (no tone for an unchanged chime, etc.). */
  current: {
    voiceOn: boolean;
    chimeOn: boolean;
    remind: boolean;
    spokenLength: 'short' | 'full';
    interrupt: boolean;
    interruptExplicit: boolean;
    sensitivity: 'low' | 'normal' | 'high';
    reviewBeforeSend: boolean;
    spaceToTalk: boolean;
    handsFree: boolean;
    globalShortcuts: boolean;
    earbudButton: boolean;
    duckOthers: boolean;
    /** Voice-input setting behind `micPreference` (absent: treated as on, its default). */
    builtInMicWithBluetooth?: boolean;
  };
  platform: NativePlatform;
}

/** Apply a profile's settings. Only values that differ are set. */
export function applyProfileSettings(s: ProfileSettings, t: ProfileTargets): void {
  const c = t.current;
  if (c.voiceOn !== s.voice.voiceOn) t.voice.setVoiceOn(s.voice.voiceOn);
  if (c.chimeOn !== s.voice.chimeOn) t.voice.setChimeOn(s.voice.chimeOn);
  if (c.remind !== s.voice.remind) t.voice.setRemind(s.voice.remind);
  if (c.spokenLength !== s.voice.spokenLength) t.voice.setSpokenLength(s.voice.spokenLength);
  // Interrupt is always made explicit, so it no longer follows the old headphone guess.
  if (c.interrupt !== s.input.interrupt || !c.interruptExplicit) t.input.setPref('interrupt', s.input.interrupt);
  if (c.sensitivity !== s.input.sensitivity) t.input.setPref('sensitivity', s.input.sensitivity);
  if (c.reviewBeforeSend !== s.input.reviewBeforeSend) t.input.setPref('reviewBeforeSend', s.input.reviewBeforeSend);
  if (c.spaceToTalk !== s.input.spaceToTalk) t.input.setPref('spaceToTalk', s.input.spaceToTalk);
  if (s.input.handsFree === 'off' && c.handsFree) t.input.setHandsFree(false);
  if (s.micPreference === 'builtin' && c.builtInMicWithBluetooth === false) t.input.setPref('builtInMicWithBluetooth', true);
  if (t.platform === 'desktop' && c.globalShortcuts !== s.native.globalShortcuts) {
    t.native.setPref('globalShortcuts', s.native.globalShortcuts);
  }
  if (t.platform === 'android' || t.platform === 'ios') {
    if (c.earbudButton !== s.native.earbudButton) t.native.setPref('earbudButton', s.native.earbudButton);
    if (c.duckOthers !== s.native.duckOthers) t.native.setPref('duckOthers', s.native.duckOthers);
  }
}

// ---------------------------------------------------------------------------
// Environment -> suggestion

const isHeadphoneOut = (env: AudioEnvironment) => env.output === 'headphones' || env.output === 'bluetooth-headphones';

/** The profile that fits what is plugged in, or null when it cannot tell. */
export function suggestProfile(env: AudioEnvironment, platform: NativePlatform, current: ProfileId | null, mobileBrowser = false): ProfileId | null {
  const mobile = platform === 'android' || platform === 'ios' || mobileBrowser;
  if (isHeadphoneOut(env)) {
    if (mobile) return 'phone';
    // A gaming headset is still gaming: plugging it in must not undo the profile.
    return current === 'gaming' ? 'gaming' : 'headphones';
  }
  if (env.output === 'speakers') {
    // Gaming is already speaker-safe (no interrupt, no hands-free).
    if (current === 'gaming') return 'gaming';
    return 'desk';
  }
  return null;
}

/** Identity of an environment for "changed?" and "dismissed" checks. */
export function envKey(env: AudioEnvironment): string {
  return `${env.output}/${env.input}`;
}

export interface EnvSuggestion {
  profile: ProfileId;
  /** "Headphones connected: switch to the Headphones profile?" */
  message: string;
  /** Remembered when dismissed, so the same change is not suggested again. */
  key: string;
}

function changeLabel(env: AudioEnvironment): string {
  switch (env.output) {
    case 'bluetooth-headphones': return env.outputLabel ? `${env.outputLabel} connected` : 'Bluetooth headphones connected';
    case 'headphones': return env.outputLabel ? `${env.outputLabel} connected` : 'Headphones connected';
    case 'speakers': return 'Playing through speakers';
    default: return 'Audio changed';
  }
}

/**
 * A profile switch worth suggesting after the audio environment changed.
 * Null on the first reading (no change yet), when it already matches, when it
 * cannot tell, or when the user said no to this exact change before.
 */
export function environmentSuggestion(opts: {
  prev: AudioEnvironment | null;
  next: AudioEnvironment;
  current: ProfileId | null;
  platform: NativePlatform;
  dismissed: readonly string[];
  mobileBrowser?: boolean;
}): EnvSuggestion | null {
  const { prev, next, current, platform, dismissed } = opts;
  if (!prev || envKey(prev) === envKey(next)) return null;
  const profile = suggestProfile(next, platform, current, opts.mobileBrowser);
  if (!profile || profile === current) return null;
  const key = `${envKey(next)}>${profile}`;
  if (dismissed.includes(key)) return null;
  return { profile, key, message: `${changeLabel(next)}. Switch to the ${PROFILES[profile].name} profile?` };
}
