// Centralized color constants for the Companion mobile app
// Blue/Purple accent theme on dark background

// === Core Backgrounds ===
export const bg = {
  primary: '#111827',       // Main app background
  card: '#1f2937',          // Standard card background
  cardTinted: '#111c33',    // Blue-tinted card background
  cardPurple: '#1a1033',    // Purple-tinted card background
  subtle: '#374151',        // Tertiary elements, borders
  element: '#4b5563',       // Lighter subtle elements
  terminal: '#0d1117',      // Terminal background (GitHub dark)
  terminalHeader: '#161b22',
  terminalBorder: '#21262d',
};

// === Text Colors ===
export const text = {
  primary: '#f3f4f6',       // Main text
  secondary: '#d1d5db',     // Secondary text
  muted: '#9ca3af',         // Muted/tertiary text
  dim: '#6b7280',           // Very subtle text
  accent: '#60a5fa',        // Blue accent text
  accentPurple: '#a78bfa',  // Purple accent text
};

// === Borders ===
export const border = {
  default: '#374151',       // Standard border
  accent: '#3b4f8a',        // Blue-tinted border for accent cards
  subtle: '#4b5563',        // Subtle borders
};

// === Accent Colors ===
export const accent = {
  blue: '#3b82f6',
  blueLight: '#60a5fa',
  bluePale: '#93c5fd',
  purple: '#8b5cf6',
  purpleLight: '#a78bfa',
  indigo: '#6366f1',
};

// === Status Colors (semantic — don't change) ===
export const status = {
  success: '#10b981',
  successBright: '#22c55e',
  successLight: '#86efac',
  successPale: '#a7f3d0',
  warning: '#f59e0b',
  warningBright: '#fbbf24',
  warningAlt: '#eab308',
  error: '#ef4444',
  errorDark: '#dc2626',
  errorLight: '#fecaca',
  orange: '#f97316',
  neutral: '#6b7280',
};

// === Semantic Backgrounds ===
export const semantic = {
  blueBg: '#1e3a5f',        // Active/processing background
  purpleBg: '#2e1065',      // Purple zone background
  greenBg: '#14532d',       // Success/agents background
  greenBgAlt: '#065f46',    // Alternative green bg
  greenBgDark: '#0f291f',   // Very dark green
  redBg: '#7f1d1d',         // Error/danger background
  redBorder: '#991b1b',     // Error border
  amberBg: '#78350f',       // Warning background
};

// === Gradient Configs (for LinearGradient) ===
export const gradient = {
  // Primary blue → purple (headers, primary buttons)
  primary: {
    colors: ['#3b82f6', '#8b5cf6'],
    start: { x: 0, y: 0 },
    end: { x: 1, y: 0 },
  },
  // Subtle dark gradient (header backgrounds — not too bright)
  headerDark: {
    colors: ['#1a2744', '#1f1a3d'],
    start: { x: 0, y: 0 },
    end: { x: 1, y: 0 },
  },
  // Button gradient (slightly more vibrant)
  button: {
    colors: ['#3b82f6', '#7c3aed'],
    start: { x: 0, y: 0 },
    end: { x: 1, y: 1 },
  },
  // Progress bar gradient
  progress: {
    colors: ['#3b82f6', '#8b5cf6'],
    start: { x: 0, y: 0 },
    end: { x: 1, y: 0 },
  },
  // Card left border (vertical)
  cardBorder: {
    colors: ['#3b82f6', '#8b5cf6'],
    start: { x: 0, y: 0 },
    end: { x: 0, y: 1 },
  },
  // User message bubble
  messageBubble: {
    colors: ['#1e3a5f', '#2a1f52'],
    start: { x: 0, y: 0 },
    end: { x: 1, y: 1 },
  },
};
