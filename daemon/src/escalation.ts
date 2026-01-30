import { v4 as uuidv4 } from 'uuid';
import { NotificationEventType, PendingEvent } from './types';
import { NotificationStore } from './notification-store';
import { PushNotificationService } from './push';

export interface EscalationEvent {
  eventType: NotificationEventType;
  sessionId: string;
  sessionName: string;
  content: string;
}

export interface EscalationResult {
  shouldBroadcast: boolean;
  pendingEvent?: PendingEvent;
}

export class EscalationService {
  private pendingEvents: Map<string, PendingEvent> = new Map();
  private timers: Map<string, NodeJS.Timeout> = new Map();
  private lastNotifiedPerSession: Map<string, number> = new Map();
  private store: NotificationStore;
  private push: PushNotificationService;

  // Auto-expire pending events after 1 hour
  private cleanupInterval: NodeJS.Timeout;
  private readonly EXPIRE_MS = 60 * 60 * 1000;

  constructor(store: NotificationStore, push: PushNotificationService) {
    this.store = store;
    this.push = push;
    this.cleanupInterval = setInterval(() => this.cleanup(), 5 * 60 * 1000);
  }

  /**
   * Handle a notification event. Checks escalation config, muted sessions,
   * and rate limits. Returns whether to broadcast to WS clients.
   */
  handleEvent(event: EscalationEvent): EscalationResult {
    const config = this.store.getEscalation();

    // Check: event type enabled?
    if (!config.events[event.eventType]) {
      return { shouldBroadcast: false };
    }

    // Check: session muted?
    if (this.store.isSessionMuted(event.sessionId)) {
      return { shouldBroadcast: false };
    }

    // Check: rate-limited?
    if (config.rateLimitSeconds > 0) {
      const lastTime = this.lastNotifiedPerSession.get(event.sessionId);
      if (lastTime && Date.now() - lastTime < config.rateLimitSeconds * 1000) {
        console.log(`Escalation: Rate-limited for session ${event.sessionId} (${config.rateLimitSeconds}s)`);
        return { shouldBroadcast: false };
      }
    }

    // Record notification time for rate limiting
    this.lastNotifiedPerSession.set(event.sessionId, Date.now());

    // Tier 1 (immediate): broadcast to WS clients -> browser notifications fire
    // Log to history as browser tier
    const preview = event.content.substring(0, 200);

    this.store.addHistoryEntry({
      eventType: event.eventType,
      sessionId: event.sessionId,
      sessionName: event.sessionName,
      preview,
      tier: 'browser',
      acknowledged: false,
    });

    // Create pending event and schedule push timer
    const pendingId = uuidv4();
    const now = Date.now();
    const pushScheduledAt = now + config.pushDelaySeconds * 1000;

    const pendingEvent: PendingEvent = {
      id: pendingId,
      sessionId: event.sessionId,
      sessionName: event.sessionName,
      eventType: event.eventType,
      preview,
      createdAt: now,
      pushScheduledAt,
      pushSent: false,
    };

    this.pendingEvents.set(pendingId, pendingEvent);

    // Schedule push escalation timer
    if (config.pushDelaySeconds === 0) {
      // Immediate push
      this.firePush(pendingId);
    } else {
      const timer = setTimeout(() => {
        this.firePush(pendingId);
      }, config.pushDelaySeconds * 1000);
      this.timers.set(pendingId, timer);
    }

    console.log(`Escalation: Event ${event.eventType} for session "${event.sessionName}" — push scheduled in ${config.pushDelaySeconds}s`);

    return { shouldBroadcast: true, pendingEvent };
  }

  /**
   * Acknowledge a session — cancels any pending push timers for that session.
   * Called when user views session, sends input, or session stops waiting.
   */
  acknowledgeSession(sessionId: string): void {
    const now = Date.now();
    let cancelled = 0;

    for (const [pendingId, event] of this.pendingEvents) {
      if (event.sessionId === sessionId && !event.pushSent && !event.acknowledgedAt) {
        event.acknowledgedAt = now;

        // Cancel the push timer
        const timer = this.timers.get(pendingId);
        if (timer) {
          clearTimeout(timer);
          this.timers.delete(pendingId);
        }
        cancelled++;
      }
    }

    if (cancelled > 0) {
      console.log(`Escalation: Acknowledged session "${sessionId}" — cancelled ${cancelled} pending push(es)`);
    }
  }

  /**
   * Get all pending (unacknowledged, unsent) events.
   */
  getPendingEvents(): PendingEvent[] {
    return Array.from(this.pendingEvents.values())
      .filter(e => !e.pushSent && !e.acknowledgedAt);
  }

  /**
   * Fire push notification for a pending event (Tier 2 escalation).
   */
  private firePush(pendingId: string): void {
    const event = this.pendingEvents.get(pendingId);
    if (!event) return;

    // Already acknowledged or sent?
    if (event.acknowledgedAt || event.pushSent) {
      this.timers.delete(pendingId);
      return;
    }

    // Check quiet hours
    const config = this.store.getEscalation();
    if (config.quietHours.enabled && this.isInQuietHours(config.quietHours.start, config.quietHours.end)) {
      console.log(`Escalation: Push suppressed for "${event.sessionName}" — quiet hours`);
      event.pushSent = true; // Mark as handled so it doesn't retry
      this.timers.delete(pendingId);
      return;
    }

    // Send push to all registered devices
    event.pushSent = true;
    this.timers.delete(pendingId);

    this.push.sendToAllDevices(event.preview, event.eventType, event.sessionId, event.sessionName);

    // Update history: add a push tier entry
    this.store.addHistoryEntry({
      eventType: event.eventType,
      sessionId: event.sessionId,
      sessionName: event.sessionName,
      preview: event.preview,
      tier: 'push',
      acknowledged: false,
    });

    console.log(`Escalation: Push sent for "${event.sessionName}" (${event.eventType})`);
  }

  private isInQuietHours(start: string, end: string): boolean {
    const now = new Date();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();

    const [startH, startM] = start.split(':').map(Number);
    const [endH, endM] = end.split(':').map(Number);
    const startMinutes = startH * 60 + startM;
    const endMinutes = endH * 60 + endM;

    // Handle overnight quiet hours (e.g., 22:00 - 08:00)
    if (startMinutes > endMinutes) {
      return currentMinutes >= startMinutes || currentMinutes < endMinutes;
    } else {
      return currentMinutes >= startMinutes && currentMinutes < endMinutes;
    }
  }

  /**
   * Auto-expire old pending events.
   */
  private cleanup(): void {
    const now = Date.now();
    let cleaned = 0;

    for (const [pendingId, event] of this.pendingEvents) {
      if (now - event.createdAt > this.EXPIRE_MS) {
        // Cancel timer if still running
        const timer = this.timers.get(pendingId);
        if (timer) {
          clearTimeout(timer);
          this.timers.delete(pendingId);
        }
        this.pendingEvents.delete(pendingId);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      console.log(`Escalation: Cleaned up ${cleaned} expired pending event(s)`);
    }
  }

  /**
   * Destroy the service (clear timers).
   */
  destroy(): void {
    clearInterval(this.cleanupInterval);
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.pendingEvents.clear();
  }
}
