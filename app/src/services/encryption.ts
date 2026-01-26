// Import polyfill first
import 'react-native-get-random-values';

import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64, encodeUTF8, decodeUTF8 } from 'tweetnacl-util';

export interface EncryptedPayload {
  encrypted: true;
  ciphertext: string;
  nonce: string;
}

export interface KeyExchangePayload {
  publicKey: string;
}

export class EncryptionService {
  private keyPair: nacl.BoxKeyPair | null = null;
  private serverPublicKey: Uint8Array | null = null;
  private isEnabled: boolean = false;

  initialize(): string {
    // Generate client key pair
    this.keyPair = nacl.box.keyPair();
    console.log('Encryption: Client key pair generated');
    return this.getPublicKey();
  }

  getPublicKey(): string {
    if (!this.keyPair) {
      throw new Error('Encryption not initialized');
    }
    return encodeBase64(this.keyPair.publicKey);
  }

  setServerPublicKey(publicKeyBase64: string): void {
    try {
      const publicKey = decodeBase64(publicKeyBase64);
      if (publicKey.length !== nacl.box.publicKeyLength) {
        throw new Error('Invalid server public key length');
      }
      this.serverPublicKey = publicKey;
      this.isEnabled = true;
      console.log('Encryption: Server public key set, E2E enabled');
    } catch (err) {
      console.error('Encryption: Failed to set server public key:', err);
      throw err;
    }
  }

  isE2EEnabled(): boolean {
    return this.isEnabled && this.keyPair !== null && this.serverPublicKey !== null;
  }

  encrypt(data: unknown): EncryptedPayload | null {
    if (!this.isE2EEnabled()) {
      return null;
    }

    try {
      const message = encodeUTF8(JSON.stringify(data));
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
    if (!this.isE2EEnabled()) {
      return null;
    }

    try {
      const ciphertext = decodeBase64(payload.ciphertext);
      const nonce = decodeBase64(payload.nonce);

      const decrypted = nacl.box.open(
        ciphertext,
        nonce,
        this.serverPublicKey!,
        this.keyPair!.secretKey
      );

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

  reset(): void {
    this.keyPair = null;
    this.serverPublicKey = null;
    this.isEnabled = false;
    console.log('Encryption: Reset');
  }
}

// Export singleton instance
export const encryptionService = new EncryptionService();
