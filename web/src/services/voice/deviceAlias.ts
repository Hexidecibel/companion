/**
 * Device words in "show me Out4 on my PC" / "pull it up on the phone" / "here":
 * which connected Herald device they mean. Shared by the web (spoken "show me")
 * and the daemon (the brain's show_session tool): the two copies,
 * web/src/services/voice/deviceAlias.ts and daemon/src/herald/device-alias.ts,
 * are byte-identical (mirror-tested), so no imports.
 *
 * Platform first, label second: each device reports its OS and whether it is
 * the native app or a browser at presence time (HeraldDevicePlatform); an older
 * client without it is classified from its label ("Windows desktop", "Chrome on
 * Windows", "Companion app on Android"). A renamed device ("Gaming rig") still
 * answers to "my PC" through its platform.
 *
 *   PC, computer, desktop, Windows, gaming PC -> Windows (computer / desktop / PC
 *                                                 fall back to Linux / ChromeOS)
 *   Mac, MacBook, iMac, laptop                -> macOS
 *   phone, mobile, Android, iPhone            -> the phone (Android / iOS)
 *   tablet, iPad                              -> iPadOS
 *   here, this one, this device               -> the device asking
 *
 * Several matches: the asking device when it is one of them, else ask which.
 * None: "I don't see a PC connected." Never falls back to the active device.
 */

export type DeviceAliasOs =
  | 'windows'
  | 'macos'
  | 'linux'
  | 'chromeos'
  | 'android'
  | 'ios'
  | 'ipados'
  | 'unknown';

export interface AliasDevice {
  id: string;
  label: string;
  platform?: { os: string; app: string } | null;
}

export type DeviceAliasResult =
  | { kind: 'device'; id: string; label: string; self: boolean }
  | { kind: 'ambiguous'; devices: Array<{ id: string; label: string }> }
  | { kind: 'none'; noun: string };

interface AliasClass {
  oses: DeviceAliasOs[];
  /** Used when nothing in `oses` is connected (generic words only). */
  fallback?: DeviceAliasOs[];
  /** Label words that place a device without platform info in this class. */
  labelRe: RegExp;
}

const WINDOWS_LABEL = /\b(?:windows|win|pc)\b/;
const MAC_LABEL = /\b(?:mac|macos|macbook|imac|osx)\b/;
const PHONE_LABEL = /\b(?:android|iphone|phone|mobile)\b/;
const TABLET_LABEL = /\b(?:ipad|tablet)\b/;

const CLASSES: Record<string, AliasClass> = {
  windows: { oses: ['windows'], labelRe: WINDOWS_LABEL },
  pc: { oses: ['windows'], fallback: ['linux', 'chromeos'], labelRe: WINDOWS_LABEL },
  mac: { oses: ['macos'], labelRe: MAC_LABEL },
  phone: { oses: ['android', 'ios'], labelRe: PHONE_LABEL },
  android: { oses: ['android'], labelRe: /\bandroid\b/ },
  iphone: { oses: ['ios'], labelRe: /\biphone\b/ },
  tablet: { oses: ['ipados'], labelRe: TABLET_LABEL },
  linux: { oses: ['linux'], labelRe: /\b(?:linux|ubuntu)\b/ },
};

/** Keyword -> class and how it is said back ("I don't see a PC connected."). */
const KEYWORDS: Record<string, { cls: string; noun: string }> = {
  windows: { cls: 'windows', noun: 'a Windows PC' },
  pc: { cls: 'pc', noun: 'a PC' },
  pcs: { cls: 'pc', noun: 'a PC' },
  computer: { cls: 'pc', noun: 'a computer' },
  desktop: { cls: 'pc', noun: 'a desktop' },
  rig: { cls: 'pc', noun: 'a PC' },
  mac: { cls: 'mac', noun: 'a Mac' },
  macbook: { cls: 'mac', noun: 'a MacBook' },
  imac: { cls: 'mac', noun: 'an iMac' },
  macos: { cls: 'mac', noun: 'a Mac' },
  laptop: { cls: 'mac', noun: 'a laptop' },
  phone: { cls: 'phone', noun: 'a phone' },
  mobile: { cls: 'phone', noun: 'a phone' },
  cellphone: { cls: 'phone', noun: 'a phone' },
  smartphone: { cls: 'phone', noun: 'a phone' },
  android: { cls: 'android', noun: 'an Android phone' },
  iphone: { cls: 'iphone', noun: 'an iPhone' },
  tablet: { cls: 'tablet', noun: 'a tablet' },
  ipad: { cls: 'tablet', noun: 'an iPad' },
  linux: { cls: 'linux', noun: 'a Linux machine' },
  ubuntu: { cls: 'linux', noun: 'a Linux machine' },
};

/** Explicit OS words beat generic ones ("my windows laptop" is the PC). */
const PRIORITY = ['windows', 'android', 'iphone', 'linux', 'mac', 'tablet', 'pc', 'phone'];

const HERE = new Set([
  'here',
  'on here',
  'right here',
  'this',
  'this one',
  'this device',
  'this computer',
  'this pc',
  'this machine',
  'this screen',
  'this phone',
  'this mac',
  'this laptop',
  'this tablet',
]);

/** Words around a device word that do not name a particular device. */
const GENERIC = new Set([
  'gaming',
  'windows',
  'big',
  'main',
  'home',
  'work',
  'other',
  'machine',
  'box',
  'device',
  'screen',
]);

const LEADING = new Set(['on', 'my', 'the', 'our', 'that', 'a']);
const TRAILING = new Set(['one', 'please', 'app', 'thanks']);

export function normalizeDevicePhrase(s: string): string {
  return s
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function coreWords(phrase: string): string[] {
  let w = normalizeDevicePhrase(phrase).split(' ').filter(Boolean);
  while (w.length > 1 && LEADING.has(w[0])) w = w.slice(1);
  while (w.length > 1 && TRAILING.has(w[w.length - 1])) w = w.slice(0, -1);
  return w;
}

const OS_SET = new Set<string>([
  'windows',
  'macos',
  'linux',
  'chromeos',
  'android',
  'ios',
  'ipados',
]);

/** A device's OS: its reported platform, else read from its label. */
export function deviceAliasOs(d: AliasDevice): DeviceAliasOs {
  const reported = d.platform?.os;
  if (reported && OS_SET.has(reported)) return reported as DeviceAliasOs;
  const l = normalizeDevicePhrase(d.label);
  if (/\bandroid\b/.test(l)) return 'android';
  if (/\b(?:iphone|ios)\b/.test(l)) return 'ios';
  if (TABLET_LABEL.test(l)) return 'ipados';
  if (/\b(?:chromeos|chromebook|cros)\b/.test(l)) return 'chromeos';
  if (WINDOWS_LABEL.test(l)) return 'windows';
  if (MAC_LABEL.test(l)) return 'macos';
  if (/\b(?:linux|ubuntu)\b/.test(l)) return 'linux';
  return 'unknown';
}

function inOses(d: AliasDevice, oses: readonly DeviceAliasOs[], labelRe: RegExp): boolean {
  const os = deviceAliasOs(d);
  if (os !== 'unknown') return oses.includes(os);
  return labelRe.test(normalizeDevicePhrase(d.label));
}

function titleCase(words: string[]): string {
  return words.map((w) => (w.length > 0 ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');
}

/** "I don't see a PC connected." */
export function deviceNotFoundLine(noun: string): string {
  return `I don't see ${noun} connected.`;
}

/**
 * The device the words name. `selfId` is the device that asked ("here", and
 * the tie-break when several match).
 */
export function resolveDeviceAlias(
  phrase: string,
  devices: readonly AliasDevice[],
  selfId: string | null
): DeviceAliasResult {
  const norm = normalizeDevicePhrase(phrase);
  const pick = (d: AliasDevice): DeviceAliasResult => ({
    kind: 'device',
    id: d.id,
    label: d.label,
    self: d.id === selfId,
  });
  const choose = (found: readonly AliasDevice[], noun: string): DeviceAliasResult => {
    if (found.length === 0) return { kind: 'none', noun };
    if (found.length === 1) return pick(found[0]);
    const mine = found.find((d) => d.id === selfId);
    if (mine) return pick(mine);
    return { kind: 'ambiguous', devices: found.map((d) => ({ id: d.id, label: d.label })) };
  };

  const stripped = norm.replace(/^on /, '');
  if (HERE.has(norm) || HERE.has(stripped)) {
    const self = devices.find((d) => d.id === selfId);
    if (self) return pick(self);
    return { kind: 'device', id: selfId ?? '', label: 'this device', self: true };
  }

  const words = coreWords(phrase);
  const joined = words.join(' ');
  if (!joined) return { kind: 'none', noun: 'that device' };

  // A device's own name, as said ("Work Mac", "Gaming rig").
  const exact = devices.filter((d) => {
    const l = normalizeDevicePhrase(d.label);
    return l === joined || l === stripped;
  });
  if (exact.length > 0) return choose(exact, titleCase(words));

  // Part of a name ("work mac" for "Work Mac Chrome"): first when the words
  // say more than a device word, and only when it settles it.
  const partial = devices.filter((d) => {
    const lw = normalizeDevicePhrase(d.label).split(' ');
    return words.every((w) => lw.includes(w));
  });
  const generic = words.every((w) => KEYWORDS[w] || GENERIC.has(w));
  if (!generic && partial.length === 1) return pick(partial[0]);

  // A device word: by platform.
  const hits = words.map((w) => KEYWORDS[w]).filter((k): k is { cls: string; noun: string } => !!k);
  if (hits.length > 0) {
    hits.sort((a, b) => PRIORITY.indexOf(a.cls) - PRIORITY.indexOf(b.cls));
    const { cls, noun } = hits[0];
    const c = CLASSES[cls];
    let found = devices.filter((d) => inOses(d, c.oses, c.labelRe));
    if (found.length === 0 && c.fallback)
      found = devices.filter((d) => inOses(d, c.fallback!, /$^/));
    return choose(found, noun);
  }

  return choose(partial, titleCase(words));
}
