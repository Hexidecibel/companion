import { useEffect, useState } from 'react';
import { copyToClipboard } from '../utils/clipboard';
import { openExternal } from '../utils/externalLinks';
import type { ProfileLoginFlow, ProfileLoginFlowState } from '../types/profiles';
import { TerminalPanel } from './TerminalPanel';

const ACTIVE: ReadonlySet<ProfileLoginFlowState> = new Set([
  'starting',
  'open_link',
  'awaiting_code',
  'verifying',
]);

export function isLoginFlowActive(flow: ProfileLoginFlow): boolean {
  return ACTIVE.has(flow.state);
}

const AUTO_CLOSE_MS = 2500;
const AGENT_NAME = { claude: 'Claude', codex: 'Codex' } as const;

interface ProfileLoginSheetProps {
  serverId: string;
  flow: ProfileLoginFlow;
  onClose: () => void;
  onSubmitCode: (code: string) => Promise<{ error?: string }>;
  onCancel: () => Promise<{ error?: string }>;
  onRetry: () => void;
}

/**
 * The login for one account: names the account (the default browser may be
 * signed in to another one), then the link and any code, then the outcome.
 */
export function ProfileLoginSheet({
  serverId,
  flow,
  onClose,
  onSubmitCode,
  onCancel,
  onRetry,
}: ProfileLoginSheetProps) {
  const [code, setCode] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [showTerminal, setShowTerminal] = useState(false);

  const active = isLoginFlowActive(flow);
  const agent = AGENT_NAME[flow.agent];

  useEffect(() => {
    if (flow.state !== 'success') return;
    const t = setTimeout(onClose, AUTO_CLOSE_MS);
    return () => clearTimeout(t);
    // onClose changes each render; the timer belongs to the state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow.state, flow.flowId]);

  useEffect(() => {
    if (!active) setShowTerminal(false);
    if (flow.state === 'awaiting_code' && flow.message) setCode('');
  }, [active, flow.state, flow.message]);

  const copy = (what: string, text: string) => {
    void copyToClipboard(text).then(() => {
      setCopied(what);
      setTimeout(() => setCopied(null), 1500);
    });
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const value = code.trim();
    if (!value || sending) return;
    setSending(true);
    setError(null);
    const r = await onSubmitCode(value);
    setSending(false);
    if (r.error) setError(r.error);
    else setCode('');
  };

  const openDevicePage = () => {
    if (!flow.url) return;
    if (flow.deviceCode) copy('code', flow.deviceCode);
    void openExternal(flow.url);
  };

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Account login">
      <div className="modal-content profile-login-sheet">
        <div className="modal-header">
          <h3>
            Logging in to {flow.profileLabel}
            {flow.profileLabel !== agent ? ` (${agent})` : ''}
          </h3>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            &times;
          </button>
        </div>
        <div className="profile-login-body">
          {flow.state === 'starting' && !flow.unparsed && (
            <p className="profile-login-text">Starting the login...</p>
          )}

          {active && flow.unparsed && (
            <p className="profile-login-text">
              Couldn't read the login's output. Open the terminal to continue there, or try again.
            </p>
          )}

          {active && flow.agent === 'codex' && flow.deviceCode && (
            <>
              <p className="profile-login-text">Enter this code on the sign-in page:</p>
              <div className="profile-login-code" aria-label="One-time code">
                {flow.deviceCode}
              </div>
              <div className="profile-login-actions">
                <button className="settings-action-btn" onClick={() => copy('code', flow.deviceCode!)}>
                  {copied === 'code' ? 'Copied' : 'Copy code'}
                </button>
                <button className="settings-action-btn" onClick={openDevicePage}>
                  Open sign-in page
                </button>
              </div>
              <p className="profile-login-text secondary">
                Opening the page also copies the code. Sign in as {flow.profileLabel}.
              </p>
            </>
          )}

          {active && flow.agent === 'claude' && flow.url && (
            <>
              <p className="profile-login-text">
                Sign in as {flow.profileLabel} on the page that opened.
              </p>
              {flow.state !== 'verifying' && (
                <form className="profile-login-form" onSubmit={(e) => void submit(e)}>
                  <input
                    className="profile-login-input"
                    placeholder="Paste the code here"
                    aria-label="Paste the code here"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    autoComplete="off"
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                  />
                  <button
                    className="settings-action-btn"
                    type="submit"
                    disabled={!code.trim() || sending}
                  >
                    {sending ? 'Sending...' : 'Submit'}
                  </button>
                </form>
              )}
              {flow.state === 'verifying' && (
                <p className="profile-login-text">Checking the code...</p>
              )}
              <p className="profile-login-text secondary">
                Wrong browser account? Copy the link and open it in another browser.
              </p>
              <div className="profile-login-actions">
                <button className="settings-action-btn" onClick={() => void openExternal(flow.url!)}>
                  Open sign-in page
                </button>
                <button className="settings-action-btn" onClick={() => copy('link', flow.url!)}>
                  {copied === 'link' ? 'Copied' : 'Copy link'}
                </button>
              </div>
            </>
          )}

          {flow.state === 'success' && (
            <p className="profile-login-text profile-login-success">
              Logged in to {flow.profileLabel}
            </p>
          )}
          {(flow.state === 'failed' || flow.state === 'expired') && (
            <p className="profile-login-text profiles-error">
              {flow.message ?? "The login didn't finish."}
            </p>
          )}
          {flow.state === 'cancelled' && <p className="profile-login-text">Login cancelled.</p>}
          {active && flow.message && <p className="profile-login-text profiles-error">{flow.message}</p>}
          {error && <p className="profile-login-text profiles-error">{error}</p>}

          {showTerminal && active && (
            <div className="profile-login-terminal">
              <TerminalPanel
                serverId={serverId}
                tmuxSessionName={flow.sessionName}
                onClose={() => setShowTerminal(false)}
              />
            </div>
          )}

          <div className="profile-login-actions">
            {active && (
              <>
                <button className="settings-action-btn" onClick={() => setShowTerminal((v) => !v)}>
                  {showTerminal ? 'Hide terminal' : 'Open terminal'}
                </button>
                {flow.unparsed && (
                  <button className="settings-action-btn" onClick={onRetry}>
                    Try again
                  </button>
                )}
                <button
                  className="settings-action-btn"
                  onClick={() =>
                    void onCancel().then((r) => {
                      if (r.error) setError(r.error);
                    })
                  }
                >
                  Cancel
                </button>
              </>
            )}
            {!active && flow.state !== 'success' && (
              <>
                <button className="settings-action-btn" onClick={onRetry}>
                  Try again
                </button>
                <button className="settings-action-btn" onClick={onClose}>
                  Close
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
