import { AuthenticatedClient, HandlerContext, MessageHandler } from '../handler-context';
import { ReviewServiceError } from '../review/service';
import { GitError } from '../review/git-runner';
import { REVIEW_LIMITS } from '../review/protocol';
import type { ReviewErrorCode, ReviewRevertTarget } from '../review/protocol';

type Obj = Record<string, unknown>;
const obj = (p: unknown): Obj => (p && typeof p === 'object' && !Array.isArray(p) ? (p as Obj) : {});
const str = (v: unknown, max = 500): string | undefined =>
  typeof v === 'string' && v.length > 0 && v.length <= max ? v : undefined;

export function errorCode(err: unknown): ReviewErrorCode {
  if (err instanceof ReviewServiceError) return err.code as ReviewErrorCode;
  if (err instanceof GitError) return err.code === 'busy' ? 'busy' : 'unavailable';
  return 'unavailable';
}

/**
 * Code Review endpoints. Each request is answered with a response of the SAME
 * type ({ type, success, payload | error, requestId }); failures carry
 * `payload: { code: ReviewErrorCode }`. `get_session_diff` is the legacy shape
 * (response type `session_diff`), rebuilt on the ledger + one bounded git diff.
 */
export function registerReviewHandlers(ctx: HandlerContext): Record<string, MessageHandler> {
  const fail = (
    client: AuthenticatedClient,
    type: string,
    code: string,
    error: string,
    requestId?: string
  ) => ctx.send(client.ws, { type, success: false, error, payload: { code }, requestId });

  /** Run a review request: same-type response, `{code}` payload on failure. */
  const handle =
    (type: string, fn: (client: AuthenticatedClient, p: Obj) => Promise<unknown>): MessageHandler =>
    async (client, payload, requestId) => {
      if (!ctx.review) {
        fail(client, type, 'unavailable', 'Code review is not available', requestId);
        return;
      }
      try {
        const out = await fn(client, obj(payload));
        ctx.send(client.ws, { type, success: true, payload: out, requestId });
      } catch (err) {
        const code = errorCode(err);
        if (code === 'unavailable') console.error(`Review: ${type} failed:`, err);
        fail(client, type, code, err instanceof Error ? err.message : String(err), requestId);
      }
    };

  /** Per-origin credentials must hold the remote capability for mutations. */
  const gate = (client: AuthenticatedClient, action: 'write' | 'dispatch'): string | null =>
    client.originCredential ? ctx.requireRemoteCapability(client, action) : null;

  const sessionIdOf = (p: Obj): string => {
    const id = str(p.sessionId, 200);
    if (!id) throw new ReviewServiceError('bad_request', 'sessionId is required');
    return id;
  };
  const scopeOf = (p: Obj) => {
    if (p.scope !== undefined && p.scope !== 'since_checkpoint' && p.scope !== 'all')
      throw new ReviewServiceError('bad_request', 'scope must be since_checkpoint or all');
    return (p.scope as 'since_checkpoint' | 'all' | undefined) || 'since_checkpoint';
  };

  return {
    review_summary_list: handle('review_summary_list', async () => ({
      summaries: await ctx.review!.summaryList(),
    })),

    review_get: handle('review_get', async (_c, p) => {
      if (p.view !== undefined && p.view !== 'turns' && p.view !== 'files')
        throw new ReviewServiceError('bad_request', 'view must be turns or files');
      return ctx.review!.get({
        sessionId: sessionIdOf(p),
        scope: scopeOf(p),
        view: (p.view as 'turns' | 'files' | undefined) || 'turns',
        ...(str(p.turnId, 200) ? { turnId: str(p.turnId, 200) } : {}),
      });
    }),

    review_get_file: handle('review_get_file', async (_c, p) => {
      const absPath = str(p.absPath, 4096);
      if (!absPath || !absPath.startsWith('/'))
        throw new ReviewServiceError('bad_request', 'absPath must be an absolute path');
      return ctx.review!.getFile({
        sessionId: sessionIdOf(p),
        absPath,
        scope: scopeOf(p),
        ...(str(p.turnId, 200) ? { turnId: str(p.turnId, 200) } : {}),
      });
    }),

    review_get_edits: handle('review_get_edits', async (_c, p) => {
      if (!Array.isArray(p.editIds) || p.editIds.some((x) => typeof x !== 'string'))
        throw new ReviewServiceError('bad_request', 'editIds must be an array of strings');
      if (p.editIds.length > REVIEW_LIMITS.maxGetEdits)
        throw new ReviewServiceError('bad_request', `at most ${REVIEW_LIMITS.maxGetEdits} editIds`);
      return ctx.review!.getEdits(sessionIdOf(p), p.editIds as string[]);
    }),

    review_watch: handle('review_watch', async (client, p) => {
      if (typeof p.live !== 'boolean') throw new ReviewServiceError('bad_request', 'live must be a boolean');
      return ctx.review!.watch(client.id, sessionIdOf(p), p.live);
    }),

    review_ask: handle('review_ask', async (client, p) => {
      const absPath = str(p.absPath, 4096);
      const hunkId = str(p.hunkId, 300);
      if (!absPath || !absPath.startsWith('/') || !hunkId)
        throw new ReviewServiceError('bad_request', 'absPath and hunkId are required');
      if (p.question !== undefined && (typeof p.question !== 'string' || p.question.length > REVIEW_LIMITS.maxQuestionChars))
        throw new ReviewServiceError('bad_request', `question must be at most ${REVIEW_LIMITS.maxQuestionChars} characters`);
      const denied = gate(client, 'dispatch');
      if (denied) throw new ReviewServiceError('blocked', denied);
      return ctx.review!.ask(
        {
          sessionId: sessionIdOf(p),
          absPath,
          hunkId,
          ...(str(p.editId, 200) ? { editId: str(p.editId, 200) } : {}),
          ...(typeof p.question === 'string' ? { question: p.question } : {}),
        },
        client.id
      );
    }),

    review_revert_preview: handle('review_revert_preview', async (client, p) => {
      const denied = gate(client, 'write');
      if (denied) throw new ReviewServiceError('blocked', denied);
      const target = obj(p.target);
      return ctx.review!.revertPreview(
        { sessionId: sessionIdOf(p), target: target as unknown as ReviewRevertTarget },
        client.id
      );
    }),

    review_revert: handle('review_revert', async (client, p) => {
      const denied = gate(client, 'write');
      if (denied) throw new ReviewServiceError('blocked', denied);
      const token = str(p.token, 100);
      if (!token || (p.confirm !== 'tap' && p.confirm !== 'hold'))
        throw new ReviewServiceError('bad_request', "token and confirm ('tap' | 'hold') are required");
      return ctx.review!.revert(
        {
          token,
          confirm: p.confirm,
          ...(typeof p.notifySession === 'boolean' ? { notifySession: p.notifySession } : {}),
          ...(str(p.device, 80) ? { device: str(p.device, 80) } : {}),
        },
        client.id
      );
    }),

    review_revert_undo: handle('review_revert_undo', async (client, p) => {
      const denied = gate(client, 'write');
      if (denied) throw new ReviewServiceError('blocked', denied);
      const backupId = str(p.backupId, 64);
      if (!backupId) throw new ReviewServiceError('bad_request', 'backupId is required');
      return ctx.review!.revertUndo(backupId, client.id);
    }),

    review_mark_reviewed: handle('review_mark_reviewed', async (_c, p) => {
      if (typeof p.through !== 'number')
        throw new ReviewServiceError('bad_request', 'through (ms) is required');
      return ctx.review!.markReviewed(sessionIdOf(p), p.through, str(p.device, 80));
    }),

    review_approve_turn: handle('review_approve_turn', async (_c, p) => {
      const turnId = str(p.turnId, 200);
      if (!turnId || typeof p.approved !== 'boolean')
        throw new ReviewServiceError('bad_request', 'turnId and approved are required');
      return ctx.review!.approveTurn(sessionIdOf(p), turnId, p.approved, str(p.device, 80));
    }),

    async get_session_diff(client, payload, requestId) {
      const p = payload as { sessionId?: string } | undefined;
      const sessionId = p?.sessionId || ctx.watcher.getActiveSessionId();
      if (!sessionId) {
        ctx.send(client.ws, {
          type: 'session_diff',
          success: false,
          error: 'No session specified',
          requestId,
        });
        return;
      }
      if (!ctx.review) {
        fail(client, 'session_diff', 'unavailable', 'Code review is not available', requestId);
        return;
      }
      try {
        const fileChanges = await ctx.review.compatSessionDiff(sessionId);
        ctx.send(client.ws, {
          type: 'session_diff',
          success: true,
          payload: { fileChanges, sessionId },
          requestId,
        });
      } catch (err) {
        ctx.send(client.ws, {
          type: 'session_diff',
          success: false,
          error: `Failed to get session diff: ${err}`,
          requestId,
        });
      }
    },
  };
}
