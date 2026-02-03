import { useMemo, useCallback } from 'react';

interface MarkdownRendererProps {
  content: string;
  onFileClick?: (path: string) => void;
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

// Matches bare file paths like src/foo.ts, ./bar.md, ../baz/qux.tsx
// Must contain a / and end with a file extension
const BARE_PATH_RE = /(?:^|\s)((?:\.\.?\/)?(?:[\w.-]+\/)+[\w.-]+\.\w{1,10})(?=[\s,;:!?)}\]]|$)/g;

function parseInline(text: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  // Regex handles: **bold**, *italic*, `code`, [text](url), bare URLs
  const re = /(\*\*(.+?)\*\*|\*(.+?)\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)|(https?:\/\/[^\s<>\])]+))/g;
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
      const trailingPunct = /[.,;:!?)]+$/.exec(url);
      if (trailingPunct) {
        url = url.slice(0, -trailingPunct[0].length);
      }
      nodes.push({ type: 'link', text: url, href: url });
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

function renderInline(text: string, keyPrefix: string, onFileClick?: (path: string) => void) {
  const nodes = parseInline(text);
  return nodes.map((node, i) => {
    const key = `${keyPrefix}-${i}`;
    switch (node.type) {
      case 'bold':
        return <strong key={key}>{node.text}</strong>;
      case 'italic':
        return <em key={key}>{node.text}</em>;
      case 'code':
        return <code key={key}>{node.text}</code>;
      case 'link':
        return <a key={key} href={node.href} target="_blank" rel="noopener noreferrer">{node.text}</a>;
      case 'fileLink':
        return (
          <a
            key={key}
            className="md-file-link"
            href="#"
            onClick={(e) => {
              e.preventDefault();
              onFileClick?.(node.path);
            }}
          >
            {node.text}
          </a>
        );
      default:
        return <span key={key}>{node.text}</span>;
    }
  });
}

type Block =
  | { type: 'heading'; level: number; text: string }
  | { type: 'code'; lang: string; lines: string[] }
  | { type: 'blockquote'; lines: string[] }
  | { type: 'ul'; items: string[] }
  | { type: 'ol'; items: string[] }
  | { type: 'hr' }
  | { type: 'paragraph'; text: string };

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

    // Horizontal rule
    if (/^(-{3,}|_{3,}|\*{3,})\s*$/.test(line)) {
      blocks.push({ type: 'hr' });
      i++;
      continue;
    }

    // Heading
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      blocks.push({ type: 'heading', level: headingMatch[1].length, text: headingMatch[2] });
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
      const items: string[] = [];
      while (i < lines.length && /^[\s]*[-*+]\s/.test(lines[i])) {
        items.push(lines[i].replace(/^[\s]*[-*+]\s/, ''));
        i++;
      }
      blocks.push({ type: 'ul', items });
      continue;
    }

    // Ordered list
    if (/^[\s]*\d+\.\s/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[\s]*\d+\.\s/.test(lines[i])) {
        items.push(lines[i].replace(/^[\s]*\d+\.\s/, ''));
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
      !/^(-{3,}|_{3,}|\*{3,})\s*$/.test(lines[i])
    ) {
      paraLines.push(lines[i]);
      i++;
    }

    if (paraLines.length > 0) {
      blocks.push({ type: 'paragraph', text: paraLines.join('\n') });
    }
  }

  return blocks;
}

export function MarkdownRenderer({ content, onFileClick }: MarkdownRendererProps) {
  const blocks = useMemo(() => parseBlocks(content), [content]);
  const ri = useCallback(
    (text: string, keyPrefix: string) => renderInline(text, keyPrefix, onFileClick),
    [onFileClick]
  );

  return (
    <div className="md-render">
      {blocks.map((block, idx) => {
        const key = `b-${idx}`;
        switch (block.type) {
          case 'heading': {
            const Tag = `h${block.level}` as keyof JSX.IntrinsicElements;
            return <Tag key={key}>{ri(block.text, key)}</Tag>;
          }
          case 'code':
            return (
              <pre key={key}>
                <code>{block.lines.join('\n')}</code>
              </pre>
            );
          case 'blockquote':
            return (
              <blockquote key={key}>
                {block.lines.map((line, li) => (
                  <p key={`${key}-${li}`}>{ri(line, `${key}-${li}`)}</p>
                ))}
              </blockquote>
            );
          case 'ul':
            return (
              <ul key={key}>
                {block.items.map((item, li) => (
                  <li key={`${key}-${li}`}>{ri(item, `${key}-${li}`)}</li>
                ))}
              </ul>
            );
          case 'ol':
            return (
              <ol key={key}>
                {block.items.map((item, li) => (
                  <li key={`${key}-${li}`}>{ri(item, `${key}-${li}`)}</li>
                ))}
              </ol>
            );
          case 'hr':
            return <hr key={key} />;
          case 'paragraph':
            return <p key={key}>{ri(block.text, key)}</p>;
          default:
            return null;
        }
      })}
    </div>
  );
}
