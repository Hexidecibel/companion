import { describe, expect, it } from 'vitest';
import { detectHeadphones, interruptDefault, looksLikeHeadphones } from '../headphones';

const out = (label: string, deviceId = 'x') => ({ kind: 'audiooutput', label, deviceId });
const mic = (label: string, deviceId = 'x') => ({ kind: 'audioinput', label, deviceId });

describe('headphone detection', () => {
  it('recognises common headphone labels', () => {
    for (const l of ['AirPods Pro', 'Default - Headphones (Realtek)', 'Galaxy Buds2', 'Jabra Evolve 65', 'USB Headset', 'Pixel Buds Pro', 'WH-1000XM4']) {
      expect(looksLikeHeadphones(l)).toBe(true);
    }
    for (const l of ['MacBook Pro Speakers', 'Speakers (Realtek)', 'LG HDR 4K', 'Built-in Output']) {
      expect(looksLikeHeadphones(l)).toBe(false);
    }
  });

  it('uses the default output, then the default mic (a headset mic means a headset)', () => {
    expect(detectHeadphones([out('Default - AirPods Pro', 'default'), out('MacBook Pro Speakers')])).toBe(true);
    expect(detectHeadphones([out('Default - MacBook Pro Speakers', 'default'), out('AirPods Pro')])).toBe(false);
    expect(detectHeadphones([out('Speakers', 'default'), mic('Default - Headset Microphone', 'default')])).toBe(true);
  });

  it('unknown without labels (no permission yet) or outputs (Safari / WKWebView)', () => {
    expect(detectHeadphones([])).toBeNull();
    expect(detectHeadphones([out('', 'default'), mic('', 'default')])).toBeNull();
    expect(detectHeadphones([mic('MacBook Pro Microphone', 'default')])).toBeNull();
  });
});

describe('interrupt default', () => {
  it('an explicit choice always wins', () => {
    expect(interruptDefault({ explicit: true, nativeDesktop: true, headphones: false })).toBe(true);
    expect(interruptDefault({ explicit: false, nativeDesktop: false, headphones: true })).toBe(false);
  });

  it('a value saved by an older build is kept in the browser, ignored in the desktop app', () => {
    expect(interruptDefault({ legacy: true, nativeDesktop: false, headphones: null })).toBe(true);
    expect(interruptDefault({ legacy: true, nativeDesktop: true, headphones: null })).toBe(false);
    expect(interruptDefault({ legacy: true, nativeDesktop: true, headphones: true })).toBe(true);
  });

  it('no preference: on only with headphones confirmed', () => {
    expect(interruptDefault({ nativeDesktop: false, headphones: null })).toBe(false);
    expect(interruptDefault({ nativeDesktop: false, headphones: false })).toBe(false);
    expect(interruptDefault({ nativeDesktop: false, headphones: true })).toBe(true);
    expect(interruptDefault({ nativeDesktop: true, headphones: true })).toBe(true);
  });
});
