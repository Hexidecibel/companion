import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react';
import type { SetupStatus, SetupStepId } from '../../types/setup';
import {
  canContinue,
  canSkip,
  canVisit,
  initWizard,
  setupCall,
  SetupApiError,
  stepIndex,
  STEP_TITLES,
  wizardReducer,
} from '../../services/setupWizard';
import { useServers } from '../../hooks/useServers';
import { useConnections } from '../../hooks/useConnections';
import { IconCheck, IconSkip, Spinner } from './SetupCommon';
import {
  ClaudeStep,
  DevicesStep,
  DoneStep,
  HeraldStep,
  MachineStep,
  NameStep,
  NotificationsStep,
  PairStep,
  ProjectsStep,
  RemoteStep,
  SessionStep,
  WelcomeStep,
  type StepCtx,
} from './SetupSteps';
import '../../styles/setup-wizard.css';

const SUBTITLES: Record<SetupStepId, string> = {
  welcome: 'Your Claude Code sessions, in your pocket.',
  pair: 'This device gets its own key. No tokens to copy.',
  name: 'How this server shows up on your devices.',
  machine: 'What Companion needs on this server.',
  claude: 'Installed and signed in on the server.',
  projects: 'Where your code lives.',
  session: 'Start Claude Code and watch it appear.',
  devices: 'Your phone, laptop and the apps.',
  notifications: 'Hear about it when Claude needs you.',
  herald: 'An optional voice and chat layer.',
  remote: 'Use Companion away from home.',
  done: 'You are all set.',
};

interface SetupWizardProps {
  /** Re-run for a connected server (Settings > Setup). Absent: a fresh device. */
  serverId?: string;
  onClose: () => void;
}

/**
 * The first-run wizard. A fresh device starts at Welcome and pairs; then, if
 * the daemon is in setup mode, it walks the whole server setup; otherwise it
 * sets up just this device (notifications, Herald device check).
 */
export function SetupWizard({ serverId: initialServerId, onClose }: SetupWizardProps) {
  const { servers } = useServers();
  const { snapshots } = useConnections();
  const [serverId, setServerId] = useState<string | null>(initialServerId ?? null);
  const [state, dispatch] = useReducer(wizardReducer, undefined, () =>
    initWizard({ mode: initialServerId ? 'server' : 'device', paired: !!initialServerId }),
  );
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [advancing, setAdvancing] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [finishError, setFinishError] = useState<string | null>(null);
  const continueFn = useRef<(() => Promise<boolean>) | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  const server = useMemo(() => servers.find((s) => s.id === serverId) ?? null, [servers, serverId]);
  const connected = !!serverId && snapshots.some((s) => s.serverId === serverId && s.state.status === 'connected');
  const pairedPending = !!serverId && !state.paired;

  // Once this device's server is connected: load its setup status (and, right
  // after pairing, decide between the server flow and the device flow).
  const loadedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!serverId || !connected || loadedFor.current === serverId) return;
    loadedFor.current = serverId;
    setupCall<SetupStatus>(serverId, 'setup_status')
      .then((st) => {
        setStatus(st);
        setSetupError(null);
        // Server step marks only drive the server flow; a joining device sets itself up.
        if (!state.paired) dispatch({ type: 'paired', setupMode: st.setupMode, marks: st.setupMode ? st.steps : undefined });
        else dispatch({ type: 'marks', marks: st.steps, resume: true });
      })
      .catch((e) => {
        const code = e instanceof SetupApiError ? e.code : undefined;
        setSetupError(
          code === 'untrusted_network'
            ? 'Server setup is only available on your local network or tailnet. Connect from home (or over Tailscale) to change server settings.'
            : code === 'forbidden'
              ? 'This sign-in cannot change server settings. Pair this device to use setup.'
              : /Unknown message type/i.test(e?.message || '')
                ? 'This server is older than the setup wizard. Update it to use setup.'
                : `Could not load the server's setup: ${e?.message || e}`,
        );
        if (!state.paired) dispatch({ type: 'paired', setupMode: false });
      });
  }, [serverId, connected, state.paired]);

  const markOnServer = useCallback(
    (step: SetupStepId, mark: 'done' | 'skipped') => {
      if (!serverId || setupError || state.mode !== 'server' || step === 'welcome' || step === 'done') return;
      setupCall<SetupStatus>(serverId, 'setup_mark_step', { step, state: mark })
        .then(setStatus)
        .catch(() => {});
    },
    [serverId, setupError, state.mode],
  );

  const scrollTop = () => contentRef.current?.scrollTo({ top: 0 });

  const next = async () => {
    if (!canContinue(state) || advancing) return;
    if (continueFn.current) {
      setAdvancing(true);
      const ok = await continueFn.current().catch(() => false);
      setAdvancing(false);
      if (!ok) return;
    }
    markOnServer(state.current, 'done');
    dispatch({ type: 'next' });
    scrollTop();
  };
  const skip = () => {
    markOnServer(state.current, 'skipped');
    dispatch({ type: 'skip' });
    scrollTop();
  };
  const finish = async () => {
    setFinishError(null);
    if (state.mode === 'server' && serverId && !setupError) {
      setFinishing(true);
      try {
        setStatus(await setupCall<SetupStatus>(serverId, 'setup_complete'));
      } catch (e) {
        setFinishing(false);
        setFinishError(e instanceof Error ? e.message : String(e));
        return;
      }
    }
    onClose();
  };

  const ctx: StepCtx = {
    serverId: state.paired ? serverId : null,
    server,
    status,
    setStatus,
    mode: state.mode,
    paired: state.paired,
    marks: state.marks,
    setupError: state.mode === 'server' ? setupError : null,
    registerContinue: (fn) => {
      continueFn.current = fn;
    },
    onPaired: (id) => setServerId(id),
  };

  const { at, of } = stepIndex(state);
  const step = state.current;
  let body: ReactNode;
  switch (step) {
    case 'welcome':
      body = <WelcomeStep />;
      break;
    case 'pair':
      body = pairedPending ? (
        <div className="sw-loading"><Spinner /> Paired. Connecting to the server...</div>
      ) : (
        <PairStep ctx={ctx} />
      );
      break;
    case 'name':
      body = <NameStep ctx={ctx} />;
      break;
    case 'machine':
      body = <MachineStep ctx={ctx} />;
      break;
    case 'claude':
      body = <ClaudeStep ctx={ctx} />;
      break;
    case 'projects':
      body = <ProjectsStep ctx={ctx} />;
      break;
    case 'session':
      body = <SessionStep ctx={ctx} />;
      break;
    case 'devices':
      body = <DevicesStep ctx={ctx} />;
      break;
    case 'notifications':
      body = <NotificationsStep ctx={ctx} />;
      break;
    case 'herald':
      body = <HeraldStep ctx={ctx} />;
      break;
    case 'remote':
      body = <RemoteStep ctx={ctx} />;
      break;
    case 'done':
      body = <DoneStep ctx={ctx} flow={state.flow} />;
      break;
  }

  const title = step === 'done' && state.mode === 'device' ? 'This device is ready' : STEP_TITLES[step];
  const serverLabel = status?.serverName || server?.name;

  return (
    <div className="sw-root" role="dialog" aria-modal="true" aria-label="Companion setup">
      <aside className="sw-rail" aria-label="Setup steps">
        <div className="sw-brand">
          <span className="sw-brand__mark" aria-hidden="true" />
          <div>
            <div className="sw-brand__name">Companion</div>
            <div className="sw-brand__sub">{serverLabel ? serverLabel : state.mode === 'server' ? 'Server setup' : 'Get started'}</div>
          </div>
        </div>
        <ol className="sw-rail__list">
          {state.flow.map((s, i) => {
            const mark = state.marks[s];
            const on = s === step;
            const reachable = canVisit(state, s);
            return (
              <li key={s}>
                <button
                  type="button"
                  className={`sw-rail__item${on ? ' is-current' : ''}${mark === 'done' ? ' is-done' : ''}${mark === 'skipped' ? ' is-skipped' : ''}`}
                  disabled={!reachable}
                  aria-current={on ? 'step' : undefined}
                  onClick={() => {
                    dispatch({ type: 'goto', step: s });
                    scrollTop();
                  }}
                >
                  <span className="sw-rail__dot">
                    {mark === 'done' && !on ? <IconCheck size={12} /> : mark === 'skipped' && !on ? <IconSkip size={12} /> : i + 1}
                  </span>
                  <span className="sw-rail__label">{STEP_TITLES[s]}</span>
                </button>
              </li>
            );
          })}
        </ol>
        <button type="button" className="sw-rail__exit" onClick={onClose}>
          {state.paired ? 'Finish later' : 'Skip setup'}
        </button>
      </aside>

      <main className="sw-main">
        <div className="sw-mobilebar">
          <div className="sw-mobilebar__top">
            <span className="sw-mobilebar__count">Step {at} of {of}</span>
            <button type="button" className="sw-link" onClick={onClose}>{state.paired ? 'Finish later' : 'Skip setup'}</button>
          </div>
          <div className="sw-progress" aria-hidden="true"><span style={{ width: `${(at / of) * 100}%` }} /></div>
        </div>

        <div className="sw-content" ref={contentRef}>
          <div className="sw-card" key={step}>
            <header className="sw-head">
              <div className="sw-head__eyebrow">Step {at} of {of}</div>
              <h1 className="sw-head__title">{title}</h1>
              <p className="sw-head__sub">{SUBTITLES[step]}</p>
            </header>
            <div className="sw-body">{body}</div>
          </div>
        </div>

        <footer className="sw-foot">
          <button type="button" className="sw-btn sw-btn--ghost" onClick={() => { dispatch({ type: 'back' }); scrollTop(); }} disabled={state.flow.indexOf(step) <= 0}>
            Back
          </button>
          <div className="sw-foot__right">
            {finishError && <span className="sw-foot__err">{finishError}</span>}
            {canSkip(state) && step !== 'done' && (
              <button type="button" className="sw-btn sw-btn--ghost" onClick={skip}>
                Skip
              </button>
            )}
            {step === 'done' ? (
              <button type="button" className="sw-btn sw-btn--primary" onClick={() => void finish()} disabled={finishing}>
                {finishing ? 'Finishing...' : state.mode === 'server' ? 'Finish setup' : 'Start using Companion'}
              </button>
            ) : (
              <button type="button" className="sw-btn sw-btn--primary" onClick={() => void next()} disabled={!canContinue(state) || advancing}>
                {advancing ? 'Saving...' : step === 'welcome' ? 'Get started' : 'Continue'}
              </button>
            )}
          </div>
        </footer>
      </main>
    </div>
  );
}
