export type InboxPriority = 'blocked' | 'finished' | 'progress';
export type HeraldActionTier = 'echo' | 'hard_confirm';
export interface HeraldSessionRef { serverId: string; sessionId: string; sessionName: string; }
export interface HeraldInboxItem {
  id: string; serverId: string; sessionId: string; sessionName: string;
  priority: InboxPriority;
  headline: string;
  createdAt: number; heard: boolean;
}
export interface HeraldMessage {
  id: string; role: 'user' | 'herald'; text: string; createdAt: number;
  sessionRefs?: HeraldSessionRef[];
  actionIds?: string[];
  streaming?: boolean;
}
export interface HeraldAction {
  id: string; tier: HeraldActionTier;
  kind: 'send_input' | 'answer_choice';
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
