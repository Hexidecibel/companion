import { beforeEach, describe, expect, it } from 'vitest';
import { TIPS_KEY, tipsStore } from '../tips';
import { DEFAULT_SETUP, heraldSetupStore, isGamingMode, overlayEnabled, parseSetup, setOverlayEnabled, SETUP_KEY } from '../setupStore';

beforeEach(() => {
  localStorage.clear();
  tipsStore.reset();
  heraldSetupStore.reset();
});

describe('tips', () => {
  it('each tip shows once, ever: queued the first time, never again (even after a reload)', () => {
    expect(tipsStore.trigger('handsfree')).toBe(true);
    expect(tipsStore.get().queue).toEqual(['handsfree']);
    expect(tipsStore.trigger('handsfree')).toBe(false);
    tipsStore.dismiss();
    expect(tipsStore.get().queue).toEqual([]);
    expect(tipsStore.trigger('handsfree')).toBe(false);
    // Reload: persisted as seen.
    tipsStore.reset();
    expect(tipsStore.trigger('handsfree')).toBe(false);
    expect(JSON.parse(localStorage.getItem(TIPS_KEY)!)).toEqual(['handsfree']);
  });

  it('queues several, dismisses by id or the one on screen', () => {
    tipsStore.trigger('first_tone');
    tipsStore.trigger('red_card');
    tipsStore.trigger('remote_trigger');
    tipsStore.dismiss('red_card');
    expect(tipsStore.get().queue).toEqual(['first_tone', 'remote_trigger']);
    tipsStore.dismiss();
    expect(tipsStore.get().queue).toEqual(['remote_trigger']);
  });

  it('ignores junk in storage', () => {
    localStorage.setItem(TIPS_KEY, '["nope", "red_card", 3]');
    tipsStore.reset();
    expect(tipsStore.get().seen).toEqual(['red_card']);
    localStorage.setItem(TIPS_KEY, '{bad json');
    tipsStore.reset();
    expect(tipsStore.get().seen).toEqual([]);
  });
});

describe('setup store', () => {
  it('parses defensively', () => {
    expect(parseSetup(null)).toEqual(DEFAULT_SETUP);
    expect(parseSetup('garbage')).toEqual(DEFAULT_SETUP);
    const p = parseSetup(JSON.stringify({ profile: 'gaming', autoSwitch: true, echo: { erleDb: 22, residualSpeechDetected: false, at: 5 }, dismissed: ['a', 1] }));
    expect(p.profile).toBe('gaming');
    expect(p.autoSwitch).toBe(true);
    expect(p.echo).toEqual({ erleDb: 22, residualSpeechDetected: false, at: 5 });
    expect(p.dismissed).toEqual(['a']);
    expect(parseSetup(JSON.stringify({ profile: 'karaoke' })).profile).toBeNull();
  });

  it('persists per device and reloads', () => {
    heraldSetupStore.set('profile', 'desk');
    heraldSetupStore.dismissSuggestion('speakers/unknown>desk');
    heraldSetupStore.dismissSuggestion('speakers/unknown>desk');
    heraldSetupStore.reset();
    expect(heraldSetupStore.get().profile).toBe('desk');
    expect(heraldSetupStore.get().dismissed).toEqual(['speakers/unknown>desk']);
    expect(JSON.parse(localStorage.getItem(SETUP_KEY)!).profile).toBe('desk');
  });

  it('floating orb: desktop app only, on by default, off in Gaming unless opted in', () => {
    expect(overlayEnabled(heraldSetupStore.get(), 'desktop')).toBe(true);
    expect(overlayEnabled(heraldSetupStore.get(), 'browser')).toBe(false);
    heraldSetupStore.set('profile', 'gaming');
    expect(isGamingMode()).toBe(true);
    expect(overlayEnabled(heraldSetupStore.get(), 'desktop')).toBe(false);
    setOverlayEnabled(true); // edits the Gaming value
    expect(overlayEnabled(heraldSetupStore.get(), 'desktop')).toBe(true);
    heraldSetupStore.set('profile', 'headphones');
    expect(heraldSetupStore.get().showOverlay).toBe(true);
    setOverlayEnabled(false);
    expect(overlayEnabled(heraldSetupStore.get(), 'desktop')).toBe(false);
    expect(heraldSetupStore.get().overlayInGaming).toBe(true);
  });
});
