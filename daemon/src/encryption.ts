import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64, encodeUTF8, decodeUTF8 } from 'tweetnacl-util';

export interface KeyPair {
  publicKey: string;
  secretKey: string;
}

export interface EncryptedPayload {
  encrypted: true;
  ciphertext: string;
  nonce: string;
}

export interface DecryptedPayload {
  encrypted: false;
  data: unknown;
}

export type MessagePayload = EncryptedPayload | DecryptedPayload | unknown;

export class EncryptionService {
  private keyPair: nacl.BoxKeyPair;
  private clientPublicKeys: Map<string, Uint8Array> = new Map();

  constructor() {
    // Generate server key pair on startup
    this.keyPair = nacl.box.keyPair();
    console.log('Encryption: Key pair generated');
  }

  getPublicKey(): string {
    return encodeBase64(this.keyPair.publicKey);
  }

  setClientPublicKey(clientId: string, publicKeyBase64: string): void {
    try {
      const publicKey = decodeBase64(publicKeyBase64);
      if (publicKey.length !== nacl.box.publicKeyLength) {
        throw new Error('Invalid public key length');
      }
      this.clientPublicKeys.set(clientId, publicKey);
      console.log(`Encryption: Stored public key for client ${clientId}`);
    } catch (err) {
      console.error(`Encryption: Failed to store public key for ${clientId}:`, err);
      throw err;
    }
  }

  removeClientPublicKey(clientId: string): void {
    this.clientPublicKeys.delete(clientId);
  }

  hasClientPublicKey(clientId: string): boolean {
    return this.clientPublicKeys.has(clientId);
  }

  encrypt(clientId: string, data: unknown): EncryptedPayload | null {
    const clientPublicKey = this.clientPublicKeys.get(clientId);
    if (!clientPublicKey) {
      console.warn(`Encryption: No public key for client ${clientId}`);
      return null;
    }

    try {
      const message = encodeUTF8(JSON.stringify(data));
      const nonce = nacl.randomBytes(nacl.box.nonceLength);

      const ciphertext = nacl.box(message, nonce, clientPublicKey, this.keyPair.secretKey);

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

  decrypt(clientId: string, payload: EncryptedPayload): unknown | null {
    const clientPublicKey = this.clientPublicKeys.get(clientId);
    if (!clientPublicKey) {
      console.warn(`Encryption: No public key for client ${clientId}`);
      return null;
    }

    try {
      const ciphertext = decodeBase64(payload.ciphertext);
      const nonce = decodeBase64(payload.nonce);

      const decrypted = nacl.box.open(ciphertext, nonce, clientPublicKey, this.keyPair.secretKey);

      if (!decrypted) {
        console.error('Encryption: Decryption failed (authentication failed)');
        return null;
      }

      const json = decodeUTF8(decrypted);
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
}

// Export singleton instance
export const encryptionService = new EncryptionService();
