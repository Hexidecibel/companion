import * as os from 'os';
import { AuthenticatedClient, HandlerContext, MessageHandler } from '../handler-context';
import { agentLaunchOpts } from '../session-spawn';
import type {
  ProfileAgent,
  ProfileLoginResponse,
  ProfilesListResponse,
} from '../profiles/protocol';
import { PROFILES_CHANGED_EVENT } from '../profiles/protocol';

/** What the login session runs (headless-friendly: both print a URL + code). */
export const LOGIN_COMMANDS: Record<ProfileAgent, string> = {
  claude: 'claude auth login',
  codex: 'codex login --device-auth',
};

export function loginSessionName(profileId: string): string {
  return `login-${profileId}`.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * Account profiles: list (with cheap login state, never secrets) and an
 * app-started login session in a profile's environment. Profile changes in
 * the config go out as the global `profiles_changed` event.
 */
export function registerProfileHandlers(ctx: HandlerContext): Record<string, MessageHandler> {
  const reg = () => ctx.watcher.profiles;
  const reply = (
    client: AuthenticatedClient,
    type: string,
    requestId: string | undefined,
    r: { payload?: unknown; error?: string }
  ) =>
    ctx.send(client.ws, {
      type,
      success: !r.error,
      ...(r.error ? { error: r.error } : { payload: r.payload }),
      requestId,
    });

  let subscribed = false;
  const subscribe = () => {
    const r = reg();
    if (subscribed || !r) return;
    subscribed = true;
    r.on('changed', () => {
      void r
        .info()
        .then((profiles) =>
          ctx.broadcast(PROFILES_CHANGED_EVENT, { profiles } satisfies ProfilesListResponse)
        )
        .catch(() => undefined);
    });
  };
  subscribe();

  return {
    async profiles_list(client, _payload, requestId) {
      const r = reg();
      if (!r) return reply(client, 'profiles_list', requestId, { payload: { profiles: [] } });
      await r.refresh().catch(() => false);
      const out: ProfilesListResponse = { profiles: await r.info() };
      reply(client, 'profiles_list', requestId, { payload: out });
    },

    async profile_login(client, payload, requestId) {
      const type = 'profile_login';
      // Starting a process on the host: same gate as sending to a session.
      const denied = client.originCredential
        ? ctx.requireRemoteCapability(client, 'dispatch')
        : null;
      if (denied) return reply(client, type, requestId, { error: denied });
      const id = (payload as { profileId?: unknown } | undefined)?.profileId;
      const p = typeof id === 'string' ? reg()?.get(id) : undefined;
      if (!p)
        return reply(client, type, requestId, {
          error: `Unknown profile: ${String(id).slice(0, 40)}`,
        });

      const sessionName = loginSessionName(p.id);
      const command = LOGIN_COMMANDS[p.agent];
      if (await ctx.tmux.sessionExists(sessionName)) {
        const out: ProfileLoginResponse = { sessionName, command, alreadyRunning: true };
        return reply(client, type, requestId, { payload: out });
      }
      const launch = await agentLaunchOpts(p.agent, p, ctx.watcher);
      const result = await ctx.tmux.createSession(sessionName, os.homedir(), true, {
        ...(p.agent !== 'claude' ? { agent: p.agent } : {}),
        ...launch,
        command,
      });
      if (!result.success) return reply(client, type, requestId, { error: result.error });
      console.log(`Profiles: login session "${sessionName}" for ${p.id} (${p.agent})`);
      ctx.watcher.noteSessionAgent(sessionName, p.agent);
      ctx.watcher.noteSessionProfile?.(sessionName, p.id);
      ctx.watcher.markSessionAsNew(sessionName);
      if (!ctx.sessionNameStore.get(sessionName)) {
        ctx.sessionNameStore.set(sessionName, `Log in: ${p.label}`);
      }
      await ctx.watcher.refreshTmuxPaths();
      ctx.broadcast('tmux_sessions_changed', { action: 'created', sessionName });
      const out: ProfileLoginResponse = { sessionName, command };
      reply(client, type, requestId, { payload: out });
    },
  };
}
