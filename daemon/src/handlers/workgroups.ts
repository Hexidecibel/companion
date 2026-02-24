import { HandlerContext, MessageHandler } from '../handler-context';

export function registerWorkgroupHandlers(
  ctx: HandlerContext
): Record<string, MessageHandler> {
  return {
    async spawn_work_group(client, payload, requestId) {
      if (!ctx.workGroupManager) {
        ctx.send(client.ws, {
          type: 'work_group_spawned',
          success: false,
          error: 'Work groups not enabled',
          requestId,
        });
        return;
      }

      const spawnPayload = payload as {
        name: string;
        foremanSessionId: string;
        foremanTmuxSession: string;
        parentDir: string;
        planFile?: string;
        workers: {
          taskSlug: string;
          taskDescription: string;
          planSection: string;
          files: string[];
        }[];
      } | undefined;

      if (!spawnPayload?.name || !spawnPayload.workers?.length) {
        ctx.send(client.ws, {
          type: 'work_group_spawned',
          success: false,
          error: 'Missing name or workers',
          requestId,
        });
        return;
      }

      try {
        const group = await ctx.workGroupManager.createWorkGroup({
          name: spawnPayload.name,
          foremanSessionId: spawnPayload.foremanSessionId,
          foremanTmuxSession: spawnPayload.foremanTmuxSession,
          parentDir: spawnPayload.parentDir,
          planFile: spawnPayload.planFile,
          workers: spawnPayload.workers,
        });

        ctx.send(client.ws, {
          type: 'work_group_spawned',
          success: true,
          payload: group,
          requestId,
        });
      } catch (err) {
        ctx.send(client.ws, {
          type: 'work_group_spawned',
          success: false,
          error: err instanceof Error ? err.message : String(err),
          requestId,
        });
      }
    },

    get_work_groups(client, _payload, requestId) {
      if (!ctx.config.git || !ctx.workGroupManager) {
        ctx.send(client.ws, {
          type: 'work_groups',
          success: true,
          payload: { groups: [] },
          requestId,
        });
        return;
      }
      const groups = ctx.workGroupManager.getWorkGroups();
      ctx.send(client.ws, { type: 'work_groups', success: true, payload: { groups }, requestId });
    },

    get_work_group(client, payload, requestId) {
      const groupPayload = payload as { groupId: string } | undefined;
      if (!ctx.workGroupManager || !groupPayload?.groupId) {
        ctx.send(client.ws, {
          type: 'work_group',
          success: false,
          error: 'Missing groupId',
          requestId,
        });
        return;
      }
      const group = ctx.workGroupManager.getWorkGroup(groupPayload.groupId);
      if (!group) {
        ctx.send(client.ws, { type: 'work_group', success: false, error: 'Not found', requestId });
        return;
      }
      ctx.send(client.ws, { type: 'work_group', success: true, payload: group, requestId });
    },

    async merge_work_group(client, payload, requestId) {
      if (!ctx.config.git) {
        ctx.send(client.ws, {
          type: 'work_group_merged',
          success: false,
          error: 'Git integration is disabled',
          requestId,
        });
        return;
      }
      const mergePayload = payload as { groupId: string } | undefined;
      if (!ctx.workGroupManager || !mergePayload?.groupId) {
        ctx.send(client.ws, {
          type: 'work_group_merged',
          success: false,
          error: 'Missing groupId',
          requestId,
        });
        return;
      }
      const result = await ctx.workGroupManager.mergeWorkGroup(mergePayload.groupId);
      ctx.send(client.ws, {
        type: 'work_group_merged',
        success: result.success,
        payload: result,
        requestId,
      });
    },

    async cancel_work_group(client, payload, requestId) {
      const cancelPayload = payload as { groupId: string } | undefined;
      if (!ctx.workGroupManager || !cancelPayload?.groupId) {
        ctx.send(client.ws, {
          type: 'work_group_cancelled',
          success: false,
          error: 'Missing groupId',
          requestId,
        });
        return;
      }
      const result = await ctx.workGroupManager.cancelWorkGroup(cancelPayload.groupId);
      ctx.send(client.ws, {
        type: 'work_group_cancelled',
        success: result.success,
        error: result.error,
        requestId,
      });
    },

    async retry_worker(client, payload, requestId) {
      const retryPayload = payload as { groupId: string; workerId: string } | undefined;
      if (!ctx.workGroupManager || !retryPayload?.groupId || !retryPayload?.workerId) {
        ctx.send(client.ws, {
          type: 'worker_retried',
          success: false,
          error: 'Missing groupId or workerId',
          requestId,
        });
        return;
      }
      const result = await ctx.workGroupManager.retryWorker(retryPayload.groupId, retryPayload.workerId);
      ctx.send(client.ws, {
        type: 'worker_retried',
        success: result.success,
        error: result.error,
        requestId,
      });
    },

    async send_worker_input(client, payload, requestId) {
      const inputPayload = payload as { groupId: string; workerId: string; text: string } | undefined;
      if (!ctx.workGroupManager || !inputPayload?.groupId || !inputPayload?.workerId || !inputPayload?.text) {
        ctx.send(client.ws, {
          type: 'worker_input_sent',
          success: false,
          error: 'Missing groupId, workerId, or text',
          requestId,
        });
        return;
      }
      const result = await ctx.workGroupManager.sendWorkerInput(
        inputPayload.groupId,
        inputPayload.workerId,
        inputPayload.text
      );
      ctx.send(client.ws, {
        type: 'worker_input_sent',
        success: result.success,
        error: result.error,
        requestId,
      });
    },

    async dismiss_work_group(client, payload, requestId) {
      const dismissPayload = payload as { groupId: string } | undefined;
      if (!ctx.workGroupManager || !dismissPayload?.groupId) {
        ctx.send(client.ws, {
          type: 'work_group_dismissed',
          success: false,
          error: 'Missing groupId',
          requestId,
        });
        return;
      }
      const result = await ctx.workGroupManager.dismissWorkGroup(dismissPayload.groupId);
      ctx.send(client.ws, {
        type: 'work_group_dismissed',
        success: result.success,
        error: result.success ? undefined : 'Group is not in completed or cancelled state',
        requestId,
      });
    },
  };
}
