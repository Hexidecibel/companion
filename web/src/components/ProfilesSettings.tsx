import { useEffect, useRef, useState } from 'react';
import { useProfiles } from '../hooks/useProfiles';
import { prepareExternalTab, type PendingExternalTab } from '../utils/externalLinks';
import type { AccountProfileInfo, ProfileLoginFlow, ProfileLoginState } from '../types/profiles';
import { isLoginFlowActive, ProfileLoginSheet } from './ProfileLoginSheet';

const STATE_TEXT: Record<ProfileLoginState, string> = {
  logged_in: 'Logged in',
  api_key: 'API key',
  logged_out: 'Not logged in',
};

/**
 * Settings > Accounts for one server: every account profile with its login
 * state and a Log in button. The login runs on the server in a hidden session;
 * the sheet opens the sign-in page, takes any code, and shows the outcome.
 */

/** This device started this flow: it alone opens the browser, and it survives a reload. */
const startedKey = (serverId: string, profileId: string) =>
  `companion.login.started.${serverId}.${profileId}`;
const openedKey = (flowId: string) => `companion.login.opened.${flowId}`;
function sessionGet(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}
function sessionSet(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    /* only costs the restore after a reload */
  }
}

export function ProfilesCard({ serverId, serverName }: { serverId: string; serverName: string }) {
  const {
    profiles,
    supported,
    error,
    login,
    refresh,
    loginFlows,
    submitLoginCode,
    cancelLogin,
  } = useProfiles(serverId);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ id: string; text: string; error?: boolean } | null>(null);
  const [sheetFor, setSheetFor] = useState<string | null>(null);
  const dismissed = useRef(new Set<string>());
  const pendingTab = useRef<{ profileId: string; tab: PendingExternalTab } | null>(null);

  // Coming back to Accounts (or reloading) with a login this device started.
  useEffect(() => {
    if (sheetFor) return;
    for (const f of Object.values(loginFlows)) {
      if (dismissed.current.has(f.flowId)) continue;
      if (sessionGet(startedKey(serverId, f.profileId)) === f.flowId) {
        setSheetFor(f.profileId);
        return;
      }
    }
  }, [loginFlows, sheetFor, serverId]);

  // The blank tab from the tap goes to the link once it is known.
  useEffect(() => {
    const pending = pendingTab.current;
    if (!pending) return;
    const flow = loginFlows[pending.profileId];
    if (!flow) return;
    if (flow.url) {
      pending.tab.navigate(flow.url);
      sessionSet(openedKey(flow.flowId), '1');
      pendingTab.current = null;
    } else if (!isLoginFlowActive(flow) || flow.unparsed) {
      pending.tab.close();
      pendingTab.current = null;
    }
  }, [loginFlows]);

  if (!supported) return null;

  const startLogin = async (p: AccountProfileInfo) => {
    setBusy(p.id);
    setNote(null);
    // Claude's sign-in page opens by itself; Codex shows its code first.
    const running = loginFlows[p.id];
    const alreadyOpened = !!running && !!sessionGet(openedKey(running.flowId));
    const tab = p.agent === 'claude' && !alreadyOpened ? prepareExternalTab() : null;
    const r = await login(p.id);
    setBusy(null);
    if ('error' in r) {
      tab?.close();
      setNote({ id: p.id, text: r.error, error: true });
      return;
    }
    if (!r.flow) {
      // An older daemon: the login is a normal session to open.
      tab?.close();
      setNote({
        id: p.id,
        text: `${r.alreadyRunning ? 'Already open' : 'Opened'}: session "${r.sessionName}" runs ${r.command}. Open it from the session list to finish logging in.`,
      });
      return;
    }
    sessionSet(startedKey(serverId, p.id), r.flow.flowId);
    dismissed.current.delete(r.flow.flowId);
    if (tab) {
      if (r.flow.url) {
        tab.navigate(r.flow.url);
        sessionSet(openedKey(r.flow.flowId), '1');
      } else {
        pendingTab.current = { profileId: p.id, tab };
      }
    }
    setSheetFor(p.id);
  };

  const sheetFlow: ProfileLoginFlow | undefined = sheetFor ? loginFlows[sheetFor] : undefined;
  const closeSheet = () => {
    if (sheetFlow) dismissed.current.add(sheetFlow.flowId);
    setSheetFor(null);
  };

  return (
    <div className="settings-card profiles-card">
      <div className="settings-card-row">
        <div className="settings-card-row-info">
          <span className="status-dot status-dot-green" />
          <span className="settings-card-label">{serverName}</span>
        </div>
        <button className="settings-action-btn" onClick={() => void refresh()}>
          Refresh
        </button>
      </div>
      {error && <div className="settings-card-detail profiles-error">{error}</div>}
      <ul className="profiles-list">
        {profiles.map((p) => {
          const flow = loginFlows[p.id];
          const inProgress = !!flow && isLoginFlowActive(flow);
          return (
          <li key={p.id} className="profiles-item">
            <div className="profiles-item-info">
              <span className="profiles-item-name">
                {p.isDefault ? (p.agent === 'codex' ? 'Codex' : 'Claude') : p.label}
                <span className="profiles-item-agent">
                  {p.isDefault ? ' default' : ` ${p.agent === 'codex' ? 'Codex' : 'Claude'}`}
                </span>
              </span>
              <span className="profiles-item-home" title={p.home}>
                {p.home}
              </span>
            </div>
            <span className={`profiles-item-state profiles-state-${p.loginState}`}>
              {inProgress ? 'Login in progress' : STATE_TEXT[p.loginState]}
            </span>
            {inProgress ? (
              <button className="settings-action-btn" onClick={() => setSheetFor(p.id)}>
                Continue
              </button>
            ) : (
              <button
                className="settings-action-btn"
                disabled={busy !== null}
                onClick={() => void startLogin(p)}
                title="Log in to this account"
              >
                {busy === p.id ? 'Starting...' : 'Log in'}
              </button>
            )}
            {note?.id === p.id && (
              <div className={`profiles-note${note.error ? ' profiles-error' : ''}`}>{note.text}</div>
            )}
          </li>
          );
        })}
      </ul>
      <div className="settings-card-detail profiles-help">
        Add an account on the server: <code>bin/companion profile add work --agent claude</code>
      </div>
      {sheetFlow && (
        <ProfileLoginSheet
          serverId={serverId}
          flow={sheetFlow}
          onClose={closeSheet}
          onSubmitCode={(code) => submitLoginCode(sheetFlow.profileId, code)}
          onCancel={() => cancelLogin(sheetFlow.profileId)}
          onRetry={() => {
            const p = profiles.find((x) => x.id === sheetFlow.profileId);
            if (p) void startLogin(p);
          }}
        />
      )}
    </div>
  );
}
