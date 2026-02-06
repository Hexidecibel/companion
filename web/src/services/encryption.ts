import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64, encodeUTF8, decodeUTF8 } from 'tweetnacl-util';

export interface EncryptedPayload {
  encrypted: true;
  ciphertext: string;
  nonce: string;
}

export class EncryptionService {
  private keyPair: nacl.BoxKeyPair | null = null;
  private serverPublicKey: Uint8Array | null = null;
  private isEnabled: boolean = false;

  initialize(): string {
    this.keyPair = nacl.box.keyPair();
    return this.getPublicKey();
  }

  getPublicKey(): string {
    if (!this.keyPair) {
      throw new Error('Encryption not initialized');
    }
    return encodeBase64(this.keyPair.publicKey);
  }

  setServerPublicKey(publicKeyBase64: string): void {
    const publicKey = decodeBase64(publicKeyBase64);
    if (publicKey.length !== nacl.box.publicKeyLength) {
      throw new Error('Invalid server public key length');
    }
    this.serverPublicKey = publicKey;
    this.isEnabled = true;
  }

  isE2EEnabled(): boolean {
    return this.isEnabled && this.keyPair !== null && this.serverPublicKey !== null;
  }

  encrypt(data: unknown): EncryptedPayload | null {
    if (!this.isE2EEnabled()) return null;
    try {
      const message = decodeUTF8(JSON.stringify(data));
      const nonce = nacl.randomBytes(nacl.box.nonceLength);
      const ciphertext = nacl.box(message, nonce, this.serverPublicKey!, this.keyPair!.secretKey);
      return {
        encrypted: true,
        ciphertext: encodeBase64(ciphertext),
        nonce: encodeBase64(nonce),
      };
    } catch (err) {
      console.error('Encryption: Failed to encrypt:', err);
      return null;
    }
  }

  decrypt(payload: EncryptedPayload): unknown | null {
    if (!this.isE2EEnabled()) return null;
    try {
      const ciphertext = decodeBase64(payload.ciphertext);
      const nonce = decodeBase64(payload.nonce);
      const decrypted = nacl.box.open(ciphertext, nonce, this.serverPublicKey!, this.keyPair!.secretKey);
      if (!decrypted) return null;
      const json = encodeUTF8(decrypted);
      return JSON.parse(json);
    } catch (err) {
      console.error('Encryption: Failed to decrypt:', err);
      return null;
    }
  }

  isEncryptedPayload(payload: unknown): payload is EncryptedPayload {
    return (
      typeof payload === 'object' &&
      payload !== null &&
      'encrypted' in payload &&
      (payload as EncryptedPayload).encrypted === true &&
      'ciphertext' in payload &&
      'nonce' in payload
    );
  }

  reset(): void {
    this.keyPair = null;
    this.serverPublicKey = null;
    this.isEnabled = false;
  }
}

export const encryptionService = new EncryptionService();
