import { useMemo, useCallback, useState, Fragment } from 'react';
import { TRAILING_PUNCT_RE, ensureProtocol, formatLinkDomain as formatLinkDomainShared } from '../utils/urls';

// Re-export shared formatLinkDomain
const formatLinkDomain = formatLinkDomainShared;

interface MarkdownRendererProps {
  content: string;
  onFileClick?: (path: string) => void;
  existingFiles?: Set<string>;
  className?: string;
}

type InlineNode =
  | { type: 'text'; text: string }
  | { type: 'bold'; text: string }
  | { type: 'italic'; text: string }
  | { type: 'code'; text: string }
  | { type: 'link'; text: string; href: string }
  | { type: 'fileLink'; text: string; path: string };

function isFilePath(href: string): boolean {
  // Not a URL
  if (/^https?:\/\//.test(href)) return false;
  if (/^mailto:/.test(href)) return false;
  if (href.startsWith('#')) return false;
  // Has a file extension or starts with ./ or ../
  if (/\.\w{1,10}$/.test(href)) return true;
  if (href.startsWith('./') || href.startsWith('../')) return true;
  return false;
}

// Matches bare file paths like src/foo.ts, ./bar.md, ../baz/qux.tsx, /home/user/file.ts
// Must contain a / and end with a file extension
// Supports: relative paths, ./ paths, ../ paths, and absolute paths starting with /
const BARE_PATH_RE = /(?:^|\s)((?:\/|\.\.?\/)?(?:[\w.-]+\/)+[\w.-]+\.\w{1,10})(?=[\s,;:!?)}\]]|$)/g;

// Check if a string looks like a file path (for code spans)
function looksLikeFilePath(text: string): boolean {
  // Absolute path with extension
  if (/^\/(?:[\w.-]+\/)*[\w.-]+\.\w{1,10}$/.test(text)) return true;
  // Relative path with extension
  if (/^(?:\.\.?\/)?(?:[\w.-]+\/)*[\w.-]+\.\w{1,10}$/.test(text)) return true;
  return false;
}

/**
 * Extract all file paths detected in markdown content.
 * Reuses the same detection logic as the renderer (BARE_PATH_RE, looksLikeFilePath, isFilePath).
 * Used by parent components to pre-check path existence.
 */
export function extractFilePaths(content: string): string[] {
  const paths = new Set<string>();
  const lines = content.split('\n');

  for (const line of lines) {
    // Skip fenced code block markers
    if (line.startsWith('```')) continue;

    // Find inline code spans that look like file paths
    const codeRe = /`([^`]+)`/g;
    let codeMatch: RegExpExecArray | null;
    while ((codeMatch = codeRe.exec(line)) !== null) {
      if (looksLikeFilePath(codeMatch[1])) {
        paths.add(codeMatch[1]);
      }
    }

    // Find markdown links with file-path hrefs: [text](path)
    const linkRe = /\[([^\]]+)\]\(([^)]+)\)/g;
    let linkMatch: RegExpExecArray | null;
    while ((linkMatch = linkRe.exec(line)) !== null) {
      if (isFilePath(linkMatch[2])) {
        paths.add(linkMatch[2]);
      }
    }

    // Find bare file paths in text (after stripping inline code and links)
    const stripped = line.replace(/`[^`]+`/g, '   ').replace(/\[[^\]]+\]\([^)]+\)/g, '   ');
    BARE_PATH_RE.lastIndex = 0;
    let bareMatch: RegExpExecArray | null;
    while ((bareMatch = BARE_PATH_RE.exec(stripped)) !== null) {
      paths.add(bareMatch[1]);
    }
  }

  return Array.from(paths);
}

// Inline URL pattern — same as shared URL_PATTERN_SOURCE but with \]) added to the
// negative character classes so URLs don't eat into markdown link syntax.
// This is a CAPTURING group so it becomes match[7] in the combined regex.
const INLINE_URL_RE_SRC = '(https?:\\/\\/[^\\s<>\\])]+|\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}(?::\\d{1,5})?(?:\\/[^\\s<>\\])]*)?|localhost:\\d{1,5}(?:\\/[^\\s<>\\])]*)?|[\\w.-]+\\.\\w+:\\d{1,5}(?:\\/[^\\s<>\\])]*)?)'

// Pre-compiled regex for checking if a code span is a URL (anchored version of the URL pattern)
const CODE_URL_RE = new RegExp('^(?:' + INLINE_URL_RE_SRC.slice(1, -1) + ')$');

// Non-anchored version for finding URLs within code spans
const CODE_URL_FIND_RE = new RegExp(INLINE_URL_RE_SRC, 'g');

function splitByUrls(text: string): Array<{ text: string; isUrl: boolean }> {
  const parts: Array<{ text: string; isUrl: boolean }> = [];
  CODE_URL_FIND_RE.lastIndex = 0;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = CODE_URL_FIND_RE.exec(text)) !== null) {
    if (match.index > last) {
      parts.push({ text: text.slice(last, match.index), isUrl: false });
    }
    let url = match[0];
    const trailingPunct = /[.,;:!?)]+$/.exec(url);
    if (trailingPunct) {
      url = url.slice(0, -trailingPunct[0].length);
    }
    parts.push({ text: url, isUrl: true });
    last = match.index + url.length;
    CODE_URL_FIND_RE.lastIndex = last;
  }
  if (last < text.length) {
    parts.push({ text: text.slice(last), isUrl: false });
  }
  return parts;
}

function parseInline(text: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  // Regex handles: **bold**, *italic*, `code`, [text](url), bare URLs (incl. bare IPs, localhost:port, host:port)
  // Groups: 1=full, 2=bold, 3=italic, 4=code, 5=linkText, 6=linkHref, 7=bareURL
  const re = new RegExp('(\\*\\*(.+?)\\*\\*|\\*(.+?)\\*|`([^`]+)`|\\[([^\\]]+)\\]\\(([^)]+)\\)|' + INLINE_URL_RE_SRC + ')', 'g');
  let last = 0;
  let match: RegExpExecArray | null;

  while ((match = re.exec(text)) !== null) {
    if (match.index > last) {
      nodes.push({ type: 'text', text: text.slice(last, match.index) });
    }

    if (match[2] !== undefined) {
      nodes.push({ type: 'bold', text: match[2] });
    } else if (match[3] !== undefined) {
      nodes.push({ type: 'italic', text: match[3] });
    } else if (match[4] !== undefined) {
      nodes.push({ type: 'code', text: match[4] });
    } else if (match[5] !== undefined && match[6] !== undefined) {
      // [text](href) -- classify as file link or web link
      if (isFilePath(match[6])) {
        nodes.push({ type: 'fileLink', text: match[5], path: match[6] });
      } else {
        nodes.push({ type: 'link', text: match[5], href: match[6] });
      }
    } else if (match[7] !== undefined) {
      let url = match[7];
      const trailingPunct = TRAILING_PUNCT_RE.exec(url);
      if (trailingPunct) {
        url = url.slice(0, -trailingPunct[0].length);
      }
      const href = ensureProtocol(url);
      nodes.push({ type: 'link', text: url, href });
      last = match.index + match[0].length - (trailingPunct ? trailingPunct[0].length : 0);
      continue;
    }

    last = match.index + match[0].length;
  }

  if (last < text.length) {
    nodes.push({ type: 'text', text: text.slice(last) });
  }

  // Second pass: find bare file paths in text nodes
  const expanded: InlineNode[] = [];
  for (const node of nodes) {
    if (node.type !== 'text') {
      expanded.push(node);
      continue;
    }
    let txt = node.text;
    let bareLast = 0;
    BARE_PATH_RE.lastIndex = 0;
    let bareMatch: RegExpExecArray | null;
    let hasBarePaths = false;

    while ((bareMatch = BARE_PATH_RE.exec(txt)) !== null) {
      hasBarePaths = true;
      const pathStr = bareMatch[1];
      const pathStart = bareMatch.index + bareMatch[0].indexOf(pathStr);

      if (pathStart > bareLast) {
        expanded.push({ type: 'text', text: txt.slice(bareLast, pathStart) });
      }
      expanded.push({ type: 'fileLink', text: pathStr, path: pathStr });
      bareLast = pathStart + pathStr.length;
    }

    if (hasBarePaths) {
      if (bareLast < txt.length) {
        expanded.push({ type: 'text', text: txt.slice(bareLast) });
      }
    } else {
      expanded.push(node);
    }
  }

  return expanded;
}

function renderInline(text: string, keyPrefix: string, onFileClick?: (path: string) => void, existingFiles?: Set<string>) {
  const nodes = parseInline(text);
  return nodes.map((node, i) => {
    const key = `${keyPrefix}-${i}`;
    switch (node.type) {
      case 'bold':
        return <strong key={key}>{node.text}</strong>;
      case 'italic':
        return <em key={key}>{node.text}</em>;
      case 'code': {
        // Make code spans clickable if they look like URLs (including bare IPs, localhost:port, host:port)
        if (CODE_URL_RE.test(node.text)) {
          const codeHref = ensureProtocol(node.text);
          return (
            <a
              key={key}
              href={codeHref}
              target="_blank"
              rel="noopener noreferrer"
              className="link-pill"
              title={node.text}
            >
              <span className="link-pill-icon">{'\u2197'}</span>
              <span className="link-pill-text">{formatLinkDomain(node.text)}</span>
            </a>
          );
        }
        // Code span contains URL(s) among other text — render code with inline link pills
        const urlParts = splitByUrls(node.text);
        if (urlParts.some(p => p.isUrl)) {
          return (
            <code key={key}>
              {urlParts.map((part, j) =>
                part.isUrl ? (
                  <a
                    key={j}
                    href={ensureProtocol(part.text)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="link-pill"
                    title={part.text}
                  >
                    <span className="link-pill-icon">{'\u2197'}</span>
                    <span className="link-pill-text">{formatLinkDomain(part.text)}</span>
                  </a>
                ) : (
                  <span key={j}>{part.text}</span>
                )
              )}
            </code>
          );
        }
        // Make code spans clickable if they look like file paths AND file exists (or existence not checked)
        if (looksLikeFilePath(node.text) && onFileClick && (!existingFiles || existingFiles.has(node.text))) {
          return (
            <code
              key={key}
              className="md-file-link-code"
              onClick={() => onFileClick(node.text)}
            >
              {node.text}
            </code>
          );
        }
        return <code key={key}>{node.text}</code>;
      }
      case 'link': {
        // Bare URL: text matches original URL (before protocol was added)
        const isBareUrl = node.text === node.href || ensureProtocol(node.text) === node.href;
        const linkHref = ensureProtocol(node.href);
        return (
          <a
            key={key}
            href={linkHref}
            target="_blank"
            rel="noopener noreferrer"
            className={isBareUrl ? 'link-pill' : undefined}
            title={isBareUrl ? node.text : undefined}
          >
            {isBareUrl ? (
              <>
                <span className="link-pill-icon">{'\u2197'}</span>
                <span className="link-pill-text">{formatLinkDomain(node.text)}</span>
              </>
            ) : node.text}
          </a>
        );
      }
      case 'fileLink':
        // Only make clickable if file exists (or existence not checked)
        if (onFileClick && (!existingFiles || existingFiles.has(node.path))) {
          return (
            <span
              key={key}
              className="md-file-link"
              role="button"
              onClick={() => onFileClick(node.path)}
            >
              {node.text}
            </span>
          );
        }
        // Non-existent file: render as plain text
        return <span key={key}>{node.text}</span>;
      default:
        return <span key={key}>{node.text}</span>;
    }
  });
}

type Block =
  | { type: 'heading'; level: number; text: string }
  | { type: 'code'; lang: string; lines: string[] }
  | { type: 'blockquote'; lines: string[] }
  | { type: 'ul'; items: ListItem[] }
  | { type: 'ol'; items: ListItem[] }
  | { type: 'table'; headers: string[]; alignments: ('left' | 'center' | 'right' | null)[]; rows: string[][] }
  | { type: 'hr' }
  | { type: 'paragraph'; text: string };

interface ListItem {
  text: string;
  checked?: boolean; // for task lists: true = [x], false = [ ], undefined = not a task
}

function parseListItem(raw: string): ListItem {
  const taskMatch = raw.match(/^\[([xX ])\]\s(.*)$/);
  if (taskMatch) {
    return { text: taskMatch[2], checked: taskMatch[1].toLowerCase() === 'x' };
  }
  return { text: raw };
}

function parseTableAlignment(cell: string): 'left' | 'center' | 'right' | null {
  const trimmed = cell.trim();
  const left = trimmed.startsWith(':');
  const right = trimmed.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  if (left) return 'left';
  return null;
}

function parseTableRow(line: string): string[] {
  // Split by | but trim leading/trailing empty cells from outer pipes
  const cells = line.split('|');
  // Remove first and last if empty (from leading/trailing |)
  if (cells.length > 0 && cells[0].trim() === '') cells.shift();
  if (cells.length > 0 && cells[cells.length - 1].trim() === '') cells.pop();
  return cells.map(c => c.trim());
}

function isTableSeparator(line: string): boolean {
  return /^\|?[\s:-]+\|[\s|:-]+$/.test(line) && line.includes('-');
}

function parseBlocks(content: string): Block[] {
  const lines = content.split('\n');
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      blocks.push({ type: 'code', lang, lines: codeLines });
      i++; // skip closing ```
      continue;
    }

    // Table: detect header | separator | rows pattern
    if (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const headers = parseTableRow(line);
      const alignments = parseTableRow(lines[i + 1]).map(parseTableAlignment);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        rows.push(parseTableRow(lines[i]));
        i++;
      }
      blocks.push({ type: 'table', headers, alignments, rows });
      continue;
    }

    // Horizontal rule
    if (/^(-{3,}|_{3,}|\*{3,})\s*$/.test(line)) {
      blocks.push({ type: 'hr' });
      i++;
      continue;
    }

    // Heading
    const headingMatch = line.match(/^(#{1,6})\s+(.*)/);
    if (headingMatch) {
      blocks.push({ type: 'heading', level: headingMatch[1].length, text: headingMatch[2] || '' });
      i++;
      continue;
    }

    // Blockquote
    if (line.startsWith('> ') || line === '>') {
      const bqLines: string[] = [];
      while (i < lines.length && (lines[i].startsWith('> ') || lines[i] === '>')) {
        bqLines.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      blocks.push({ type: 'blockquote', lines: bqLines });
      continue;
    }

    // Unordered list
    if (/^[\s]*[-*+]\s/.test(line)) {
      const items: ListItem[] = [];
      while (i < lines.length && /^[\s]*[-*+]\s/.test(lines[i])) {
        items.push(parseListItem(lines[i].replace(/^[\s]*[-*+]\s/, '')));
        i++;
      }
      blocks.push({ type: 'ul', items });
      continue;
    }

    // Ordered list
    if (/^[\s]*\d+\.\s/.test(line)) {
      const items: ListItem[] = [];
      while (i < lines.length && /^[\s]*\d+\.\s/.test(lines[i])) {
        items.push(parseListItem(lines[i].replace(/^[\s]*\d+\.\s/, '')));
        i++;
      }
      blocks.push({ type: 'ol', items });
      continue;
    }

    // Blank line
    if (line.trim() === '') {
      i++;
      continue;
    }

    // Paragraph: collect consecutive non-empty, non-special lines
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !lines[i].startsWith('```') &&
      !lines[i].startsWith('# ') &&
      !lines[i].startsWith('## ') &&
      !lines[i].startsWith('### ') &&
      !lines[i].startsWith('#### ') &&
      !lines[i].startsWith('##### ') &&
      !lines[i].startsWith('###### ') &&
      !lines[i].startsWith('> ') &&
      lines[i] !== '>' &&
      !/^[\s]*[-*+]\s/.test(lines[i]) &&
      !/^[\s]*\d+\.\s/.test(lines[i]) &&
      !/^(-{3,}|_{3,}|\*{3,})\s*$/.test(lines[i]) &&
      // Don't eat table rows into paragraphs
      !(lines[i].includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1]))
    ) {
      paraLines.push(lines[i]);
      i++;
    }

    if (paraLines.length > 0) {
      blocks.push({ type: 'paragraph', text: paraLines.join('\n') });
    } else {
      // Safety: skip unhandled line to prevent infinite loop
      i++;
    }
  }

  return blocks;
}

function renderListItem(item: ListItem, key: string, ri: (text: string, keyPrefix: string) => React.ReactNode) {
  if (item.checked !== undefined) {
    return (
      <li key={key} className="md-task-item">
        <input type="checkbox" checked={item.checked} readOnly className="md-task-checkbox" />
        <span>{ri(item.text, key)}</span>
      </li>
    );
  }
  return <li key={key}>{ri(item.text, key)}</li>;
}

function CodeBlock({ lang, lines, keyProp }: { lang: string; lines: string[]; keyProp: string }) {
  const [copied, setCopied] = useState(false);
  const code = lines.join('\n');

  return (
    <pre key={keyProp} className="md-code-block">
      <div className="md-code-header">
        {lang && <span className="md-code-lang">{lang}</span>}
        <button
          className="md-code-copy-btn"
          onClick={() => {
            navigator.clipboard.writeText(code);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>
      <code>{code}</code>
    </pre>
  );
}

// --- Task notification pill support ---

interface TaskNotification {
  summary: string;
  status: string;
}

const TASK_NOTIFICATION_RE = /<task-notification>[\s\S]*?<\/task-notification>/g;
const TASK_PLACEHOLDER = '\u200B__TASK_PILL_';

function extractTag(xml: string, tag: string): string {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`);
  const m = xml.match(re);
  return m ? m[1].trim() : '';
}

function extractTaskNotifications(content: string): { cleaned: string; notifications: TaskNotification[] } {
  const notifications: TaskNotification[] = [];
  const cleaned = content.replace(TASK_NOTIFICATION_RE, (match) => {
    const summary = extractTag(match, 'summary') || 'Agent task';
    const status = extractTag(match, 'status') || 'completed';
    const idx = notifications.length;
    notifications.push({ summary, status });
    return `${TASK_PLACEHOLDER}${idx}__\u200B`;
  });
  return { cleaned, notifications };
}

function TaskNotificationPill({ notification }: { notification: TaskNotification }) {
  const dotClass = notification.status === 'completed' ? 'task-pill-dot-completed'
    : notification.status === 'error' ? 'task-pill-dot-error'
    : notification.status === 'running' ? 'task-pill-dot-running'
    : 'task-pill-dot-unknown';
  return (
    <span className="task-notification-pill">
      <span className={`task-notification-pill-dot ${dotClass}`} />
      <span>{notification.summary}</span>
    </span>
  );
}

const PILL_PLACEHOLDER_RE = /\u200B__TASK_PILL_(\d+)__\u200B/g;

function splitPillPlaceholders(
  nodes: React.ReactNode,
  notifications: TaskNotification[],
  keyPrefix: string
): React.ReactNode {
  if (!Array.isArray(nodes)) return nodes;
  const result: React.ReactNode[] = [];
  let changed = false;

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    // Check if this is a React element with string children (span with text)
    if (node && typeof node === 'object' && 'props' in (node as any)) {
      const el = node as React.ReactElement;
      if (typeof el.props?.children === 'string') {
        const text: string = el.props.children;
        if (text.includes('\u200B__TASK_PILL_')) {
          changed = true;
          const parts: React.ReactNode[] = [];
          let last = 0;
          PILL_PLACEHOLDER_RE.lastIndex = 0;
          let m: RegExpExecArray | null;
          while ((m = PILL_PLACEHOLDER_RE.exec(text)) !== null) {
            if (m.index > last) {
              parts.push(<span key={`${keyPrefix}-tp-${i}-t-${last}`}>{text.slice(last, m.index)}</span>);
            }
            const idx = parseInt(m[1], 10);
            if (notifications[idx]) {
              parts.push(<TaskNotificationPill key={`${keyPrefix}-tp-${i}-p-${idx}`} notification={notifications[idx]} />);
            }
            last = m.index + m[0].length;
          }
          if (last < text.length) {
            parts.push(<span key={`${keyPrefix}-tp-${i}-t-${last}`}>{text.slice(last)}</span>);
          }
          result.push(<Fragment key={`${keyPrefix}-tp-${i}`}>{parts}</Fragment>);
          continue;
        }
      }
    }
    result.push(node);
  }

  return changed ? result : nodes;
}

export function MarkdownRenderer({ content, onFileClick, existingFiles, className }: MarkdownRendererProps) {
  const { cleaned, notifications } = useMemo(() => extractTaskNotifications(content), [content]);
  const blocks = useMemo(() => parseBlocks(cleaned), [cleaned]);
  const ri = useCallback(
    (text: string, keyPrefix: string) => renderInline(text, keyPrefix, onFileClick, existingFiles),
    [onFileClick, existingFiles]
  );

  // Render inline text, then replace any task-notification placeholders with pill components
  const riWithPills = useCallback(
    (text: string, keyPrefix: string): React.ReactNode => {
      const inlineNodes = renderInline(text, keyPrefix, onFileClick, existingFiles);
      if (notifications.length === 0) return inlineNodes;
      // Walk the rendered nodes looking for placeholder strings in text content
      return splitPillPlaceholders(inlineNodes, notifications, keyPrefix);
    },
    [onFileClick, existingFiles, notifications]
  );

  const currentRi = notifications.length > 0 ? riWithPills : ri;

  return (
    <div className={`md-render ${className || ''}`}>
      {blocks.map((block, idx) => {
        const key = `b-${idx}`;
        switch (block.type) {
          case 'heading': {
            const Tag = `h${block.level}` as keyof JSX.IntrinsicElements;
            return <Tag key={key}>{currentRi(block.text, key)}</Tag>;
          }
          case 'code':
            return <CodeBlock key={key} lang={block.lang} lines={block.lines} keyProp={key} />;
          case 'blockquote':
            return (
              <blockquote key={key}>
                {block.lines.map((line, li) => (
                  <p key={`${key}-${li}`}>{currentRi(line, `${key}-${li}`)}</p>
                ))}
              </blockquote>
            );
          case 'ul':
            return (
              <ul key={key}>
                {block.items.map((item, li) => renderListItem(item, `${key}-${li}`, currentRi))}
              </ul>
            );
          case 'ol':
            return (
              <ol key={key}>
                {block.items.map((item, li) => renderListItem(item, `${key}-${li}`, currentRi))}
              </ol>
            );
          case 'table':
            return (
              <div key={key} className="md-table-wrap">
                <table>
                  <thead>
                    <tr>
                      {block.headers.map((h, hi) => (
                        <th key={hi} style={block.alignments[hi] ? { textAlign: block.alignments[hi]! } : undefined}>
                          {currentRi(h, `${key}-th-${hi}`)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, ri_idx) => (
                      <tr key={ri_idx}>
                        {row.map((cell, ci) => (
                          <td key={ci} style={block.alignments[ci] ? { textAlign: block.alignments[ci]! } : undefined}>
                            {currentRi(cell, `${key}-${ri_idx}-${ci}`)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case 'hr':
            return <hr key={key} />;
          case 'paragraph':
            return <p key={key}>{currentRi(block.text, key)}</p>;
          default:
            return null;
        }
      })}
    </div>
  );
}
