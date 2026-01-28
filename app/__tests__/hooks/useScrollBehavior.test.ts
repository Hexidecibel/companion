import { renderHook, act } from '@testing-library/react-native';
import { useScrollBehavior } from '../../src/hooks/useScrollBehavior';

describe('useScrollBehavior', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const createScrollEvent = (contentHeight: number, offset: number, viewportHeight = 600) => ({
    nativeEvent: {
      layoutMeasurement: { height: viewportHeight },
      contentOffset: { y: offset },
      contentSize: { height: contentHeight },
    },
  });

  describe('initial state', () => {
    it('should start with scroll button hidden', () => {
      const { result } = renderHook(() => useScrollBehavior());
      expect(result.current.state.showScrollButton).toBe(false);
    });

    it('should start with no new messages', () => {
      const { result } = renderHook(() => useScrollBehavior());
      expect(result.current.state.hasNewMessages).toBe(false);
    });

    it('should start with auto-scroll enabled', () => {
      const { result } = renderHook(() => useScrollBehavior());
      expect(result.current.state.autoScrollEnabled).toBe(true);
    });

    it('should start near bottom', () => {
      const { result } = renderHook(() => useScrollBehavior());
      expect(result.current.state.isNearBottom).toBe(true);
    });
  });

  describe('scroll position detection', () => {
    it('should detect when user is near bottom (within threshold)', () => {
      const { result } = renderHook(() => useScrollBehavior());

      // Content: 1000px, viewport: 600px, scrolled to 350 (50px from bottom)
      act(() => {
        result.current.handleScroll(createScrollEvent(1000, 350, 600));
      });

      expect(result.current.state.isNearBottom).toBe(true);
    });

    it('should detect when user scrolled up (beyond threshold)', () => {
      const { result } = renderHook(() => useScrollBehavior());

      // Content: 1000px, viewport: 600px, scrolled to 100 (300px from bottom)
      act(() => {
        result.current.handleScroll(createScrollEvent(1000, 100, 600));
      });

      expect(result.current.state.isNearBottom).toBe(false);
    });

    it('should show scroll button when far from bottom', () => {
      const { result } = renderHook(() => useScrollBehavior());

      // Scrolled far up - 300px from bottom (> 150 threshold)
      act(() => {
        result.current.handleScroll(createScrollEvent(1000, 100, 600));
      });

      expect(result.current.state.showScrollButton).toBe(true);
    });

    it('should hide scroll button when near bottom', () => {
      const { result } = renderHook(() => useScrollBehavior());

      // First scroll up to show button
      act(() => {
        result.current.handleScroll(createScrollEvent(1000, 100, 600));
      });
      expect(result.current.state.showScrollButton).toBe(true);

      // Then scroll back to bottom
      act(() => {
        result.current.handleScroll(createScrollEvent(1000, 350, 600));
      });

      expect(result.current.state.showScrollButton).toBe(false);
    });
  });

  describe('new messages indicator', () => {
    it('should show new messages badge when content grows and user is scrolled up', () => {
      const { result } = renderHook(() => useScrollBehavior());

      // Initial load
      act(() => {
        result.current.handleContentSizeChange(0, 1000);
      });

      // Simulate user scrolling up
      act(() => {
        result.current.handleScroll(createScrollEvent(1000, 100, 600));
      });

      // New content arrives (> 50px growth)
      act(() => {
        result.current.handleContentSizeChange(0, 1200);
      });

      expect(result.current.state.hasNewMessages).toBe(true);
    });

    it('should NOT show new messages badge when user is at bottom', () => {
      const { result } = renderHook(() => useScrollBehavior());

      // Initial load
      act(() => {
        result.current.handleContentSizeChange(0, 1000);
      });

      // User stays near bottom
      act(() => {
        result.current.handleScroll(createScrollEvent(1000, 350, 600));
      });

      // New content arrives
      act(() => {
        result.current.handleContentSizeChange(0, 1200);
      });

      expect(result.current.state.hasNewMessages).toBe(false);
    });

    it('should clear new messages badge when scrolling to bottom', () => {
      const { result } = renderHook(() => useScrollBehavior());

      // Setup: user scrolled up, new messages arrived
      act(() => {
        result.current.handleContentSizeChange(0, 1000);
      });
      act(() => {
        result.current.handleScroll(createScrollEvent(1000, 100, 600));
      });
      act(() => {
        result.current.handleContentSizeChange(0, 1200);
      });
      expect(result.current.state.hasNewMessages).toBe(true);

      // User scrolls back to bottom
      act(() => {
        result.current.handleScroll(createScrollEvent(1200, 550, 600));
      });

      expect(result.current.state.hasNewMessages).toBe(false);
    });
  });

  describe('scrollToBottom', () => {
    it('should clear new messages badge', () => {
      const { result } = renderHook(() => useScrollBehavior());

      // Setup: trigger new messages state
      act(() => {
        result.current.handleContentSizeChange(0, 1000);
      });
      act(() => {
        result.current.handleScroll(createScrollEvent(1000, 100, 600));
      });
      act(() => {
        result.current.handleContentSizeChange(0, 1200);
      });
      expect(result.current.state.hasNewMessages).toBe(true);

      act(() => {
        result.current.scrollToBottom();
      });

      expect(result.current.state.hasNewMessages).toBe(false);
    });

    it('should hide scroll button', () => {
      const { result } = renderHook(() => useScrollBehavior());

      // Show scroll button first
      act(() => {
        result.current.handleScroll(createScrollEvent(1000, 100, 600));
      });
      expect(result.current.state.showScrollButton).toBe(true);

      act(() => {
        result.current.scrollToBottom();
      });

      expect(result.current.state.showScrollButton).toBe(false);
    });

    it('should re-enable auto-scroll', () => {
      const { result } = renderHook(() => useScrollBehavior());

      // Disable auto-scroll by scrolling up
      act(() => {
        result.current.handleScroll(createScrollEvent(1000, 100, 600));
      });
      expect(result.current.state.autoScrollEnabled).toBe(false);

      act(() => {
        result.current.scrollToBottom();
      });

      expect(result.current.state.autoScrollEnabled).toBe(true);
    });
  });

  describe('prepareForSend', () => {
    it('should clear UI state immediately', () => {
      const { result } = renderHook(() => useScrollBehavior());

      // Setup: user scrolled up with new messages
      act(() => {
        result.current.handleContentSizeChange(0, 1000);
      });
      act(() => {
        result.current.handleScroll(createScrollEvent(1000, 100, 600));
      });
      act(() => {
        result.current.handleContentSizeChange(0, 1200);
      });
      expect(result.current.state.hasNewMessages).toBe(true);
      expect(result.current.state.showScrollButton).toBe(true);

      act(() => {
        result.current.prepareForSend();
      });

      expect(result.current.state.hasNewMessages).toBe(false);
      expect(result.current.state.showScrollButton).toBe(false);
    });

    it('should re-enable auto-scroll', () => {
      const { result } = renderHook(() => useScrollBehavior());

      // Disable auto-scroll by scrolling up
      act(() => {
        result.current.handleScroll(createScrollEvent(1000, 100, 600));
      });

      act(() => {
        result.current.prepareForSend();
      });

      expect(result.current.state.autoScrollEnabled).toBe(true);
      expect(result.current.state.isNearBottom).toBe(true);
    });
  });

  describe('resetForSessionSwitch', () => {
    it('should reset all state for new session', () => {
      const { result } = renderHook(() => useScrollBehavior());

      // Setup: user had scrolled up with new messages
      act(() => {
        result.current.handleContentSizeChange(0, 1000);
      });
      act(() => {
        result.current.handleScroll(createScrollEvent(1000, 100, 600));
      });
      act(() => {
        result.current.handleContentSizeChange(0, 1200);
      });

      act(() => {
        result.current.resetForSessionSwitch();
      });

      expect(result.current.state.hasNewMessages).toBe(false);
      expect(result.current.state.showScrollButton).toBe(false);
      expect(result.current.state.autoScrollEnabled).toBe(true);
      expect(result.current.state.isNearBottom).toBe(true);
      expect(result.current.state.initialScrollDone).toBe(false);
    });
  });

  describe('hysteresis behavior', () => {
    it('should not flap state when scrolling in the middle zone', () => {
      const { result } = renderHook(() => useScrollBehavior());

      // Start at bottom
      act(() => {
        result.current.handleScroll(createScrollEvent(1000, 350, 600));
      });
      expect(result.current.state.autoScrollEnabled).toBe(true);

      // Scroll to middle zone (between 100 and 150 from bottom)
      // distanceFromBottom = 1000 - 600 - 280 = 120 (between 100 and 150)
      act(() => {
        result.current.handleScroll(createScrollEvent(1000, 280, 600));
      });

      // Should maintain previous state (true) due to hysteresis
      expect(result.current.state.autoScrollEnabled).toBe(true);
    });

    it('should disable auto-scroll only when clearly scrolled up', () => {
      const { result } = renderHook(() => useScrollBehavior());

      // Start at bottom
      act(() => {
        result.current.handleScroll(createScrollEvent(1000, 350, 600));
      });
      expect(result.current.state.autoScrollEnabled).toBe(true);

      // Scroll up past the threshold (200px from bottom > 150)
      act(() => {
        result.current.handleScroll(createScrollEvent(1000, 200, 600));
      });

      expect(result.current.state.autoScrollEnabled).toBe(false);
    });
  });

  describe('custom thresholds', () => {
    it('should respect custom nearBottomThreshold', () => {
      const { result } = renderHook(() => useScrollBehavior({ nearBottomThreshold: 200 }));

      // 150px from bottom - would be "not near" with default 100, but "near" with 200 threshold
      // distanceFromBottom = 1000 - 600 - 250 = 150
      act(() => {
        result.current.handleScroll(createScrollEvent(1000, 250, 600));
      });

      expect(result.current.state.isNearBottom).toBe(true);
    });

    it('should respect custom showButtonThreshold', () => {
      const { result } = renderHook(() => useScrollBehavior({ showButtonThreshold: 300 }));

      // 200px from bottom - would show button with default 150, but not with 300
      // distanceFromBottom = 1000 - 600 - 200 = 200
      act(() => {
        result.current.handleScroll(createScrollEvent(1000, 200, 600));
      });

      expect(result.current.state.showScrollButton).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('should handle empty content (height 0)', () => {
      const { result } = renderHook(() => useScrollBehavior());

      act(() => {
        result.current.handleContentSizeChange(0, 0);
      });

      // Should not crash and initial scroll should not be marked done
      expect(result.current.state.initialScrollDone).toBe(false);
    });

    it('should handle scroll event with content smaller than viewport', () => {
      const { result } = renderHook(() => useScrollBehavior());

      // Content (400) smaller than viewport (600)
      act(() => {
        result.current.handleScroll(createScrollEvent(400, 0, 600));
      });

      // distanceFromBottom = 400 - 600 - 0 = -200 (negative means at bottom)
      expect(result.current.state.isNearBottom).toBe(true);
    });

    it('should handle rapid scroll events', () => {
      const { result } = renderHook(() => useScrollBehavior());

      // Rapid scrolling
      act(() => {
        for (let i = 0; i < 100; i++) {
          result.current.handleScroll(createScrollEvent(1000, i * 4, 600));
        }
      });

      // Should not crash and should be at final position (400 = 100 * 4)
      // distanceFromBottom = 1000 - 600 - 396 = 4
      expect(result.current.state.isNearBottom).toBe(true);
    });

    it('should handle content shrinking', () => {
      const { result } = renderHook(() => useScrollBehavior());

      // Initial content
      act(() => {
        result.current.handleContentSizeChange(0, 1000);
      });

      // Content shrinks (e.g., messages deleted)
      act(() => {
        result.current.handleContentSizeChange(0, 500);
      });

      // Should not show new messages badge for shrinking content
      expect(result.current.state.hasNewMessages).toBe(false);
    });
  });

  describe('sending while receiving (real-world scenarios)', () => {
    it('should handle user sending message while Claude is responding', () => {
      const { result } = renderHook(() => useScrollBehavior());

      // Initial conversation
      act(() => {
        result.current.handleContentSizeChange(0, 1000);
      });

      // User is at bottom reading
      act(() => {
        result.current.handleScroll(createScrollEvent(1000, 350, 600));
      });
      expect(result.current.state.autoScrollEnabled).toBe(true);
      expect(result.current.state.isNearBottom).toBe(true);

      // User types and sends message (prepareForSend called)
      act(() => {
        result.current.prepareForSend();
      });

      // User's message appears (content grows)
      act(() => {
        result.current.handleContentSizeChange(0, 1100);
      });

      // Claude starts responding (content grows more)
      act(() => {
        result.current.handleContentSizeChange(0, 1200);
      });

      // User should still be pinned to bottom, no new message badge
      expect(result.current.state.autoScrollEnabled).toBe(true);
      expect(result.current.state.hasNewMessages).toBe(false);
      expect(result.current.state.showScrollButton).toBe(false);
    });

    it('should handle user scrolling up to read while Claude continues responding', () => {
      const { result } = renderHook(() => useScrollBehavior());

      // Ongoing conversation with Claude responding
      act(() => {
        result.current.handleContentSizeChange(0, 1500);
      });

      // User at bottom initially
      act(() => {
        result.current.handleScroll(createScrollEvent(1500, 850, 600));
      });
      expect(result.current.state.autoScrollEnabled).toBe(true);

      // User scrolls up to read earlier message
      act(() => {
        result.current.handleScroll(createScrollEvent(1500, 200, 600));
      });
      expect(result.current.state.autoScrollEnabled).toBe(false);
      expect(result.current.state.showScrollButton).toBe(true);

      // Claude keeps responding (content grows)
      act(() => {
        result.current.handleContentSizeChange(0, 1700);
      });

      // User should see new message badge but NOT auto-scroll
      expect(result.current.state.hasNewMessages).toBe(true);
      expect(result.current.state.autoScrollEnabled).toBe(false);

      // More Claude output
      act(() => {
        result.current.handleContentSizeChange(0, 2000);
      });

      // Still not auto-scrolling, badge still shown
      expect(result.current.state.hasNewMessages).toBe(true);
      expect(result.current.state.autoScrollEnabled).toBe(false);
    });

    it('should handle user sending while scrolled up with new messages', () => {
      const { result } = renderHook(() => useScrollBehavior());

      // Setup: user scrolled up with new messages badge showing
      act(() => {
        result.current.handleContentSizeChange(0, 1000);
      });
      act(() => {
        result.current.handleScroll(createScrollEvent(1000, 100, 600));
      });
      act(() => {
        result.current.handleContentSizeChange(0, 1200);
      });
      expect(result.current.state.hasNewMessages).toBe(true);
      expect(result.current.state.showScrollButton).toBe(true);

      // User sends a message from scrolled up position
      act(() => {
        result.current.prepareForSend();
      });

      // Should clear badge and re-enable auto-scroll for their own message
      expect(result.current.state.hasNewMessages).toBe(false);
      expect(result.current.state.showScrollButton).toBe(false);
      expect(result.current.state.autoScrollEnabled).toBe(true);
    });
  });

  describe('tool execution scenarios', () => {
    it('should handle long tool output appearing while user is pinned', () => {
      const { result } = renderHook(() => useScrollBehavior());

      // User at bottom of conversation
      act(() => {
        result.current.handleContentSizeChange(0, 1000);
      });
      act(() => {
        result.current.handleScroll(createScrollEvent(1000, 350, 600));
      });

      // Tool executes and produces large output (e.g., file read)
      act(() => {
        result.current.handleContentSizeChange(0, 2000);
      });

      // User should stay pinned, no badge
      expect(result.current.state.autoScrollEnabled).toBe(true);
      expect(result.current.state.hasNewMessages).toBe(false);
    });

    it('should handle tool output appearing while user is scrolled up', () => {
      const { result } = renderHook(() => useScrollBehavior());

      // User scrolled up reading history
      act(() => {
        result.current.handleContentSizeChange(0, 1000);
      });
      act(() => {
        result.current.handleScroll(createScrollEvent(1000, 0, 600));
      });
      expect(result.current.state.autoScrollEnabled).toBe(false);

      // Large tool output appears
      act(() => {
        result.current.handleContentSizeChange(0, 3000);
      });

      // User should NOT be auto-scrolled, should see badge
      expect(result.current.state.hasNewMessages).toBe(true);
      expect(result.current.state.autoScrollEnabled).toBe(false);
    });

    it('should handle multiple rapid tool calls', () => {
      const { result } = renderHook(() => useScrollBehavior());

      // User at bottom
      act(() => {
        result.current.handleContentSizeChange(0, 1000);
      });
      act(() => {
        result.current.handleScroll(createScrollEvent(1000, 350, 600));
      });

      // Rapid tool calls adding content
      act(() => {
        result.current.handleContentSizeChange(0, 1100);
        result.current.handleContentSizeChange(0, 1200);
        result.current.handleContentSizeChange(0, 1300);
        result.current.handleContentSizeChange(0, 1400);
        result.current.handleContentSizeChange(0, 1500);
      });

      // Should stay pinned through all updates
      expect(result.current.state.autoScrollEnabled).toBe(true);
      expect(result.current.state.hasNewMessages).toBe(false);
    });
  });

  describe('waiting for input state', () => {
    it('should show new message badge when waiting for input and user scrolled up', () => {
      const { result } = renderHook(() => useScrollBehavior());

      // Claude working, user reading history
      act(() => {
        result.current.handleContentSizeChange(0, 1500);
      });
      act(() => {
        result.current.handleScroll(createScrollEvent(1500, 100, 600));
      });

      // Claude finishes and shows input request
      act(() => {
        result.current.handleContentSizeChange(0, 1600);
      });

      // Badge should appear since user is scrolled up
      expect(result.current.state.hasNewMessages).toBe(true);
    });

    it('should not show badge when waiting for input and user is pinned', () => {
      const { result } = renderHook(() => useScrollBehavior());

      // User at bottom watching Claude work
      act(() => {
        result.current.handleContentSizeChange(0, 1500);
      });
      act(() => {
        result.current.handleScroll(createScrollEvent(1500, 850, 600));
      });

      // Claude finishes and shows input request
      act(() => {
        result.current.handleContentSizeChange(0, 1600);
      });

      // No badge needed - user is already at bottom
      expect(result.current.state.hasNewMessages).toBe(false);
    });
  });

  describe('pinned behavior (at bottom)', () => {
    it('should remain pinned through multiple content updates', () => {
      const { result } = renderHook(() => useScrollBehavior());

      // Initial position at bottom
      act(() => {
        result.current.handleContentSizeChange(0, 1000);
      });
      act(() => {
        result.current.handleScroll(createScrollEvent(1000, 350, 600));
      });

      // Series of content updates simulating streaming response
      for (let i = 0; i < 20; i++) {
        act(() => {
          result.current.handleContentSizeChange(0, 1000 + (i + 1) * 100);
          // Simulate scroll events as if auto-scroll is working
          result.current.handleScroll(createScrollEvent(1000 + (i + 1) * 100, 400 + (i + 1) * 100, 600));
        });
      }

      expect(result.current.state.autoScrollEnabled).toBe(true);
      expect(result.current.state.isNearBottom).toBe(true);
      expect(result.current.state.hasNewMessages).toBe(false);
    });

    it('should detect when scroll position drifts away from bottom', () => {
      const { result } = renderHook(() => useScrollBehavior());

      // User at bottom
      act(() => {
        result.current.handleContentSizeChange(0, 1000);
      });
      act(() => {
        result.current.handleScroll(createScrollEvent(1000, 350, 600));
      });
      expect(result.current.state.isNearBottom).toBe(true);

      // Content grows but scroll position doesn't follow (simulating user interaction)
      act(() => {
        result.current.handleContentSizeChange(0, 1500);
      });
      // Scroll event showing user didn't scroll down
      act(() => {
        result.current.handleScroll(createScrollEvent(1500, 350, 600));
      });

      // Now 550px from bottom (1500 - 600 - 350 = 550) - way past threshold
      expect(result.current.state.isNearBottom).toBe(false);
      expect(result.current.state.autoScrollEnabled).toBe(false);
      expect(result.current.state.showScrollButton).toBe(true);
    });
  });

  describe('not pinned behavior (scrolled up)', () => {
    it('should maintain unpinned state through content updates', () => {
      const { result } = renderHook(() => useScrollBehavior());

      // User explicitly scrolled up
      act(() => {
        result.current.handleContentSizeChange(0, 2000);
      });
      act(() => {
        result.current.handleScroll(createScrollEvent(2000, 0, 600));
      });

      expect(result.current.state.autoScrollEnabled).toBe(false);

      // Content updates shouldn't re-enable auto-scroll
      act(() => {
        result.current.handleContentSizeChange(0, 2500);
      });
      act(() => {
        result.current.handleContentSizeChange(0, 3000);
      });

      expect(result.current.state.autoScrollEnabled).toBe(false);
      expect(result.current.state.hasNewMessages).toBe(true);
    });

    it('should re-enable auto-scroll only when user manually scrolls to bottom', () => {
      const { result } = renderHook(() => useScrollBehavior());

      // Scrolled up
      act(() => {
        result.current.handleContentSizeChange(0, 2000);
      });
      act(() => {
        result.current.handleScroll(createScrollEvent(2000, 0, 600));
      });
      expect(result.current.state.autoScrollEnabled).toBe(false);

      // User scrolls down to near bottom
      act(() => {
        result.current.handleScroll(createScrollEvent(2000, 1350, 600));
      });

      // Should re-enable - distanceFromBottom = 2000 - 600 - 1350 = 50
      expect(result.current.state.isNearBottom).toBe(true);
      expect(result.current.state.autoScrollEnabled).toBe(true);
    });

    it('should re-enable auto-scroll via scrollToBottom button', () => {
      const { result } = renderHook(() => useScrollBehavior());

      // Scrolled up with badge
      act(() => {
        result.current.handleContentSizeChange(0, 2000);
      });
      act(() => {
        result.current.handleScroll(createScrollEvent(2000, 0, 600));
      });
      act(() => {
        result.current.handleContentSizeChange(0, 2500);
      });

      expect(result.current.state.autoScrollEnabled).toBe(false);
      expect(result.current.state.hasNewMessages).toBe(true);
      expect(result.current.state.showScrollButton).toBe(true);

      // User taps scroll to bottom button
      act(() => {
        result.current.scrollToBottom();
      });

      expect(result.current.state.autoScrollEnabled).toBe(true);
      expect(result.current.state.hasNewMessages).toBe(false);
      expect(result.current.state.showScrollButton).toBe(false);
    });
  });

  describe('session switch scenarios', () => {
    it('should reset all state when switching sessions', () => {
      const { result } = renderHook(() => useScrollBehavior());

      // Complex state from previous session
      act(() => {
        result.current.handleContentSizeChange(0, 3000);
      });
      act(() => {
        result.current.handleScroll(createScrollEvent(3000, 100, 600));
      });
      act(() => {
        result.current.handleContentSizeChange(0, 3500);
      });

      // Verify messy state
      expect(result.current.state.autoScrollEnabled).toBe(false);
      expect(result.current.state.hasNewMessages).toBe(true);
      expect(result.current.state.showScrollButton).toBe(true);
      expect(result.current.state.isNearBottom).toBe(false);

      // Switch sessions
      act(() => {
        result.current.resetForSessionSwitch();
      });

      // Should be clean initial state
      expect(result.current.state.autoScrollEnabled).toBe(true);
      expect(result.current.state.hasNewMessages).toBe(false);
      expect(result.current.state.showScrollButton).toBe(false);
      expect(result.current.state.isNearBottom).toBe(true);
      expect(result.current.state.initialScrollDone).toBe(false);
    });

    it('should handle immediate content load after session switch', () => {
      const { result } = renderHook(() => useScrollBehavior());

      // Previous session state - user scrolled up with new messages
      act(() => {
        result.current.handleContentSizeChange(0, 2000);
      });
      act(() => {
        result.current.handleScroll(createScrollEvent(2000, 0, 600));
      });
      act(() => {
        result.current.handleContentSizeChange(0, 2500);
      });
      expect(result.current.state.hasNewMessages).toBe(true);

      // Switch sessions
      act(() => {
        result.current.resetForSessionSwitch();
      });

      // New session loads content immediately
      act(() => {
        result.current.handleContentSizeChange(0, 1500);
      });

      // After initial load, subsequent content growth should not show badge
      // (because user is conceptually at bottom of new session)
      act(() => {
        result.current.handleScroll(createScrollEvent(1500, 850, 600));
      });
      act(() => {
        result.current.handleContentSizeChange(0, 1700);
      });

      // Should NOT show new messages badge since user is at bottom of new session
      expect(result.current.state.hasNewMessages).toBe(false);
    });
  });

  describe('stress tests', () => {
    it('should handle extremely long conversations', () => {
      const { result } = renderHook(() => useScrollBehavior());

      // Simulate very long conversation (50000px of content)
      act(() => {
        result.current.handleContentSizeChange(0, 50000);
      });

      // User at various positions
      act(() => {
        result.current.handleScroll(createScrollEvent(50000, 0, 600));
      });
      expect(result.current.state.isNearBottom).toBe(false);

      act(() => {
        result.current.handleScroll(createScrollEvent(50000, 49350, 600));
      });
      expect(result.current.state.isNearBottom).toBe(true);
    });

    it('should handle alternating scroll up/down rapidly', () => {
      const { result } = renderHook(() => useScrollBehavior());

      act(() => {
        result.current.handleContentSizeChange(0, 2000);
      });

      // Rapid alternating scrolls
      for (let i = 0; i < 50; i++) {
        act(() => {
          const offset = i % 2 === 0 ? 1350 : 100;
          result.current.handleScroll(createScrollEvent(2000, offset, 600));
        });
      }

      // Should be in consistent state at final position (100 = far from bottom)
      expect(result.current.state.isNearBottom).toBe(false);
    });

    it('should handle content size changes while actively scrolling', () => {
      const { result } = renderHook(() => useScrollBehavior());

      act(() => {
        result.current.handleContentSizeChange(0, 1000);
      });
      act(() => {
        result.current.handleScroll(createScrollEvent(1000, 350, 600));
      });

      // Interleaved content changes and scroll events
      for (let i = 0; i < 20; i++) {
        act(() => {
          const newHeight = 1000 + (i + 1) * 50;
          result.current.handleContentSizeChange(0, newHeight);
          // Scroll follows content
          result.current.handleScroll(createScrollEvent(newHeight, newHeight - 650, 600));
        });
      }

      // Should still be pinned at end
      expect(result.current.state.isNearBottom).toBe(true);
      expect(result.current.state.autoScrollEnabled).toBe(true);
    });
  });

  describe('markNewMessages', () => {
    it('should set hasNewMessages when not near bottom', () => {
      const { result } = renderHook(() => useScrollBehavior());

      // User scrolled up
      act(() => {
        result.current.handleContentSizeChange(0, 1000);
      });
      act(() => {
        result.current.handleScroll(createScrollEvent(1000, 0, 600));
      });

      act(() => {
        result.current.markNewMessages();
      });

      expect(result.current.state.hasNewMessages).toBe(true);
    });

    it('should NOT set hasNewMessages when near bottom', () => {
      const { result } = renderHook(() => useScrollBehavior());

      // User at bottom
      act(() => {
        result.current.handleContentSizeChange(0, 1000);
      });
      act(() => {
        result.current.handleScroll(createScrollEvent(1000, 350, 600));
      });

      act(() => {
        result.current.markNewMessages();
      });

      expect(result.current.state.hasNewMessages).toBe(false);
    });
  });

  describe('scroll direction detection', () => {
    // Note: autoScrollEnabled is a ref (doesn't trigger re-renders), so we verify
    // behavior by checking what happens when content grows, not the ref value directly

    it('should disable auto-scroll immediately when user scrolls UP', () => {
      // Mock Date.now to control programmatic scroll window
      let mockTime = 1000;
      const originalDateNow = Date.now;
      Date.now = jest.fn(() => mockTime);

      try {
        const { result } = renderHook(() => useScrollBehavior());

        // Start at bottom with auto-scroll enabled (initial load)
        act(() => {
          result.current.handleContentSizeChange(0, 1000);
        });

        // Advance past initial programmatic scroll window
        mockTime += 400;

        act(() => {
          result.current.handleScroll(createScrollEvent(1000, 350, 600)); // at bottom
        });

        // User scrolls UP by just 20px (still "near bottom" by threshold)
        act(() => {
          result.current.handleScroll(createScrollEvent(1000, 330, 600));
        });

        // Verify by checking behavior: content grows, should show badge (not auto-scroll)
        act(() => {
          result.current.handleContentSizeChange(0, 1200);
        });

        // If auto-scroll was disabled, we should see new messages badge
        expect(result.current.state.hasNewMessages).toBe(true);
      } finally {
        Date.now = originalDateNow;
      }
    });

    it('should re-enable auto-scroll when user scrolls DOWN to bottom', () => {
      const { result } = renderHook(() => useScrollBehavior());

      // Setup: user was scrolled up
      act(() => {
        result.current.handleContentSizeChange(0, 1000);
      });
      act(() => {
        result.current.handleScroll(createScrollEvent(1000, 200, 600)); // scrolled up
      });

      // Content grows - badge should appear
      act(() => {
        result.current.handleContentSizeChange(0, 1100);
      });
      expect(result.current.state.hasNewMessages).toBe(true);

      // User scrolls DOWN to bottom
      act(() => {
        result.current.handleScroll(createScrollEvent(1100, 450, 600)); // at bottom
      });

      // Badge should clear when reaching bottom
      expect(result.current.state.hasNewMessages).toBe(false);

      // More content grows - should NOT show badge (auto-scroll re-enabled)
      act(() => {
        result.current.handleContentSizeChange(0, 1300);
      });
      expect(result.current.state.hasNewMessages).toBe(false);
    });

    it('should handle tap-scroll-bottom then immediate scroll up (the exact bug scenario)', () => {
      // Mock Date.now to control time
      let mockTime = 1000;
      const originalDateNow = Date.now;
      Date.now = jest.fn(() => mockTime);

      try {
        const { result } = renderHook(() => useScrollBehavior());

        // Setup: conversation with content, user scrolled up
        act(() => {
          result.current.handleContentSizeChange(0, 2000);
        });
        act(() => {
          result.current.handleScroll(createScrollEvent(2000, 100, 600)); // scrolled up
        });

        // User taps scroll-to-bottom button
        act(() => {
          result.current.scrollToBottom();
        });

        // Simulate scroll event as list scrolls to bottom (during programmatic scroll)
        act(() => {
          result.current.handleScroll(createScrollEvent(2000, 1350, 600)); // at bottom
        });

        // Advance past programmatic scroll window (500ms)
        mockTime += 600;

        // User scrolls up "a bit" - even small scroll should disable
        act(() => {
          result.current.handleScroll(createScrollEvent(2000, 1340, 600)); // 10px up
        });

        // Content grows (tool output arrives)
        act(() => {
          result.current.handleContentSizeChange(0, 2200);
        });

        // Should show new messages badge (proving auto-scroll was disabled)
        expect(result.current.state.hasNewMessages).toBe(true);
      } finally {
        Date.now = originalDateNow;
      }
    });
  });
});
