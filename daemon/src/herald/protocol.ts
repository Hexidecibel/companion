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
