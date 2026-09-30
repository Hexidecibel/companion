import type { SessionSnapshot } from '../src/herald/session-source';

export function snap(overrides: Partial<SessionSnapshot> & { sessionId: string }): SessionSnapshot {
  return {
    serverId: 'local',
    sessionName: overrides.sessionId,
    tmuxName: overrides.sessionId,
    projectPath: `/home/u/src/${overrides.sessionId}`,
    projectName: overrides.sessionId,
    status: 'idle',
    inactive: false,
    lastActivity: 1_000,
    pendingChoice: null,
    pendingApproval: null,
    pendingQuestion: null,
    lastTurnKey: null,
    lastTurnGist: null,
    ...overrides,
  };
}
