/**
 * "Interrupt by talking" is only safe when Herald cannot hear itself. Through
 * speakers, its own voice reaches the mic (WKWebView, and sometimes WebView2,
 * do not cancel our WebAudio playback), so the default is OFF unless headphones
 * are confirmed. An explicit choice by the user always wins.
 *
 * Pure helpers; the hook feeds them `navigator.mediaDevices.enumerateDevices()`
 * (and native route info). Measured echo (audioEnvironment.ts) beats both.
 */

import { classifyInputLabel, classifyOutput, resolveDefault, type DeviceLike, type NativeAudioRoute } from './audioDevices';

export { looksLikeHeadphones, type DeviceLike } from './audioDevices';

/**
 * True: the output in use (or the default mic, which follows a headset) is a
 * headphone / headset. False: the output in use is known and is not.
 * Null: cannot tell (no labels before mic permission, Safari lists no outputs,
 * a macOS "External Headphones" jack that may well be desk speakers).
 * Native route info (iOS / Android / macOS), when present, beats labels.
 */
export function detectHeadphones(devices: DeviceLike[], route: NativeAudioRoute | null = null): boolean | null {
  const out = classifyOutput(devices, route);
  if (out.kind === 'headphones' || out.kind === 'bluetooth-headphones') return true;
  const input = classifyInputLabel(resolveDefault(devices, 'audioinput')?.label);
  if (input === 'headset' || input === 'bluetooth-headset') return true;
  if (out.kind === 'speakers') return false;
  return null;
}

/**
 * The effective interrupt setting. `explicit`: the user's own choice (always
 * wins). `legacy`: a value saved by an older build that auto-saved the old
 * default ON: honoured in the browser (do not break existing users) but not in
 * the native desktop app, where it made Herald talk to itself.
 */
export function interruptDefault(opts: {
  explicit?: boolean;
  legacy?: boolean;
  nativeDesktop: boolean;
  headphones: boolean | null;
}): boolean {
  if (typeof opts.explicit === 'boolean') return opts.explicit;
  if (typeof opts.legacy === 'boolean' && !opts.nativeDesktop) return opts.legacy;
  return opts.headphones === true;
}
