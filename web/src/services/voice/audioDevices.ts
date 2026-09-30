/**
 * What is Herald playing through and listening with? Pure classification of
 * device labels (from enumerateDevices, available after mic permission) and
 * native route info (iOS / Android / macOS / Linux), plus the microphone choice
 * that avoids the Bluetooth trap.
 *
 * The Bluetooth trap: opening a Bluetooth headset's microphone switches it from
 * A2DP (stereo, full quality) to HFP/SCO (a phone call: mono, narrowband), so
 * music and Herald's own voice turn to mush for as long as the mic is open.
 * With another microphone available (built-in, USB, webcam) we use that one.
 *
 * Labels lie in known ways, and each one here is a real-world failure:
 * - macOS names whatever is in the 3.5 mm jack "External Headphones", speakers
 *   included (a Mac mini with desk speakers): that is NOT evidence of headphones.
 * - Chrome prefixes the OS default with "Default - " / "Communications - ".
 * - Windows exposes a Bluetooth headset twice: "Headphones (X Stereo)" (A2DP) and
 *   "Headset (X Hands-Free AG Audio)" (HFP). The HFP one is the trap.
 * - Virtual devices (Discord, VB-Cable, Voicemeeter, BlackHole) say nothing
 *   about the real output.
 */
import type { InputKind, OutputKind } from './audioEnvironment';

export interface DeviceLike {
  kind: string;
  label: string;
  deviceId: string;
  groupId?: string;
}

// ---- native route (from tauri-plugin-herald-native) ------------------------

export type PortType =
  | 'builtin-speaker'
  | 'builtin-receiver'
  | 'builtin-mic'
  | 'wired-headphones'
  | 'wired-headset'
  /** A 3.5 mm jack that cannot tell headphones from speakers (macOS "External Headphones"). */
  | 'jack'
  | 'bluetooth'
  | 'usb'
  | 'hdmi'
  | 'airplay'
  | 'virtual'
  | 'unknown';

export interface NativePort {
  type: PortType;
  name: string;
  /** Bluetooth profile when known: a2dp (music), hfp (call), le (LE audio). */
  profile?: 'a2dp' | 'hfp' | 'le';
  id?: string;
}

export interface NativeAudioRoute {
  platform: 'ios' | 'android' | 'macos' | 'linux' | 'windows';
  /** Current output(s), first = primary. */
  outputs: NativePort[];
  /** Current input(s), first = primary. */
  inputs: NativePort[];
  /** Inputs that could be used (iOS availableInputs, Android input devices). */
  availableInputs?: NativePort[];
}

// ---- labels -----------------------------------------------------------------

/** Chrome's pseudo-device prefixes. */
export function cleanLabel(label: string): string {
  return label.replace(/^(default|communications)\s*-\s*/i, '').trim();
}

const BT_BRAND_RE = /airpods|beats\s?(studio|solo|flex|fit|x)|powerbeats|\bbuds\b|galaxy buds|pixel buds|nothing ear|\bwh-1000|\bwf-1000|\bwh-\w+|\bwf-\w+|bose (qc|quietcomfort|nc)|quietcomfort|jabra (elite|evolve2? \d+ ?\w*)|soundcore|jbl (tune|live|tour)|sennheiser momentum|shokz|aftershokz|\bbluetooth\b|\(bt\)|hands-?free|\bhfp\b|\ba2dp\b|\bble\b|le audio/i;
const HANDS_FREE_RE = /hands-?free|\bhfp\b|\bsco\b|headset \(.*\)|ag audio/i;
const HEADPHONE_RE = /head\s?phone|headset|ear\s?phone|ear\s?bud|in-?ear|airpods|\bbuds\b|galaxy buds|pixel buds|bose qc|quietcomfort|wh-1000|wf-1000|jabra|arctis|hyperx|cloud (ii|alpha|flight|stinger)|razer (blackshark|kraken|barracuda)|astro a\d+|logitech g (pro|735|733|535|435)|corsair (hs|void|virtuoso)|steelseries|beats|sennheiser (hd|momentum|game)|audio-?technica ath|\bath-|sony mdr/i;
const SPEAKER_RE = /speaker|soundbar|sound bar|\bhdmi\b|display ?port|display audio|\btv\b|monitor|studio display|homepod|sonos|echo (dot|studio)|soundlink|jbl (flip|charge|go|xtreme|boombox|pulse|clip)|ue (boom|megaboom|wonderboom)|bose (soundlink|home)|\bline out\b|line-out|realtek.*digital|s\/pdif|spdif|optical|airplay|chromecast|nest (audio|mini|hub)/i;
const VIRTUAL_RE = /virtual|vb-?audio|cable (input|output)|voicemeeter|blackhole|loopback|soundflower|discord|obs|steam streaming|nvidia broadcast|krisp|rtx voice|monitor of|null output|dummy/i;
const MAC_JACK_RE = /^external (headphones|microphone)\b/i;
const BUILTIN_MIC_RE = /built-?in|internal|macbook|imac|mac studio|iphone|ipad|microphone array|mic(rophone)? array|intel.*smart sound|realtek.*(mic|array)|digital microphone|laptop|front mic|speakerphone|\bphone\b|bottom|back mic|default microphone/i;
const EXTERNAL_MIC_RE = /\byeti\b|blue (snowball|yeti)|shure|\bsm7|\bmv7|rode|r[øo]de|at2020|audio-?technica|samson|elgato wave|hyperx quadcast|quadcast|fifine|scarlett|focusrite|motu|audient|behringer|steinberg|audio interface|usb (audio|mic|microphone)|webcam|c9\d0|brio|streamcam|camera|condenser|lavalier|wireless mic|dji mic|rode wireless/i;

/** Old helper kept for callers: does this label read like headphones? */
export function looksLikeHeadphones(label: string): boolean {
  const l = cleanLabel(label);
  if (MAC_JACK_RE.test(l)) return false;
  return HEADPHONE_RE.test(l) || BT_BRAND_RE.test(l) && !SPEAKER_RE.test(l);
}

export function looksBluetooth(label: string): boolean {
  return BT_BRAND_RE.test(cleanLabel(label));
}

/** A Bluetooth HFP ("hands-free") endpoint: opening it is the trap. */
export function looksHandsFree(label: string): boolean {
  const l = cleanLabel(label);
  return HANDS_FREE_RE.test(l) && (BT_BRAND_RE.test(l) || /hands-?free|ag audio/i.test(l));
}

export function looksVirtual(label: string): boolean {
  return VIRTUAL_RE.test(cleanLabel(label));
}

/** Output kind from a label alone. */
export function classifyOutputLabel(label: string | undefined): OutputKind {
  if (!label) return 'unknown';
  const l = cleanLabel(label);
  if (!l || looksVirtual(l)) return 'unknown';
  if (MAC_JACK_RE.test(l)) return 'unknown'; // could be desk speakers
  if (SPEAKER_RE.test(l) && !HEADPHONE_RE.test(l)) return 'speakers';
  const bt = BT_BRAND_RE.test(l);
  if (HEADPHONE_RE.test(l) || bt) {
    if (SPEAKER_RE.test(l)) return 'speakers';
    return bt ? 'bluetooth-headphones' : 'headphones';
  }
  if (/built-?in|internal|macbook|imac|mac mini|ipad|iphone|analog stereo|realtek|high definition audio|conexant|cirrus/i.test(l)) {
    // Built-in output that is not a named headphone port: speakers.
    return 'speakers';
  }
  return 'unknown';
}

/** Input kind from a label alone. */
export function classifyInputLabel(label: string | undefined): InputKind {
  if (!label) return 'unknown';
  const l = cleanLabel(label);
  if (!l || looksVirtual(l)) return 'unknown';
  if (BT_BRAND_RE.test(l) || looksHandsFree(l)) return 'bluetooth-headset';
  if (MAC_JACK_RE.test(l)) return 'headset'; // a mic in the combo jack is a headset mic
  if (HEADPHONE_RE.test(l)) return 'headset';
  if (EXTERNAL_MIC_RE.test(l)) return 'external';
  if (BUILTIN_MIC_RE.test(l)) return 'builtin';
  if (/microphone|\bmic\b/i.test(l)) return 'unknown';
  return 'unknown';
}

// ---- native ports -------------------------------------------------------------

export function classifyOutputPort(p: NativePort | undefined): OutputKind {
  if (!p) return 'unknown';
  switch (p.type) {
    case 'wired-headphones':
    case 'wired-headset':
      return 'headphones';
    case 'bluetooth': {
      const byName = classifyOutputLabel(p.name);
      return byName === 'speakers' ? 'speakers' : 'bluetooth-headphones';
    }
    case 'builtin-speaker':
    case 'builtin-receiver':
    case 'hdmi':
    case 'airplay':
      return 'speakers';
    case 'usb': {
      const byName = classifyOutputLabel(p.name);
      return byName === 'bluetooth-headphones' ? 'headphones' : byName;
    }
    case 'jack':
    case 'virtual':
      return 'unknown';
    default:
      return classifyOutputLabel(p.name);
  }
}

export function classifyInputPort(p: NativePort | undefined): InputKind {
  if (!p) return 'unknown';
  switch (p.type) {
    case 'builtin-mic':
      return 'builtin';
    case 'bluetooth':
      return 'bluetooth-headset';
    case 'wired-headset':
    case 'jack':
      return 'headset';
    case 'usb': {
      const k = classifyInputLabel(p.name);
      return k === 'unknown' ? 'external' : k === 'bluetooth-headset' ? 'headset' : k;
    }
    default:
      return classifyInputLabel(p.name);
  }
}

// ---- the default devices ------------------------------------------------------

/**
 * The real device behind the OS default. Chrome lists a pseudo "default" entry
 * (label "Default - X") that shares a groupId with X; Safari / WebKit list the
 * default first and have no pseudo entry.
 */
export function resolveDefault(devices: DeviceLike[], kind: 'audioinput' | 'audiooutput'): DeviceLike | undefined {
  const list = devices.filter((d) => d.kind === kind);
  if (!list.length) return undefined;
  const pseudo = list.find((d) => d.deviceId === 'default');
  const real = list.filter((d) => d.deviceId !== 'default' && d.deviceId !== 'communications');
  if (pseudo) {
    const name = cleanLabel(pseudo.label);
    return real.find((d) => d.groupId && d.groupId === pseudo.groupId && cleanLabel(d.label) === name)
      ?? real.find((d) => cleanLabel(d.label) === name)
      ?? pseudo;
  }
  return real[0] ?? list[0];
}

export function labelsAvailable(devices: DeviceLike[]): boolean {
  return devices.some((d) => (d.kind === 'audioinput' || d.kind === 'audiooutput') && d.label.trim() !== '');
}

// ---- microphone choice ----------------------------------------------------------

export interface InputChoice {
  /** Device to open; undefined = the OS default (follows the user's system choice). */
  deviceId?: string;
  label?: string;
  kind: InputKind;
  reason: 'default' | 'avoid-bluetooth' | 'only-bluetooth' | 'no-labels' | 'user' | 'no-devices';
  /** The only microphone is a Bluetooth headset's: using it degrades their audio. */
  onlyBluetooth: boolean;
}

const PREFERENCE: InputKind[] = ['builtin', 'external', 'headset', 'unknown'];

/**
 * Which microphone to open. With `avoidBluetooth` (setting "Use built-in mic
 * with Bluetooth headphones", default on), a Bluetooth headset mic is replaced
 * by the best other one (built-in, then USB / external, then a wired headset).
 * `userDeviceId` (an explicit pick) always wins while it exists.
 */
export function chooseInput(devices: DeviceLike[], opts: { avoidBluetooth: boolean; userDeviceId?: string | null }): InputChoice {
  const inputs = devices.filter((d) => d.kind === 'audioinput');
  if (!inputs.length) return { kind: 'unknown', reason: 'no-devices', onlyBluetooth: false };
  if (opts.userDeviceId) {
    const u = inputs.find((d) => d.deviceId === opts.userDeviceId);
    if (u) return { deviceId: u.deviceId, label: u.label, kind: classifyInputLabel(u.label), reason: 'user', onlyBluetooth: false };
  }
  if (!labelsAvailable(devices)) return { kind: 'unknown', reason: 'no-labels', onlyBluetooth: false };
  const def = resolveDefault(devices, 'audioinput');
  const defKind = classifyInputLabel(def?.label);
  const real = inputs.filter((d) => d.deviceId !== 'default' && d.deviceId !== 'communications');
  const nonBt = real.filter((d) => classifyInputLabel(d.label) !== 'bluetooth-headset' && !looksVirtual(d.label));
  if (defKind !== 'bluetooth-headset') {
    return { label: def?.label, kind: defKind, reason: 'default', onlyBluetooth: false };
  }
  if (!nonBt.length) {
    return { label: def?.label, kind: defKind, reason: 'only-bluetooth', onlyBluetooth: true };
  }
  if (!opts.avoidBluetooth) {
    return { label: def?.label, kind: defKind, reason: 'default', onlyBluetooth: false };
  }
  const ranked = [...nonBt].sort((a, b) => PREFERENCE.indexOf(classifyInputLabel(a.label)) - PREFERENCE.indexOf(classifyInputLabel(b.label)));
  const pick = ranked[0];
  return { deviceId: pick.deviceId, label: pick.label, kind: classifyInputLabel(pick.label), reason: 'avoid-bluetooth', onlyBluetooth: false };
}

/** Output in use, from native route info when there is any, else labels. */
export function classifyOutput(devices: DeviceLike[], route: NativeAudioRoute | null): { kind: OutputKind; label?: string } {
  const port = route?.outputs[0];
  if (port) {
    const k = classifyOutputPort(port);
    if (k !== 'unknown' || port.type === 'jack') return { kind: k, label: port.name };
  }
  const out = resolveDefault(devices, 'audiooutput');
  if (out?.label) return { kind: classifyOutputLabel(out.label), label: cleanLabel(out.label) };
  // WebKit lists no outputs: a Bluetooth headset mic still tells us what is on.
  const input = resolveDefault(devices, 'audioinput');
  if (input?.label && classifyInputLabel(input.label) === 'bluetooth-headset') {
    return { kind: 'bluetooth-headphones', label: cleanLabel(input.label) };
  }
  return { kind: 'unknown', label: port?.name };
}
