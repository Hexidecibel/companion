export type InboxPriority = 'blocked' | 'finished' | 'progress';
export type HeraldActionTier = 'echo' | 'hard_confirm';
export interface HeraldSessionRef { serverId: string; sessionId: string; sessionName: string; }
export interface HeraldInboxItem {
  id: string; serverId: string; sessionId: string; sessionName: string;
  priority: InboxPriority;
  headline: string;
  createdAt: number; heard: boolean;
}
/** voice = push-to-talk / talk-over / hands-free; text = typed. Voice replies are kept shorter. */
export type HeraldInputMode = 'voice' | 'text';
/** A spoken command turned into a structured brain request. */
export type HeraldIntent = 'shorter' | 'more' | 'brief';
/** Reply length. `auto` = brief for voice, normal for text. */
export type HeraldVerbosity = 'auto' | 'brief' | 'normal' | 'detailed';
/** herald_send payload. Unknown mode / intent values are ignored by the daemon. */
export interface HeraldSendRequest {
  text: string;
  mode?: HeraldInputMode;
  intent?: HeraldIntent;
}
export interface HeraldMessage {
  id: string; role: 'user' | 'herald'; text: string; createdAt: number;
  sessionRefs?: HeraldSessionRef[];
  actionIds?: string[];
  streaming?: boolean;
  intent?: HeraldIntent;  // user lines sent as a voice command (rendered as a chip)
}
export interface HeraldAction {
  id: string; tier: HeraldActionTier;
  kind: 'send_input' | 'answer_choice' | 'cush_command';  // cush_command: payload is the command line, no session
  serverId: string; sessionId: string; sessionName: string;
  payload: string;
  readback: string;
  reasons: string[];
  status: 'pending' | 'sent' | 'cancelled' | 'failed' | 'expired';
  autoSendAt?: number;   // echo tier: server auto-sends at this epoch ms
  error?: string; createdAt: number; resolvedAt?: number;
}
export interface HeraldState {
  displayName: string;
  enabled: boolean; disabledReason?: string;
  model: string;
  busy: boolean;
  messages: HeraldMessage[];
  inbox: HeraldInboxItem[];
  actions: HeraldAction[];
  verbosity?: HeraldVerbosity;  // persisted on the hub; absent on older daemons
  /** The device that acts (tones, triggers, hands-free); absent on older daemons. */
  activeDevice?: HeraldActiveDevice | null;
  /** Connected Herald devices (those that reported presence). */
  devices?: HeraldDeviceInfo[];
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
  /** Remote trigger, sent ONLY to the active device (see HeraldTriggerAction). */
  | { kind: 'trigger'; action: HeraldTriggerAction; id: string }
  /** The active device or the device list changed (broadcast). */
  | { kind: 'devices'; activeDevice: HeraldActiveDevice | null; devices: HeraldDeviceInfo[] }
  | { kind: 'error'; error: string };
/** herald_set_verbosity payload; answered with { verbosity }. */
export interface HeraldSetVerbosityRequest {
  verbosity: HeraldVerbosity;
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
 *   toggle - Herald speaking: stop; otherwise listen (the one-button default)
 *   claim  - make `device` (a label or id) the active device; pinned unless pin=false
 */
export type HeraldTriggerAction = 'brief' | 'listen' | 'stop' | 'repeat' | 'toggle' | 'claim';
/** herald_trigger payload and the POST /herald/trigger JSON body. */
export interface HeraldTriggerRequest {
  action: HeraldTriggerAction;
  /** claim only: the device to make active, by label (case-insensitive) or id. */
  device?: string;
  /** claim only: keep it active against other devices' activity (default true). */
  pin?: boolean;
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
  | 'unavailable';

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
 * Per-client pushes arrive as `herald_voice_event` with a HeraldVoiceEvent payload.
 *
 * ONE device is active (the announcer): it plays inbox tones, runs hands-free
 * and receives remote triggers. A device claimed by hand wins (pinned: until
 * another device claims or it disconnects; unpinned: until another device is
 * used); else the hands-free device; else the one the user touched last; else
 * the one seen last. Clients report presence on connect / when shown
 * (interacted: false) and on use (true). The active device and the device list
 * reach everyone as a `devices` herald_event (and in HeraldState).
 */
export interface HeraldPresence {
  /** The user just used this device (a key press or tap), not merely opened it. */
  interacted: boolean;
  /** Friendly name, e.g. "Chrome on Windows" (auto-detected, user-editable). */
  label?: string;
  /** Stable random id of this browser / app install: a pin survives a quick reconnect. */
  deviceKey?: string;
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
