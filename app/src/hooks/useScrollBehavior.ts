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

    const nearBottom = distanceFromBottom < nearBottomThreshold;
    isNearBottom.current = nearBottom;

    // Show/hide scroll button based on distance
    const shouldShowButton = distanceFromBottom > showButtonThreshold;
    setShowScrollButton(prev => prev !== shouldShowButton ? shouldShowButton : prev);

    // Update auto-scroll state with hysteresis to prevent flapping
    if (nearBottom) {
      autoScrollEnabled.current = true;
      setHasNewMessages(false);
    } else if (distanceFromBottom > showButtonThreshold) {
      autoScrollEnabled.current = false;
    }
    // Between thresholds: keep current state (hysteresis)
  }, [nearBottomThreshold, showButtonThreshold]);

  const handleContentSizeChange = useCallback((_width: number, height: number) => {
    const prevHeight = lastContentHeight.current;
    lastContentHeight.current = height;

    // Initial load - scroll to bottom immediately
    if (!initialScrollDone.current && height > 0) {
      initialScrollDone.current = true;
      listRef.current?.scrollToEnd({ animated: false });
      return;
    }

    // Content grew - show new message indicator if user scrolled up
    const contentGrew = height > prevHeight + 50; // 50px threshold to avoid noise
    if (contentGrew && !isNearBottom.current) {
      setHasNewMessages(true);
    }

    // Auto-scroll if enabled and near bottom
    if (contentGrew && autoScrollEnabled.current && isNearBottom.current) {
      listRef.current?.scrollToEnd({ animated: true });
    }
  }, []);

  const scrollToBottom = useCallback((animated = true) => {
    setHasNewMessages(false);
    setShowScrollButton(false);
    autoScrollEnabled.current = true;
    isNearBottom.current = true;
    listRef.current?.scrollToEnd({ animated });
  }, []);

  const prepareForSend = useCallback(() => {
    // When user sends a message, ensure we scroll to see it
    isNearBottom.current = true;
    autoScrollEnabled.current = true;
    setHasNewMessages(false);
    setShowScrollButton(false);

    // Small delay to let the message render
    setTimeout(() => {
      listRef.current?.scrollToEnd({ animated: true });
    }, 100);
  }, []);

  const resetForSessionSwitch = useCallback(() => {
    initialScrollDone.current = false;
    lastContentHeight.current = 0;
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
