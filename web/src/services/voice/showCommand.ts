/**
 * "Show me": what a spoken show command does. Pure over injected actions, so
 * device resolution, the clarifying question and every outcome are unit-tested.
 *
 * The hub resolves the session (fuzzy names, and the "what Herald just talked
 * about" order: newest pending card, latest Herald message's first chip, newest
 * unheard inbox item) and sends a `navigate` event to the device that should
 * show it. This side resolves the device words ("my phone", "the Mac", "here")
 * against the device list, speaks the short acknowledgement, asks "Which one,
 * Out4 or Docs?" when the name is ambiguous, and hands a name that matches no
 * session to the brain as an ordinary message.
 */
import type {
  HeraldAction,
  HeraldDeviceInfo,
  HeraldInboxItem,
  HeraldMessage,
  HeraldSessionRef,
  HeraldShowRequest,
  HeraldShowResult,
} from '../../types/herald';
import { normalizeUtterance, stripAddress, type ShowCommand } from './voiceCommands';
import { deviceNotFoundLine, resolveDeviceAlias } from './deviceAlias';

/** How long a "Which one, A or B?" waits for its answer. */
export const CLARIFY_WINDOW_MS = 20_000;

export type DeviceResolution =
  | { kind: 'device'; id: string; label: string; self: boolean }
  /** Nothing connected matches: "I don't see a PC connected." (`noun` = "a PC"). */
  | { kind: 'offline'; noun: string }
  | { kind: 'ambiguous'; labels: string[]; devices: Array<{ id: string; label: string }> };

/** "my phone" -> "Your phone"; "the Mac" -> "Your Mac"; a label stays as is. */
export function spokenDeviceName(phrase: string): string {
  const words = normalizeUtterance(phrase).split(' ').filter(Boolean);
  const core = words[0] === 'my' || words[0] === 'the' || words[0] === 'this' ? words.slice(1) : words;
  const name = core
    .map((w) => (w === 'mac' ? 'Mac' : w === 'pc' ? 'PC' : w === 'ipad' ? 'iPad' : w === 'iphone' ? 'iPhone' : w))
    .join(' ');
  return name ? `Your ${name}` : 'That device';
}

/**
 * The device the words name ("my PC", "the phone", "here"): by each device's
 * reported platform, else its label (deviceAlias.ts, shared with the hub).
 * Several matches: this device when it is one of them, else ask which. None:
 * offline, never the active device instead.
 */
export function resolveDevicePhrase(
  phrase: string,
  devices: readonly HeraldDeviceInfo[],
  selfId: string | null,
): DeviceResolution {
  const r = resolveDeviceAlias(phrase, devices, selfId);
  if (r.kind === 'none') return { kind: 'offline', noun: r.noun };
  if (r.kind === 'ambiguous') return { kind: 'ambiguous', labels: r.devices.map((d) => d.label), devices: r.devices };
  return r;
}

/** "Out4 or Docs" / "Out4, Docs or Blog" (at most three). */
export function orList(names: readonly string[]): string {
  const n = names.slice(0, 3);
  if (n.length <= 1) return n[0] ?? '';
  return `${n.slice(0, -1).join(', ')} or ${n[n.length - 1]}`;
}

export const showLines = {
  here: (name: string) => `Here's ${name}.`,
  there: (name: string, device: string) => `${name} is up on ${device}.`,
  which: (names: readonly string[]) => `Which one, ${orList(names)}?`,
  whichDevice: (labels: readonly string[]) => `Which one, ${orList(labels)}?`,
  offline: (name: string) => `${name} isn't connected.`,
  /** A device word that matches nothing connected: "I don't see a PC connected." */
  notConnected: (noun: string) => deviceNotFoundLine(noun),
  nothing: () => 'Nothing to show right now.',
  noDevice: () => 'No device is open to show it on.',
  failed: () => "I couldn't open that.",
};

/** A pending "Which one, A or B?" (sessions, or devices when `devices` is set). */
export interface ShowClarify {
  candidates: string[];
  /** Device id the original request named (kept for the answer). */
  deviceId?: string;
  /** Asking which DEVICE: the candidates' ids (same order as `candidates`). */
  devices?: Array<{ id: string; label: string }>;
  /** The session the original request named (kept for a device answer). */
  target?: string | null;
  until: number;
}

const ORDINALS: Record<string, number> = {
  first: 0, '1st': 0, one: 0, '1': 0,
  second: 1, '2nd': 1, two: 1, '2': 1,
  third: 2, '3rd': 2, three: 2, '3': 2,
};

function compact(s: string): string {
  return normalizeUtterance(s).replace(/\b(?:the|session|one)\b/g, '').replace(/\s+/g, '');
}

/**
 * The candidate a short answer picks ("Out4", "the docs one", "the first one",
 * "show me Docs"), or null when it is not an answer (the window then closes
 * and the words are handled as usual).
 */
export function matchClarifyAnswer(text: string, candidates: readonly string[]): string | null {
  let core = stripAddress(normalizeUtterance(text));
  core = core.replace(/^(?:um|uh|oh|ok|okay|so|just|please)\s+/, '');
  core = core.replace(/^(?:show me|open|pull up|take me to|i mean|i said)\s+/, '');
  core = core.replace(/\s+(?:please|thanks)$/, '');
  if (!core || core.split(' ').length > 5) return null;
  const words = core.split(' ');
  // "the first one" / "the second".
  const ord = words.find((w) => w in ORDINALS);
  if (ord && words.every((w) => w === ord || w === 'the' || w === 'one')) {
    return candidates[ORDINALS[ord]] ?? null;
  }
  if (words.includes('last') && words.every((w) => ['the', 'last', 'one'].includes(w))) {
    return candidates[candidates.length - 1] ?? null;
  }
  const said = compact(core);
  if (!said) return null;
  const exact = candidates.filter((c) => compact(c) === said);
  if (exact.length === 1) return exact[0];
  const partial = candidates.filter((c) => compact(c).includes(said) || said.includes(compact(c)));
  return partial.length === 1 ? partial[0] : null;
}

/**
 * Old hubs (no herald_show): the same unnamed order over the client's copy of
 * Herald's state, so "show me" still works on this device.
 */
export function localShowTarget(state: {
  actions?: readonly HeraldAction[];
  messages?: readonly HeraldMessage[];
  inbox?: readonly HeraldInboxItem[];
}): HeraldSessionRef | null {
  const cards = (state.actions ?? [])
    .filter((a) => a.status === 'pending' && a.kind !== 'cush_command' && a.sessionId)
    .sort((a, b) => b.createdAt - a.createdAt);
  if (cards[0]) return { serverId: cards[0].serverId, sessionId: cards[0].sessionId, sessionName: cards[0].sessionName };
  const msgs = state.messages ?? [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role !== 'herald') continue;
    const r = msgs[i].sessionRefs?.[0];
    if (r) return { ...r };
    break;
  }
  // A pairing request is not a session: nothing to show.
  const unheard = (state.inbox ?? []).filter((i) => !i.heard && !i.pairing).sort((a, b) => b.createdAt - a.createdAt);
  if (unheard[0]) return { serverId: unheard[0].serverId, sessionId: unheard[0].sessionId, sessionName: unheard[0].sessionName };
  return null;
}

export interface ShowActions {
  devices: () => readonly HeraldDeviceInfo[];
  selfId: () => string | null;
  activeId: () => string | null;
  /** herald_show on the hub. Rejects when the hub cannot do it (older daemon, offline). */
  request: (req: HeraldShowRequest) => Promise<HeraldShowResult>;
  /** Older hub: open locally (unnamed only). */
  localTarget: () => HeraldSessionRef | null;
  navigateHere: (ref: HeraldSessionRef) => void;
  /** Short spoken line (also flashed). */
  say: (line: string) => void;
  /** The success acknowledgement: spoken, or a tick in the Gaming profile. */
  ack: (line: string) => void;
  /** Hand the original words to the brain (a name that matches no session). */
  sendToBrain: (text: string) => void;
  setClarify: (c: ShowClarify | null) => void;
  now: () => number;
}

export type ShowOutcome =
  | 'shown_here'
  | 'shown_there'
  | 'shown_local'
  | 'ambiguous'
  | 'ambiguous_device'
  | 'to_brain'
  | 'nothing'
  | 'offline'
  | 'no_device'
  | 'failed';

/** Run a spoken show command. `said` = the original words (for the brain). */
export async function runShowCommand(
  cmd: ShowCommand,
  said: string,
  a: ShowActions,
  presetDeviceId?: string,
): Promise<ShowOutcome> {
  let deviceId: string | undefined = presetDeviceId;
  if (!deviceId && cmd.device) {
    const r = resolveDevicePhrase(cmd.device, a.devices(), a.selfId());
    if (r.kind === 'offline') {
      // Never quietly show it on another device instead.
      a.say(showLines.notConnected(r.noun));
      return 'offline';
    }
    if (r.kind === 'ambiguous') {
      const devices = r.devices.slice(0, 3);
      a.setClarify({ candidates: devices.map((d) => d.label), devices, target: cmd.target, until: a.now() + CLARIFY_WINDOW_MS });
      a.say(showLines.whichDevice(devices.map((d) => d.label)));
      return 'ambiguous_device';
    }
    deviceId = r.id || undefined;
  }
  let res: HeraldShowResult;
  try {
    res = await a.request({ ...(cmd.target ? { session: cmd.target } : {}), ...(deviceId ? { device: deviceId } : {}) });
  } catch {
    // An older hub: "show me" (unnamed, this device) still works from local state.
    if (!cmd.target && (!deviceId || deviceId === a.selfId())) {
      const ref = a.localTarget();
      if (!ref) {
        a.say(showLines.nothing());
        return 'nothing';
      }
      a.navigateHere(ref);
      a.ack(showLines.here(ref.sessionName));
      return 'shown_local';
    }
    if (cmd.target) {
      a.sendToBrain(said);
      return 'to_brain';
    }
    a.say(showLines.failed());
    return 'failed';
  }
  switch (res.status) {
    case 'shown': {
      const name = res.session?.sessionName ?? 'it';
      const here = !res.device || res.device.id === a.selfId();
      a.ack(here ? showLines.here(name) : showLines.there(name, res.device!.label));
      return here ? 'shown_here' : 'shown_there';
    }
    case 'ambiguous': {
      const candidates = (res.candidates ?? []).slice(0, 3);
      if (candidates.length < 2) {
        a.sendToBrain(said);
        return 'to_brain';
      }
      a.setClarify({ candidates, deviceId, until: a.now() + CLARIFY_WINDOW_MS });
      a.say(showLines.which(candidates));
      return 'ambiguous';
    }
    case 'not_found':
      a.sendToBrain(said);
      return 'to_brain';
    case 'nothing':
      a.say(showLines.nothing());
      return 'nothing';
    case 'offline': {
      const label = a.devices().find((d) => d.id === deviceId)?.label;
      a.say(showLines.offline(label ?? (cmd.device ? spokenDeviceName(cmd.device) : 'That device')));
      return 'offline';
    }
    case 'no_device':
    default:
      a.say(showLines.noDevice());
      return 'no_device';
  }
}
