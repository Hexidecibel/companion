// Named constants for daemon magic numbers
// Organized by category for readability

// ========================================
// Tmux Operations
// ========================================
export const TMUX_OPERATION_TIMEOUT_MS = 5000;
export const POST_TEXT_DELAY_MS = 150;
export const POST_ENTER_DELAY_MS = 50;
export const POST_ENTER_BEFORE_TYPING_DELAY_MS = 200;
export const POST_OTHER_SELECT_DELAY_MS = 200;
export const POST_TEXT_INPUT_DELAY_MS = 150;
export const POST_CHOICE_DELAY_MS = 50;
export const DEFAULT_PANE_CAPTURE_LINES = 20;

// ========================================
// File Size Limits
// ========================================
export const MAX_IMAGE_FILE_SIZE_BYTES = 5 * 1024 * 1024;     // 5MB
export const MAX_TEXT_FILE_SIZE_BYTES = 1024 * 1024;           // 1MB
export const MAX_APK_FILE_SIZE_BYTES = 150 * 1024 * 1024;     // 150MB

// ========================================
// Buffer Sizes
// ========================================
export const FILE_ACTIVITY_READ_BUFFER_SIZE = 32 * 1024;      // 32KB
export const CONVERSATION_READ_BUFFER_SIZE = 64 * 1024;       // 64KB
export const BINARY_DETECTION_PROBE_SIZE = 8192;               // 8KB

// ========================================
// Polling & Debounce
// ========================================
export const TMUX_PATH_REFRESH_INTERVAL_MS = 5000;
export const CHOKIDAR_STABILITY_THRESHOLD_MS = 100;
export const CHOKIDAR_POLL_INTERVAL_MS = 50;
export const FILE_WATCHER_POLL_INTERVAL_MS = 100;
export const INITIAL_LOAD_COMPLETION_DELAY_MS = 3000;
export const INITIAL_LOAD_WINDOW_MS = 3000;
export const INITIAL_FILE_MAX_AGE_MS = 2 * 60 * 1000;         // 2 min

// ========================================
// Auto-Approval
// ========================================
export const AUTO_APPROVAL_DEDUP_WINDOW_MS = 1000;
export const AUTO_APPROVAL_CLEANUP_WINDOW_MS = 30000;
export const APPROVAL_SEND_DELAY_MS = 300;

// ========================================
// Server & Lifecycle
// ========================================
export const SHUTDOWN_TIMEOUT_MS = 5000;
export const STATUS_LOG_INTERVAL_MS = 60000;

// ========================================
// Display & Truncation
// ========================================
export const INPUT_LOG_PREVIEW_LENGTH = 80;
export const COMMAND_LOG_PREVIEW_LENGTH = 40;
export const SHORT_COMMAND_DISPLAY_LENGTH = 30;
export const QUESTION_PREVIEW_LENGTH = 50;
export const TOOL_DESCRIPTION_PREVIEW_LENGTH = 100;
export const TOOL_APPROVAL_PREVIEW_LENGTH = 50;
export const TOOL_INPUT_SUMMARY_LENGTH = 100;
export const MAX_TOOL_OUTPUT_SIZE = 2000;
export const MAX_SUMMARY_TEXT_LENGTH = 200;
export const SESSION_COMPLETION_MESSAGE_LENGTH = 200;
export const FCM_TOKEN_LOG_PREVIEW_LENGTH = 30;
export const CONVERSATION_ID_LOG_LENGTH = 8;
export const USER_LINE_LOG_LENGTH = 40;

// ========================================
// Parser
// ========================================
export const PARSER_WARNING_RATE_LIMIT_MS = 60000;
export const PARSER_DEDUP_KEY_PREVIEW_LENGTH = 100;

// ========================================
// Search
// ========================================
export const DEFAULT_SEARCH_RESULT_LIMIT = 20;
export const MAX_SEARCH_RESULT_LIMIT = 50;
export const SEARCH_SNIPPET_CONTEXT_CHARS = 60;
export const DEFAULT_SEARCH_SNIPPET_LENGTH = 120;
export const DEFAULT_HIGHLIGHTS_LIMIT = 50;
export const DEFAULT_FILE_SEARCH_LIMIT = 20;
export const MAX_DIRECTORY_TRAVERSAL_DEPTH = 10;
export const MAX_DIRECTORY_LISTING_ENTRIES = 100;

// ========================================
// Fuzzy Search Scoring
// ========================================
export const FUZZY_SCORE_EXACT_MATCH = 1000;
export const FUZZY_SCORE_STARTS_WITH = 500;
export const FUZZY_SCORE_CONTAINS = 300;
export const FUZZY_SCORE_PATH_MATCH = 100;
export const FUZZY_SCORE_SUBSEQUENCE_BASE = 50;
export const FUZZY_SCORE_CONSECUTIVE_MULTIPLIER = 10;
export const FUZZY_SCORE_LENGTH_MULTIPLIER = 100;

// ========================================
// Terminal
// ========================================
export const DEFAULT_TERMINAL_LINES = 100;
export const DEFAULT_DIGEST_PERIOD_MS = 24 * 60 * 60 * 1000;  // 24h
export const SCAFFOLD_INIT_TIMEOUT_MS = 5000;
export const EXEC_OPERATION_TIMEOUT_MS = 5000;

// ========================================
// Watcher
// ========================================
export const SLOW_FILE_PROCESSING_THRESHOLD_MS = 50;
export const SLOW_OPERATION_THRESHOLD_MS = 100;
export const MIN_USER_PROMPT_LENGTH = 10;
export const RECENT_ACTIVITY_LIMIT = 10;
