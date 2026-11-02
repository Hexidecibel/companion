import { AuthenticatedClient, HandlerContext, MessageHandler } from '../handler-context';
import { agentLaunchOpts } from '../session-spawn';
import { hideTmuxSession, unhideTmuxSession } from '../tmux-manager';
import { LOGIN_COMMANDS, LoginFlowManager, loginSessionName } from '../profiles/login-flow';
import type {
  ProfileLoginCodeRequest,
  ProfileLoginResponse,
  ProfileLoginStatusResponse,
  ProfilesListResponse,
} from '../profiles/protocol';
import { PROFILE_LOGIN_UPDATE_EVENT, PROFILES_CHANGED_EVENT } from '../profiles/protocol';

export { LOGIN_COMMANDS, loginSessionName };

/**
 * Account profiles: list (with cheap login state, never secrets) and the
 * one-tap login flow (profiles/login-flow.ts). Profile changes in the config
 * go out as the global `profiles_changed` event.
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

  const broadcastProfiles = () => {
    const r = reg();
    if (!r) return;
    void r
      .info()
      .then((profiles) =>
        ctx.broadcast(PROFILES_CHANGED_EVENT, { profiles } satisfies ProfilesListResponse)
      )
      .catch(() => undefined);
  };

  let subscribed = false;
  const subscribe = () => {
    const r = reg();
    if (subscribed || !r) return;
    subscribed = true;
    r.on('changed', broadcastProfiles);
  };
  subscribe();

  // A login runs a process on the host and its events can carry the sign-in
  // link: same gate as sending to a session, for requests and events alike.
  const loginDenied = (client: AuthenticatedClient): string | null => {
    if (client.scope === 'trigger') return 'capability_disabled';
    if (client.deviceCapabilities?.dispatch === false) return 'capability_disabled';
    return client.originCredential ? ctx.requireRemoteCapability(client, 'dispatch') : null;
  };

  const flows = new LoginFlowManager({
    tmux: ctx.tmux,
    launchOpts: (p) => agentLaunchOpts(p.agent, p, ctx.watcher),
    emit: (flow) => {
      const message = { type: PROFILE_LOGIN_UPDATE_EVENT, success: true, payload: { flow } };
      for (const c of ctx.clients?.values() ?? []) {
        if (c.authenticated && c.subscribed && !loginDenied(c)) ctx.send(c.ws, message);
      }
    },
    onSuccess: () => broadcastProfiles(),
    audit: (action, info, ok) =>
      ctx.auditLog?.append({
        ts: Date.now(),
        origin: { addr: 'daemon', clientId: '', isLocal: true, tls: false, origin: null },
        action,
        payload: info,
        result: { ok },
        durationMs: 0,
      }),
    hide: hideTmuxSession,
    unhide: unhideTmuxSession,
  });
  void flows.reapLeftovers().catch(() => undefined);

  const respond = (
    client: AuthenticatedClient,
    type: string,
    requestId: string | undefined,
    flow: ProfileLoginResponse['flow'],
    alreadyRunning?: boolean
  ) => {
    const out: ProfileLoginResponse = {
      sessionName: flow?.sessionName ?? '',
      command: flow ? LOGIN_COMMANDS[flow.agent] : '',
      ...(alreadyRunning ? { alreadyRunning: true } : {}),
      flow,
    };
    reply(client, type, requestId, { payload: out });
  };

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
      const denied = loginDenied(client);
      if (denied) return reply(client, type, requestId, { error: denied });
      const id = (payload as { profileId?: unknown } | undefined)?.profileId;
      const p = typeof id === 'string' ? reg()?.get(id) : undefined;
      if (!p)
        return reply(client, type, requestId, {
          error: `Unknown profile: ${String(id).slice(0, 40)}`,
        });
      const r = await flows.start(p);
      if ('error' in r) return reply(client, type, requestId, { error: r.error });
      respond(client, type, requestId, r.flow, r.alreadyRunning);
    },

    async profile_login_code(client, payload, requestId) {
      const type = 'profile_login_code';
      const denied = loginDenied(client);
      if (denied) return reply(client, type, requestId, { error: denied });
      const req = (payload ?? {}) as Partial<ProfileLoginCodeRequest>;
      const r = await flows.submitCode(String(req.profileId ?? ''), req.code);
      if ('error' in r) return reply(client, type, requestId, { error: r.error });
      respond(client, type, requestId, r.flow);
    },

    async profile_login_cancel(client, payload, requestId) {
      const type = 'profile_login_cancel';
      const denied = loginDenied(client);
      if (denied) return reply(client, type, requestId, { error: denied });
      const r = await flows.cancel(String((payload as { profileId?: unknown })?.profileId ?? ''));
      if ('error' in r) return reply(client, type, requestId, { error: r.error });
      respond(client, type, requestId, r.flow);
    },

    async profile_login_status(client, _payload, requestId) {
      const type = 'profile_login_status';
      const denied = loginDenied(client);
      if (denied) return reply(client, type, requestId, { error: denied });
      const out: ProfileLoginStatusResponse = { flows: flows.list() };
      reply(client, type, requestId, { payload: out });
    },
  };
}
