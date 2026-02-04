export interface AnsiSpan {
  text: string;
  color?: string;
  bgColor?: string;
  bold?: boolean;
  dim?: boolean;
  underline?: boolean;
  inverse?: boolean;
}

// Standard 8 colors (GitHub dark terminal theme)
const STANDARD_COLORS: Record<number, string> = {
  0: '#484f58', // black
  1: '#ff7b72', // red
  2: '#3fb950', // green
  3: '#d29922', // yellow
  4: '#58a6ff', // blue
  5: '#bc8cff', // magenta
  6: '#39d2d2', // cyan
  7: '#c9d1d9', // white
};

// Bright variants
const BRIGHT_COLORS: Record<number, string> = {
  0: '#6e7681', // bright black
  1: '#ffa198', // bright red
  2: '#56d364', // bright green
  3: '#e3b341', // bright yellow
  4: '#79c0ff', // bright blue
  5: '#d2a8ff', // bright magenta
  6: '#56d4dd', // bright cyan
  7: '#f0f6fc', // bright white
};

// 256-color palette: 0-7 standard, 8-15 bright, 16-231 6x6x6 cube, 232-255 grayscale
function color256ToHex(n: number): string | undefined {
  if (n < 0 || n > 255) return undefined;
  if (n < 8) return STANDARD_COLORS[n];
  if (n < 16) return BRIGHT_COLORS[n - 8];
  if (n < 232) {
    // 6x6x6 color cube
    const idx = n - 16;
    const r = Math.floor(idx / 36);
    const g = Math.floor((idx % 36) / 6);
    const b = idx % 6;
    const toVal = (v: number) => (v === 0 ? 0 : 55 + v * 40);
    return `#${toVal(r).toString(16).padStart(2, '0')}${toVal(g).toString(16).padStart(2, '0')}${toVal(b).toString(16).padStart(2, '0')}`;
  }
  // Grayscale: 232-255 -> 8, 18, ..., 238
  const gray = 8 + (n - 232) * 10;
  const hex = gray.toString(16).padStart(2, '0');
  return `#${hex}${hex}${hex}`;
}

interface AnsiState {
  fg?: string;
  bg?: string;
  bold: boolean;
  dim: boolean;
  underline: boolean;
  inverse: boolean;
}

function newState(): AnsiState {
  return { bold: false, dim: false, underline: false, inverse: false };
}

function applyState(state: AnsiState, span: { text: string }): AnsiSpan {
  const result: AnsiSpan = { text: span.text };
  if (state.fg) result.color = state.fg;
  if (state.bg) result.bgColor = state.bg;
  if (state.bold) result.bold = true;
  if (state.dim) result.dim = true;
  if (state.underline) result.underline = true;
  if (state.inverse) result.inverse = true;
  return result;
}

function parseSGR(params: number[], state: AnsiState): void {
  let i = 0;
  while (i < params.length) {
    const code = params[i];

    if (code === 0) {
      // Reset
      state.fg = undefined;
      state.bg = undefined;
      state.bold = false;
      state.dim = false;
      state.underline = false;
      state.inverse = false;
    } else if (code === 1) {
      state.bold = true;
    } else if (code === 2) {
      state.dim = true;
    } else if (code === 4) {
      state.underline = true;
    } else if (code === 7) {
      state.inverse = true;
    } else if (code === 22) {
      state.bold = false;
      state.dim = false;
    } else if (code === 24) {
      state.underline = false;
    } else if (code === 27) {
      state.inverse = false;
    } else if (code >= 30 && code <= 37) {
      // Standard foreground
      state.fg = STANDARD_COLORS[code - 30];
    } else if (code === 38) {
      // Extended foreground
      if (i + 1 < params.length && params[i + 1] === 5 && i + 2 < params.length) {
        // 256-color: \e[38;5;Nm
        state.fg = color256ToHex(params[i + 2]);
        i += 2;
      } else if (i + 1 < params.length && params[i + 1] === 2 && i + 4 < params.length) {
        // True color: \e[38;2;R;G;Bm
        const r = params[i + 2];
        const g = params[i + 3];
        const b = params[i + 4];
        state.fg = `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
        i += 4;
      }
    } else if (code === 39) {
      state.fg = undefined;
    } else if (code >= 40 && code <= 47) {
      // Standard background
      state.bg = STANDARD_COLORS[code - 40];
    } else if (code === 48) {
      // Extended background
      if (i + 1 < params.length && params[i + 1] === 5 && i + 2 < params.length) {
        state.bg = color256ToHex(params[i + 2]);
        i += 2;
      } else if (i + 1 < params.length && params[i + 1] === 2 && i + 4 < params.length) {
        const r = params[i + 2];
        const g = params[i + 3];
        const b = params[i + 4];
        state.bg = `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
        i += 4;
      }
    } else if (code === 49) {
      state.bg = undefined;
    } else if (code >= 90 && code <= 97) {
      // Bright foreground
      state.fg = BRIGHT_COLORS[code - 90];
    } else if (code >= 100 && code <= 107) {
      // Bright background
      state.bg = BRIGHT_COLORS[code - 100];
    }

    i++;
  }
}

// Regex to match ANSI escape sequences
// SGR: \x1b[ ... m  (we parse these)
// Other CSI: \x1b[ ... <letter>  (we strip these)
// OSC: \x1b] ... \x07 or \x1b] ... \x1b\\  (we strip these)
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[([0-9;]*)m|\x1b\[[0-9;]*[A-HJKSTfhlnr]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g;

/**
 * Parse a single line of text containing ANSI escape codes into styled spans.
 */
export function parseAnsiLine(line: string): AnsiSpan[] {
  const spans: AnsiSpan[] = [];
  const state = newState();
  let lastIndex = 0;

  ANSI_RE.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = ANSI_RE.exec(line)) !== null) {
    // Text before this escape sequence
    if (match.index > lastIndex) {
      const text = line.slice(lastIndex, match.index);
      if (text) spans.push(applyState(state, { text }));
    }

    // If this is an SGR sequence (group 1 captured)
    if (match[1] !== undefined) {
      const paramStr = match[1];
      const params = paramStr === '' ? [0] : paramStr.split(';').map(Number);
      parseSGR(params, state);
    }
    // Other escape sequences are stripped (no text output)

    lastIndex = match.index + match[0].length;
  }

  // Remaining text after last escape
  if (lastIndex < line.length) {
    const text = line.slice(lastIndex);
    if (text) spans.push(applyState(state, { text }));
  }

  // If line is empty, return a single empty span so the line still renders
  if (spans.length === 0) {
    spans.push({ text: '' });
  }

  return spans;
}

/**
 * Parse multiple lines of ANSI text.
 * State carries across lines (as in a real terminal).
 */
export function parseAnsiText(text: string): AnsiSpan[][] {
  const lines = text.split('\n');
  const result: AnsiSpan[][] = [];
  const state = newState();

  for (const line of lines) {
    const spans: AnsiSpan[] = [];
    let lastIndex = 0;

    ANSI_RE.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = ANSI_RE.exec(line)) !== null) {
      if (match.index > lastIndex) {
        const text = line.slice(lastIndex, match.index);
        if (text) spans.push(applyState(state, { text }));
      }

      if (match[1] !== undefined) {
        const paramStr = match[1];
        const params = paramStr === '' ? [0] : paramStr.split(';').map(Number);
        parseSGR(params, state);
      }

      lastIndex = match.index + match[0].length;
    }

    if (lastIndex < line.length) {
      const remaining = line.slice(lastIndex);
      if (remaining) spans.push(applyState(state, { text: remaining }));
    }

    if (spans.length === 0) {
      spans.push({ text: '' });
    }

    result.push(spans);
  }

  return result;
}
