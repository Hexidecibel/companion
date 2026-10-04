/**
 * Test helper: a WebSocket stand-in that answers the pairing handshake like
 * the daemon does (daemon/src/pairing). `FakeDaemon.last` is the latest socket.
 */
export class FakeDaemonSocket {
  static instances: FakeDaemonSocket[] = [];
  static code = '424242';
  static mode: 'ok' | 'untrusted' | 'old' = 'ok';
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  sent: Array<{ type: string; payload?: any; requestId?: string }> = [];
  pairingId = 'pid-1';
  nonce = '';
  closed = false;

  constructor(readonly url: string) {
    FakeDaemonSocket.instances.push(this);
    setTimeout(() => this.onopen?.(), 0);
  }

  static get last(): FakeDaemonSocket {
    return FakeDaemonSocket.instances[FakeDaemonSocket.instances.length - 1];
  }

  static reset(): void {
    FakeDaemonSocket.instances = [];
    FakeDaemonSocket.code = '424242';
    FakeDaemonSocket.mode = 'ok';
  }

  emit(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }

  approved(via: string) {
    return {
      status: 'approved',
      pairingId: this.pairingId,
      token: 'cdt1.0123456789abcdef.' + 'x'.repeat(43),
      deviceId: '0123456789abcdef',
      deviceName: 'Test device',
      daemonId: 'd'.repeat(32),
      daemonName: 'Companion on box',
      publicNonce: this.nonce,
      via,
    };
  }

  /** Simulate a signed-in user approving the request. */
  approve(): void {
    this.emit({ type: 'pair_result', success: true, payload: this.approved('approval') });
  }

  send(raw: string): void {
    const m = JSON.parse(raw);
    this.sent.push(m);
    const reply = (success: boolean, payload: unknown, error?: string): void => {
      setTimeout(() => this.emit({ type: m.type, success, payload, error, requestId: m.requestId }), 0);
    };
    if (FakeDaemonSocket.mode === 'old') return reply(false, undefined, `Not authenticated`);
    switch (m.type) {
      case 'pair_hello':
        return reply(true, { daemonId: 'd'.repeat(32), name: 'Companion on box', version: '1.0.0', pairing: true, codePairing: true });
      case 'pair_request':
        if (FakeDaemonSocket.mode === 'untrusted') return reply(false, { code: 'untrusted_network' }, 'nope');
        this.nonce = m.payload.publicNonce;
        return reply(true, { pairingId: this.pairingId, expiresAt: Date.now() + 120_000 });
      case 'pair_confirm':
        if (m.payload.code === FakeDaemonSocket.code) return reply(true, this.approved('code'));
        return reply(false, { code: 'bad_code', attemptsLeft: 4 }, 'Wrong code');
      case 'pair_redeem_qr':
        if (m.payload.otp === 'o'.repeat(43)) return reply(true, this.approved('qr'));
        return reply(false, { code: 'bad_otp' }, 'expired');
    }
  }

  close(): void {
    this.closed = true;
  }
}
