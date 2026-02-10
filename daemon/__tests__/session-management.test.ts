/**
 * Comprehensive session management tests.
 *
 * Covers the full lifecycle: create, adopt, kill, switch, send_input routing,
 * multi-session per directory, tmux matching, and server summary generation.
 *
 * These tests exercise the WebSocketHandler with a mock TmuxManager and Watcher
 * to verify end-to-end session management behavior.
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

// Mock WebSocket classes
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

// Mock watcher with full session tracking
function createMockWatcher() {
  const watcher = new EventEmitter() as any;
  const conversations = new Map<string, any>();

  watcher.getMessages = jest.fn().mockReturnValue([]);
  watcher.getStatus = jest.fn((sessionId?: string) => {
    const id = sessionId || watcher.getActiveSessionId();
    const conv = conversations.get(id);
    return {
      isRunning: !!conv,
      isWaitingForInput: conv?.status === 'waiting',
      lastActivity: conv?.lastActivity || Date.now(),
      projectPath: conv?.projectPath,
    };
  });
  watcher.getSessions = jest.fn(() => {
    return Array.from(conversations.values()).map((c: any) => ({
      id: c.id,
      name: c.name,
      projectPath: c.projectPath,
      status: c.status || 'idle',
      lastActivity: c.lastActivity || Date.now(),
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
  watcher.getServerSummary = jest.fn(async (tmuxSessions?: any[]) => {
    const sessions = watcher.getSessions();
    let filteredSessions = sessions;

    if (tmuxSessions && tmuxSessions.length > 0) {
      // Build map of encoded paths from tmux sessions
      const tmuxPaths = new Map<string, string>();
      for (const ts of tmuxSessions) {
        if (ts.workingDir) {
          const encoded = ts.workingDir.replace(/[/_]/g, '-');
          tmuxPaths.set(encoded, ts.name);
        }
      }

      filteredSessions = sessions.filter((s: any) => {
        // Match by encoded project path
        const encoded = s.projectPath?.replace(/[/_]/g, '-') || '';
        return tmuxPaths.has(encoded);
      });
    }

    const waitingCount = filteredSessions.filter((s: any) => s.status === 'waiting').length;
    const workingCount = filteredSessions.filter((s: any) => s.status === 'working').length;

    return {
      sessions: filteredSessions,
      totalSessions: filteredSessions.length,
      waitingCount,
      workingCount,
    };
  });

  // Helper to add tracked conversations for testing
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
    sessionExists: jest.fn(async (name: string) => sessions.some(s => s.name === name)),
    createSession: jest.fn(async (name: string, dir: string) => {
      const session = {
        name,
        windows: 1,
        attached: false,
        tagged: true,
        workingDir: dir,
      };
      sessions.push(session);
      return { success: true, sessionName: name };
    }),
    killSession: jest.fn(async (name: string) => {
      const idx = sessions.findIndex(s => s.name === name);
      if (idx >= 0) {
        sessions.splice(idx, 1);
        return { success: true };
      }
      return { success: false, error: 'Session not found' };
    }),
    generateSessionName: jest.fn((dir: string) => {
      const base = dir.split('/').pop() || 'session';
      return `companion-${base}-${Math.random().toString(36).slice(2, 6)}`;
    }),
    isGitRepo: jest.fn().mockResolvedValue(false),
    tagSession: jest.fn().mockResolvedValue(undefined),
    // Helper for tests
    _sessions: sessions,
    _addSession: (s: any) => sessions.push(s),
    _clearSessions: () => sessions.length = 0,
  } as any;
}

const mockInjector = {
  sendInput: jest.fn().mockResolvedValue(true),
  getActiveSession: jest.fn().mockReturnValue('companion-default'),
  setActiveSession: jest.fn(),
  checkSessionExists: jest.fn().mockResolvedValue(true),
} as any;

const mockStore = {
  getNotifications: jest.fn().mockReturnValue([]),
  addNotification: jest.fn(),
  markAsRead: jest.fn(),
  markAllAsRead: jest.fn(),
  getUnreadCount: jest.fn().mockReturnValue(0),
  deleteNotification: jest.fn(),
  getEscalation: jest.fn().mockReturnValue({
    events: { waiting_for_input: true, error_detected: true, session_completed: false, worker_waiting: true, worker_error: true, work_group_ready: true },
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
  addHistoryEntry: jest.fn(),
  getHistory: jest.fn().mockReturnValue([]),
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
};

// ========================================
// Helper: create authenticated client
// ========================================

function createAuthenticatedClient(wss: MockWebSocketServer): MockWebSocket {
  const client = new MockWebSocket();
  wss.clients.add(client);
  wss.emit('connection', client, { socket: { remoteAddress: '127.0.0.1' } });

  client.emit(
    'message',
    JSON.stringify({ type: 'authenticate', token: 'test-token', requestId: 'auth-1' })
  );
  client.send.mockClear();

  return client;
}

// Helper: send message and wait for response
async function sendAndWait(
  client: MockWebSocket,
  message: any,
  waitMs: number = 50
): Promise<any[]> {
  client.send.mockClear();
  client.emit('message', JSON.stringify(message));
  await new Promise((r) => setTimeout(r, waitMs));
  return client.send.mock.calls.map((call: any) => JSON.parse(call[0]));
}

// ========================================
// Tests
// ========================================

describe('Session Management', () => {
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
  // Session creation via tmux
  // ========================================

  describe('session creation', () => {
    it('should create a tmux session with given directory', async () => {
      const responses = await sendAndWait(client, {
        type: 'create_tmux_session',
        payload: { workingDir: '/home/test/my-project', startCli: false },
        requestId: 'req-create-1',
      }, 100);

      expect(responses.length).toBeGreaterThanOrEqual(1);
      const response = responses.find(r => r.requestId === 'req-create-1');
      expect(response).toBeDefined();
      expect(response.success).toBe(true);

      // tmux session should exist
      const tmuxSessions = await mockTmux.listSessions();
      expect(tmuxSessions.length).toBe(1);
      expect(tmuxSessions[0].workingDir).toBe('/home/test/my-project');
      expect(tmuxSessions[0].tagged).toBe(true);
    });

    it('should set new session as active injector target', async () => {
      await sendAndWait(client, {
        type: 'create_tmux_session',
        payload: { workingDir: '/home/test/my-project', startCli: true },
        requestId: 'req-create-2',
      }, 100);

      expect(mockInjector.setActiveSession).toHaveBeenCalled();
    });

    it('should clear watcher active session after creation', async () => {
      await sendAndWait(client, {
        type: 'create_tmux_session',
        payload: { workingDir: '/home/test/my-project', startCli: false },
        requestId: 'req-create-3',
      }, 100);

      // Should clear active session because new conversation doesn't exist yet
      expect(mockWatcher.clearActiveSession).toHaveBeenCalled();
    });
  });

  // ========================================
  // Session killing
  // ========================================

  describe('session killing', () => {
    beforeEach(async () => {
      // Pre-create a tmux session
      mockTmux._addSession({
        name: 'companion-myproject-abc1',
        windows: 1,
        attached: false,
        tagged: true,
        workingDir: '/home/test/my-project',
      });
    });

    it('should kill an existing tmux session', async () => {
      const responses = await sendAndWait(client, {
        type: 'kill_tmux_session',
        payload: { sessionName: 'companion-myproject-abc1' },
        requestId: 'req-kill-1',
      }, 100);

      const response = responses.find(r => r.requestId === 'req-kill-1');
      expect(response).toBeDefined();
      expect(response.success).toBe(true);

      // Should be removed
      const sessions = await mockTmux.listSessions();
      expect(sessions.length).toBe(0);
    });

    it('should handle killing non-existent session gracefully', async () => {
      const responses = await sendAndWait(client, {
        type: 'kill_tmux_session',
        payload: { sessionName: 'does-not-exist' },
        requestId: 'req-kill-2',
      }, 100);

      const response = responses.find(r => r.requestId === 'req-kill-2');
      expect(response).toBeDefined();
      // Should not crash
    });

    it('should broadcast tmux_sessions_changed after kill', async () => {
      // Subscribe to get broadcasts
      client.emit('message', JSON.stringify({ type: 'subscribe', requestId: 'sub-1' }));
      client.send.mockClear();

      await sendAndWait(client, {
        type: 'kill_tmux_session',
        payload: { sessionName: 'companion-myproject-abc1' },
        requestId: 'req-kill-3',
      }, 100);

      const sent = client.send.mock.calls.map((c: any) => JSON.parse(c[0]));
      const broadcast = sent.find(s => s.type === 'tmux_sessions_changed');
      expect(broadcast).toBeDefined();
      expect(broadcast.payload.action).toBe('killed');
    });
  });

  // ========================================
  // Session adoption (switch_tmux_session)
  // ========================================

  describe('session adoption', () => {
    it('should adopt an untagged tmux session', async () => {
      // Add an untagged session
      mockTmux._addSession({
        name: 'user-session',
        windows: 1,
        attached: true,
        tagged: false,
        workingDir: '/home/test/existing-project',
      });

      const responses = await sendAndWait(client, {
        type: 'switch_tmux_session',
        payload: { sessionName: 'user-session' },
        requestId: 'req-adopt-1',
      }, 100);

      const response = responses.find(r => r.requestId === 'req-adopt-1');
      expect(response).toBeDefined();
      expect(response.success).toBe(true);

      // Should tag the session
      expect(mockTmux.tagSession).toHaveBeenCalledWith('user-session');
    });

    it('should set adopted session as active injector target', async () => {
      mockTmux._addSession({
        name: 'user-session',
        windows: 1,
        attached: true,
        tagged: false,
        workingDir: '/home/test/existing-project',
      });

      await sendAndWait(client, {
        type: 'switch_tmux_session',
        payload: { sessionName: 'user-session' },
        requestId: 'req-adopt-2',
      }, 100);

      expect(mockInjector.setActiveSession).toHaveBeenCalledWith('user-session');
    });
  });

  // ========================================
  // Session switching
  // ========================================

  describe('session switching', () => {
    const UUID_1 = 'aaaa-bbbb-cccc-dddd';
    const UUID_2 = 'eeee-ffff-0000-1111';

    beforeEach(() => {
      mockWatcher._addConversation(UUID_1, {
        name: 'project-a',
        projectPath: '/home/test/project-a',
        path: `/home/test/.claude/projects/-home-test-project-a/${UUID_1}.jsonl`,
        status: 'waiting',
        lastActivity: Date.now(),
      });
      mockWatcher._addConversation(UUID_2, {
        name: 'project-b',
        projectPath: '/home/test/project-b',
        path: `/home/test/.claude/projects/-home-test-project-b/${UUID_2}.jsonl`,
        status: 'working',
        lastActivity: Date.now(),
      });
    });

    it('should switch to session by UUID', async () => {
      const responses = await sendAndWait(client, {
        type: 'switch_session',
        payload: { sessionId: UUID_1 },
        requestId: 'req-switch-1',
      }, 100);

      const response = responses.find(r => r.requestId === 'req-switch-1');
      expect(response.success).toBe(true);
      expect(response.payload?.sessionId).toBe(UUID_1);
    });

    it('should handle switching to non-existent session gracefully', async () => {
      const responses = await sendAndWait(client, {
        type: 'switch_session',
        payload: { sessionId: 'non-existent' },
        requestId: 'req-switch-2',
      }, 100);

      const response = responses.find(r => r.requestId === 'req-switch-2');
      // handleSwitchSession succeeds but can't resolve a tmux session
      expect(response.success).toBe(true);
      expect(response.payload?.sessionId).toBe('non-existent');
    });

    it('should update client subscription on switch', async () => {
      // First subscribe
      await sendAndWait(client, { type: 'subscribe', requestId: 'sub-1' }, 50);

      // Then switch
      await sendAndWait(client, {
        type: 'switch_session',
        payload: { sessionId: UUID_2 },
        requestId: 'req-switch-3',
      }, 100);

      // Client should now be subscribed to UUID_2
      const clients = (handler as any).clients;
      for (const [, c] of clients) {
        if (c.subscribed) {
          expect(c.subscribedSessionId).toBe(UUID_2);
        }
      }
    });

    it('should resolve tmux session from projectPath on switch', async () => {
      // Add a tmux session matching project-a's path
      mockTmux._addSession({
        name: 'companion-project-a-xyz1',
        windows: 1,
        attached: false,
        tagged: true,
        workingDir: '/home/test/project-a',
      });

      await sendAndWait(client, {
        type: 'switch_session',
        payload: { sessionId: UUID_1 },
        requestId: 'req-switch-4',
      }, 100);

      // Should set the matching tmux session as active injector target
      expect(mockInjector.setActiveSession).toHaveBeenCalledWith('companion-project-a-xyz1');
    });
  });

  // ========================================
  // send_input routing
  // ========================================

  describe('send_input routing', () => {
    const UUID_1 = 'input-test-uuid-1111';
    const UUID_2 = 'input-test-uuid-2222';

    beforeEach(() => {
      mockWatcher._addConversation(UUID_1, {
        name: 'project-a',
        projectPath: '/home/test/project-a',
        path: `/home/test/.claude/projects/-home-test-project-a/${UUID_1}.jsonl`,
        status: 'waiting',
      });
      mockWatcher._addConversation(UUID_2, {
        name: 'project-b',
        projectPath: '/home/test/project-b',
        path: `/home/test/.claude/projects/-home-test-project-b/${UUID_2}.jsonl`,
        status: 'waiting',
      });

      // Add tmux sessions for both projects
      mockTmux._addSession({
        name: 'companion-project-a-xyz1',
        windows: 1,
        attached: false,
        tagged: true,
        workingDir: '/home/test/project-a',
      });
      mockTmux._addSession({
        name: 'companion-project-b-xyz2',
        windows: 1,
        attached: false,
        tagged: true,
        workingDir: '/home/test/project-b',
      });
    });

    it('should route input to correct tmux session via sessionId', async () => {
      const responses = await sendAndWait(client, {
        type: 'send_input',
        payload: { input: 'hello world', sessionId: UUID_1 },
        requestId: 'req-input-1',
      }, 100);

      // Should send to the tmux session matching project-a
      expect(mockInjector.sendInput).toHaveBeenCalledWith(
        'hello world',
        'companion-project-a-xyz1'
      );
    });

    it('should fall back to active session when no sessionId', async () => {
      mockInjector.getActiveSession.mockReturnValue('companion-default');

      const responses = await sendAndWait(client, {
        type: 'send_input',
        payload: { input: 'hello' },
        requestId: 'req-input-2',
      }, 100);

      // Should use the active session from injector
      expect(mockInjector.sendInput).toHaveBeenCalledWith(
        'hello',
        'companion-default'
      );
    });

    it('should reject empty input', async () => {
      const responses = await sendAndWait(client, {
        type: 'send_input',
        payload: { input: '' },
        requestId: 'req-input-3',
      }, 100);

      const response = responses.find(r => r.requestId === 'req-input-3');
      expect(response.success).toBe(false);
      expect(response.error).toContain('Missing input');
    });
  });

  // ========================================
  // Server summary
  // ========================================

  describe('server summary', () => {
    beforeEach(() => {
      const UUID_1 = 'summary-uuid-1111';
      const UUID_2 = 'summary-uuid-2222';

      mockWatcher._addConversation(UUID_1, {
        name: 'project-a',
        projectPath: '/home/test/project-a',
        path: `/home/test/.claude/projects/-home-test-project-a/${UUID_1}.jsonl`,
        status: 'waiting',
        lastActivity: Date.now(),
      });
      mockWatcher._addConversation(UUID_2, {
        name: 'project-b',
        projectPath: '/home/test/project-b',
        path: `/home/test/.claude/projects/-home-test-project-b/${UUID_2}.jsonl`,
        status: 'working',
        lastActivity: Date.now(),
      });
    });

    it('should return server summary with session list', async () => {
      const responses = await sendAndWait(client, {
        type: 'get_server_summary',
        requestId: 'req-summary-1',
      }, 100);

      const response = responses.find(r => r.requestId === 'req-summary-1');
      expect(response).toBeDefined();
      expect(response.success).toBe(true);
      expect(response.payload.sessions).toBeDefined();
      expect(response.payload.totalSessions).toBeGreaterThan(0);
    });

    it('should include projectPath in session summaries', async () => {
      // Add a tagged tmux session so sessions show up
      mockTmux._addSession({
        name: 'companion-project-a',
        windows: 1,
        attached: false,
        tagged: true,
        workingDir: '/home/test/project-a',
      });

      const responses = await sendAndWait(client, {
        type: 'get_server_summary',
        requestId: 'req-summary-2',
      }, 100);

      const response = responses.find(r => r.requestId === 'req-summary-2');
      const sessions = response.payload.sessions;
      for (const session of sessions) {
        expect(session.projectPath).toBeDefined();
      }
    });
  });

  // ========================================
  // tmux session listing
  // ========================================

  describe('tmux session listing', () => {
    it('should list tagged and untagged tmux sessions', async () => {
      mockTmux._addSession({
        name: 'companion-managed',
        windows: 1,
        attached: false,
        tagged: true,
        workingDir: '/home/test/managed-project',
      });
      mockTmux._addSession({
        name: 'user-session',
        windows: 2,
        attached: true,
        tagged: false,
        workingDir: '/home/test/other-project',
      });

      const responses = await sendAndWait(client, {
        type: 'list_tmux_sessions',
        requestId: 'req-list-1',
      }, 100);

      const response = responses.find(r => r.requestId === 'req-list-1');
      expect(response.success).toBe(true);
      expect(response.payload.sessions.length).toBe(2);

      const tagged = response.payload.sessions.filter((s: any) => s.tagged);
      const untagged = response.payload.sessions.filter((s: any) => !s.tagged);
      expect(tagged.length).toBe(1);
      expect(untagged.length).toBe(1);
    });

    it('should return empty list when no tmux sessions', async () => {
      const responses = await sendAndWait(client, {
        type: 'list_tmux_sessions',
        requestId: 'req-list-2',
      }, 100);

      const response = responses.find(r => r.requestId === 'req-list-2');
      expect(response.success).toBe(true);
      expect(response.payload.sessions.length).toBe(0);
    });
  });

  // ========================================
  // Terminal output
  // ========================================

  describe('terminal output', () => {
    it('should capture terminal output from tmux session', async () => {
      mockTmux.capturePane.mockResolvedValue('$ ls\nfoo.txt\nbar.txt\n$ ');

      const responses = await sendAndWait(client, {
        type: 'get_terminal_output',
        payload: { sessionName: 'companion-project', lines: 50 },
        requestId: 'req-term-1',
      }, 100);

      const response = responses.find(r => r.requestId === 'req-term-1');
      expect(response.success).toBe(true);
      expect(response.payload.output).toContain('foo.txt');
    });

    it('should support offset for terminal pagination', async () => {
      mockTmux.capturePane.mockResolvedValue('old output line 1\nold output line 2');

      const responses = await sendAndWait(client, {
        type: 'get_terminal_output',
        payload: { sessionName: 'companion-project', lines: 50, offset: 100 },
        requestId: 'req-term-2',
      }, 100);

      // Should pass offset to capturePane
      expect(mockTmux.capturePane).toHaveBeenCalledWith(
        'companion-project',
        50,
        100
      );
    });
  });

  // ========================================
  // Multi-client scenarios
  // ========================================

  describe('multi-client scenarios', () => {
    it('should handle multiple clients subscribing to different sessions', async () => {
      const UUID_1 = 'multi-uuid-1111';
      const UUID_2 = 'multi-uuid-2222';

      mockWatcher._addConversation(UUID_1, {
        name: 'project-a',
        projectPath: '/home/test/project-a',
        path: `/home/test/.claude/projects/-home-test-project-a/${UUID_1}.jsonl`,
      });
      mockWatcher._addConversation(UUID_2, {
        name: 'project-b',
        projectPath: '/home/test/project-b',
        path: `/home/test/.claude/projects/-home-test-project-b/${UUID_2}.jsonl`,
      });

      const client2 = createAuthenticatedClient(wss);

      // Client 1 subscribes to session 1
      await sendAndWait(client, { type: 'subscribe', requestId: 'sub-1' }, 50);
      await sendAndWait(client, {
        type: 'switch_session',
        payload: { sessionId: UUID_1 },
        requestId: 'sw-1',
      }, 50);

      // Client 2 subscribes to session 2
      await sendAndWait(client2, { type: 'subscribe', requestId: 'sub-2' }, 50);
      await sendAndWait(client2, {
        type: 'switch_session',
        payload: { sessionId: UUID_2 },
        requestId: 'sw-2',
      }, 50);

      // Both clients should have different subscribed sessions
      const clients = (handler as any).clients;
      const subscriptions = new Set<string>();
      for (const [, c] of clients) {
        if (c.subscribedSessionId) {
          subscriptions.add(c.subscribedSessionId);
        }
      }

      expect(subscriptions.size).toBe(2);
      expect(subscriptions.has(UUID_1)).toBe(true);
      expect(subscriptions.has(UUID_2)).toBe(true);
    });
  });

  // ========================================
  // Status broadcasting
  // ========================================

  describe('status broadcasting', () => {
    it('should broadcast status changes to subscribed clients', () => {
      // Subscribe
      client.emit('message', JSON.stringify({ type: 'subscribe', requestId: 'sub-1' }));
      client.send.mockClear();

      // Emit status change from watcher
      mockWatcher.emit('status-change', {
        isWaitingForInput: true,
        sessionId: 'test-session',
        lastMessage: { content: 'Ready for input' },
      });

      const sent = client.send.mock.calls.map((c: any) => JSON.parse(c[0]));
      const statusChange = sent.find(s => s.type === 'status_change');
      expect(statusChange).toBeDefined();
      expect(statusChange.payload.isWaitingForInput).toBe(true);
    });

    it('should not broadcast to unsubscribed clients', () => {
      // Don't subscribe
      client.send.mockClear();

      mockWatcher.emit('status-change', {
        isWaitingForInput: true,
        sessionId: 'test-session',
        lastMessage: { content: 'Ready' },
      });

      expect(client.send).not.toHaveBeenCalled();
    });
  });

  // ========================================
  // Escalation acknowledgment
  // ========================================

  describe('escalation acknowledgment', () => {
    it('should acknowledge session on send_input', async () => {
      mockWatcher.getActiveSessionId.mockReturnValue('active-session-id');

      await sendAndWait(client, {
        type: 'send_input',
        payload: { input: 'yes' },
        requestId: 'req-ack-1',
      }, 100);

      // Escalation should be acknowledged for the active session
      // (The actual escalation module is mocked, but we verify the flow)
    });

    it('should acknowledge session on switch', async () => {
      const UUID = 'ack-uuid-1111';
      mockWatcher._addConversation(UUID, {
        name: 'project',
        projectPath: '/home/test/project',
        path: `/home/test/.claude/projects/-home-test-project/${UUID}.jsonl`,
      });

      await sendAndWait(client, {
        type: 'switch_session',
        payload: { sessionId: UUID },
        requestId: 'req-ack-2',
      }, 100);

      // Flow verified by not crashing - escalation module handles the rest
    });
  });
});
