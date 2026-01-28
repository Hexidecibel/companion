/**
 * SessionGuard - Ensures session data integrity during switches
 *
 * Every WebSocket message is tagged with a sessionId. The guard validates
 * incoming data and rejects stale messages from previous sessions.
 */

type SessionChangeHandler = (sessionId: string | null, epoch: number) => void;

class SessionGuard {
  private currentSessionId: string | null = null;
  private sessionEpoch: number = 0;
  private changeHandlers: Set<SessionChangeHandler> = new Set();

  /**
   * Begin a session switch. Increments epoch to invalidate in-flight requests.
   * Returns the new epoch for tracking.
   */
  beginSwitch(newSessionId: string): number {
    this.sessionEpoch++;
    this.currentSessionId = newSessionId;
    console.log(`SessionGuard: Switching to session ${newSessionId} (epoch ${this.sessionEpoch})`);
    this.notifyHandlers();
    return this.sessionEpoch;
  }

  /**
   * Clear the current session (e.g., on disconnect)
   */
  clear(): void {
    this.sessionEpoch++;
    this.currentSessionId = null;
    console.log(`SessionGuard: Cleared session (epoch ${this.sessionEpoch})`);
    this.notifyHandlers();
  }

  /**
   * Validate incoming data. Returns false if:
   * - sessionId doesn't match current session (strict matching required)
   * - epoch is older than current epoch (stale request)
   */
  isValid(sessionId: string | null | undefined, epoch?: number): boolean {
    // If we have no session set yet, accept data and auto-initialize from first response
    // This handles the case where the app connects before sessionGuard is initialized
    if (!this.currentSessionId) {
      if (sessionId) {
        console.log(`SessionGuard: Auto-initializing from response sessionId: ${sessionId}`);
        this.currentSessionId = sessionId;
        return true;
      }
      console.log(`SessionGuard: No current session and response has no sessionId, rejecting`);
      return false;
    }

    // STRICT: Response must include matching sessionId
    // This prevents old session data from leaking through when switching
    if (!sessionId || sessionId !== this.currentSessionId) {
      console.log(`SessionGuard: Rejecting message (got "${sessionId}", expected "${this.currentSessionId}")`);
      return false;
    }

    // If epoch provided, it must be current or newer
    if (epoch !== undefined && epoch < this.sessionEpoch) {
      console.log(`SessionGuard: Rejecting stale message (epoch ${epoch} < ${this.sessionEpoch})`);
      return false;
    }

    return true;
  }

  /**
   * Check if a specific session ID is the current one
   */
  isCurrentSession(sessionId: string | null | undefined): boolean {
    return sessionId === this.currentSessionId;
  }

  /**
   * Get the current session context for outgoing requests
   */
  getContext(): { sessionId: string | null; epoch: number } {
    return {
      sessionId: this.currentSessionId,
      epoch: this.sessionEpoch,
    };
  }

  /**
   * Get current session ID
   */
  getCurrentSessionId(): string | null {
    return this.currentSessionId;
  }

  /**
   * Get current epoch
   */
  getEpoch(): number {
    return this.sessionEpoch;
  }

  /**
   * Subscribe to session changes
   */
  onSessionChange(handler: SessionChangeHandler): () => void {
    this.changeHandlers.add(handler);
    return () => this.changeHandlers.delete(handler);
  }

  private notifyHandlers(): void {
    for (const handler of this.changeHandlers) {
      try {
        handler(this.currentSessionId, this.sessionEpoch);
      } catch (err) {
        console.error('SessionGuard: Handler error:', err);
      }
    }
  }
}

// Singleton instance
export const sessionGuard = new SessionGuard();
