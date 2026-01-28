import { useRef, useCallback, useState } from 'react';
import { FlatList } from 'react-native';

export interface ScrollState {
  isNearBottom: boolean;
  autoScrollEnabled: boolean;
  hasNewMessages: boolean;
  showScrollButton: boolean;
  initialScrollDone: boolean;
}

export interface ScrollBehaviorConfig {
  /** Distance from bottom to consider "near bottom" (default: 100) */
  nearBottomThreshold?: number;
  /** Distance to scroll up before showing scroll button (default: 150) */
  showButtonThreshold?: number;
}

export interface ScrollBehaviorResult {
  state: ScrollState;
  listRef: React.RefObject<FlatList | null>;

  /** Call when scroll event fires */
  handleScroll: (event: { nativeEvent: { layoutMeasurement: { height: number }; contentOffset: { y: number }; contentSize: { height: number } } }) => void;

  /** Call when content size changes */
  handleContentSizeChange: (width: number, height: number) => void;

  /** Manually scroll to bottom */
  scrollToBottom: (animated?: boolean) => void;

  /** Call before sending a message - ensures scroll to bottom */
  prepareForSend: () => void;

  /** Call when switching sessions - resets state */
  resetForSessionSwitch: () => void;

  /** Mark that there are new messages (for badge) */
  markNewMessages: () => void;
}

const DEFAULT_CONFIG: Required<ScrollBehaviorConfig> = {
  nearBottomThreshold: 100,
  showButtonThreshold: 150,
};

export function useScrollBehavior(config: ScrollBehaviorConfig = {}): ScrollBehaviorResult {
  const { nearBottomThreshold, showButtonThreshold } = { ...DEFAULT_CONFIG, ...config };

  const listRef = useRef<FlatList>(null);
  const lastContentHeight = useRef(0);
  const lastScrollOffset = useRef(0);
  const programmaticScrollUntil = useRef(0); // Timestamp when programmatic scroll ends
  const userScrollCooldownUntil = useRef(0); // Cooldown after user scroll to prevent fighting

  // State that triggers re-renders
  const [hasNewMessages, setHasNewMessages] = useState(false);
  const [showScrollButton, setShowScrollButton] = useState(false);

  // Refs for values that don't need re-renders
  const isNearBottom = useRef(true);
  const autoScrollEnabled = useRef(true);
  const initialScrollDone = useRef(false);

  const handleScroll = useCallback((event: { nativeEvent: { layoutMeasurement: { height: number }; contentOffset: { y: number }; contentSize: { height: number } } }) => {
    const { layoutMeasurement, contentOffset, contentSize } = event.nativeEvent;
    const distanceFromBottom = contentSize.height - layoutMeasurement.height - contentOffset.y;
    const currentOffset = contentOffset.y;
    const prevOffset = lastScrollOffset.current;
    lastScrollOffset.current = currentOffset;

    // Check if we're in a programmatic scroll window (ignore user input detection)
    const isProgrammaticScroll = Date.now() < programmaticScrollUntil.current;

    // Detect manual scroll direction (negative = scrolling up toward top)
    const scrollDelta = currentOffset - prevOffset;
    const isScrollingUp = scrollDelta < -5; // Small threshold to ignore noise
    const isUserScrolling = Math.abs(scrollDelta) > 2; // Any significant scroll

    const nearBottom = distanceFromBottom < nearBottomThreshold;
    isNearBottom.current = nearBottom;

    // Show/hide scroll button based on distance
    const shouldShowButton = distanceFromBottom > showButtonThreshold;
    setShowScrollButton(prev => prev !== shouldShowButton ? shouldShowButton : prev);

    // Set cooldown on ANY user scroll to prevent fighting with auto-scroll
    if (!isProgrammaticScroll && isUserScrolling) {
      userScrollCooldownUntil.current = Date.now() + 500; // 500ms cooldown
    }

    // Update auto-scroll state
    // IMPORTANT: Check scroll direction FIRST - if user scrolls up, disable immediately
    if (!isProgrammaticScroll && isScrollingUp) {
      // User manually scrolled UP - immediately disable auto-scroll
      autoScrollEnabled.current = false;
    } else if (nearBottom && !isScrollingUp) {
      // At bottom and not scrolling up - re-enable auto-scroll
      autoScrollEnabled.current = true;
      setHasNewMessages(false);
    } else if (distanceFromBottom > showButtonThreshold) {
      // Far from bottom - disable auto-scroll
      autoScrollEnabled.current = false;
    }
    // Between thresholds and not scrolling up: keep current state (hysteresis)
  }, [nearBottomThreshold, showButtonThreshold]);

  const handleContentSizeChange = useCallback((_width: number, height: number) => {
    const prevHeight = lastContentHeight.current;
    lastContentHeight.current = height;

    // Initial load - scroll to bottom immediately
    if (!initialScrollDone.current && height > 0) {
      initialScrollDone.current = true;
      // Mark as programmatic scroll
      programmaticScrollUntil.current = Date.now() + 300;
      listRef.current?.scrollToEnd({ animated: false });
      return;
    }

    // Content grew - show new message indicator if auto-scroll is disabled
    // (meaning user has scrolled up and is reading)
    const contentGrew = height > prevHeight + 50; // 50px threshold to avoid noise
    if (contentGrew && !autoScrollEnabled.current) {
      setHasNewMessages(true);
    }

    // Check if user is actively scrolling (cooldown period)
    const userIsScrolling = Date.now() < userScrollCooldownUntil.current;

    // Auto-scroll only if:
    // 1. Auto-scroll is enabled (user hasn't scrolled up)
    // 2. User isn't actively scrolling (respect their scroll intent)
    // 3. We're actually near the bottom (don't jump from far away)
    if (contentGrew && autoScrollEnabled.current && !userIsScrolling && isNearBottom.current) {
      // Mark as programmatic scroll
      programmaticScrollUntil.current = Date.now() + 300;
      listRef.current?.scrollToEnd({ animated: true });
    }
  }, []);

  const scrollToBottom = useCallback((animated = true) => {
    setHasNewMessages(false);
    setShowScrollButton(false);
    autoScrollEnabled.current = true;
    isNearBottom.current = true;
    // Mark as programmatic scroll for 500ms to ignore scroll events during animation
    programmaticScrollUntil.current = Date.now() + 500;
    listRef.current?.scrollToEnd({ animated });
  }, []);

  const prepareForSend = useCallback(() => {
    // When user sends a message, ensure we scroll to see it
    isNearBottom.current = true;
    autoScrollEnabled.current = true;
    setHasNewMessages(false);
    setShowScrollButton(false);
    // Mark as programmatic scroll for 600ms (100ms delay + 500ms animation)
    programmaticScrollUntil.current = Date.now() + 600;

    // Small delay to let the message render
    setTimeout(() => {
      listRef.current?.scrollToEnd({ animated: true });
    }, 100);
  }, []);

  const resetForSessionSwitch = useCallback(() => {
    initialScrollDone.current = false;
    lastContentHeight.current = 0;
    lastScrollOffset.current = 0;
    programmaticScrollUntil.current = 0;
    userScrollCooldownUntil.current = 0;
    autoScrollEnabled.current = true;
    isNearBottom.current = true;
    setHasNewMessages(false);
    setShowScrollButton(false);
  }, []);

  const markNewMessages = useCallback(() => {
    if (!isNearBottom.current) {
      setHasNewMessages(true);
    }
  }, []);

  return {
    state: {
      isNearBottom: isNearBottom.current,
      autoScrollEnabled: autoScrollEnabled.current,
      hasNewMessages,
      showScrollButton,
      initialScrollDone: initialScrollDone.current,
    },
    listRef,
    handleScroll,
    handleContentSizeChange,
    scrollToBottom,
    prepareForSend,
    resetForSessionSwitch,
    markNewMessages,
  };
}
