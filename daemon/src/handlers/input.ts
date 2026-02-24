import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { HandlerContext, MessageHandler } from '../handler-context';

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
      const uploadPayload = payload as { base64: string; mimeType: string } | undefined;
      if (!uploadPayload?.base64) {
        ctx.send(client.ws, {
          type: 'image_uploaded',
          success: false,
          error: 'Missing image data',
          requestId,
        });
        return;
      }

      try {
        const ext = uploadPayload.mimeType === 'image/png' ? 'png' : 'jpg';
        const filename = `companion-${Date.now()}.${ext}`;
        const filepath = path.join(os.tmpdir(), filename);

        const buffer = Buffer.from(uploadPayload.base64, 'base64');
        fs.writeFileSync(filepath, buffer);

        console.log(`Image uploaded to: ${filepath}`);

        ctx.send(client.ws, {
          type: 'image_uploaded',
          success: true,
          payload: { filepath },
          requestId,
        });
      } catch (err) {
        console.error('Error uploading image:', err);
        ctx.send(client.ws, {
          type: 'image_uploaded',
          success: false,
          error: 'Failed to save image',
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
        for (const imgPath of msgPayload.imagePaths) {
          parts.push(`[image: ${imgPath}]`);
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
