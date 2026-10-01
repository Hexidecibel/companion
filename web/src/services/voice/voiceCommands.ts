/**
 * Local voice commands: short, whole-utterance phrases handled on the device
 * without a brain round trip ("stop", "say that again", "slower"), or turned
 * into a structured brain request ("shorter", "go on").
 *
 * A phrase only counts when it is essentially the WHOLE utterance: after
 * normalising case, punctuation, filler words and a leading/trailing name
 * ("Herald, stop", "Hey Jarvis, repeat that"), what is left must be one of the
 * known phrases exactly (1 to 5 words). "stop the build" or "repeat the
 * migration" are ordinary messages and go to the brain untouched.
 *
 * Pure (no DOM, no React) so the table and its negative cases are unit-tested.
 */

import { matchVolumePhrase, type VolumeCommand } from '../tts/volume';

export type VoiceCommand = 'stop' | 'repeat' | 'shorter' | 'more' | 'slower' | 'faster' | 'brief' | 'undo';

/** Longest utterance (in words, after normalising) that can be a command. */
export const MAX_COMMAND_WORDS = 5;

/** Phrases per command, written in normalised form (lowercase, no punctuation). */
export const COMMAND_PHRASES: Record<VoiceCommand, readonly string[]> = {
  stop: [
    'stop', 'stop it', 'stop talking', 'stop stop', 'quiet', 'be quiet', 'quiet please', 'shush', 'shh', 'hush',
    'shut up', 'enough', 'thats enough', 'that is enough', 'never mind', 'nevermind', 'cancel',
    'thanks', 'thank you', 'got it', 'i got it', 'silence', 'hold on', 'wait',
  ],
  repeat: [
    'repeat', 'repeat that', 'repeat it', 'say that again', 'say it again', 'say again', 'what was that',
    'come again', 'pardon', 'pardon me', 'one more time', 'what did you say', 'sorry what',
  ],
  shorter: [
    'shorter', 'short version', 'the short version', 'tldr', 'tl dr', 'too long', 'bottom line',
    'the bottom line', 'whats the bottom line', 'summarize', 'summarise', 'summarize that', 'summarise that',
    'sum it up', 'sum up', 'give me the gist', 'the gist', 'just the gist', 'in short', 'keep it short',
    'make it shorter',
  ],
  more: [
    'go on', 'keep going', 'continue', 'carry on', 'tell me more', 'more', 'and', 'and then', 'what else',
    'go ahead and continue',
  ],
  brief: [
    'whats up', 'what is up', 'anything for me', 'anything new', 'whats new', 'what is new', 'brief me',
    'catch me up', 'what did i miss', 'what have i missed', 'give me the rundown', 'status report',
  ],
  // Cancel the newest pending (still counting down) send. With nothing pending,
  // "cancel that" while Herald talks is a stop (see voiceCommandRouter).
  undo: [
    'undo', 'undo that', 'undo it', 'take that back', 'take it back', 'cancel that', 'cancel it',
    'dont send that', 'dont send it', 'do not send that', 'do not send it', 'scratch that',
  ],
  slower: ['slower', 'slow down', 'talk slower', 'speak slower', 'slow it down', 'more slowly'],
  faster: ['faster', 'speed up', 'talk faster', 'speak faster', 'speed it up', 'quicker'],
};

/** Dropped anywhere in a short utterance. */
const FILLERS = new Set([
  'uh', 'uhh', 'uhm', 'um', 'umm', 'er', 'erm', 'hmm', 'hm', 'mm', 'mhm', 'ah', 'oh',
  'please', 'okay', 'ok', 'alright', 'right', 'so', 'just', 'now', 'herald', 'jarvis',
]);

/** Whisper's spellings of the names (see daemon/src/herald/voice/wake-phrase.ts). */
const NAMES = ['herald', 'harold', 'jarvis', 'jervis', 'jarvas', 'jarvus', 'javis'];
const NAME_RE = new RegExp(`^(?:(?:hey|hi|hay|yo|okay|ok)\\s+)?(?:${NAMES.join('|')})\\b`);
const TRAILING_NAME_RE = new RegExp(`\\b(?:${NAMES.join('|')})$`);

const PHRASE_TO_COMMAND = new Map<string, VoiceCommand>();
for (const [cmd, phrases] of Object.entries(COMMAND_PHRASES) as Array<[VoiceCommand, readonly string[]]>) {
  for (const p of phrases) PHRASE_TO_COMMAND.set(p, cmd);
}

/**
 * Lowercase, straighten apostrophes and drop them ("that's" -> "thats"), turn
 * every other punctuation mark into a space, and collapse whitespace.
 */
export function normalizeUtterance(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’ʼ']/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Strip a leading "Hey Jarvis" / "Herald" and a trailing name ("stop, Herald"). */
export function stripAddress(normalized: string): string {
  let t = normalized.replace(NAME_RE, '').trim();
  t = t.replace(TRAILING_NAME_RE, '').trim();
  return t;
}

/** The phrase a transcript reduces to, or null when it is too long to be a command. */
export function commandCore(text: string): string | null {
  const addressed = stripAddress(normalizeUtterance(text));
  if (!addressed) return null;
  const words: string[] = [];
  for (const w of addressed.split(' ')) {
    if (FILLERS.has(w)) continue;
    // "stop stop stop" -> "stop stop" at most (a table phrase); longer echoes collapse.
    if (words.length >= 2 && words[words.length - 1] === w && words[words.length - 2] === w) continue;
    words.push(w);
  }
  if (words.length === 0 || words.length > MAX_COMMAND_WORDS) return null;
  return words.join(' ');
}

/**
 * The command a whole utterance expresses, or null for an ordinary message.
 * Fillers are only ever dropped from short utterances, so a real sentence is
 * never mistaken for a command because of its first word.
 */
export function matchVoiceCommand(text: string): VoiceCommand | null {
  if (!text || text.length > 80) return null;
  const core = commandCore(text);
  if (!core) {
    // Only fillers and a name ("okay", "um"): nothing to do, not a command.
    return null;
  }
  const direct = PHRASE_TO_COMMAND.get(core);
  if (direct) return direct;
  // Filler words are part of some phrases ("just the gist", "okay stop" -> "stop"):
  // retry with the fillers kept, so both spellings resolve.
  const kept = stripAddress(normalizeUtterance(text));
  return PHRASE_TO_COMMAND.get(kept) ?? null;
}

const DIAGNOSTICS_PHRASES = new Set([
  'diagnostics', 'diagnostic', 'diagnose', 'show diagnostics', 'open diagnostics', 'run diagnostics',
  'show the diagnostics', 'open the diagnostics', 'show me diagnostics', 'show me the diagnostics',
  'voice diagnostics', 'herald diagnostics',
]);

/**
 * DIAGNOSTICS: "diagnostics", "show diagnostics", "open the diagnostics" (whole
 * utterance) opens Help > Diagnostics. Checked before "show me ...".
 */
export function matchDiagnosticsCommand(text: string): boolean {
  if (!text || text.length > 60) return false;
  const core = commandCore(text);
  return !!core && DIAGNOSTICS_PHRASES.has(core);
}

/**
 * VOLUME: "louder", "quieter", "softer", "volume up/down", "volume 50" (whole
 * utterance, see services/tts/volume.ts). "turn up the logging" or "what's the
 * volume on the build" are ordinary messages for the brain.
 */
export function matchVolumeCommand(text: string): VolumeCommand | null {
  if (!text || text.length > 80) return null;
  const addressed = stripAddress(normalizeUtterance(text));
  if (!addressed) return null;
  return matchVolumePhrase(addressed);
}

// ---------------------------------------------------------------------------
// SHOW: "show me", "open Doc Upload Site", "show me Out4 on my phone".
//
// Whole-utterance only, like the commands above: a show verb, then optionally
// a session name, then optionally "on <device>" / "here". The target must look
// like a NAME: "show me how to deploy", "open a new session" or "show me what
// Out4 did" contain words a session name never does and go to the brain. A
// target that is a plausible name but matches no session also goes to the
// brain (the daemon answers not_found), so "open the pod bay doors" is safe.

/** A spoken "show me". `target` null = what Herald just talked about; `device` null = the active device. */
export interface ShowCommand {
  target: string | null;
  /** The device words as said ("my phone", "the mac", "here"), unresolved. */
  device: string | null;
}

/** Longest show utterance, in words, after normalising (verb + name + "on my phone"). */
export const MAX_SHOW_WORDS = 10;
/** Longest session name, in words. */
const MAX_TARGET_WORDS = 5;

/** Whole phrases that mean "show me what you are talking about". */
const SHOW_BARE = new Set([
  'show me', 'show me that', 'show me it', 'show me this', 'show it', 'show that', 'show it to me', 'show that to me',
  'show me that one', 'show me the session', 'show me that session',
  'open it', 'open that', 'open it up', 'open that up', 'open that one', 'open that session',
  'take me there', 'take me to it', 'take me to that', 'take me to that session',
  'pull it up', 'pull that up', 'pull it up for me', 'bring it up', 'bring that up',
  'let me see', 'let me see it', 'let me see that', 'let me see that one', 'lemme see', 'let me look', 'let me have a look',
  'go there', 'go to it', 'jump to it',
]);

/** Verbs that take a name after them, longest first. */
const SHOW_VERBS = [
  'show me the', 'take me to the', 'pull up the', 'bring up the', 'let me see the', 'open up the', 'open the', 'go to the', 'jump to the', 'switch to the',
  'show me', 'take me to', 'pull up', 'bring up', 'let me see', 'open up', 'open', 'go to', 'jump to', 'switch to',
];

/** Words a session NAME never contains: the utterance is a question or a request for the brain. */
const NOT_A_NAME = new Set([
  'how', 'what', 'whats', 'why', 'where', 'when', 'who', 'whom', 'whose', 'which', 'whether', 'if',
  'is', 'are', 'was', 'were', 'be', 'been', 'do', 'does', 'did', 'done', 'can', 'could', 'would', 'should', 'will', 'shall', 'might',
  'to', 'me', 'i', 'you', 'your', 'my', 'we', 'our', 'us', 'they', 'them', 'he', 'she', 'his', 'her', 'its',
  'a', 'an', 'all', 'every', 'everything', 'any', 'anything', 'something', 'some', 'nothing', 'more', 'less', 'again',
  'new', 'list', 'about', 'with', 'for', 'from', 'of', 'and', 'or', 'but', 'not', 'dont', 'than', 'then', 'way',
  'there', 'here', 'up', 'please', 'happening', 'going', 'doing', 'last', 'latest', 'next', 'other', 'others',
]);

/** Words that, after "on", name a device rather than continuing a session name. */
export const DEVICE_WORDS = new Set([
  'computer', 'desktop', 'pc', 'laptop', 'mac', 'macbook', 'imac', 'windows', 'linux', 'browser',
  'phone', 'mobile', 'android', 'iphone', 'ipad', 'tablet', 'device', 'screen', 'monitor',
]);

/** Pronouns that, as the whole target, mean "the thing we are talking about". */
const PRONOUN_TARGETS = new Set(['it', 'that', 'this', 'that one', 'this one', 'there', 'session', 'that session', 'this session', 'the session']);

/** Split a trailing "on my phone" / "on the mac" / "here" off; null device when there is none. */
function splitDevice(words: string[], labels: string[][]): { rest: string[]; device: string | null } {
  const last = words[words.length - 1];
  if (last === 'here') {
    const cut = words[words.length - 2] === 'on' ? 2 : 1;
    return { rest: words.slice(0, -cut), device: 'here' };
  }
  for (let i = words.length - 2; i >= 1; i--) {
    if (words[i] !== 'on') continue;
    const tail = words.slice(i + 1);
    const core = tail[0] === 'my' || tail[0] === 'the' || tail[0] === 'this' ? tail.slice(1) : tail;
    if (core.length === 0 || core.length > 4) continue;
    const isDeviceWord = core.some((w) => DEVICE_WORDS.has(w));
    const joined = core.join(' ');
    const isLabel = labels.some((l) => l.join(' ') === joined || (l.length > 0 && core.every((w) => l.includes(w))));
    if (isDeviceWord || isLabel) return { rest: words.slice(0, i), device: tail.join(' ') };
  }
  return { rest: words, device: null };
}

/**
 * The "show me" a whole utterance expresses, or null for anything else.
 * `deviceLabels`: the connected devices' names, so "on Work Mac" splits off.
 */
export function matchShowCommand(text: string, deviceLabels: readonly string[] = []): ShowCommand | null {
  if (!text || text.length > 120) return null;
  const addressed = stripAddress(normalizeUtterance(text));
  if (!addressed) return null;
  const words = addressed.split(' ').filter((w) => !FILLERS.has(w));
  if (words.length === 0 || words.length > MAX_SHOW_WORDS) return null;
  const labels = deviceLabels.map((l) => normalizeUtterance(l).split(' ').filter(Boolean));
  const { rest, device } = splitDevice(words, labels);
  const phrase = rest.join(' ');
  if (SHOW_BARE.has(phrase)) return { target: null, device };
  // "show me" + "on my phone" / "here" with nothing between.
  if (device && (phrase === 'show' || phrase === 'show me' || phrase === 'open' || phrase === 'pull up')) {
    return { target: null, device };
  }
  // "pull Out4 up" / "bring Docs up".
  let verbless: string | null = null;
  const pulled = /^(?:pull|bring) (.+) up$/.exec(phrase);
  if (pulled) verbless = pulled[1];
  else {
    for (const v of SHOW_VERBS) {
      if (phrase.startsWith(`${v} `)) {
        verbless = phrase.slice(v.length + 1);
        break;
      }
    }
  }
  if (verbless === null) return null;
  let t = verbless.split(' ').filter(Boolean);
  if (t[0] === 'the') t = t.slice(1);
  // "the deploy session" / "the Out4 one" / "the docs window".
  while (t.length > 1 && ['session', 'one', 'window', 'tab', 'project'].includes(t[t.length - 1])) t = t.slice(0, -1);
  if (t.length === 0) return { target: null, device };
  const target = t.join(' ');
  if (PRONOUN_TARGETS.has(target)) return { target: null, device };
  if (t.length > MAX_TARGET_WORDS) return null;
  if (t.some((w) => NOT_A_NAME.has(w))) return null;
  return { target, device };
}

/** Chip label shown in the chat for a command sent to the brain. */
export const INTENT_LABELS: Record<'shorter' | 'more' | 'brief', string> = {
  shorter: 'Shorter',
  more: 'Tell me more',
  brief: 'Brief me',
};

const WAKE_LEAD_RE = new RegExp(`^\\s*(?:(?:hey|hi|hay|a|okay|ok|yo)[\\s,.!-]*)?(?:${NAMES.filter((n) => n !== 'herald' && n !== 'harold').join('|')})\\b[\\s,.!?:;-]*`, 'i');

/**
 * Drop a leading "Hey Jarvis" from a transcript that was not a wake stream
 * (talking over Herald in hands-free mode, or push-to-talk out of habit).
 * "Herald" is left alone: "Herald, ..." reads naturally in the chat.
 */
export function stripWakeWord(text: string): string {
  const m = WAKE_LEAD_RE.exec(text);
  if (!m) return text.trim();
  const rest = text.slice(m[0].length).trim();
  return rest ? rest.charAt(0).toUpperCase() + rest.slice(1) : '';
}

/** Compact help list for the menu: one example per command. */
export const VOICE_COMMAND_HELP: Array<{ say: string; does: string }> = [
  { say: '"Stop" · "never mind" · "thanks"', does: 'Stop talking' },
  { say: '"Repeat that" · "say that again"', does: 'Hear the last reply again' },
  { say: '"Shorter" · "TL;DR" · "bottom line"', does: 'One-sentence version' },
  { say: '"Go on" · "tell me more"', does: 'Keep going / more detail' },
  { say: '"Slower" · "faster"', does: 'Change the speaking speed' },
  { say: '"Louder" · "quieter" · "volume 50"', does: "Change Herald's volume (this device)" },
  { say: '"What\'s up?" · "catch me up"', does: 'Brief me on what is new' },
  { say: '"Undo that" · "don\'t send that"', does: 'Cancel a reply that is about to be sent' },
  { say: '"Show me" · "show me Out4" · "pull it up on my phone"', does: 'Open the session Herald is talking about' },
  { say: '"Diagnostics"', does: 'Open Help > Diagnostics (mic, wake word, hands-free, devices)' },
];
