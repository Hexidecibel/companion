import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createKeyboardHandler, KeyboardHandler } from '../platform';

describe('createKeyboardHandler', () => {
  let setProperty: ReturnType<typeof vi.fn<(value: string) => void>>;
  let removeProperty: ReturnType<typeof vi.fn<() => void>>;
  let handler: KeyboardHandler;
  const FULL_HEIGHT = 800; // Typical mobile viewport

  beforeEach(() => {
    setProperty = vi.fn<(value: string) => void>();
    removeProperty = vi.fn<() => void>();
    handler = createKeyboardHandler(FULL_HEIGHT, setProperty, removeProperty);
  });

  // -----------------------------------------------------------------------
  // Initial state — no --app-height set, CSS 100dvh is the default
  // -----------------------------------------------------------------------

  it('should NOT set --app-height on creation', () => {
    expect(setProperty).not.toHaveBeenCalled();
    expect(removeProperty).not.toHaveBeenCalled();
  });

  it('should report keyboard closed initially', () => {
    expect(handler.isKeyboardOpen()).toBe(false);
  });

  // -----------------------------------------------------------------------
  // URL bar / small viewport changes — must be IGNORED
  // -----------------------------------------------------------------------

  it('should ignore small shrinks from URL bar appearing (< 100px)', () => {
    handler.handleResize(750); // 50px shrink
    expect(setProperty).not.toHaveBeenCalled();
    expect(handler.isKeyboardOpen()).toBe(false);
  });

  it('should ignore 99px shrink (just under threshold)', () => {
    handler.handleResize(701);
    expect(setProperty).not.toHaveBeenCalled();
  });

  it('should not trigger on slight viewport growth', () => {
    handler.handleResize(810);
    expect(setProperty).not.toHaveBeenCalled();
    expect(removeProperty).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Keyboard OPEN — input bar must move IMMEDIATELY
  // -----------------------------------------------------------------------

  it('should set --app-height IMMEDIATELY when keyboard opens (no delay)', () => {
    handler.handleResize(500); // 300px shrink — keyboard
    // Must be called synchronously, not after a timer
    expect(setProperty).toHaveBeenCalledTimes(1);
    expect(setProperty).toHaveBeenCalledWith('500px');
    expect(handler.isKeyboardOpen()).toBe(true);
  });

  it('should set --app-height at exactly 100px threshold', () => {
    handler.handleResize(700);
    expect(setProperty).toHaveBeenCalledWith('700px');
    expect(handler.isKeyboardOpen()).toBe(true);
  });

  it('should track keyboard animation — update on each significant resize', () => {
    // Simulate keyboard opening animation: 800 → 700 → 600 → 500
    handler.handleResize(700);
    expect(setProperty).toHaveBeenLastCalledWith('700px');

    handler.handleResize(600);
    expect(setProperty).toHaveBeenLastCalledWith('600px');

    handler.handleResize(500);
    expect(setProperty).toHaveBeenLastCalledWith('500px');

    expect(setProperty).toHaveBeenCalledTimes(3);
  });

  // -----------------------------------------------------------------------
  // Keyboard CLOSE — must remove --app-height IMMEDIATELY
  // -----------------------------------------------------------------------

  it('should remove --app-height immediately when keyboard closes', () => {
    // Open keyboard
    handler.handleResize(500);
    expect(handler.isKeyboardOpen()).toBe(true);

    // Close keyboard — back to full
    handler.handleResize(800);
    expect(removeProperty).toHaveBeenCalledTimes(1);
    expect(handler.isKeyboardOpen()).toBe(false);
  });

  it('should remove --app-height when viewport exceeds original full height', () => {
    handler.handleResize(500);
    handler.handleResize(850); // URL bar also hid
    expect(removeProperty).toHaveBeenCalled();
    expect(handler.isKeyboardOpen()).toBe(false);
    expect(handler.getFullHeight()).toBe(850);
  });

  it('should NOT call removeProperty if keyboard was never open', () => {
    handler.handleResize(800);
    expect(removeProperty).not.toHaveBeenCalled();
    handler.handleResize(850);
    expect(removeProperty).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Full open → close → open cycle (the critical user flow)
  // -----------------------------------------------------------------------

  it('should handle open → close → open correctly', () => {
    // Open: tap input, keyboard slides up
    handler.handleResize(500);
    expect(setProperty).toHaveBeenCalledWith('500px');
    expect(handler.isKeyboardOpen()).toBe(true);

    // Close: tap elsewhere, keyboard slides down
    handler.handleResize(800);
    expect(removeProperty).toHaveBeenCalledTimes(1);
    expect(handler.isKeyboardOpen()).toBe(false);

    // Open again: tap input again
    setProperty.mockClear();
    handler.handleResize(500);
    expect(setProperty).toHaveBeenCalledWith('500px');
    expect(handler.isKeyboardOpen()).toBe(true);

    // Close again
    handler.handleResize(800);
    expect(removeProperty).toHaveBeenCalledTimes(2);
    expect(handler.isKeyboardOpen()).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Full height tracking — adapts to viewport changes
  // -----------------------------------------------------------------------

  it('should update fullHeight baseline when viewport grows', () => {
    expect(handler.getFullHeight()).toBe(800);
    handler.handleResize(850);
    expect(handler.getFullHeight()).toBe(850);

    // 90px shrink from new baseline — below threshold
    handler.handleResize(760);
    expect(setProperty).not.toHaveBeenCalled();

    // 110px shrink — above threshold
    handler.handleResize(740);
    expect(setProperty).toHaveBeenCalledWith('740px');
  });

  // -----------------------------------------------------------------------
  // Mixed URL bar + keyboard scenarios
  // -----------------------------------------------------------------------

  it('should ignore URL bar hide then correctly detect keyboard', () => {
    // URL bar hides (small grow)
    handler.handleResize(830);
    expect(handler.getFullHeight()).toBe(830);
    expect(setProperty).not.toHaveBeenCalled();

    // Keyboard opens from new baseline
    handler.handleResize(500);
    expect(setProperty).toHaveBeenCalledWith('500px');
    expect(handler.isKeyboardOpen()).toBe(true);
  });

  it('should ignore small jitter while keyboard is open (autocomplete bar)', () => {
    // Keyboard opens at 500px
    handler.handleResize(500);
    expect(setProperty).toHaveBeenCalledTimes(1);
    setProperty.mockClear();

    // Small changes while typing (autocomplete suggestions, < 40px)
    handler.handleResize(510); // +10px
    handler.handleResize(490); // -10px
    handler.handleResize(520); // +20px
    // All < 40px from last applied (500) — must be ignored
    expect(setProperty).not.toHaveBeenCalled();
  });

  it('should update when keyboard changes significantly while open (e.g. emoji picker)', () => {
    // Keyboard opens at 500px
    handler.handleResize(500);
    setProperty.mockClear();

    // Emoji picker or different keyboard layout — 60px change
    handler.handleResize(440);
    expect(setProperty).toHaveBeenCalledWith('440px');
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------

  it('should handle zero height', () => {
    handler.handleResize(0);
    expect(setProperty).toHaveBeenCalledWith('0px');
    expect(handler.isKeyboardOpen()).toBe(true);
  });

  it('should ignore rapid same-value resizes (0 change from last applied)', () => {
    handler.handleResize(500);
    expect(setProperty).toHaveBeenCalledTimes(1);

    handler.handleResize(500); // same value — 0px change, filtered by jitter guard
    expect(setProperty).toHaveBeenCalledTimes(1);
  });

  it('should remove --app-height when keyboard closes but URL bar is visible', () => {
    // This is the critical bug: keyboard opens, then closes, but URL bar
    // means viewport returns to 760 not 800. Must still detect keyboard close.
    handler.handleResize(500); // keyboard opens
    expect(handler.isKeyboardOpen()).toBe(true);

    // Keyboard closes — viewport goes to 760 (not 800 because URL bar is showing)
    handler.handleResize(760); // shrinkFromFull = 40 < 100
    expect(removeProperty).toHaveBeenCalledTimes(1);
    expect(handler.isKeyboardOpen()).toBe(false);
  });

  it('should handle keyboard dismissed mid-animation', () => {
    // Keyboard starts opening
    handler.handleResize(700);
    expect(setProperty).toHaveBeenCalledWith('700px');

    // User dismisses immediately — viewport grows back
    handler.handleResize(800);
    expect(removeProperty).toHaveBeenCalledTimes(1);
    expect(handler.isKeyboardOpen()).toBe(false);
  });
});
