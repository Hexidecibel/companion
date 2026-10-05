export type InboxPriority = 'blocked' | 'finished' | 'progress';
export type HeraldActionTier = 'echo' | 'hard_confirm';
export interface HeraldSessionRef {
  serverId: string;
  sessionId: string;
  sessionName: string;
}
export interface HeraldInboxItem {
  id: string;
  serverId: string;
  sessionId: string;
  sessionName: string;
  priority: InboxPriority;
  headline: string; // deterministic one-liner, NOT LLM-generated
  createdAt: number;
  heard: boolean;
  /** Answer to something the user asked a session ("Out4 answered your question: ..."). */
  answer?: boolean;
  /** A risky code change (Code Review): toned like news, never spoken unasked. */
  review?: { level: 'high' | 'medium'; kinds: string[]; paths: string[] };
  /**
   * A session that looks stuck (stuck detection): toned with its own subtle
   * "attention" tone on the active device, never spoken unasked. Updates in
   * place while the session's turn lasts; gone when it recovers.
   */
  stuck?: { kind: string; kinds: string[]; findingId: string; summary: string; count: number };
  /**
   * The session's turn ended on an unresolved tool error: the tool and its
   * first error line (redacted). A finished-toned item, never spoken unasked;
   * it replaces the plain "finished" note for that turn.
   */
  error?: { tool: string; line: string };
  /**
   * A new device wants to pair with this daemon: a blocked-toned item on the
   * active device, never spoken unasked, approved ON SCREEN ONLY (never by
   * voice). `code` is for the screen: the brain only sees a placeholder. Gone
   * on approve, deny or expiry.
   */
  pairing?: { pairingId: string; deviceName: string; platform: string; code: string; expiresAt: number };
}
/**
 * How a message reached Herald: `voice` = push-to-talk, talking over Herald or
 * hands-free; `text` = typed (or reviewed in the composer). Voice replies are
 * kept shorter. Optional: an older client sends neither field.
 */
export type HeraldInputMode = 'voice' | 'text';
/** A spoken command the client turned into a structured brain request. */
export type HeraldIntent = 'shorter' | 'more' | 'brief';
/** Reply length. `auto` = brief for voice, normal for text. */
export type HeraldVerbosity = 'auto' | 'brief' | 'normal' | 'detailed';
/** herald_send payload. Unknown `mode` / `intent` values are ignored. */
export interface HeraldSendRequest {
  text: string;
  mode?: HeraldInputMode;
  intent?: HeraldIntent;
  /**
   * Voice only: the words came from a deliberate gesture (push-to-talk, a
   * hotkey, a remote-trigger listen, a button), not a hands-off capture. While
   * another device is speaking, the hub drops hands-off voice sends from the
   * other devices (Herald's own voice heard by their mics); a gesture gets through.
   */
  gesture?: boolean;
}
export interface HeraldMessage {
  id: string;
  role: 'user' | 'herald';
  text: string;
  createdAt: number;
  sessionRefs?: HeraldSessionRef[];
  actionIds?: string[];
  streaming?: boolean;
  /** Announcement posted on Herald's own initiative: shown + toned, never spoken unasked. */
  quiet?: boolean;
  /** User lines only: sent as a voice command (shown as a chip, not raw text). */
  intent?: HeraldIntent;
  /**
   * Herald lines only: the ONE device that speaks it aloud (a connection id, as
   * in HeraldDeviceInfo.id); every other device shows it silently. A reply goes
   * to the device the turn came from (the one that sent it, or the device a
   * trigger was routed to), anything Herald says unasked to the active device;
   * when that device has gone, the active device, else nobody. null = nobody
   * speaks it. Absent = no routing (older hub, or a turn from a connection that
   * is not a Herald device): each device decides as before. message_end carries
   * the final value (it may change if the device disconnects mid-reply).
   */
  speakOn?: string | null;
}
export interface HeraldAction {
  id: string;
  tier: HeraldActionTier;
  /** cush_command: a validated cush-tools command (payload = the command line; no session). */
  kind: 'send_input' | 'answer_choice' | 'cush_command' | 'interrupt' | 'spawn_session';
  serverId: string;
  sessionId: string;
  sessionName: string;
  payload: string; // exact text / option that will be sent
  readback: string; // human confirmation line, e.g. "companion: option 2, skip tests"
  reasons: string[]; // why this tier (danger classifier hits); empty for plain echo
  status: 'pending' | 'sent' | 'cancelled' | 'failed' | 'expired';
  autoSendAt?: number; // echo tier only: epoch ms when server auto-sends
  error?: string;
  createdAt: number;
  resolvedAt?: number;
  /** hard_confirm: the words that confirm it by voice, e.g. "confirm deploy". */
  confirmPhrase?: string;
  /** hard_confirm: voice tries left (0 = on-screen only). */
  voiceAttemptsLeft?: number;
}
export interface HeraldState {
  displayName: string;
  enabled: boolean;
  disabledReason?: string;
  model: string;
  busy: boolean;
  messages: HeraldMessage[]; // most recent N (e.g. 100)
  inbox: HeraldInboxItem[];
  actions: HeraldAction[]; // pending + recently resolved
  /** Reply length setting (persisted server-side, follows the user). Absent on older daemons. */
  verbosity?: HeraldVerbosity;
  /** The device that acts (tones, triggers, hands-free); absent on older daemons. */
  activeDevice?: HeraldActiveDevice | null;
  /** Connected Herald devices (those that reported presence). */
  devices?: HeraldDeviceInfo[];
  /** API spend (today / this month) and the monthly budget. Absent on older daemons. */
  usage?: HeraldUsageSummary;
  /** Brain health: 'degraded' = answering from the fallback (no LLM). Absent = ok. */
  brain?: HeraldBrainStatus;
  /** The user's pronunciations for Herald's voice (persisted on the hub, follows the user). Absent on older daemons. */
  pronunciations?: HeraldPronunciation[];
}
/** Token and dollar totals for one period. */
export interface HeraldUsageBucket {
  /** Conversation turns that reached the brain. */
  turns: number;
  /** Brain requests (a turn with tool calls makes several). */
  requests: number;
  /** Uncached input tokens. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}
export interface HeraldUsageSummary {
  model: string;
  /** False when the model has no price list (a local server): costs read 0. */
  priced: boolean;
  today: HeraldUsageBucket;
  month: HeraldUsageBucket;
  /** Local calendar month of `month`, YYYY-MM. */
  monthKey: string;
  /** Monthly cap in USD, or null for none. */
  budgetUsd: number | null;
  /** Where the cap comes from: set in the app, or herald.monthly_budget_usd. */
  budgetSource?: 'app' | 'config';
  overBudget: boolean;
  /** Epoch ms of the next month start (the budget resets then). */
  resetsAt: number;
}
/** Why the brain is unavailable (plain-word text is in `detail`). */
export type HeraldBrainDownReason =
  | 'budget'
  | 'credit'
  | 'auth'
  | 'rate_limited'
  | 'unreachable'
  | 'timeout'
  | 'server'
  | 'bad_request'
  | 'other';
export interface HeraldBrainStatus {
  state: 'ok' | 'degraded';
  reason?: HeraldBrainDownReason;
  /** Plain words for the reason, e.g. "out of API credit". */
  detail?: string;
  /** Epoch ms the outage started. */
  since?: number;
  /** Epoch ms of the next automatic recovery attempt (absent for 'budget'). */
  retryAt?: number;
}
/** herald_set_budget payload: monthly cap in USD; null = no cap; omitted = back to config. Answered with HeraldUsageSummary. */
export interface HeraldSetBudgetRequest {
  monthlyUsd?: number | null;
}
export type HeraldEvent =
  | { kind: 'state'; state: HeraldState }
  | { kind: 'message_start'; message: HeraldMessage }
  | { kind: 'message_delta'; messageId: string; delta: string }
  | { kind: 'message_end'; message: HeraldMessage }
  | { kind: 'inbox'; inbox: HeraldInboxItem[] }
  | { kind: 'action'; action: HeraldAction }
  | { kind: 'busy'; busy: boolean }
  | { kind: 'settings'; verbosity: HeraldVerbosity }
  /** The pronunciation list changed (herald_set_pronunciations). */
  | { kind: 'pronunciations'; pronunciations: HeraldPronunciation[] }
  /** Remote trigger, sent ONLY to the active device (see HeraldTriggerAction). */
  | { kind: 'trigger'; action: HeraldTriggerAction; id: string; allowListen?: boolean }
  /** Usage totals changed; `notice` = a one-shot budget warning to announce (tone). */
  | { kind: 'usage'; usage: HeraldUsageSummary; notice?: 'budget_warning' | 'budget_exceeded' }
  /** The brain went down (fallback answers) or came back. */
  | { kind: 'brain'; brain: HeraldBrainStatus }
  /** The active device or the device list changed (broadcast). */
  | { kind: 'devices'; activeDevice: HeraldActiveDevice | null; devices: HeraldDeviceInfo[] }
  /**
   * A device started / is still (heartbeat) / stopped speaking Herald's voice
   * (broadcast; see herald_speaking). Other devices hold back hands-off capture
   * while it is active and for a short tail after.
   */
  | { kind: 'speaking'; speaking: HeraldSpeakingSignal }
  /** Stop playing now (sent ONLY to the speaking device): another device asked (button or "stop"). */
  | { kind: 'stop_speaking'; utteranceId: string | null; by: string | null }
  /**
   * "Show me": open this session's view, sent ONLY to the device that should
   * show it. `pending` = it has a question / choice waiting (scroll to it and
   * highlight it); `ack` = the receiving device acknowledges it ("Here's Out4.",
   * or a tick in the Gaming profile); voice requests are acknowledged by the
   * device that heard them, brain requests by the reply.
   */
  | {
      kind: 'navigate';
      id: string;
      session: HeraldSessionRef;
      via: HeraldShowVia;
      pending?: boolean;
      ack?: boolean;
    }
  | { kind: 'error'; error: string };
/**
 * herald_confirm payload; answered with the HeraldAction. `method: 'voice'`
 * confirms a hard_confirm action by its spoken phrase: the daemon checks its
 * own transcript of this device's mic (`streamId`, else the latest), timing
 * against Herald's speech, the active device and the attempt limit.
 */
export interface HeraldConfirmRequest {
  actionId: string;
  decision: 'confirm' | 'cancel';
  method?: 'tap' | 'voice';
  phrase?: string;
  streamId?: string;
}
/** herald_set_verbosity payload; answered with { verbosity }. */
export interface HeraldSetVerbosityRequest {
  verbosity: HeraldVerbosity;
}
/** One entry of the voice's pronunciation list: whole-word `from` (any case) is spoken as `to`. */
export interface HeraldPronunciation {
  from: string;
  to: string;
}
/** herald_set_pronunciations payload (the whole list); answered with { pronunciations } (cleaned). */
export interface HeraldSetPronunciationsRequest {
  pronunciations: HeraldPronunciation[];
}

/** Who asked for a `navigate`: a spoken "show me", the brain's show_session tool, a `show` trigger. */
export type HeraldShowVia = 'voice' | 'brain' | 'trigger';
/**
 * herald_show payload ("show me", "show me Out4 on my phone"). `session`: a
 * session name as said (fuzzy, like every session tool); absent = what Herald
 * just talked about: the newest pending card's session, else the latest Herald
 * message's first session, else the newest unheard inbox item. `device`: a
 * device id or label; absent = the active device (else the requester). Never
 * changes the active device. Answered with HeraldShowResult.
 */
export interface HeraldShowRequest {
  session?: string;
  device?: string;
}
export type HeraldShowStatus =
  /** Delivered: `session` is opening on `device`. */
  | 'shown'
  /** `session` matches several: ask "Which one, A or B?" (`candidates`). */
  | 'ambiguous'
  /** `session` names no session (the client sends the words to the brain instead). */
  | 'not_found'
  /** No session named and nothing recent to show. */
  | 'nothing'
  /** `device` is not connected. */
  | 'offline'
  /** No device to show it on. */
  | 'no_device';
export interface HeraldShowResult {
  status: HeraldShowStatus;
  session?: HeraldSessionRef;
  device?: { id: string; label: string };
  candidates?: string[];
}

/**
 * Remote triggers: a hotkey on another machine (AutoHotkey, Raycast), a Stream
 * Deck, a phone shortcut. `POST /herald/trigger` with the scoped trigger token
 * (Authorization: Bearer), or the `herald_trigger` WS request. The daemon routes
 * the action to the ACTIVE device (the announcer: hands-free device, else the
 * one used last) as a `trigger` herald_event sent to that client only.
 *   brief  - spoken rundown of what is new
 *   listen - open the mic, capture one utterance (ends on VAD), send it as a voice turn
 *   stop   - stop speaking and cancel any capture
 *   repeat - say the last reply again
 *   toggle - Herald speaking: stop; otherwise listen (the one-button default).
 *            From an untrusted origin the event carries allowListen=false: stop/cancel only.
 *   claim  - make `device` (a label or id) the active device; pinned unless pin=false.
 *            Any action may name a `device`: it is made active first, then acts.
 *   show   - open a session's view (`session`, else what Herald just talked about),
 *            delivered as a `navigate` herald_event with ack=true.
 */
export type HeraldTriggerAction =
  | 'brief'
  | 'listen'
  | 'stop'
  | 'repeat'
  | 'toggle'
  | 'claim'
  | 'show';
/** herald_trigger payload and the POST /herald/trigger JSON body. */
export interface HeraldTriggerRequest {
  action: HeraldTriggerAction;
  /**
   * The device to make active first, by label (case-insensitive) or id: required
   * for `claim`, optional for the rest ("act on THIS machine's device").
   */
  device?: string;
  /** With `device`: keep it active against other devices' activity (default true). */
  pin?: boolean;
  /** `show` only: the session to open (fuzzy name); absent = Herald's latest session. */
  session?: string;
}
/** A delivered trigger. Failures carry `error` plus `code` instead. */
export interface HeraldTriggerResult {
  action: HeraldTriggerAction;
  delivered: true;
}
export type HeraldTriggerErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'rate_limited'
  | 'no_active_device'
  | 'unknown_device'
  | 'unavailable'
  /** A mic-opening action from outside the home network / tailnet (see herald.trigger_public_listen). */
  | 'untrusted_origin'
  /** `show`: `session` names no session. */
  | 'unknown_session'
  /** `show`: `session` matches several. */
  | 'ambiguous_session'
  /** `show` without `session`: nothing recent to show. */
  | 'nothing_to_show';

// --- voice protocol (mirrored byte-for-byte in web/src/types/herald.ts; a web test enforces it) ---
/**
 * Voice rides the same authenticated WebSocket as everything else. Requests:
 *   herald_voice_status        -> HeraldVoiceStatus
 *   herald_tts                 HeraldTtsRequest -> HeraldTtsResult (one sentence per request)
 *   herald_tts_cancel          -> { cancelled: number } (drops this client's pending synthesis)
 *   herald_voice_stream_start  HeraldVoiceStreamStart -> { ok: true }
 *   herald_voice_audio         HeraldVoiceAudioChunk (fire-and-forget; no requestId, no reply)
 *   herald_voice_stream_end    HeraldVoiceStreamEnd -> HeraldSttResult
 *   herald_handsfree           { on: boolean } -> { owner: boolean }
 *   herald_presence            HeraldPresence -> HeraldPresenceResult
 *   herald_claim_device        HeraldClaimDeviceRequest -> HeraldDevicesSnapshot
 *   herald_speaking            HeraldSpeakingReport -> { ok: true }
 *   herald_stop_speaking       HeraldStopSpeakingRequest -> HeraldStopSpeakingResult
 * Per-client pushes arrive as `herald_voice_event` with a HeraldVoiceEvent payload.
 *
 * ONE device is active (the announcer): it plays inbox tones, runs hands-free
 * and receives remote triggers. A device claimed by hand wins (pinned: until
 * another device claims or it disconnects; unpinned: until another device is
 * used); else the hands-free device; else the one the user touched last; else
 * the one seen last. Clients report presence on connect / when shown
 * (interacted: false) and on use (true). The active device and the device list
 * reach everyone as a `devices` herald_event (and in HeraldState).
 *
 * ONE device speaks each Herald line (HeraldMessage.speakOn). While it plays,
 * it reports herald_speaking `start` (again every ~1 s as a heartbeat) and
 * `end`; the hub broadcasts a `speaking` herald_event. Every OTHER device then
 * ignores barge-in, follow-up and hands-free captures (its mic hears Herald
 * with nothing to cancel it against), except a wake word followed at once by
 * "stop"; gestures (push-to-talk, hotkeys, triggers, buttons) still work.
 * herald_stop_speaking from any device stops the speaker (a `stop_speaking`
 * herald_event to it).
 */
export interface HeraldPresence {
  /** The user just used this device (a key press or tap), not merely opened it. */
  interacted: boolean;
  /** Friendly name, e.g. "Chrome on Windows" (auto-detected, user-editable). */
  label?: string;
  /** Stable random id of this browser / app install: a pin survives a quick reconnect. */
  deviceKey?: string;
  /** OS and app kind, so "on my PC" / "the phone" resolve whatever the label says. Absent on older clients. */
  platform?: HeraldDevicePlatform;
}
/** What a device runs on (reported with presence). */
export interface HeraldDevicePlatform {
  os: 'windows' | 'macos' | 'linux' | 'chromeos' | 'android' | 'ios' | 'ipados' | 'unknown';
  /** The Companion app (Tauri) or a browser tab. */
  app: 'native' | 'browser';
}
export interface HeraldPresenceResult {
  announcer: boolean;
  /** This connection's device id (compare with HeraldActiveDevice.id). Absent on older daemons. */
  clientId?: string;
}
export interface HeraldDeviceInfo {
  /** Connection id: changes when the device reconnects. */
  id: string;
  label: string;
  /** Holds hands-free (wake word) mode. */
  handsFree: boolean;
  /** Reported platform. Absent for an older client (then read from the label). */
  platform?: HeraldDevicePlatform;
}
export interface HeraldActiveDevice {
  id: string;
  label: string;
  /** Claimed by hand and kept until another device claims or it disconnects. */
  pinned: boolean;
  /** Why it is active. */
  reason: 'claimed' | 'handsfree' | 'recent';
}
/** Make a device active. `deviceId` absent = the requesting device. */
export interface HeraldClaimDeviceRequest {
  pin: boolean;
  deviceId?: string;
}
export interface HeraldDevicesSnapshot {
  activeDevice: HeraldActiveDevice | null;
  devices: HeraldDeviceInfo[];
}
export interface HeraldSpeakingReport {
  /** `start` also serves as the ~1 s heartbeat while playing. */
  state: 'start' | 'end';
  /** One id per stretch of playback (start .. end). */
  utteranceId: string;
  /** Epoch ms (sender's clock) playback is expected to end; an estimate. */
  approxEndAt?: number;
  /** Epoch ms (sender's clock) of this report: re-bases approxEndAt across clock skew. */
  sentAt?: number;
}
export interface HeraldSpeakingSignal {
  /** True: playing (start / heartbeat). False: ended, stopped, timed out or disconnected. */
  active: boolean;
  deviceId: string;
  label: string;
  utteranceId: string;
  /** Expected ms of playback left when the hub sent this (0 = unknown / ended). */
  remainingMs: number;
}
/** Stop Herald speaking on another device. `deviceId` absent = whichever device is speaking. */
export interface HeraldStopSpeakingRequest {
  deviceId?: string;
}
export interface HeraldStopSpeakingResult {
  /** A stop went to a speaking device. */
  stopped: boolean;
  deviceId?: string;
}
export interface HeraldVoiceInfo {
  id: string;
  name: string;
  lang: string;
  gender: string;
}
export interface HeraldVoiceStatus {
  /** Voice service reachable from the daemon. */
  available: boolean;
  tts: {
    ready: boolean;
    voices: HeraldVoiceInfo[];
    defaultVoice: string | null;
    sampleRate: number;
  };
  stt: { ready: boolean; model: string | null };
  wake: { ready: boolean; models: string[] };
  /** This client currently holds hands-free (wake word) mode. */
  handsFreeOwner: boolean;
}
export interface HeraldTtsRequest {
  text: string;
  voice?: string | null;
  /** 0.5 - 2, 1 = normal. */
  speed?: number;
}
export interface HeraldTtsResult {
  /** Base64 PCM16LE mono. */
  audio: string;
  sampleRate: number;
  audioMs: number;
  synthMs: number;
}
export type HeraldVoiceStreamPurpose = 'stt' | 'wake';
export interface HeraldVoiceStreamStart {
  streamId: string;
  purpose: HeraldVoiceStreamPurpose;
  /** Always 16000: the browser resamples before sending. */
  sampleRate: number;
}
export interface HeraldVoiceAudioChunk {
  streamId: string;
  seq: number;
  /** Base64 PCM16LE mono 16 kHz. */
  pcm: string;
}
export interface HeraldVoiceStreamEnd {
  streamId: string;
  action: 'transcribe' | 'discard';
}
export interface HeraldSttResult {
  /** Transcript; for a woken wake stream, with the wake phrase stripped. */
  text: string;
  audioMs: number;
  sttMs: number;
  /** Wake streams: the wake word was heard in this stream. */
  woke: boolean;
}
export type HeraldVoiceEvent =
  | { kind: 'wake'; streamId: string; score: number; model: string }
  | { kind: 'stream_error'; streamId: string; error: string }
  | { kind: 'handsfree_revoked' }
  /** This client became (true) or stopped being (false) the device that plays inbox tones. */
  | { kind: 'announcer'; owner: boolean };
// --- end voice protocol ---
