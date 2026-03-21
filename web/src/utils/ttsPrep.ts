import type { ToolCall } from '../types';

/**
 * Transform markdown content into clean speakable plain text for TTS.
 */
export function prepareForSpeech(markdown: string): string {
  let text = markdown;
  const collapses: string[] = [];

  // Remove fenced code blocks (``` ... ```) silently
  text = text.replace(/```[\s\S]*?```/g, '');

  // Strip inline code backticks but keep the text inside
  text = text.replace(/`([^`]+)`/g, '$1');

  // Convert [text](url) links to just text
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

  // Strip bold (**text** or __text__)
  text = text.replace(/\*\*(.+?)\*\*/g, '$1');
  text = text.replace(/__(.+?)__/g, '$1');

  // Strip italic (*text* or _text_) — single markers
  text = text.replace(/\*(.+?)\*/g, '$1');
  text = text.replace(/(?<!\w)_(.+?)_(?!\w)/g, '$1');

  // Strip strikethrough (~~text~~)
  text = text.replace(/~~(.+?)~~/g, '$1');

  // Strip heading markers
  text = text.replace(/^#{1,6}\s+/gm, '');

  // Strip bullet list markers (-, *, numbered)
  text = text.replace(/^[\t ]*[-*]\s+/gm, '');
  text = text.replace(/^[\t ]*\d+\.\s+/gm, '');

  // Strip HTML tags
  text = text.replace(/<[^>]+>/g, '');

  // Convert file paths to just the filename
  text = text.replace(/(?:\/[\w.-]+){2,}\/?([\w.-]+)/g, '$1');

  // Collapse runs of 4+ filenames into a summary
  const filenamePattern = /\b\w+\.\w{1,5}\b/g;
  text = text.replace(/((?:[ \t]*\b\w+\.\w{1,5}\b[ \t]*[,\n][ \t]*){3,}\b\w+\.\w{1,5}\b)/g, (match) => {
    const filenames = match.match(filenamePattern);
    if (filenames && filenames.length >= 4) {
      collapses.push(`${filenames.length} filenames collapsed`);
      return `${filenames.length} files mentioned`;
    }
    return match;
  });

  // Collapse multiple newlines into sentence breaks, then collapse whitespace
  text = text.replace(/\n{2,}/g, '. ');
  text = text.replace(/\n/g, ' ');
  text = text.replace(/\s{2,}/g, ' ');

  // Clean up repeated periods from collapse
  text = text.replace(/\.{2,}/g, '.');
  text = text.replace(/\.\s*\./g, '.');

  text = text.trim();

  // Truncate if over 2000 chars
  if (text.length > 2000) {
    text = text.slice(0, 2000).trimEnd() + '... message truncated';
  }

  console.log(`[TTS-Prep] input=${markdown.length} chars, output=${text.length} chars${collapses.length > 0 ? ', collapses: ' + collapses.join(', ') : ''}`);

  return text;
}

/**
 * Summarize an array of tool calls into a spoken description.
 * Groups by tool name and provides counts.
 */
export function summarizeToolCalls(toolCalls: ToolCall[]): string {
  if (!toolCalls || toolCalls.length === 0) {
    return '';
  }

  const counts = new Map<string, number>();
  for (const call of toolCalls) {
    counts.set(call.name, (counts.get(call.name) || 0) + 1);
  }

  const parts: string[] = [];
  for (const [name, count] of counts) {
    if (count === 1) {
      parts.push(`Used ${name} once.`);
    } else {
      parts.push(`Used ${name} ${count} times.`);
    }
  }

  return parts.join(' ');
}
