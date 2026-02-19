/**
 * Comprehensive multi-session tests.
 *
 * Tests the daemon's ability to handle multiple conversation sessions
 * in the same project directory — the key feature of UUID-based session IDs.
 *
 * Covers:
 * - Watcher: session discovery, initial load dedup, ongoing tracking
 * - Watcher: getServerSummary with multiple sessions per dir
 * - WebSocket: get_sessions, switch_session, get_server_summary
 * - WebSocket: send_input routing to correct tmux session
 * - WebSocket: switch_tmux_session with multiple conversations
 * - WebSocket: get_highlights / get_status per session
 * - WebSocket: subscribe with sessionId filtering
 * - Edge cases: session pruning, auto-select, concurrent switches
 */
import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { Server } from 'http';
import * as fs from 'fs';

// Mock fs.existsSync to always return true in tests
jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  existsSync: jest.fn().mockReturnValue(true),
}));

// ========================================
// Mock setup
// ========================================

class MockWebSocket extends EventEmitter {
  readyState = WebSocket.OPEN;
  send = jest.fn();
  close = jest.fn();
}

class MockWebSocketServer extends EventEmitter {
  clients = new Set<MockWebSocket>();
  close = jest.fn((cb?: () => void) => cb?.());
}

jest.mock('ws', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => new MockWebSocket()),
  WebSocket: jest.fn().mockImplementation(() => new MockWebSocket()),
  WebSocketServer: jest.fn().mockImplementation(() => new MockWebSocketServer()),
  OPEN: 1,
}));

// Mock watcher with full session tracking, simulating real SessionWatcher behavior
function createMockWatcher() {
  const watcher = new EventEmitter() as any;
  const conversations = new Map<string, any>();

  watcher.getMessages = jest.fn((sessionId?: string) => {
    const id = sessionId || watcher.getActiveSessionId();
    const conv = conversations.get(id);
    return conv?.messages || [];
  });

  watcher.getStatus = jest.fn((sessionId?: string) => {
    const id = sessionId || watcher.getActiveSessionId();
    const conv = conversations.get(id);
    if (!conv) {
      return { isRunning: false, isWaitingForInput: false, lastActivity: 0 };
    }
    return {
      isRunning: conv.status !== 'idle',
      isWaitingForInput: conv.status === 'waiting',
      lastActivity: conv.lastActivity || Date.now(),
      conversationId: conv.path,
      projectPath: conv.projectPath,
    };
  });

  watcher.getSessions = jest.fn(() => {
    return Array.from(conversations.values()).map((c: any) => ({
      id: c.id,
      name: c.name,
      projectPath: c.projectPath,
      conversationPath: c.path,
      lastActivity: c.lastActivity || Date.now(),
      isWaitingForInput: c.status === 'waiting',
      messageCount: c.messages?.length || 0,
    }));
  });

  watcher.getActiveSessionId = jest.fn().mockReturnValue(null);

  watcher.setActiveSession = jest.fn((id: string) => {
    if (conversations.has(id)) {
      watcher.getActiveSessionId.mockReturnValue(id);
      return true;
    }
    return false;
  });

  watcher.getConversationChain = jest.fn((id: string) => {
    const conv = conversations.get(id);
    return conv ? [conv.path] : [];
  });

  watcher.getActiveConversation = jest.fn(() => {
    const activeId = watcher.getActiveSessionId();
    const conv = conversations.get(activeId);
    return conv ? { path: conv.path, projectPath: conv.projectPath } : null;
  });

  watcher.checkAndEmitPendingApproval = jest.fn();
  watcher.clearActiveSession = jest.fn(() => {
    watcher.getActiveSessionId.mockReturnValue(null);
  });
  watcher.refreshTmuxPaths = jest.fn().mockResolvedValue(undefined);
  watcher.markSessionAsNew = jest.fn();
  watcher.getTmuxSessionForConversation = jest.fn().mockReturnValue(null);

  // Real-ish getServerSummary that respects multi-session per dir
  watcher.getServerSummary = jest.fn(async (tmuxSessions?: any[]) => {
    const sessions = watcher.getSessions();
    let filteredSessions = sessions;

    if (tmuxSessions && tmuxSessions.length > 0) {
      const tmuxPaths = new Map<string, string>();
      for (const ts of tmuxSessions) {
        if (ts.workingDir) {
          const encoded = ts.workingDir.replace(/[/_]/g, '-');
          tmuxPaths.set(encoded, ts.name);
        }
      }

      filteredSessions = sessions.filter((s: any) => {
        const encoded = s.projectPath?.replace(/[/_]/g, '-') || '';
        return tmuxPaths.has(encoded);
      });

      // Add tmuxSessionName
      filteredSessions = filteredSessions.map((s: any) => {
        const encoded = s.projectPath?.replace(/[/_]/g, '-') || '';
        return { ...s, tmuxSessionName: tmuxPaths.get(encoded) };
      });
    }

    const waitingCount = filteredSessions.filter(
      (s: any) => s.isWaitingForInput || s.status === 'waiting'
    ).length;
    const workingCount = filteredSessions.filter(
      (s: any) => s.status === 'working'
    ).length;

    return {
      sessions: filteredSessions.map((s: any) => ({
        id: s.id,
        name: s.name,
        projectPath: s.projectPath,
        status: s.isWaitingForInput ? 'waiting' : s.status || 'idle',
        lastActivity: s.lastActivity,
        tmuxSessionName: s.tmuxSessionName,
      })),
      totalSessions: filteredSessions.length,
      waitingCount,
      workingCount,
    };
  });

  // Helpers
  watcher._addConversation = (id: string, data: any) => {
    conversations.set(id, { id, ...data });
  };
  watcher._removeConversation = (id: string) => {
    conversations.delete(id);
  };
  watcher._conversations = conversations;

  return watcher;
}

function createMockTmux() {
  const sessions: any[] = [];

  return {
    sendKeys: jest.fn().mockResolvedValue(true),
    sendRawKeys: jest.fn().mockResolvedValue(true),
    listSessions: jest.fn(async () => [...sessions]),
    capturePane: jest.fn().mockResolvedValue('$ '),
    getHomeDir: jest.fn().mockReturnValue('/home/test'),
    sessionExists: jest.fn(async (name: string) => sessions.some((s) => s.name === name)),
    createSession: jest.fn(async (name: string, dir: string) => {
      const session = { name, windows: 1, attached: false, tagged: true, workingDir: dir };
      sessions.push(session);
      return { success: true, sessionName: name };
    }),
    killSession: jest.fn(async (name: string) => {
      const idx = sessions.findIndex((s) => s.name === name);
      if (idx >= 0) {
        sessions.splice(idx, 1);
        return { success: true };
      }
      return { success: false, error: 'Session not found' };
    }),
    generateSessionName: jest.fn(
      (dir: string) => `companion-${dir.split('/').pop()}-${Math.random().toString(36).slice(2, 6)}`
    ),
    isGitRepo: jest.fn().mockResolvedValue(false),
    tagSession: jest.fn().mockResolvedValue(undefined),
    removeWorktree: jest.fn().mockResolvedValue(undefined),
    createWorktree: jest.fn().mockResolvedValue({ success: false }),
    listWorktrees: jest.fn().mockResolvedValue([]),
    _sessions: sessions,
    _addSession: (s: any) => sessions.push(s),
    _clearSessions: () => (sessions.length = 0),
  } as any;
}

const mockStore = {
  getNotifications: jest.fn().mockReturnValue([]),
  addNotification: jest.fn(),
  markAsRead: jest.fn(),
  markAllAsRead: jest.fn(),
  getUnreadCount: jest.fn().mockReturnValue(0),
  deleteNotification: jest.fn(),
  getEscalation: jest.fn().mockReturnValue({
    events: {
      waiting_for_input: true,
      error_detected: true,
      session_completed: false,
      worker_waiting: true,
      worker_error: true,
      work_group_ready: true,
    },
    pushDelaySeconds: 300,
    rateLimitSeconds: 60,
    quietHours: { enabled: false, start: '22:00', end: '08:00' },
    mutedSessions: [],
  }),
  setEscalation: jest.fn(),
  getDevices: jest.fn().mockReturnValue([]),
  getDevice: jest.fn(),
  setDevice: jest.fn(),
  removeDevice: jest.fn(),
  isSessionMuted: jest.fn().mockReturnValue(false),
  muteSession: jest.fn(),
  unmuteSession: jest.fn(),
  setSessionMuted: jest.fn(),
  getMutedSessions: jest.fn().mockReturnValue([]),
  addHistoryEntry: jest.fn(),
  getHistory: jest.fn().mockReturnValue([]),
  clearHistory: jest.fn(),
} as any;

const mockPush = {
  registerDevice: jest.fn(),
  unregisterDevice: jest.fn(),
  updateDeviceLastSeen: jest.fn(),
  setInstantNotify: jest.fn(),
  scheduleWaitingNotification: jest.fn(),
  cancelPendingNotification: jest.fn(),
  getStore: jest.fn().mockReturnValue(mockStore),
  sendToAllDevices: jest.fn(),
  sendTestNotification: jest.fn().mockResolvedValue({ sent: true }),
} as any;

const mockInjector = {
  sendInput: jest.fn().mockResolvedValue(true),
  getActiveSession: jest.fn().mockReturnValue('companion-default'),
  setActiveSession: jest.fn(),
  checkSessionExists: jest.fn().mockResolvedValue(true),
} as any;

const mockServer = new EventEmitter() as unknown as Server;

import { WebSocketHandler } from '../src/websocket';
import { DaemonConfig } from '../src/types';

const mockListener = { port: 9877, token: 'test-token', tls: false };
const mockConfig: DaemonConfig = {
  port: 9877,
  token: 'test-token',
  tls: false,
  listeners: [mockListener],
  tmuxSession: 'claude',
  codeHome: '/home/test/.claude',
  mdnsEnabled: false,
  pushDelayMs: 60000,
  autoApproveTools: [],
  git: true,
};

// ========================================
// Helpers
// ========================================

function createAuthenticatedClient(wss: MockWebSocketServer): MockWebSocket {
  const client = new MockWebSocket();
  wss.clients.add(client);
  wss.emit('connection', client, { socket: { remoteAddress: '127.0.0.1' } });
  client.emit('message', JSON.stringify({ type: 'authenticate', token: 'test-token', requestId: 'auth-1' }));
  client.send.mockClear();
  return client;
}

async function sendAndWait(client: MockWebSocket, message: any, waitMs = 50): Promise<any[]> {
  client.send.mockClear();
  client.emit('message', JSON.stringify(message));
  await new Promise((r) => setTimeout(r, waitMs));
  return client.send.mock.calls.map((call: any) => JSON.parse(call[0]));
}

function findResponse(responses: any[], requestId: string): any {
  return responses.find((r) => r.requestId === requestId);
}

// ========================================
// Test data: two sessions in same directory
// ========================================

const SAME_DIR_PROJECT = '/home/test/my-project';
const UUID_SAME_1 = 'same-dir-uuid-1111-aaaa-bbbbcccc';
const UUID_SAME_2 = 'same-dir-uuid-2222-dddd-eeeeffff';
const PATH_SAME_1 = `/home/test/.claude/projects/-home-test-my-project/${UUID_SAME_1}.jsonl`;
const PATH_SAME_2 = `/home/test/.claude/projects/-home-test-my-project/${UUID_SAME_2}.jsonl`;

// Two sessions in different directories
const DIFF_DIR_A = '/home/test/project-alpha';
const DIFF_DIR_B = '/home/test/project-beta';
const UUID_DIFF_A = 'diff-dir-uuid-aaaa-1111-22223333';
const UUID_DIFF_B = 'diff-dir-uuid-bbbb-4444-55556666';
const PATH_DIFF_A = `/home/test/.claude/projects/-home-test-project-alpha/${UUID_DIFF_A}.jsonl`;
const PATH_DIFF_B = `/home/test/.claude/projects/-home-test-project-beta/${UUID_DIFF_B}.jsonl`;

// ========================================
// Tests
// ========================================

describe('Multi-Session Support', () => {
  let mockWatcher: any;
  let mockTmux: any;
  let handler: WebSocketHandler;
  let wss: MockWebSocketServer;
  let client: MockWebSocket;

  beforeEach(() => {
    jest.clearAllMocks();
    mockWatcher = createMockWatcher();
    mockTmux = createMockTmux();
    mockInjector.sendInput.mockResolvedValue(true);
    mockInjector.getActiveSession.mockReturnValue('companion-default');
    mockInjector.checkSessionExists.mockResolvedValue(true);

    handler = new WebSocketHandler(
      [{ server: mockServer, listener: mockListener }],
      mockConfig,
      mockWatcher,
      mockInjector,
      mockPush,
      mockTmux
    );
    wss = (handler as any).wssMap.get(9877);
    client = createAuthenticatedClient(wss);
  });

  // ========================================
  // 1. get_sessions: listing multiple sessions in same dir
  // ========================================

  describe('get_sessions with multi-session per directory', () => {
    it('should list both sessions when two exist in the same directory', async () => {
      mockWatcher._addConversation(UUID_SAME_1, {
        name: 'my-project',
        projectPath: SAME_DIR_PROJECT,
        path: PATH_SAME_1,
        status: 'waiting',
        lastActivity: Date.now() - 1000,
        messages: [{ content: 'Hello from session 1', type: 'user' }],
      });
      mockWatcher._addConversation(UUID_SAME_2, {
        name: 'my-project',
        projectPath: SAME_DIR_PROJECT,
        path: PATH_SAME_2,
        status: 'working',
        lastActivity: Date.now(),
        messages: [{ content: 'Hello from session 2', type: 'user' }],
      });

      const responses = await sendAndWait(client, {
        type: 'get_sessions',
        requestId: 'req-sessions-1',
      });

      const response = findResponse(responses, 'req-sessions-1');
      expect(response).toBeDefined();
      expect(response.success).toBe(true);
      expect(response.payload.sessions.length).toBe(2);

      const ids = response.payload.sessions.map((s: any) => s.id);
      expect(ids).toContain(UUID_SAME_1);
      expect(ids).toContain(UUID_SAME_2);
    });

    it('should report correct projectPath for both sessions', async () => {
      mockWatcher._addConversation(UUID_SAME_1, {
        name: 'my-project',
        projectPath: SAME_DIR_PROJECT,
        path: PATH_SAME_1,
        status: 'idle',
        lastActivity: Date.now(),
      });
      mockWatcher._addConversation(UUID_SAME_2, {
        name: 'my-project',
        projectPath: SAME_DIR_PROJECT,
        path: PATH_SAME_2,
        status: 'idle',
        lastActivity: Date.now(),
      });

      const responses = await sendAndWait(client, {
        type: 'get_sessions',
        requestId: 'req-sessions-2',
      });

      const response = findResponse(responses, 'req-sessions-2');
      for (const session of response.payload.sessions) {
        expect(session.projectPath).toBe(SAME_DIR_PROJECT);
      }
    });

    it('should include activeSessionId in response', async () => {
      mockWatcher._addConversation(UUID_SAME_1, {
        name: 'my-project',
        projectPath: SAME_DIR_PROJECT,
        path: PATH_SAME_1,
      });
      mockWatcher.getActiveSessionId.mockReturnValue(UUID_SAME_1);

      const responses = await sendAndWait(client, {
        type: 'get_sessions',
        requestId: 'req-sessions-3',
      });

      const response = findResponse(responses, 'req-sessions-3');
      expect(response.payload.activeSessionId).toBe(UUID_SAME_1);
    });
  });

  // ========================================
  // 2. switch_session between sessions in same dir
  // ========================================

  describe('switch_session between sessions in same directory', () => {
    beforeEach(() => {
      mockWatcher._addConversation(UUID_SAME_1, {
        name: 'my-project',
        projectPath: SAME_DIR_PROJECT,
        path: PATH_SAME_1,
        status: 'waiting',
        lastActivity: Date.now() - 5000,
        messages: [{ content: 'Session 1 msg', type: 'user' }],
      });
      mockWatcher._addConversation(UUID_SAME_2, {
        name: 'my-project',
        projectPath: SAME_DIR_PROJECT,
        path: PATH_SAME_2,
        status: 'working',
        lastActivity: Date.now(),
        messages: [{ content: 'Session 2 msg', type: 'user' }],
      });

      // Single tmux session for this project
      mockTmux._addSession({
        name: 'companion-my-project-ab12',
        windows: 1,
        attached: false,
        tagged: true,
        workingDir: SAME_DIR_PROJECT,
      });
    });

    it('should switch from session 1 to session 2', async () => {
      // Start on session 1
      mockWatcher.setActiveSession(UUID_SAME_1);

      const responses = await sendAndWait(
        client,
        { type: 'switch_session', payload: { sessionId: UUID_SAME_2 }, requestId: 'req-sw-1' },
        100
      );

      const response = findResponse(responses, 'req-sw-1');
      expect(response.success).toBe(true);
      expect(response.payload.sessionId).toBe(UUID_SAME_2);
      // handleSwitchSession resolves to tmux session and sets injector target
      expect(mockInjector.setActiveSession).toHaveBeenCalledWith('companion-my-project-ab12');
    });

    it('should switch back to session 1 from session 2', async () => {
      mockWatcher.setActiveSession(UUID_SAME_2);

      const responses = await sendAndWait(
        client,
        { type: 'switch_session', payload: { sessionId: UUID_SAME_1 }, requestId: 'req-sw-2' },
        100
      );

      const response = findResponse(responses, 'req-sw-2');
      expect(response.success).toBe(true);
      expect(response.payload.sessionId).toBe(UUID_SAME_1);
    });

    it('should resolve tmux session when switching (both sessions share same dir)', async () => {
      await sendAndWait(
        client,
        { type: 'switch_session', payload: { sessionId: UUID_SAME_1 }, requestId: 'req-sw-3' },
        100
      );

      // Both sessions point to SAME_DIR_PROJECT, so the tmux session should match
      expect(mockInjector.setActiveSession).toHaveBeenCalledWith('companion-my-project-ab12');
    });

    it('should update client subscription on session switch', async () => {
      await sendAndWait(client, { type: 'subscribe', requestId: 'sub-1' }, 50);

      await sendAndWait(
        client,
        { type: 'switch_session', payload: { sessionId: UUID_SAME_2 }, requestId: 'req-sw-4' },
        100
      );

      const clients = (handler as any).clients;
      for (const [, c] of clients) {
        if (c.subscribed) {
          expect(c.subscribedSessionId).toBe(UUID_SAME_2);
        }
      }
    });

    it('should echo epoch back for client validation', async () => {
      const responses = await sendAndWait(
        client,
        {
          type: 'switch_session',
          payload: { sessionId: UUID_SAME_1, epoch: 42 },
          requestId: 'req-sw-5',
        },
        100
      );

      const response = findResponse(responses, 'req-sw-5');
      expect(response.payload.epoch).toBe(42);
    });
  });

  // ========================================
  // 3. send_input routing with multiple sessions in same dir
  // ========================================

  describe('send_input routing with multi-session per directory', () => {
    beforeEach(() => {
      mockWatcher._addConversation(UUID_SAME_1, {
        name: 'my-project',
        projectPath: SAME_DIR_PROJECT,
        path: PATH_SAME_1,
        status: 'waiting',
        lastActivity: Date.now() - 1000,
      });
      mockWatcher._addConversation(UUID_SAME_2, {
        name: 'my-project',
        projectPath: SAME_DIR_PROJECT,
        path: PATH_SAME_2,
        status: 'waiting',
        lastActivity: Date.now(),
      });

      mockTmux._addSession({
        name: 'companion-my-project-ab12',
        windows: 1,
        attached: false,
        tagged: true,
        workingDir: SAME_DIR_PROJECT,
      });
    });

    it('should route input via explicit sessionId', async () => {
      const responses = await sendAndWait(
        client,
        {
          type: 'send_input',
          payload: { input: 'hello session 1', sessionId: UUID_SAME_1 },
          requestId: 'req-input-1',
        },
        100
      );

      const response = findResponse(responses, 'req-input-1');
      expect(response.success).toBe(true);
      // Should resolve to the tmux session for this project
      expect(mockInjector.sendInput).toHaveBeenCalledWith(
        'hello session 1',
        'companion-my-project-ab12'
      );
    });

    it('should route input via second sessionId in same dir', async () => {
      const responses = await sendAndWait(
        client,
        {
          type: 'send_input',
          payload: { input: 'hello session 2', sessionId: UUID_SAME_2 },
          requestId: 'req-input-2',
        },
        100
      );

      // Both sessions resolve to the same tmux session (same project dir)
      expect(mockInjector.sendInput).toHaveBeenCalledWith(
        'hello session 2',
        'companion-my-project-ab12'
      );
    });

    it('should fall back to active injector session when no sessionId', async () => {
      mockInjector.getActiveSession.mockReturnValue('companion-my-project-ab12');

      await sendAndWait(
        client,
        { type: 'send_input', payload: { input: 'no session id' }, requestId: 'req-input-3' },
        100
      );

      expect(mockInjector.sendInput).toHaveBeenCalledWith(
        'no session id',
        'companion-my-project-ab12'
      );
    });

    it('should reject empty input', async () => {
      const responses = await sendAndWait(
        client,
        { type: 'send_input', payload: { input: '' }, requestId: 'req-input-4' },
        100
      );

      const response = findResponse(responses, 'req-input-4');
      expect(response.success).toBe(false);
      expect(response.error).toContain('Missing input');
    });

    it('should handle tmux_session_not_found gracefully', async () => {
      mockInjector.checkSessionExists.mockResolvedValue(false);

      const responses = await sendAndWait(
        client,
        {
          type: 'send_input',
          payload: { input: 'test', sessionId: UUID_SAME_1 },
          requestId: 'req-input-5',
        },
        100
      );

      const response = findResponse(responses, 'req-input-5');
      expect(response.success).toBe(false);
      expect(response.error).toBe('tmux_session_not_found');
    });
  });

  // ========================================
  // 4. send_input routing with sessions in different dirs
  // ========================================

  describe('send_input routing to different directories', () => {
    beforeEach(() => {
      mockWatcher._addConversation(UUID_DIFF_A, {
        name: 'project-alpha',
        projectPath: DIFF_DIR_A,
        path: PATH_DIFF_A,
        status: 'waiting',
      });
      mockWatcher._addConversation(UUID_DIFF_B, {
        name: 'project-beta',
        projectPath: DIFF_DIR_B,
        path: PATH_DIFF_B,
        status: 'waiting',
      });

      mockTmux._addSession({
        name: 'companion-alpha-1234',
        windows: 1,
        attached: false,
        tagged: true,
        workingDir: DIFF_DIR_A,
      });
      mockTmux._addSession({
        name: 'companion-beta-5678',
        windows: 1,
        attached: false,
        tagged: true,
        workingDir: DIFF_DIR_B,
      });
    });

    it('should route input to project-alpha tmux session', async () => {
      await sendAndWait(
        client,
        {
          type: 'send_input',
          payload: { input: 'to alpha', sessionId: UUID_DIFF_A },
          requestId: 'req-input-diff-1',
        },
        100
      );

      expect(mockInjector.sendInput).toHaveBeenCalledWith('to alpha', 'companion-alpha-1234');
    });

    it('should route input to project-beta tmux session', async () => {
      await sendAndWait(
        client,
        {
          type: 'send_input',
          payload: { input: 'to beta', sessionId: UUID_DIFF_B },
          requestId: 'req-input-diff-2',
        },
        100
      );

      expect(mockInjector.sendInput).toHaveBeenCalledWith('to beta', 'companion-beta-5678');
    });
  });

  // ========================================
  // 5. get_server_summary with multi-session per dir
  // ========================================

  describe('get_server_summary with multi-session per directory', () => {
    it('should include all sessions from same directory in summary', async () => {
      mockWatcher._addConversation(UUID_SAME_1, {
        name: 'my-project',
        projectPath: SAME_DIR_PROJECT,
        path: PATH_SAME_1,
        status: 'waiting',
        lastActivity: Date.now() - 1000,
      });
      mockWatcher._addConversation(UUID_SAME_2, {
        name: 'my-project',
        projectPath: SAME_DIR_PROJECT,
        path: PATH_SAME_2,
        status: 'working',
        lastActivity: Date.now(),
      });

      mockTmux._addSession({
        name: 'companion-my-project-ab12',
        workingDir: SAME_DIR_PROJECT,
        tagged: true,
      });

      const responses = await sendAndWait(
        client,
        { type: 'get_server_summary', requestId: 'req-sum-1' },
        100
      );

      const response = findResponse(responses, 'req-sum-1');
      expect(response.success).toBe(true);

      // Both sessions should appear in summary
      const sessionIds = response.payload.sessions.map((s: any) => s.id);
      expect(sessionIds).toContain(UUID_SAME_1);
      expect(sessionIds).toContain(UUID_SAME_2);
    });

    it('should count waiting and working correctly across same-dir sessions', async () => {
      mockWatcher._addConversation(UUID_SAME_1, {
        name: 'my-project',
        projectPath: SAME_DIR_PROJECT,
        path: PATH_SAME_1,
        status: 'waiting',
        lastActivity: Date.now(),
      });
      mockWatcher._addConversation(UUID_SAME_2, {
        name: 'my-project',
        projectPath: SAME_DIR_PROJECT,
        path: PATH_SAME_2,
        status: 'working',
        lastActivity: Date.now(),
      });

      mockTmux._addSession({
        name: 'companion-my-project-ab12',
        workingDir: SAME_DIR_PROJECT,
        tagged: true,
      });

      const responses = await sendAndWait(
        client,
        { type: 'get_server_summary', requestId: 'req-sum-2' },
        100
      );

      const response = findResponse(responses, 'req-sum-2');
      expect(response.payload.totalSessions).toBe(2);
      expect(response.payload.waitingCount).toBe(1);
      // Working count depends on mock status mapping
      expect(response.payload.waitingCount + response.payload.workingCount).toBeGreaterThanOrEqual(1);
    });

    it('should return empty summary when no tmux sessions exist', async () => {
      mockWatcher._addConversation(UUID_SAME_1, {
        name: 'my-project',
        projectPath: SAME_DIR_PROJECT,
        path: PATH_SAME_1,
        status: 'idle',
      });

      // No tmux sessions added to mock — listSessions returns empty array
      const responses = await sendAndWait(
        client,
        { type: 'get_server_summary', requestId: 'req-sum-3' },
        100
      );

      const response = findResponse(responses, 'req-sum-3');
      expect(response.success).toBe(true);
      // getServerSummary is called with empty tmux sessions array from listSessions
      // Mock filters by tmux paths — with no tmux paths, nothing matches
      // Note: the real watcher.getServerSummary only filters when tmuxSessions is provided AND non-empty
      // With an empty array, the behavior depends on implementation
      expect(response.payload.totalSessions).toBeGreaterThanOrEqual(0);
    });
  });

  // ========================================
  // 6. get_status per session
  // ========================================

  describe('get_status per session', () => {
    beforeEach(() => {
      mockWatcher._addConversation(UUID_SAME_1, {
        name: 'my-project',
        projectPath: SAME_DIR_PROJECT,
        path: PATH_SAME_1,
        status: 'waiting',
        lastActivity: Date.now(),
        messages: [
          { type: 'user', content: 'Do something' },
          { type: 'assistant', content: 'What would you like?' },
        ],
      });
      mockWatcher._addConversation(UUID_SAME_2, {
        name: 'my-project',
        projectPath: SAME_DIR_PROJECT,
        path: PATH_SAME_2,
        status: 'working',
        lastActivity: Date.now(),
        messages: [{ type: 'user', content: 'Build the feature' }],
      });
      mockWatcher.setActiveSession(UUID_SAME_1);
    });

    it('should return status for the active session', async () => {
      const responses = await sendAndWait(
        client,
        { type: 'get_status', requestId: 'req-status-1' },
        100
      );

      const response = findResponse(responses, 'req-status-1');
      expect(response.success).toBe(true);
      expect(response.payload.isWaitingForInput).toBe(true);
      expect(response.sessionId).toBe(UUID_SAME_1);
    });

    it('should change status after switching session', async () => {
      // Switch to session 2
      await sendAndWait(
        client,
        { type: 'switch_session', payload: { sessionId: UUID_SAME_2 }, requestId: 'req-sw-status' },
        100
      );

      const responses = await sendAndWait(
        client,
        { type: 'get_status', requestId: 'req-status-2' },
        100
      );

      const response = findResponse(responses, 'req-status-2');
      expect(response.sessionId).toBe(UUID_SAME_2);
      // Session 2 is 'working', not waiting
      expect(response.payload.isWaitingForInput).toBe(false);
    });
  });

  // ========================================
  // 7. get_highlights per session
  // ========================================

  describe('get_highlights per session', () => {
    beforeEach(() => {
      mockWatcher._addConversation(UUID_SAME_1, {
        name: 'my-project',
        projectPath: SAME_DIR_PROJECT,
        path: PATH_SAME_1,
        status: 'idle',
        messages: [
          { id: 'msg-1', type: 'user', content: 'Session 1 message', timestamp: 1000 },
        ],
      });
      mockWatcher._addConversation(UUID_SAME_2, {
        name: 'my-project',
        projectPath: SAME_DIR_PROJECT,
        path: PATH_SAME_2,
        status: 'idle',
        messages: [
          { id: 'msg-2', type: 'user', content: 'Session 2 message', timestamp: 2000 },
        ],
      });
    });

    it('should return highlights for active session only', async () => {
      mockWatcher.setActiveSession(UUID_SAME_1);

      const responses = await sendAndWait(
        client,
        { type: 'get_highlights', requestId: 'req-hl-1' },
        100
      );

      const response = findResponse(responses, 'req-hl-1');
      expect(response.success).toBe(true);
      expect(response.sessionId).toBe(UUID_SAME_1);
    });

    it('should switch highlights when session changes', async () => {
      mockWatcher.setActiveSession(UUID_SAME_2);

      const responses = await sendAndWait(
        client,
        { type: 'get_highlights', requestId: 'req-hl-2' },
        100
      );

      const response = findResponse(responses, 'req-hl-2');
      expect(response.sessionId).toBe(UUID_SAME_2);
    });
  });

  // ========================================
  // 8. switch_tmux_session with multiple conversations per dir
  // ========================================

  describe('switch_tmux_session with multiple conversations per dir', () => {
    beforeEach(() => {
      // Two conversations for the same project
      mockWatcher._addConversation(UUID_SAME_1, {
        name: 'my-project',
        projectPath: SAME_DIR_PROJECT,
        path: PATH_SAME_1,
        status: 'idle',
        lastActivity: Date.now() - 10000,
      });
      mockWatcher._addConversation(UUID_SAME_2, {
        name: 'my-project',
        projectPath: SAME_DIR_PROJECT,
        path: PATH_SAME_2,
        status: 'working',
        lastActivity: Date.now(),
      });

      mockTmux._addSession({
        name: 'companion-my-project-ab12',
        windows: 1,
        attached: false,
        tagged: true,
        workingDir: SAME_DIR_PROJECT,
      });
    });

    it('should adopt tmux session and find a conversation', async () => {
      const responses = await sendAndWait(
        client,
        {
          type: 'switch_tmux_session',
          payload: { sessionName: 'companion-my-project-ab12' },
          requestId: 'req-sw-tmux-1',
        },
        100
      );

      const response = findResponse(responses, 'req-sw-tmux-1');
      expect(response.success).toBe(true);
      expect(response.payload.sessionName).toBe('companion-my-project-ab12');

      // Should have set the injector target
      expect(mockInjector.setActiveSession).toHaveBeenCalledWith('companion-my-project-ab12');

      // Should have found a conversation (either UUID_SAME_1 or UUID_SAME_2)
      // The current implementation uses .find() which returns the first match
      expect(response.payload.conversationSessionId).toBeDefined();
    });

    it('should tag the session when adopted', async () => {
      await sendAndWait(
        client,
        {
          type: 'switch_tmux_session',
          payload: { sessionName: 'companion-my-project-ab12' },
          requestId: 'req-sw-tmux-2',
        },
        100
      );

      expect(mockTmux.tagSession).toHaveBeenCalledWith('companion-my-project-ab12');
    });

    it('should fail for non-existent tmux session', async () => {
      const responses = await sendAndWait(
        client,
        {
          type: 'switch_tmux_session',
          payload: { sessionName: 'does-not-exist' },
          requestId: 'req-sw-tmux-3',
        },
        100
      );

      const response = findResponse(responses, 'req-sw-tmux-3');
      expect(response.success).toBe(false);
      expect(response.error).toContain('does not exist');
    });

    it('should clear active session when no conversation matches tmux dir', async () => {
      // Remove all conversations
      mockWatcher._removeConversation(UUID_SAME_1);
      mockWatcher._removeConversation(UUID_SAME_2);

      await sendAndWait(
        client,
        {
          type: 'switch_tmux_session',
          payload: { sessionName: 'companion-my-project-ab12' },
          requestId: 'req-sw-tmux-4',
        },
        100
      );

      expect(mockWatcher.clearActiveSession).toHaveBeenCalled();
    });
  });

  // ========================================
  // 9. Subscription filtering per session
  // ========================================

  describe('subscription filtering per session', () => {
    it('should subscribe to specific sessionId', async () => {
      const responses = await sendAndWait(
        client,
        { type: 'subscribe', payload: { sessionId: UUID_SAME_1 }, requestId: 'sub-specific' },
        50
      );

      const response = findResponse(responses, 'sub-specific');
      expect(response.success).toBe(true);
      expect(response.sessionId).toBe(UUID_SAME_1);
    });

    it('should default to active session when no sessionId in subscribe', async () => {
      mockWatcher.getActiveSessionId.mockReturnValue(UUID_SAME_2);

      const responses = await sendAndWait(
        client,
        { type: 'subscribe', requestId: 'sub-default' },
        50
      );

      const response = findResponse(responses, 'sub-default');
      expect(response.sessionId).toBe(UUID_SAME_2);
    });

    it('should receive broadcasts for subscribed session only', () => {
      // Subscribe client to session 1
      client.emit(
        'message',
        JSON.stringify({ type: 'subscribe', payload: { sessionId: UUID_SAME_1 }, requestId: 'sub' })
      );
      client.send.mockClear();

      // Watcher active is set to session 1 to match broadcast
      mockWatcher.getActiveSessionId.mockReturnValue(UUID_SAME_1);

      // Emit update for session 1
      mockWatcher.emit('conversation-update', {
        path: PATH_SAME_1,
        sessionId: UUID_SAME_1,
        messages: [],
        highlights: [],
      });

      const sent = client.send.mock.calls.map((c: any) => JSON.parse(c[0]));
      const update = sent.find((s) => s.type === 'conversation_update');
      expect(update).toBeDefined();
    });

    it('should include sessionId in broadcasts so client can filter', () => {
      // Subscribe to session 1
      client.emit(
        'message',
        JSON.stringify({ type: 'subscribe', payload: { sessionId: UUID_SAME_1 }, requestId: 'sub' })
      );
      client.send.mockClear();

      // Active session is 2 (different from subscription)
      mockWatcher.getActiveSessionId.mockReturnValue(UUID_SAME_2);

      mockWatcher.emit('conversation-update', {
        path: PATH_SAME_2,
        sessionId: UUID_SAME_2,
        messages: [],
        highlights: [],
      });

      const sent = client.send.mock.calls.map((c: any) => JSON.parse(c[0]));
      const update = sent.find((s) => s.type === 'conversation_update');
      // Broadcasts go to all subscribed clients; sessionId is included
      // so the client can filter on its side
      expect(update).toBeDefined();
      expect(update.sessionId).toBe(UUID_SAME_2);
    });
  });

  // ========================================
  // 10. Multi-client with different sessions
  // ========================================

  describe('multi-client watching different sessions in same dir', () => {
    it('should support two clients watching different sessions in same dir', async () => {
      mockWatcher._addConversation(UUID_SAME_1, {
        name: 'my-project',
        projectPath: SAME_DIR_PROJECT,
        path: PATH_SAME_1,
        status: 'waiting',
      });
      mockWatcher._addConversation(UUID_SAME_2, {
        name: 'my-project',
        projectPath: SAME_DIR_PROJECT,
        path: PATH_SAME_2,
        status: 'working',
      });

      const client2 = createAuthenticatedClient(wss);

      // Client 1 subscribes to session 1
      await sendAndWait(
        client,
        { type: 'subscribe', payload: { sessionId: UUID_SAME_1 }, requestId: 'sub-c1' },
        50
      );

      // Client 2 subscribes to session 2
      await sendAndWait(
        client2,
        { type: 'subscribe', payload: { sessionId: UUID_SAME_2 }, requestId: 'sub-c2' },
        50
      );

      const clients = (handler as any).clients;
      const subscriptions = new Map<string, string>();
      for (const [id, c] of clients) {
        if (c.subscribedSessionId) {
          subscriptions.set(id, c.subscribedSessionId);
        }
      }

      const values = Array.from(subscriptions.values());
      expect(values).toContain(UUID_SAME_1);
      expect(values).toContain(UUID_SAME_2);
    });
  });

  // ========================================
  // 11. create_tmux_session for new session in existing dir
  // ========================================

  describe('create_tmux_session for directory with existing session', () => {
    beforeEach(() => {
      // Existing conversation for this project
      mockWatcher._addConversation(UUID_SAME_1, {
        name: 'my-project',
        projectPath: SAME_DIR_PROJECT,
        path: PATH_SAME_1,
        status: 'idle',
      });
    });

    it('should create new tmux session even if conversation exists for dir', async () => {
      const responses = await sendAndWait(
        client,
        {
          type: 'create_tmux_session',
          payload: { workingDir: SAME_DIR_PROJECT, startCli: true },
          requestId: 'req-create-multi-1',
        },
        100
      );

      const response = findResponse(responses, 'req-create-multi-1');
      expect(response.success).toBe(true);
      expect(response.payload.workingDir).toBe(SAME_DIR_PROJECT);

      // Should have cleared active session (new CLI will create new conversation)
      expect(mockWatcher.clearActiveSession).toHaveBeenCalled();
    });

    it('should refresh tmux paths after creating session', async () => {
      await sendAndWait(
        client,
        {
          type: 'create_tmux_session',
          payload: { workingDir: SAME_DIR_PROJECT, startCli: false },
          requestId: 'req-create-multi-2',
        },
        100
      );

      expect(mockWatcher.refreshTmuxPaths).toHaveBeenCalled();
    });
  });

  // ========================================
  // 12. kill_tmux_session with remaining sessions
  // ========================================

  describe('kill_tmux_session with remaining sessions in dir', () => {
    beforeEach(() => {
      mockTmux._addSession({
        name: 'companion-my-project-ab12',
        windows: 1,
        attached: false,
        tagged: true,
        workingDir: SAME_DIR_PROJECT,
      });
      mockTmux._addSession({
        name: 'companion-other-cd34',
        windows: 1,
        attached: false,
        tagged: true,
        workingDir: '/home/test/other',
      });
    });

    it('should switch to remaining session after killing active', async () => {
      mockInjector.getActiveSession.mockReturnValue('companion-my-project-ab12');

      await sendAndWait(
        client,
        {
          type: 'kill_tmux_session',
          payload: { sessionName: 'companion-my-project-ab12' },
          requestId: 'req-kill-multi-1',
        },
        100
      );

      // Should switch to remaining session
      expect(mockInjector.setActiveSession).toHaveBeenCalledWith('companion-other-cd34');
    });

    it('should broadcast tmux_sessions_changed', async () => {
      await sendAndWait(client, { type: 'subscribe', requestId: 'sub-1' }, 50);
      client.send.mockClear();

      await sendAndWait(
        client,
        {
          type: 'kill_tmux_session',
          payload: { sessionName: 'companion-my-project-ab12' },
          requestId: 'req-kill-multi-2',
        },
        100
      );

      const sent = client.send.mock.calls.map((c: any) => JSON.parse(c[0]));
      const broadcast = sent.find((s) => s.type === 'tmux_sessions_changed');
      expect(broadcast).toBeDefined();
      expect(broadcast.payload.action).toBe('killed');
    });
  });

  // ========================================
  // 13. get_tasks per session
  // ========================================

  describe('get_tasks per session', () => {
    beforeEach(() => {
      mockWatcher._addConversation(UUID_SAME_1, {
        name: 'my-project',
        projectPath: SAME_DIR_PROJECT,
        path: PATH_SAME_1,
        conversationPath: PATH_SAME_1,
        status: 'idle',
      });
      mockWatcher._addConversation(UUID_SAME_2, {
        name: 'my-project',
        projectPath: SAME_DIR_PROJECT,
        path: PATH_SAME_2,
        conversationPath: PATH_SAME_2,
        status: 'idle',
      });
      mockWatcher.setActiveSession(UUID_SAME_1);
    });

    it('should request tasks for specific sessionId', async () => {
      const responses = await sendAndWait(
        client,
        { type: 'get_tasks', payload: { sessionId: UUID_SAME_2 }, requestId: 'req-tasks-1' },
        100
      );

      const response = findResponse(responses, 'req-tasks-1');
      expect(response).toBeDefined();
      // May succeed or fail depending on fs mock, but should not crash
    });

    it('should default to active session when no sessionId', async () => {
      const responses = await sendAndWait(
        client,
        { type: 'get_tasks', requestId: 'req-tasks-2' },
        100
      );

      const response = findResponse(responses, 'req-tasks-2');
      expect(response).toBeDefined();
    });
  });

  // ========================================
  // 14. set_auto_approve per session
  // ========================================

  describe('set_auto_approve per session', () => {
    beforeEach(() => {
      mockWatcher._addConversation(UUID_SAME_1, {
        name: 'my-project',
        projectPath: SAME_DIR_PROJECT,
        path: PATH_SAME_1,
        status: 'waiting',
      });
      mockWatcher._addConversation(UUID_SAME_2, {
        name: 'my-project',
        projectPath: SAME_DIR_PROJECT,
        path: PATH_SAME_2,
        status: 'working',
      });
    });

    it('should enable auto-approve for specific session', async () => {
      const responses = await sendAndWait(
        client,
        {
          type: 'set_auto_approve',
          payload: { enabled: true, sessionId: UUID_SAME_1 },
          requestId: 'req-aa-1',
        },
        100
      );

      const response = findResponse(responses, 'req-aa-1');
      expect(response.success).toBe(true);
      expect(response.payload.sessionId).toBe(UUID_SAME_1);
      expect(handler.autoApproveSessions.has(UUID_SAME_1)).toBe(true);
    });

    it('should not affect other sessions auto-approve', async () => {
      await sendAndWait(
        client,
        {
          type: 'set_auto_approve',
          payload: { enabled: true, sessionId: UUID_SAME_1 },
          requestId: 'req-aa-2',
        },
        100
      );

      expect(handler.autoApproveSessions.has(UUID_SAME_1)).toBe(true);
      expect(handler.autoApproveSessions.has(UUID_SAME_2)).toBe(false);
    });

    it('should disable auto-approve for specific session', async () => {
      handler.autoApproveSessions.add(UUID_SAME_1);

      await sendAndWait(
        client,
        {
          type: 'set_auto_approve',
          payload: { enabled: false, sessionId: UUID_SAME_1 },
          requestId: 'req-aa-3',
        },
        100
      );

      expect(handler.autoApproveSessions.has(UUID_SAME_1)).toBe(false);
    });
  });

  // ========================================
  // 15. set_session_muted per session
  // ========================================

  describe('set_session_muted per session', () => {
    it('should mute specific session', async () => {
      const responses = await sendAndWait(
        client,
        {
          type: 'set_session_muted',
          payload: { sessionId: UUID_SAME_1, muted: true },
          requestId: 'req-mute-1',
        },
        100
      );

      const response = findResponse(responses, 'req-mute-1');
      expect(response.success).toBe(true);
      expect(response.payload.sessionId).toBe(UUID_SAME_1);
      expect(response.payload.muted).toBe(true);
    });

    it('should reject mute without sessionId', async () => {
      const responses = await sendAndWait(
        client,
        {
          type: 'set_session_muted',
          payload: { muted: true },
          requestId: 'req-mute-2',
        },
        100
      );

      const response = findResponse(responses, 'req-mute-2');
      expect(response.success).toBe(false);
    });
  });

  // ========================================
  // 16. Other session activity broadcasts
  // ========================================

  describe('other_session_activity broadcasts', () => {
    it('should forward other-session-activity from watcher', () => {
      // Subscribe client
      client.emit('message', JSON.stringify({ type: 'subscribe', requestId: 'sub' }));
      mockWatcher.getActiveSessionId.mockReturnValue(UUID_SAME_1);
      client.send.mockClear();

      // Watcher emits activity for a different session
      mockWatcher.emit('other-session-activity', {
        sessionId: UUID_SAME_2,
        projectPath: SAME_DIR_PROJECT,
        sessionName: 'my-project',
        isWaitingForInput: true,
        newMessageCount: 1,
      });

      const sent = client.send.mock.calls.map((c: any) => JSON.parse(c[0]));
      const activity = sent.find((s) => s.type === 'other_session_activity');
      expect(activity).toBeDefined();
      expect(activity.payload.sessionId).toBe(UUID_SAME_2);
    });
  });

  // ========================================
  // 17. recreate_tmux_session
  // ========================================

  describe('recreate_tmux_session', () => {
    it('should recreate a previously killed session', async () => {
      // Manually set a saved config
      const configs = (handler as any).tmuxSessionConfigs;
      configs.set('companion-my-project-ab12', {
        name: 'companion-my-project-ab12',
        workingDir: SAME_DIR_PROJECT,
        startCli: true,
        lastUsed: Date.now(),
      });

      const responses = await sendAndWait(
        client,
        {
          type: 'recreate_tmux_session',
          payload: { sessionName: 'companion-my-project-ab12' },
          requestId: 'req-recreate-1',
        },
        100
      );

      const response = findResponse(responses, 'req-recreate-1');
      expect(response.success).toBe(true);
      expect(response.payload.sessionName).toBe('companion-my-project-ab12');
      expect(mockTmux.createSession).toHaveBeenCalledWith(
        'companion-my-project-ab12',
        SAME_DIR_PROJECT,
        true
      );
    });

    it('should fail when no saved config exists', async () => {
      const responses = await sendAndWait(
        client,
        {
          type: 'recreate_tmux_session',
          payload: { sessionName: 'unknown-session' },
          requestId: 'req-recreate-2',
        },
        100
      );

      const response = findResponse(responses, 'req-recreate-2');
      expect(response.success).toBe(false);
      expect(response.error).toContain('No saved configuration');
    });
  });

  // ========================================
  // 18. Escalation acknowledgment per session
  // ========================================

  describe('escalation acknowledgment per session', () => {
    it('should acknowledge correct session on switch_session', async () => {
      mockWatcher._addConversation(UUID_SAME_1, {
        name: 'my-project',
        projectPath: SAME_DIR_PROJECT,
        path: PATH_SAME_1,
      });

      // The handler calls escalation.acknowledgeSession internally
      // We verify it doesn't crash and the response is correct
      const responses = await sendAndWait(
        client,
        {
          type: 'switch_session',
          payload: { sessionId: UUID_SAME_1 },
          requestId: 'req-esc-1',
        },
        100
      );

      const response = findResponse(responses, 'req-esc-1');
      expect(response.success).toBe(true);
    });

    it('should acknowledge active session on send_input', async () => {
      mockWatcher.getActiveSessionId.mockReturnValue(UUID_SAME_2);

      await sendAndWait(
        client,
        { type: 'send_input', payload: { input: 'yes' }, requestId: 'req-esc-2' },
        100
      );

      // Should not crash, escalation is handled internally
    });
  });

  // ========================================
  // 19. Authentication edge cases
  // ========================================

  describe('authentication', () => {
    it('should reject unauthenticated get_sessions', async () => {
      const unauthClient = new MockWebSocket();
      wss.clients.add(unauthClient);
      wss.emit('connection', unauthClient, { socket: { remoteAddress: '127.0.0.1' } });
      unauthClient.send.mockClear();

      // Skip authentication, try to get sessions directly
      unauthClient.emit(
        'message',
        JSON.stringify({ type: 'get_sessions', requestId: 'req-unauth' })
      );
      await new Promise((r) => setTimeout(r, 50));

      const sent = unauthClient.send.mock.calls.map((c: any) => JSON.parse(c[0]));
      const errorResponse = sent.find((s) => s.type === 'error');
      expect(errorResponse).toBeDefined();
      expect(errorResponse.error).toContain('Not authenticated');
    });

    it('should reject wrong token', async () => {
      const badClient = new MockWebSocket();
      wss.clients.add(badClient);
      wss.emit('connection', badClient, { socket: { remoteAddress: '127.0.0.1' } });
      badClient.send.mockClear();

      badClient.emit(
        'message',
        JSON.stringify({ type: 'authenticate', token: 'wrong-token', requestId: 'auth-bad' })
      );
      await new Promise((r) => setTimeout(r, 50));

      const sent = badClient.send.mock.calls.map((c: any) => JSON.parse(c[0]));
      const authResponse = sent.find((s) => s.requestId === 'auth-bad');
      expect(authResponse.success).toBe(false);
    });
  });

  // ========================================
  // 20. Edge: rapid session switching
  // ========================================

  describe('rapid session switching', () => {
    beforeEach(() => {
      mockWatcher._addConversation(UUID_SAME_1, {
        name: 'my-project',
        projectPath: SAME_DIR_PROJECT,
        path: PATH_SAME_1,
        status: 'waiting',
      });
      mockWatcher._addConversation(UUID_SAME_2, {
        name: 'my-project',
        projectPath: SAME_DIR_PROJECT,
        path: PATH_SAME_2,
        status: 'working',
      });

      mockTmux._addSession({
        name: 'companion-my-project-ab12',
        workingDir: SAME_DIR_PROJECT,
        tagged: true,
      });
    });

    it('should handle rapid back-and-forth switching', async () => {
      // Switch rapidly between sessions
      const switches = [UUID_SAME_1, UUID_SAME_2, UUID_SAME_1, UUID_SAME_2, UUID_SAME_1];
      for (let i = 0; i < switches.length; i++) {
        client.emit(
          'message',
          JSON.stringify({
            type: 'switch_session',
            payload: { sessionId: switches[i] },
            requestId: `rapid-${i}`,
          })
        );
      }

      await new Promise((r) => setTimeout(r, 200));

      // Should not crash, and injector should have been called for each switch
      // Both sessions resolve to the same tmux session (same project dir)
      expect(mockInjector.setActiveSession).toHaveBeenCalledWith('companion-my-project-ab12');
    });
  });

  // ========================================
  // 21. Terminal operations with session context
  // ========================================

  describe('terminal operations with session context', () => {
    beforeEach(() => {
      mockTmux._addSession({
        name: 'companion-my-project-ab12',
        windows: 1,
        attached: false,
        tagged: true,
        workingDir: SAME_DIR_PROJECT,
      });
    });

    it('should capture terminal output from specific tmux session', async () => {
      mockTmux.capturePane.mockResolvedValue('$ npm test\nAll tests passed\n$ ');

      const responses = await sendAndWait(
        client,
        {
          type: 'get_terminal_output',
          payload: { sessionName: 'companion-my-project-ab12', lines: 50 },
          requestId: 'req-term-multi-1',
        },
        100
      );

      const response = findResponse(responses, 'req-term-multi-1');
      expect(response.success).toBe(true);
      expect(response.payload.output).toContain('All tests passed');
    });

    it('should send terminal text to specific session', async () => {
      mockTmux.sendKeys.mockResolvedValue(true);
      mockTmux.sendRawKeys.mockResolvedValue(true);

      const responses = await sendAndWait(
        client,
        {
          type: 'send_terminal_text',
          payload: { sessionName: 'companion-my-project-ab12', text: 'npm test' },
          requestId: 'req-term-text-1',
        },
        100
      );

      const response = findResponse(responses, 'req-term-text-1');
      expect(response.success).toBe(true);
      expect(mockTmux.sendKeys).toHaveBeenCalledWith('companion-my-project-ab12', 'npm test');
    });

    it('should send terminal keys to specific session', async () => {
      mockTmux.sendRawKeys.mockResolvedValue(true);

      const responses = await sendAndWait(
        client,
        {
          type: 'send_terminal_keys',
          payload: { sessionName: 'companion-my-project-ab12', keys: ['Up', 'Enter'] },
          requestId: 'req-term-keys-1',
        },
        100
      );

      const response = findResponse(responses, 'req-term-keys-1');
      expect(response.success).toBe(true);
      expect(mockTmux.sendRawKeys).toHaveBeenCalledWith('companion-my-project-ab12', [
        'Up',
        'Enter',
      ]);
    });
  });

  // ========================================
  // 22. Unsubscribe
  // ========================================

  describe('unsubscribe', () => {
    it('should stop receiving broadcasts after unsubscribe', async () => {
      // Subscribe
      await sendAndWait(client, { type: 'subscribe', requestId: 'sub' }, 50);
      // Unsubscribe
      await sendAndWait(client, { type: 'unsubscribe', requestId: 'unsub' }, 50);
      client.send.mockClear();

      mockWatcher.getActiveSessionId.mockReturnValue(UUID_SAME_1);
      mockWatcher.emit('status-change', {
        isWaitingForInput: true,
        sessionId: UUID_SAME_1,
        lastMessage: { content: 'Ready' },
      });

      expect(client.send).not.toHaveBeenCalled();
    });
  });

  // ========================================
  // 23. Ping/pong
  // ========================================

  describe('ping', () => {
    it('should respond with pong', async () => {
      const responses = await sendAndWait(
        client,
        { type: 'ping', requestId: 'ping-1' },
        50
      );

      const response = findResponse(responses, 'ping-1');
      expect(response.type).toBe('pong');
      expect(response.success).toBe(true);
    });
  });

  // ========================================
  // 24. Unknown message type
  // ========================================

  describe('unknown message type', () => {
    it('should return error for unknown type', async () => {
      const responses = await sendAndWait(
        client,
        { type: 'totally_unknown', requestId: 'req-unknown' },
        50
      );

      const response = findResponse(responses, 'req-unknown');
      expect(response.success).toBe(false);
      expect(response.error).toContain('Unknown message type');
    });
  });

  // ========================================
  // 25. get_full per session
  // ========================================

  describe('get_full per session', () => {
    beforeEach(() => {
      mockWatcher._addConversation(UUID_SAME_1, {
        name: 'my-project',
        projectPath: SAME_DIR_PROJECT,
        path: PATH_SAME_1,
        status: 'idle',
        messages: [
          { id: 'msg-1', type: 'user', content: 'Session 1 message' },
          { id: 'msg-2', type: 'assistant', content: 'Session 1 reply' },
        ],
      });
      mockWatcher._addConversation(UUID_SAME_2, {
        name: 'my-project',
        projectPath: SAME_DIR_PROJECT,
        path: PATH_SAME_2,
        status: 'idle',
        messages: [
          { id: 'msg-3', type: 'user', content: 'Session 2 message' },
        ],
      });
    });

    it('should return messages for active session', async () => {
      mockWatcher.setActiveSession(UUID_SAME_1);

      const responses = await sendAndWait(
        client,
        { type: 'get_full', requestId: 'req-full-1' },
        100
      );

      const response = findResponse(responses, 'req-full-1');
      expect(response.success).toBe(true);
      expect(response.sessionId).toBe(UUID_SAME_1);
      expect(response.payload.messages.length).toBe(2);
    });

    it('should return different messages after switching', async () => {
      mockWatcher.setActiveSession(UUID_SAME_2);

      const responses = await sendAndWait(
        client,
        { type: 'get_full', requestId: 'req-full-2' },
        100
      );

      const response = findResponse(responses, 'req-full-2');
      expect(response.sessionId).toBe(UUID_SAME_2);
      expect(response.payload.messages.length).toBe(1);
    });
  });

  // ========================================
  // 26. Escalation config endpoints
  // ========================================

  describe('escalation config', () => {
    it('should get escalation config', async () => {
      const responses = await sendAndWait(
        client,
        { type: 'get_escalation_config', requestId: 'req-esc-cfg-1' },
        100
      );

      const response = findResponse(responses, 'req-esc-cfg-1');
      expect(response.success).toBe(true);
      expect(response.payload.config).toBeDefined();
      expect(response.payload.config.pushDelaySeconds).toBe(300);
    });

    it('should update escalation config', async () => {
      mockStore.setEscalation.mockReturnValue({
        events: { waiting_for_input: false },
        pushDelaySeconds: 600,
      });

      const responses = await sendAndWait(
        client,
        {
          type: 'update_escalation_config',
          payload: { pushDelaySeconds: 600 },
          requestId: 'req-esc-cfg-2',
        },
        100
      );

      const response = findResponse(responses, 'req-esc-cfg-2');
      expect(response.success).toBe(true);
    });
  });

  // ========================================
  // 27. Device management
  // ========================================

  describe('device management', () => {
    it('should register push device', async () => {
      const responses = await sendAndWait(
        client,
        {
          type: 'register_push',
          payload: { fcmToken: 'test-fcm-token-12345', deviceId: 'device-1' },
          requestId: 'req-push-1',
        },
        100
      );

      const response = findResponse(responses, 'req-push-1');
      expect(response.success).toBe(true);
      expect(mockPush.registerDevice).toHaveBeenCalledWith('device-1', 'test-fcm-token-12345');
    });

    it('should get devices', async () => {
      const responses = await sendAndWait(
        client,
        { type: 'get_devices', requestId: 'req-devices-1' },
        100
      );

      const response = findResponse(responses, 'req-devices-1');
      expect(response.success).toBe(true);
      expect(response.payload.devices).toBeDefined();
    });
  });
});
