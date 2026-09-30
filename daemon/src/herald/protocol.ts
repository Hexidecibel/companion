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
}
export interface HeraldMessage {
  id: string;
  role: 'user' | 'herald';
  text: string;
  createdAt: number;
  sessionRefs?: HeraldSessionRef[];
  actionIds?: string[];
  streaming?: boolean;
}
export interface HeraldAction {
  id: string;
  tier: HeraldActionTier;
  /** cush_command: a validated cush-tools command (payload = the command line; no session). */
  kind: 'send_input' | 'answer_choice' | 'cush_command';
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
}
export type HeraldEvent =
  | { kind: 'state'; state: HeraldState }
  | { kind: 'message_start'; message: HeraldMessage }
  | { kind: 'message_delta'; messageId: string; delta: string }
  | { kind: 'message_end'; message: HeraldMessage }
  | { kind: 'inbox'; inbox: HeraldInboxItem[] }
  | { kind: 'action'; action: HeraldAction }
  | { kind: 'busy'; busy: boolean }
  | { kind: 'error'; error: string };

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
 * Per-client pushes arrive as `herald_voice_event` with a HeraldVoiceEvent payload.
 */
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
  | { kind: 'handsfree_revoked' };
// --- end voice protocol ---
