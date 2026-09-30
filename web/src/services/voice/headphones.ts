/**
 * "Interrupt by talking" is only safe when Herald cannot hear itself. Through
 * speakers, its own voice reaches the mic (WKWebView, and sometimes WebView2,
 * do not cancel our WebAudio playback), so the default is OFF unless headphones
 * are confirmed. An explicit choice by the user always wins.
 *
 * Pure helpers; the hook feeds them `navigator.mediaDevices.enumerateDevices()`.
 */

export interface DeviceLike {
  kind: string;
  label: string;
  deviceId: string;
}

const HEADPHONE_RE = /head\s?phone|headset|ear\s?phone|ear\s?bud|airpods|\bbuds\b|galaxy buds|pixel buds|hands-?free|bose qc|wh-1000|wf-1000|jabra/i;

export function looksLikeHeadphones(label: string): boolean {
  return HEADPHONE_RE.test(label);
}

/**
 * True: the output in use (or the default mic, which follows a headset) is a
 * headphone / headset. False: the output in use is known and is not.
 * Null: cannot tell (no labels before mic permission, Safari lists no outputs).
 */
export function detectHeadphones(devices: DeviceLike[]): boolean | null {
  const outputs = devices.filter((d) => d.kind === 'audiooutput' && d.label);
  const inputs = devices.filter((d) => d.kind === 'audioinput' && d.label);
  const defaultOut = outputs.find((d) => d.deviceId === 'default') ?? outputs[0];
  const defaultIn = inputs.find((d) => d.deviceId === 'default') ?? inputs[0];
  if (defaultOut && looksLikeHeadphones(defaultOut.label)) return true;
  if (defaultIn && looksLikeHeadphones(defaultIn.label)) return true;
  if (defaultOut) return false;
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
