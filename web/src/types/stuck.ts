// --- stuck protocol v1 ---
// Mirrored byte-for-byte: daemon/src/stuck/protocol.ts <-> web/src/types/stuck.ts. No imports.

/**
 * repeated_failure - the same failure (test, compiler error, error output) keeps recurring
 * loop             - the same tool call with the same result, again and again, nothing changed
 * oscillation      - an edit and its undo, back and forth on the same spot
 * no_progress      - working a long time with no edit and no new text
 * stalled_tool     - one tool call running far longer than normal, its screen unchanged
 */
export type StuckKind =
  | 'repeated_failure'
  | 'loop'
  | 'oscillation'
  | 'no_progress'
  | 'stalled_tool';
export type StuckSeverity = 'medium' | 'high';

export interface StuckFinding {
  /** `<sessionId>|<kind>|<signature>`: stable while the same thing recurs. */
  id: string;
  sessionId: string;
  sessionName: string;
  kind: StuckKind;
  severity: StuckSeverity;
  /** Normalised fingerprint of what recurs (numbers, paths, timestamps stripped), hashed. */
  signature: string;
  /** Deterministic, human: "Same test failing 6 times in 18 min: api.test.ts › retries". */
  summary: string;
  /** Short form for briefings: "same test failing 6 times". */
  headline: string;
  /** Up to 3 short excerpts (commands, error lines), secrets redacted. */
  evidence: string[];
  /** Earliest occurrence that counts (ms). */
  firstSeen: number;
  /** Latest occurrence (ms). */
  lastSeen: number;
  /** Occurrences (no_progress / stalled_tool: minutes). */
  count: number;
  /** uuid of the prompt that opened the turn (a new prompt clears the finding). */
  turnId: string | null;
}

export interface StuckSettings {
  /** Master switch (default on). */
  enabled: boolean;
  /** repeated_failure: occurrences of the same failure ... */
  failureRepeats: number;
  /** ... within this many minutes. */
  failureWindowMin: number;
  /** loop: identical calls with identical results ... */
  loopRepeats: number;
  /** ... within this many minutes. */
  loopWindowMin: number;
  /** oscillation: back-and-forth edits of the same spot ... */
  oscillationFlips: number;
  /** ... within this many minutes. */
  oscillationWindowMin: number;
  /** no_progress: minutes working with no edit and no new text. */
  noProgressMin: number;
  /** Known long commands (builds, installs, test suites) and subagents are exempt up to this many minutes. */
  longCommandCapMin: number;
  /** stalled_tool: a Bash call pending this long with an unchanged screen. */
  stalledBashMin: number;
  /** stalled_tool: any other tool pending this long with an unchanged screen. */
  stalledToolMin: number;
}

export const STUCK_DEFAULTS: StuckSettings = {
  enabled: true,
  failureRepeats: 5,
  failureWindowMin: 30,
  loopRepeats: 5,
  loopWindowMin: 15,
  oscillationFlips: 4,
  oscillationWindowMin: 30,
  noProgressMin: 30,
  longCommandCapMin: 90,
  stalledBashMin: 20,
  stalledToolMin: 10,
};

/** Accepted range per numeric setting: [min, max]. */
export const STUCK_SETTING_RANGES: Record<
  Exclude<keyof StuckSettings, 'enabled'>,
  [number, number]
> = {
  failureRepeats: [3, 50],
  failureWindowMin: [5, 240],
  loopRepeats: [3, 50],
  loopWindowMin: [2, 120],
  oscillationFlips: [3, 50],
  oscillationWindowMin: [5, 240],
  noProgressMin: [5, 480],
  longCommandCapMin: [10, 720],
  stalledBashMin: [5, 480],
  stalledToolMin: [2, 240],
};

export const STUCK_LIMITS = {
  /** Snooze length bounds (minutes). */
  minSnoozeMin: 1,
  maxSnoozeMin: 24 * 60,
  defaultSnoozeMin: 30,
  maxEvidence: 3,
  maxEvidenceChars: 200,
  maxFindings: 50,
} as const;

export type StuckErrorCode =
  | 'unknown_session'
  | 'bad_request'
  | 'unavailable'
  | 'not_found'
  | 'herald_unavailable'
  | 'session_waiting';

// Requests: envelope {type, payload, requestId}. Response: same `type`, {success, payload | error, requestId};
// on failure payload = { code: StuckErrorCode }.

/** stuck_list: every visible finding on this server (snoozed and dismissed ones are left out). */
export interface StuckListResponse {
  findings: StuckFinding[];
  settings: StuckSettings;
}

/** stuck_snooze: quiet for a session (+ kind, else every kind). minutes 0 = lift the snooze. */
export interface StuckSnoozeRequest {
  sessionId: string;
  kind?: StuckKind;
  minutes?: number;
}
export interface StuckSnoozeResponse {
  snoozedUntil: number;
  findings: StuckFinding[];
}

/** stuck_dismiss: "Not stuck": that signature stays quiet for the rest of the session's turn. */
export interface StuckDismissRequest {
  findingId: string;
}
export interface StuckDismissResponse {
  findings: StuckFinding[];
}

/** stuck_ask: ask the session what is going on (through Herald's ask-and-report when it runs). */
export interface StuckAskRequest {
  findingId: string;
}
export interface StuckAskResponse {
  via: 'herald' | 'direct';
  askId: string | null;
  sentText: string;
}

/** stuck_interrupt: proposes Herald's interrupt (echo tier: a short countdown, cancellable). */
export interface StuckInterruptRequest {
  sessionId: string;
}
export interface StuckInterruptResponse {
  actionId: string;
  autoSendAt: number | null;
}

/** stuck_get_settings / stuck_set_settings ({ settings: partial patch }). */
export interface StuckSetSettingsRequest {
  settings: Partial<StuckSettings>;
}
export interface StuckSettingsResponse {
  settings: StuckSettings;
}

/** Event type 'stuck_update': global to every subscribed client, on change only; the full visible list. */
export interface StuckUpdateEvent {
  findings: StuckFinding[];
}
// --- end stuck protocol ---
