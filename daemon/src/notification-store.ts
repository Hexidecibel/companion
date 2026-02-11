import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { v4 as uuidv4 } from 'uuid';
import {
  RegisteredDevice,
  EscalationConfig,
  DEFAULT_ESCALATION_CONFIG,
  NotificationHistoryEntry,
  PersistedNotificationState,
} from './types';

const COMPANION_DIR = path.join(os.homedir(), '.companion');
const STATE_FILE = path.join(COMPANION_DIR, 'notification-state.json');
const HISTORY_FILE = path.join(COMPANION_DIR, 'notification-history.json');

const MAX_HISTORY = 500;
const SAVE_DEBOUNCE_MS = 2000;

export class NotificationStore {
  private escalation: EscalationConfig = { ...DEFAULT_ESCALATION_CONFIG };
  private devices: Map<string, RegisteredDevice> = new Map();
  private mutedSessions: Set<string> = new Set();
  private history: NotificationHistoryEntry[] = [];

  private saveTimer: NodeJS.Timeout | null = null;
  private historySaveTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.ensureDir();
    this.load();
  }

  private ensureDir(): void {
    if (!fs.existsSync(COMPANION_DIR)) {
      fs.mkdirSync(COMPANION_DIR, { recursive: true });
    }
  }

  private load(): void {
    // Load state
    try {
      if (fs.existsSync(STATE_FILE)) {
        const content = fs.readFileSync(STATE_FILE, 'utf-8');
        const raw = JSON.parse(content);

        // Migration: detect old format (has `rules` array)
        if (raw.rules && Array.isArray(raw.rules)) {
          console.log('NotificationStore: Migrating from old rules-based format');
          // Preserve devices and mutedSessions, create default escalation config
          for (const device of raw.devices || []) {
            this.devices.set(device.deviceId, device);
          }
          for (const sessionId of raw.mutedSessions || []) {
            this.mutedSessions.add(sessionId);
          }
          this.escalation = { ...DEFAULT_ESCALATION_CONFIG };
          // Save in new format immediately
          this.saveState();
        } else {
          // New format
          const state: PersistedNotificationState = raw;
          this.escalation = { ...DEFAULT_ESCALATION_CONFIG, ...state.escalation };
          for (const device of state.devices || []) {
            this.devices.set(device.deviceId, device);
          }
          for (const sessionId of state.mutedSessions || []) {
            this.mutedSessions.add(sessionId);
          }
        }

        console.log(
          `NotificationStore: Loaded ${this.devices.size} devices, ${this.mutedSessions.size} muted sessions`
        );
      } else {
        console.log('NotificationStore: First startup, using default escalation config');
      }
    } catch (err) {
      console.error('NotificationStore: Failed to load state:', err);
    }

    // Load history
    try {
      if (fs.existsSync(HISTORY_FILE)) {
        const content = fs.readFileSync(HISTORY_FILE, 'utf-8');
        const rawHistory = JSON.parse(content) as unknown[];
        // Migration: old entries may have ruleName/ruleId/devicesSent/devicesSkipped
        // Convert them to the new format
        this.history = (rawHistory as Record<string, unknown>[]).map((entry) => {
          if ('tier' in entry) {
            return entry as unknown as NotificationHistoryEntry;
          }
          // Migrate old entry
          return {
            id: (entry.id as string) || uuidv4(),
            timestamp: (entry.timestamp as number) || Date.now(),
            eventType:
              (entry.eventType as NotificationHistoryEntry['eventType']) || 'waiting_for_input',
            sessionId: entry.sessionId as string | undefined,
            sessionName: entry.sessionName as string | undefined,
            preview: (entry.preview as string) || '',
            tier: 'push' as const,
            acknowledged: false,
          };
        });
        console.log(`NotificationStore: Loaded ${this.history.length} history entries`);
      }
    } catch (err) {
      console.error('NotificationStore: Failed to load history:', err);
      this.history = [];
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveState();
    }, SAVE_DEBOUNCE_MS);
  }

  private scheduleHistorySave(): void {
    if (this.historySaveTimer) return;
    this.historySaveTimer = setTimeout(() => {
      this.historySaveTimer = null;
      this.saveHistory();
    }, SAVE_DEBOUNCE_MS);
  }

  private saveState(): void {
    try {
      const state: PersistedNotificationState = {
        escalation: this.escalation,
        devices: Array.from(this.devices.values()),
        mutedSessions: Array.from(this.mutedSessions),
      };
      fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    } catch (err) {
      console.error('NotificationStore: Failed to save state:', err);
    }
  }

  private saveHistory(): void {
    try {
      fs.writeFileSync(HISTORY_FILE, JSON.stringify(this.history, null, 2));
    } catch (err) {
      console.error('NotificationStore: Failed to save history:', err);
    }
  }

  // Escalation config methods

  getEscalation(): EscalationConfig {
    return { ...this.escalation };
  }

  setEscalation(config: Partial<EscalationConfig>): EscalationConfig {
    if (config.events !== undefined) {
      this.escalation.events = { ...this.escalation.events, ...config.events };
    }
    if (config.pushDelaySeconds !== undefined) {
      this.escalation.pushDelaySeconds = config.pushDelaySeconds;
    }
    if (config.rateLimitSeconds !== undefined) {
      this.escalation.rateLimitSeconds = config.rateLimitSeconds;
    }
    if (config.quietHours !== undefined) {
      this.escalation.quietHours = { ...this.escalation.quietHours, ...config.quietHours };
    }
    this.scheduleSave();
    return this.getEscalation();
  }

  // Device methods

  getDevices(): RegisteredDevice[] {
    return Array.from(this.devices.values());
  }

  getDevice(deviceId: string): RegisteredDevice | undefined {
    return this.devices.get(deviceId);
  }

  setDevice(device: RegisteredDevice): void {
    this.devices.set(device.deviceId, device);
    this.scheduleSave();
  }

  removeDevice(deviceId: string): boolean {
    const existed = this.devices.delete(deviceId);
    if (existed) this.scheduleSave();
    return existed;
  }

  updateDeviceLastSeen(deviceId: string): void {
    const device = this.devices.get(deviceId);
    if (device) {
      device.lastSeen = Date.now();
      // Don't schedule save for lastSeen updates (too frequent)
    }
  }

  getDeviceCount(): number {
    return this.devices.size;
  }

  // Muted session methods

  getMutedSessions(): string[] {
    return Array.from(this.mutedSessions);
  }

  isSessionMuted(sessionId: string): boolean {
    return this.mutedSessions.has(sessionId);
  }

  setSessionMuted(sessionId: string, muted: boolean): void {
    if (muted) {
      this.mutedSessions.add(sessionId);
    } else {
      this.mutedSessions.delete(sessionId);
    }
    this.scheduleSave();
  }

  // History methods

  getHistory(limit?: number): { entries: NotificationHistoryEntry[]; total: number } {
    const total = this.history.length;
    const entries = limit ? this.history.slice(-limit).reverse() : [...this.history].reverse();
    return { entries, total };
  }

  getHistorySince(since: number): { entries: NotificationHistoryEntry[]; total: number } {
    const entries = this.history.filter((e) => e.timestamp >= since);
    return { entries, total: entries.length };
  }

  addHistoryEntry(
    entry: Omit<NotificationHistoryEntry, 'id' | 'timestamp'>
  ): NotificationHistoryEntry {
    const full: NotificationHistoryEntry = {
      ...entry,
      id: uuidv4(),
      timestamp: Date.now(),
    };
    this.history.push(full);
    if (this.history.length > MAX_HISTORY) {
      this.history = this.history.slice(-MAX_HISTORY);
    }
    this.scheduleHistorySave();
    return full;
  }

  clearHistory(): void {
    this.history = [];
    this.scheduleHistorySave();
  }

  // Flush pending saves (for shutdown)
  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      this.saveState();
    }
    if (this.historySaveTimer) {
      clearTimeout(this.historySaveTimer);
      this.historySaveTimer = null;
      this.saveHistory();
    }
  }
}
