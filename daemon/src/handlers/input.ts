import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { HandlerContext, MessageHandler } from '../handler-context';
import { MAX_ATTACHMENT_FILE_SIZE_BYTES } from '../constants';

// Known image file extensions (lowercase, with leading dot).
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']);

// Fallback mimeType -> extension mapping for deriving an on-disk extension
// when the supplied filename has none.
const MIME_EXTENSION_MAP: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/svg+xml': '.svg',
  'application/pdf': '.pdf',
  'text/plain': '.txt',
  'application/json': '.json',
  'text/csv': '.csv',
};

/**
 * Sanitize a client-supplied filename into a safe on-disk base name.
 * Strips any directory components (path traversal), control characters, and
 * leading-dot traversal sequences. Returns '' if nothing usable remains.
 */
function sanitizeFilename(name: string): string {
  if (!name) return '';
  // Take only the final path component — defeats "../../etc/passwd" and "a/b.txt".
  let base = path.basename(name);
  // Strip control chars and path separators that basename may not catch.
  base = base.replace(/[\x00-\x1f/\\]/g, '');
  // Collapse any leading dots to avoid hidden/traversal-style names like "..".
  base = base.replace(/^\.+/, '');
  // Allow only a conservative set of filename characters.
  base = base.replace(/[^A-Za-z0-9._-]/g, '_');
  return base;
}

/** True if the attachment is an image, by mimeType or known extension. */
function isImageAttachment(mimeType: string | undefined, ext: string): boolean {
  if (mimeType && mimeType.startsWith('image/')) return true;
  return IMAGE_EXTENSIONS.has(ext.toLowerCase());
}

/**
 * Resolve a sessionId to a tmux session name.
 * If sessionId already matches a tmux session, return it directly.
 * Otherwise, look up the session's projectPath and find the matching tmux session.
 */
async function resolveTmuxSession(ctx: HandlerContext, sessionId: string): Promise<string | null> {
  const tmuxSessions = await ctx.tmux.listSessions();
  if (tmuxSessions.some((ts) => ts.name === sessionId)) {
    return sessionId;
  }

  const status = ctx.watcher.getStatus(sessionId);
  if (status?.projectPath) {
    const match = tmuxSessions.find((ts) => ts.workingDir === status.projectPath);
    if (match) return match.name;
  }

  return null;
}

export function registerInputHandlers(
  ctx: HandlerContext
): Record<string, MessageHandler> {
  return {
    async send_input(client, payload, requestId) {
      const inputPayload = payload as {
        input: string;
        sessionId?: string;
        tmuxSessionName?: string;
        clientMessageId?: string;
      } | undefined;

      if (!inputPayload?.input) {
        ctx.send(client.ws, {
          type: 'input_sent',
          success: false,
          error: 'Missing input',
          requestId,
        });
        return;
      }

      let sessionToUse: string;
      if (inputPayload.tmuxSessionName) {
        sessionToUse = inputPayload.tmuxSessionName;
      } else if (inputPayload.sessionId) {
        const resolved = await resolveTmuxSession(ctx, inputPayload.sessionId);
        sessionToUse = resolved || inputPayload.sessionId;
      } else {
        sessionToUse = ctx.injector.getActiveSession();
      }

      const sessionExists = await ctx.injector.checkSessionExists(sessionToUse);

      if (!sessionExists) {
        const savedConfig = ctx.tmuxSessionConfigs.get(sessionToUse);

        ctx.send(client.ws, {
          type: 'input_sent',
          success: false,
          error: 'tmux_session_not_found',
          payload: {
            sessionName: sessionToUse,
            canRecreate: !!savedConfig,
            savedConfig: savedConfig
              ? {
                  name: savedConfig.name,
                  workingDir: savedConfig.workingDir,
                }
              : undefined,
          },
          requestId,
        });
        return;
      }

      const success = await ctx.injector.sendInput(inputPayload.input, sessionToUse);

      if (success && inputPayload.clientMessageId) {
        const pending = ctx.pendingSentMessages.get(sessionToUse) || [];
        pending.push({
          clientMessageId: inputPayload.clientMessageId,
          content: inputPayload.input,
          sentAt: Date.now(),
        });
        ctx.pendingSentMessages.set(sessionToUse, pending);
      }

      ctx.send(client.ws, {
        type: 'input_sent',
        success,
        error: success ? undefined : 'Failed to send input to session',
        requestId,
      });

      // Acknowledge session — user is responding, cancel push escalation
      const activeSessionId = ctx.watcher.getActiveSessionId();
      if (activeSessionId) {
        ctx.escalation.acknowledgeSession(activeSessionId);
      }
    },

    async send_choice(client, payload, requestId) {
      const choicePayload = payload as {
        selectedIndices: number[];
        optionCount: number;
        multiSelect: boolean;
        otherText?: string;
        sessionId?: string;
        tmuxSessionName?: string;
      } | undefined;

      if (!choicePayload || !Array.isArray(choicePayload.selectedIndices) || !choicePayload.optionCount) {
        ctx.send(client.ws, {
          type: 'choice_sent',
          success: false,
          error: 'Missing choice data',
          requestId,
        });
        return;
      }

      let sessionToUse: string;
      if (choicePayload.tmuxSessionName) {
        sessionToUse = choicePayload.tmuxSessionName;
      } else if (choicePayload.sessionId) {
        const resolved = await resolveTmuxSession(ctx, choicePayload.sessionId);
        sessionToUse = resolved || choicePayload.sessionId;
      } else {
        sessionToUse = ctx.injector.getActiveSession();
      }

      const sessionExists = await ctx.injector.checkSessionExists(sessionToUse);
      if (!sessionExists) {
        ctx.send(client.ws, {
          type: 'choice_sent',
          success: false,
          error: 'tmux_session_not_found',
          requestId,
        });
        return;
      }

      const success = await ctx.injector.sendChoice(
        choicePayload.selectedIndices,
        choicePayload.optionCount,
        choicePayload.multiSelect,
        choicePayload.otherText,
        sessionToUse
      );

      ctx.send(client.ws, {
        type: 'choice_sent',
        success,
        error: success ? undefined : 'Failed to send choice to session',
        requestId,
      });

      // Acknowledge session
      const activeSessionId = ctx.watcher.getActiveSessionId();
      if (activeSessionId) {
        ctx.escalation.acknowledgeSession(activeSessionId);
      }
    },

    async cancel_input(client, payload, requestId) {
      const cancelPayload = payload as {
        clientMessageId: string;
        tmuxSessionName?: string;
        sessionId?: string;
      } | undefined;

      if (!cancelPayload?.clientMessageId) {
        ctx.send(client.ws, {
          type: 'cancel_input',
          success: false,
          error: 'No clientMessageId',
          requestId,
        });
        return;
      }

      let sessionToUse = cancelPayload.tmuxSessionName || undefined;
      if (!sessionToUse && cancelPayload.sessionId) {
        sessionToUse = ctx.watcher.getTmuxSessionForConversation(cancelPayload.sessionId) || undefined;
      }

      let removed = false;
      for (const [tmuxName, pending] of ctx.pendingSentMessages) {
        const idx = pending.findIndex((p) => p.clientMessageId === cancelPayload.clientMessageId);
        if (idx !== -1) {
          pending.splice(idx, 1);
          if (pending.length === 0) ctx.pendingSentMessages.delete(tmuxName);
          removed = true;
          sessionToUse = sessionToUse || tmuxName;
          console.log(`[CANCEL] Removed pending message ${cancelPayload.clientMessageId} from ${tmuxName}`);
          break;
        }
      }

      if (sessionToUse) {
        await ctx.injector.cancelInput(sessionToUse);
        console.log(`[CANCEL] Sent Ctrl+C to tmux="${sessionToUse}"`);
      }

      ctx.send(client.ws, {
        type: 'cancel_input',
        success: true,
        payload: { removed, clientMessageId: cancelPayload.clientMessageId },
        requestId,
      });
    },

    async send_image(client, payload, requestId) {
      const imagePayload = payload as { base64: string; mimeType: string } | undefined;
      if (!imagePayload?.base64) {
        ctx.send(client.ws, {
          type: 'image_sent',
          success: false,
          error: 'Missing image data',
          requestId,
        });
        return;
      }

      try {
        const ext = imagePayload.mimeType === 'image/png' ? 'png' : 'jpg';
        const filename = `companion-${Date.now()}.${ext}`;
        const filepath = path.join(os.tmpdir(), filename);

        const buffer = Buffer.from(imagePayload.base64, 'base64');
        fs.writeFileSync(filepath, buffer);

        console.log(`Image saved to: ${filepath}`);

        const success = await ctx.injector.sendInput(`Please look at this image: ${filepath}`);

        ctx.send(client.ws, {
          type: 'image_sent',
          success,
          payload: { filepath },
          error: success ? undefined : 'Failed to send image path to session',
          requestId,
        });
      } catch (err) {
        console.error('Error saving image:', err);
        ctx.send(client.ws, {
          type: 'image_sent',
          success: false,
          error: 'Failed to save image',
          requestId,
        });
      }
    },

    async upload_image(client, payload, requestId) {
      // Handles ANY file type (the request name is kept for compatibility).
      const uploadPayload = payload as {
        base64: string;
        mimeType?: string;
        filename?: string;
      } | undefined;
      if (!uploadPayload?.base64) {
        ctx.send(client.ws, {
          type: 'image_uploaded',
          success: false,
          error: 'Missing file data',
          requestId,
        });
        return;
      }

      try {
        const buffer = Buffer.from(uploadPayload.base64, 'base64');

        // Enforce the size cap on the decoded buffer; do not write if oversized.
        if (buffer.length > MAX_ATTACHMENT_FILE_SIZE_BYTES) {
          const maxMb = Math.round(MAX_ATTACHMENT_FILE_SIZE_BYTES / (1024 * 1024));
          ctx.send(client.ws, {
            type: 'image_uploaded',
            success: false,
            error: `Attachment exceeds maximum size of ${maxMb} MB`,
            requestId,
          });
          return;
        }

        const safeName = sanitizeFilename(uploadPayload.filename || '');

        // Derive the on-disk extension: prefer the real extension from the
        // (sanitized) filename, fall back to a mimeType mapping, default .bin.
        let ext = path.extname(safeName).toLowerCase();
        if (!ext) {
          ext = (uploadPayload.mimeType && MIME_EXTENSION_MAP[uploadPayload.mimeType]) || '.bin';
        }

        const isImage = isImageAttachment(uploadPayload.mimeType, ext);

        // Build a final on-disk name: companion-<ts>-<safeName>, ensuring it
        // carries the derived extension even if the supplied name lacked one.
        let onDiskName = safeName;
        if (!onDiskName) {
          onDiskName = `file${ext}`;
        } else if (!path.extname(onDiskName)) {
          onDiskName = `${onDiskName}${ext}`;
        }
        const filename = `companion-${Date.now()}-${onDiskName}`;
        const filepath = path.join(os.tmpdir(), filename);

        fs.writeFileSync(filepath, buffer);

        console.log(`Attachment uploaded to: ${filepath} (isImage=${isImage})`);

        ctx.send(client.ws, {
          type: 'image_uploaded',
          success: true,
          payload: { filepath, isImage },
          requestId,
        });
      } catch (err) {
        console.error('Error uploading attachment:', err);
        ctx.send(client.ws, {
          type: 'image_uploaded',
          success: false,
          error: 'Failed to save attachment',
          requestId,
        });
      }
    },

    async send_with_images(client, payload, requestId) {
      const msgPayload = payload as {
        imagePaths: string[];
        message: string;
        tmuxSessionName?: string;
        sessionId?: string;
      } | undefined;

      if (!msgPayload) {
        ctx.send(client.ws, {
          type: 'message_sent',
          success: false,
          error: 'Missing payload',
          requestId,
        });
        return;
      }

      const parts: string[] = [];

      if (msgPayload.imagePaths && msgPayload.imagePaths.length > 0) {
        for (const attPath of msgPayload.imagePaths) {
          const ext = path.extname(attPath).toLowerCase();
          if (IMAGE_EXTENSIONS.has(ext)) {
            // Images keep the exact existing marker format (unchanged behavior).
            parts.push(`[image: ${attPath}]`);
          } else {
            // Non-image files: instruct claude to read the file from disk.
            // We use this explicit-instruction form rather than the Claude Code
            // `@<path>` file-mention because `@` can trigger tmux send-keys
            // autocomplete issues. NOTE: this still needs LIVE verification that
            // claude actually reads the file given this phrasing.
            parts.push(`Read the attached file at ${attPath}`);
          }
        }
      }

      if (msgPayload.message && msgPayload.message.trim()) {
        parts.push(msgPayload.message.trim());
      }

      const combinedMessage = parts.join(' ');

      if (!combinedMessage) {
        ctx.send(client.ws, {
          type: 'message_sent',
          success: false,
          error: 'No content to send',
          requestId,
        });
        return;
      }

      let sessionToUse: string;
      if (msgPayload.tmuxSessionName) {
        sessionToUse = msgPayload.tmuxSessionName;
      } else if (msgPayload.sessionId) {
        const resolved = await resolveTmuxSession(ctx, msgPayload.sessionId);
        sessionToUse = resolved || msgPayload.sessionId;
      } else {
        sessionToUse = ctx.injector.getActiveSession();
      }

      const sessionExists = await ctx.injector.checkSessionExists(sessionToUse);

      if (!sessionExists) {
        const savedConfig = ctx.tmuxSessionConfigs.get(sessionToUse);

        ctx.send(client.ws, {
          type: 'message_sent',
          success: false,
          error: 'tmux_session_not_found',
          payload: {
            sessionName: sessionToUse,
            canRecreate: !!savedConfig,
            savedConfig: savedConfig
              ? {
                  name: savedConfig.name,
                  workingDir: savedConfig.workingDir,
                }
              : undefined,
          },
          requestId,
        });
        return;
      }

      const success = await ctx.injector.sendInput(combinedMessage, sessionToUse);
      ctx.send(client.ws, {
        type: 'message_sent',
        success,
        error: success ? undefined : 'Failed to send message',
        requestId,
      });

      // Acknowledge session
      const activeSessionId = ctx.watcher.getActiveSessionId();
      if (activeSessionId) {
        ctx.escalation.acknowledgeSession(activeSessionId);
      }
    },

    async send_feedback(client, payload, requestId) {
      const fbPayload = payload as { key: string; sessionId?: string } | undefined;
      const feedbackKey = fbPayload?.key;
      if (!feedbackKey || !['0', '1', '2', '3'].includes(feedbackKey)) {
        ctx.send(client.ws, {
          type: 'feedback_sent',
          success: false,
          error: 'Invalid feedback key. Must be "0", "1", "2", or "3".',
          requestId,
        });
        return;
      }

      const feedbackSessionId =
        fbPayload?.sessionId || client.subscribedSessionId || ctx.watcher.getActiveSessionId();

      try {
        await ctx.injector.sendKeypress(feedbackKey, feedbackSessionId || undefined);
        ctx.watcher.clearFeedbackPrompt();
        ctx.send(client.ws, {
          type: 'feedback_sent',
          success: true,
          requestId,
        });
        if (feedbackSessionId) {
          ctx.broadcast('status_change', {
            sessionId: feedbackSessionId,
            isWaitingForInput: false,
            currentActivity: undefined,
            lastMessage: undefined,
            feedbackPrompt: undefined,
          }, feedbackSessionId);
        }
      } catch (err) {
        ctx.send(client.ws, {
          type: 'feedback_sent',
          success: false,
          error: `Failed to send feedback: ${err}`,
          requestId,
        });
      }
    },
  };
}
