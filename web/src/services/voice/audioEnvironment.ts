/**
 * Audio environment contract: what Herald is playing through, what it is
 * listening with, and how (or whether) its own voice is cancelled from the mic.
 *
 * Consumers (setup profiles, device check, overlay) build against this API.
 * STUB: returns 'unknown' / 'browser' until the real detector lands.
 */

export type OutputKind = 'headphones' | 'bluetooth-headphones' | 'speakers' | 'unknown';
export type InputKind = 'headset' | 'bluetooth-headset' | 'builtin' | 'external' | 'unknown';
export type AecMode = 'native' | 'in-graph' | 'browser' | 'none';

export interface AudioEnvironment {
  output: OutputKind;
  input: InputKind;
  aec: AecMode;
  inputDeviceId?: string;
  outputLabel?: string;
  inputLabel?: string;
}

const listeners = new Set<(env: AudioEnvironment) => void>();

export async function getAudioEnvironment(): Promise<AudioEnvironment> {
  return { output: 'unknown', input: 'unknown', aec: 'browser' };
}

export function onAudioEnvironmentChange(cb: (env: AudioEnvironment) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Plays a short known Herald line and measures the echo left after cancellation. */
export async function measureEchoSuppression(): Promise<{ erleDb: number; residualSpeechDetected: boolean }> {
  return { erleDb: 0, residualSpeechDetected: false };
}
