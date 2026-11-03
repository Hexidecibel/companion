# Implementation patterns

Moved verbatim from `CLAUDE.md` (2026-11-03) to keep the auto-loaded context small.

> Note (2026-11-03): the "Adding a Daemon Endpoint" recipe below predates the handler split. New request types now go in `daemon/src/handlers/<area>.ts` (a `register<Area>Handlers(ctx)` map of type -> handler), wired in `daemon/src/handlers/index.ts` `registerAllHandlers`. The `websocket.ts` switch only covers a few core types.

## Implementation Patterns

### Adding a Daemon Endpoint

1. Add message handler in `daemon/src/websocket.ts` switch statement:
```typescript
case 'my_endpoint':
  const result = await this.handleMyEndpoint(message.payload);
  this.sendResponse(ws, message.type, result, message.requestId);
  break;
```

2. Add handler method:
```typescript
private async handleMyEndpoint(payload: unknown): Promise<{ success: boolean; payload?: unknown; error?: string }> {
  try {
    // Implementation
    return { success: true, payload: { data: 'result' } };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}
```

3. Call from web client via `connectionManager.sendRequest(serverId, 'my_endpoint', { data })`.

### Adding Types

- **Web types:** `web/src/types/index.ts`
- **Daemon types:** `daemon/src/types.ts`
- Keep types in sync between web and daemon for shared interfaces

### Hooks Pattern

Hooks in `web/src/hooks/`:
```typescript
export function useMyHook(param: string) {
  const [state, setState] = useState<MyType | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Setup, subscriptions
    return () => { /* cleanup */ };
  }, [param]);

  const doAction = useCallback(async () => {
    // Action logic
  }, [param]);

  return { state, loading, doAction };
}
```
