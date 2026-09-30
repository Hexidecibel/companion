import { describe, expect, it } from 'vitest';
import { GOOD_SUPPRESSION_DB, PASSIVE_MIN_SECONDS, selectBargeInMode, type BargeInInput } from '../bargeInMode';

const base: BargeInInput = {
  aec: 'in-graph',
  playbackReferenced: true,
  output: 'speakers',
  evidence: { measured: null, passive: null, echoHeard: 0, falseBargeIns: 0 },
};
const withEv = (ev: Partial<BargeInInput['evidence']>, over: Partial<BargeInInput> = {}) => selectBargeInMode({ ...base, ...over, evidence: { ...base.evidence, ...ev } });

describe('selectBargeInMode', () => {
  it('unmeasured: transcript-gated, whatever the device names say', () => {
    expect(selectBargeInMode(base).mode).toBe('gated');
    expect(selectBargeInMode({ ...base, output: 'headphones' }).mode).toBe('gated');
  });

  it('a good echo check with in-graph (or native) cancellation: instant', () => {
    expect(withEv({ measured: { erleDb: GOOD_SUPPRESSION_DB + 3, residualSpeechDetected: false } }).mode).toBe('vad');
    expect(withEv({ measured: { erleDb: 32, residualSpeechDetected: false } }, { aec: 'native' }).mode).toBe('vad');
  });

  it('a weak check, or speech left in the mic, keeps the transcript gate', () => {
    expect(withEv({ measured: { erleDb: 18, residualSpeechDetected: false } }).mode).toBe('gated');
    expect(withEv({ measured: { erleDb: 40, residualSpeechDetected: true } }).mode).toBe('gated');
  });

  it("Herald's browser voice (Web Speech) has no reference: gated even when the check passed", () => {
    expect(withEv({ measured: { erleDb: 35, residualSpeechDetected: false } }, { playbackReferenced: false }).mode).toBe('gated');
  });

  it('no echo path at all (headphones, measured) is instant for any voice and any canceller', () => {
    const m = { erleDb: 55, erlDb: 50, residualSpeechDetected: false };
    expect(withEv({ measured: m }, { playbackReferenced: false, aec: 'browser' }).mode).toBe('vad');
  });

  it('browser echo cancellation only earns trust by measurement, never passively', () => {
    expect(withEv({ passive: { totalDb: 45, seconds: 30 } }, { aec: 'browser' }).mode).toBe('gated');
    expect(withEv({ measured: { erleDb: 30, residualSpeechDetected: false } }, { aec: 'browser' }).mode).toBe('vad');
    expect(withEv({ measured: { erleDb: 30, residualSpeechDetected: false } }, { aec: 'none' }).mode).toBe('gated');
  });

  it("passive evidence from Herald's replies upgrades in-graph after enough playback", () => {
    expect(withEv({ passive: { totalDb: 36, seconds: PASSIVE_MIN_SECONDS - 1 } }).mode).toBe('gated');
    expect(withEv({ passive: { totalDb: 36, seconds: PASSIVE_MIN_SECONDS + 1 } }).mode).toBe('vad');
    expect(withEv({ passive: { totalDb: 24, seconds: 60 } }).mode).toBe('gated');
    expect(withEv({ passive: { totalDb: 36, seconds: 60 }, echoHeard: 1 }).mode).toBe('gated');
  });

  it('one false instant stop drops back to gated, measurement or not', () => {
    expect(withEv({ measured: { erleDb: 40, residualSpeechDetected: false }, falseBargeIns: 1 }).mode).toBe('gated');
  });
});
