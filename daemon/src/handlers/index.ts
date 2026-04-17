import { HandlerContext, MessageHandler } from '../handler-context';
import { registerNotificationHandlers } from './notifications';
import { registerUsageHandlers } from './usage';
import { registerSkillHandlers } from './skills';
import { registerWorkgroupHandlers } from './workgroups';
import { registerFileHandlers } from './files';
import { registerTmuxHandlers } from './tmux';
import { registerInputHandlers } from './input';
import { registerSessionHandlers } from './session';
import { registerMetricsHandlers } from './metrics';
import { registerRemoteHandlers } from './remote';

export function registerAllHandlers(ctx: HandlerContext): Map<string, MessageHandler> {
  const handlers = new Map<string, MessageHandler>();
  const modules = [
    registerNotificationHandlers(ctx),
    registerUsageHandlers(ctx),
    registerSkillHandlers(ctx),
    registerWorkgroupHandlers(ctx),
    registerFileHandlers(ctx),
    registerTmuxHandlers(ctx),
    registerInputHandlers(ctx),
    registerSessionHandlers(ctx),
    registerMetricsHandlers(ctx),
    registerRemoteHandlers(ctx),
  ];
  for (const mod of modules) {
    for (const [type, handler] of Object.entries(mod)) {
      handlers.set(type, handler);
    }
  }
  return handlers;
}
