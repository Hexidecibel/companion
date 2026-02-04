# Find File

Find a file in the project by name or description and output its absolute path.

## Usage

```
/file <filename or description>
```

## Instructions

1. The query: `$ARGUMENTS`

2. Search for the file in `/Users/chriscushman/local/src/claude-companion/`:
   - If the query looks like a filename (e.g. `useConversation.ts`, `parser.ts`), search by glob pattern
   - If the query is a description (e.g. "websocket service", "push notifications"), search by grepping for relevant exports/class names or use the file structure knowledge
   - Check all subdirectories: `app/`, `web/`, `daemon/`, `desktop/`, root

3. If multiple matches are found, list all of them as absolute paths — one per line

4. If a single match is found, output just the absolute path

5. Output each path wrapped in backticks (inline code) so the mobile file viewer detects them as tappable links. One path per line.

## Examples

Input: `useConversation`
Output: `/Users/chriscushman/local/src/claude-companion/app/src/hooks/useConversation.ts`

Input: `websocket`
Output:
`/Users/chriscushman/local/src/claude-companion/app/src/services/websocket.ts`
`/Users/chriscushman/local/src/claude-companion/daemon/src/websocket.ts`
`/Users/chriscushman/local/src/claude-companion/web/src/services/ServerConnection.ts`

## Notes

- ALWAYS wrap paths in backticks — the mobile file viewer only detects inline code as tappable file paths
- Output absolute paths so the mobile file viewer can open them
- If nothing is found, say so briefly
- Keep output minimal — just the path(s) and a one-line description if multiple matches need disambiguation
