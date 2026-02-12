import { NotificationStore } from '../notification-store';

// Monkey-patch fs so tests don't touch real state
jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    existsSync: jest.fn((p: string) => {
      if (p.includes('companion-digest-test')) return actual.existsSync(p);
      return false;
    }),
    mkdirSync: jest.fn((p: string, opts: any) => {
      return actual.mkdirSync(p, opts);
    }),
    readFileSync: jest.fn((p: string, enc: string) => actual.readFileSync(p, enc)),
    writeFileSync: jest.fn((p: string, data: string) => actual.writeFileSync(p, data)),
  };
});

describe('NotificationStore.getHistorySince', () => {
  let store: NotificationStore;

  beforeEach(() => {
    // Create a fresh store for each test
    store = new NotificationStore();
  });

  afterEach(() => {
    store.flush();
  });

  it('should return empty array when no history exists', () => {
    const result = store.getHistorySince(0);
    expect(result.entries).toEqual([]);
    expect(result.total).toBe(0);
  });

  it('should return entries after the given timestamp', () => {
    const now = Date.now();

    // Add entries with known timing
    store.addHistoryEntry({
      eventType: 'waiting_for_input',
      sessionId: 'sess-1',
      sessionName: 'Session 1',
      preview: 'First event',
      tier: 'browser',
      acknowledged: false,
    });

    store.addHistoryEntry({
      eventType: 'error_detected',
      sessionId: 'sess-2',
      sessionName: 'Session 2',
      preview: 'Second event',
      tier: 'push',
      acknowledged: false,
    });

    store.addHistoryEntry({
      eventType: 'session_completed',
      sessionId: 'sess-3',
      sessionName: 'Session 3',
      preview: 'Third event',
      tier: 'both',
      acknowledged: true,
    });

    // Get all entries since before anything was added
    const allEntries = store.getHistorySince(now - 1000);
    expect(allEntries.entries.length).toBe(3);
    expect(allEntries.total).toBe(3);

    // Entries should be in chronological order (oldest first)
    expect(allEntries.entries[0].preview).toBe('First event');
    expect(allEntries.entries[2].preview).toBe('Third event');
  });

  it('should return entries after a specific timestamp (filtering old ones)', () => {
    // Add an old entry
    store.addHistoryEntry({
      eventType: 'waiting_for_input',
      sessionId: 'sess-old',
      sessionName: 'Old Session',
      preview: 'Old event',
      tier: 'browser',
      acknowledged: false,
    });

    const midpoint = Date.now() + 1; // Just after the old entry

    // Add newer entries
    store.addHistoryEntry({
      eventType: 'error_detected',
      sessionId: 'sess-new',
      sessionName: 'New Session',
      preview: 'New event',
      tier: 'push',
      acknowledged: false,
    });

    const result = store.getHistorySince(midpoint);
    // Should only contain the newer entry
    expect(result.entries.every((e) => e.timestamp >= midpoint)).toBe(true);
  });

  it('should return empty when since is in the future', () => {
    store.addHistoryEntry({
      eventType: 'waiting_for_input',
      sessionId: 'sess-1',
      sessionName: 'Session 1',
      preview: 'Some event',
      tier: 'browser',
      acknowledged: false,
    });

    const futureTimestamp = Date.now() + 100000;
    const result = store.getHistorySince(futureTimestamp);
    expect(result.entries).toEqual([]);
    expect(result.total).toBe(0);
  });

  it('should group entries by session for digest summary', () => {
    store.addHistoryEntry({
      eventType: 'waiting_for_input',
      sessionId: 'sess-1',
      sessionName: 'Project A',
      preview: 'Waiting for input',
      tier: 'browser',
      acknowledged: false,
    });

    store.addHistoryEntry({
      eventType: 'error_detected',
      sessionId: 'sess-1',
      sessionName: 'Project A',
      preview: 'Error found',
      tier: 'push',
      acknowledged: false,
    });

    store.addHistoryEntry({
      eventType: 'session_completed',
      sessionId: 'sess-2',
      sessionName: 'Project B',
      preview: 'Completed',
      tier: 'browser',
      acknowledged: true,
    });

    const result = store.getHistorySince(0);
    expect(result.entries.length).toBe(3);

    // Verify we can group by sessionId
    const bySession = new Map<string, typeof result.entries>();
    for (const entry of result.entries) {
      const key = entry.sessionId || 'unknown';
      if (!bySession.has(key)) bySession.set(key, []);
      bySession.get(key)!.push(entry);
    }
    expect(bySession.get('sess-1')?.length).toBe(2);
    expect(bySession.get('sess-2')?.length).toBe(1);
  });
});
