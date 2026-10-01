import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useHeraldData, useHeraldSetupCtx, useHeraldVoiceCtx, useHeraldVoiceInputCtx } from '../../../context/HeraldContext';
import { HeraldOrb, type HeraldOrbState } from '../HeraldOrb';
import {
  IconCheck,
  IconClose,
  IconDeskSpeaker,
  IconGamepad,
  IconHeadphones,
  IconMic,
  IconPhone,
} from '../heraldIcons';
import { currentStep, initialSetupState, progress, setupReducer, summarize, type SetupAction, type SetupFlowState, type SetupStep } from '../../../services/heraldSetup/onboarding';
import { gradeEcho, PROFILES, type EchoGrade, type ProfileId } from '../../../services/heraldSetup/profiles';
import { heraldSetupStore } from '../../../services/heraldSetup/setupStore';
import { setTriggerProbe } from '../../../services/heraldSetup/triggerProbe';
import { measureEchoSuppression, type AudioEnvironment } from '../../../services/voice/audioEnvironment';
import { getMicCapture } from '../../../services/voice/micCapture';
import { VoiceInputController, type VoiceInputState } from '../../../services/voice/voiceInput';
import { isMacDesktop, nativeHeraldStore, useNativeHeraldState } from '../../../hooks/useNativeHerald';
import { displayChordText } from '../../../services/voice/hotkeys';
import { TriggersGuide } from './TriggersGuide';
import type { NativePlatform } from '../../../utils/platform';

const STEP_NAME: Record<SetupStep, string> = {
  profile: 'Profile',
  mic: 'Microphone',
  echo: 'Echo',
  wake: 'Wake word',
  trigger: 'Trigger',
  control: 'Main device',
  done: 'Ready',
};

const PROFILE_ICON: Record<ProfileId, (p: { size?: number }) => JSX.Element> = {
  headphones: IconHeadphones,
  desk: IconDeskSpeaker,
  gaming: IconGamepad,
  phone: IconPhone,
};

type Dispatch = (a: SetupAction) => void;

function Switch({ on }: { on: boolean }) {
  return <span className={`herald-switch${on ? ' herald-switch--on' : ''}`} aria-hidden="true" />;
}

function envLine(env: AudioEnvironment | null): string | null {
  if (!env) return null;
  const out = env.outputLabel ?? (env.output === 'speakers' ? 'Speakers' : env.output === 'unknown' ? null : 'Headphones');
  const inp = env.inputLabel ?? null;
  if (!out && !inp) return null;
  return [out && `Playing on ${out}`, inp && `listening with ${inp}`].filter(Boolean).join(', ');
}

// ---------------------------------------------------------------- steps

function ProfileStep({ flow, dispatch }: { flow: SetupFlowState; dispatch: Dispatch }) {
  const setup = useHeraldSetupCtx();
  const detected = envLine(setup.env);
  return (
    <>
      <div className="hs-cards" role="radiogroup" aria-label="Profile">
        {setup.profiles.map((id) => {
          const p = PROFILES[id];
          const Icon = PROFILE_ICON[id];
          const on = flow.profile === id;
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={on}
              className={`hs-card${on ? ' hs-card--on' : ''}`}
              onClick={() => dispatch({ type: 'profile', profile: id })}
            >
              <span className="hs-card__icon"><Icon size={20} /></span>
              <span className="hs-card__main">
                <span className="hs-card__name">
                  {p.name}
                  {id === setup.recommended && <span className="hs-badge">Recommended</span>}
                </span>
                <span className="hs-card__tag">{p.tagline}</span>
              </span>
              <span className={`hs-radio${on ? ' hs-radio--on' : ''}`} aria-hidden="true" />
            </button>
          );
        })}
      </div>
      {detected && <p className="hs-note hs-note--detected"><span className="hs-dot" aria-hidden="true" />{detected}</p>}
      <button
        type="button"
        role="switch"
        aria-checked={setup.state.autoSwitch}
        className="hs-toggle"
        onClick={() => heraldSetupStore.set('autoSwitch', !setup.state.autoSwitch)}
      >
        <span>
          <span className="hs-toggle__label">Switch automatically</span>
          <span className="hs-toggle__hint">When headphones come and go. Otherwise Herald just suggests it.</span>
        </span>
        <Switch on={setup.state.autoSwitch} />
      </button>
    </>
  );
}

const METER_BARS = 24;

function MicStep({ flow, dispatch }: { flow: SetupFlowState; dispatch: Dispatch }) {
  const data = useHeraldData();
  const input = useHeraldVoiceInputCtx();
  const setup = useHeraldSetupCtx();
  const [st, setSt] = useState<VoiceInputState | null>(null);
  const ctrl = useRef<VoiceInputController | null>(null);
  const stopTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const getTransport = data.getTransport;

  useEffect(() => {
    // Its own controller: the transcript comes back here, never to Herald.
    const c = new VoiceInputController({
      mic: getMicCapture(),
      getTransport,
      onTranscript: (text) => dispatch({ type: 'heard', text }),
      onBargeIn: () => {},
    });
    ctrl.current = c;
    const off = c.subscribe(setSt);
    return () => {
      off();
      if (stopTimer.current) clearTimeout(stopTimer.current);
      c.dispose();
      ctrl.current = null;
    };
  }, [getTransport, dispatch]);

  const phase = st?.phase ?? 'idle';
  const live = phase === 'starting' || phase === 'listening';
  const toggle = () => {
    const c = ctrl.current;
    if (!c) return;
    if (live) {
      void c.stop();
      return;
    }
    if (phase !== 'idle') return;
    void c.start('button');
    if (stopTimer.current) clearTimeout(stopTimer.current);
    stopTimer.current = setTimeout(() => void ctrl.current?.stop(), 6000);
  };

  const level = live ? st?.level ?? 0 : 0;
  const unavailable = !input.available && input.unavailableReason;
  const label = setup.env?.inputLabel;
  return (
    <>
      <div className="hs-mic">
        <button
          type="button"
          className={`hs-mic__btn${live ? ' hs-mic__btn--live' : ''}${phase === 'transcribing' ? ' hs-mic__btn--busy' : ''}`}
          style={{ ['--lvl' as string]: level.toFixed(3) }}
          onClick={toggle}
          disabled={!!unavailable || phase === 'transcribing'}
          aria-label={live ? 'Stop' : 'Start the microphone test'}
        >
          <IconMic size={26} />
        </button>
        <div className="hs-meter" aria-hidden="true">
          {Array.from({ length: METER_BARS }, (_, i) => {
            const center = 1 - Math.abs(i - (METER_BARS - 1) / 2) / (METER_BARS / 2);
            const h = live ? Math.max(0.08, Math.min(1, level * (0.35 + center * 1.1))) : 0.08;
            return <span key={i} style={{ transform: `scaleY(${h.toFixed(3)})` }} />;
          })}
        </div>
        <p className="hs-mic__status" aria-live="polite">
          {unavailable
            ? unavailable
            : phase === 'starting'
              ? 'Opening the microphone…'
              : phase === 'listening'
                ? 'Listening. Say "What is everyone working on?"'
                : phase === 'transcribing'
                  ? 'Transcribing…'
                  : st?.error
                    ? st.error
                    : flow.heard
                      ? 'Tap to try again'
                      : 'Tap the mic and say a short sentence'}
        </p>
      </div>
      {flow.heard && (
        <div className="hs-heard" role="status">
          <span className="hs-heard__label">Herald heard</span>
          <span className="hs-heard__text">“{flow.heard}”</span>
        </div>
      )}
      {label && <p className="hs-note">Using {label}</p>}
    </>
  );
}

type EchoRun = { status: 'idle' } | { status: 'running' } | { status: 'done'; grade: EchoGrade; erleDb: number };

const ECHO_TIMEOUT_MS = 20_000;

function EchoStep({ flow, dispatch }: { flow: SetupFlowState; dispatch: Dispatch }) {
  const setup = useHeraldSetupCtx();
  const [run, setRun] = useState<EchoRun>(() => (flow.echo ? { status: 'done', grade: flow.echo, erleDb: setup.state.echo?.erleDb ?? 0 } : { status: 'idle' }));
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  const recordEcho = setup.recordEcho;

  const start = useCallback(async () => {
    setRun({ status: 'running' });
    try {
      const r = await Promise.race([
        measureEchoSuppression(),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), ECHO_TIMEOUT_MS)),
      ]);
      if (!alive.current) return;
      recordEcho(r);
      const grade = gradeEcho(r);
      dispatch({ type: 'echo', grade });
      setRun({ status: 'done', grade, erleDb: r.erleDb });
    } catch {
      if (!alive.current) return;
      dispatch({ type: 'echo', grade: 'unmeasured' });
      setRun({ status: 'done', grade: 'unmeasured', erleDb: 0 });
    }
  }, [dispatch, recordEcho]);

  const out = setup.env?.outputLabel ?? (flow.profile === 'headphones' || flow.profile === 'phone' || flow.profile === 'gaming' ? 'your headphones' : 'your speakers');
  const wearing = flow.profile === 'headphones' || flow.profile === 'phone' || flow.profile === 'gaming';

  return (
    <>
      {run.status !== 'done' && (
        <div className="hs-echo">
          <p className="hs-body-text">
            Herald will say one line through {out} while it listens. Stay quiet for a few seconds.
            {wearing && ' With headphones on it should hear nothing at all.'}
          </p>
          <button type="button" className="herald-btn herald-btn--primary hs-cta" onClick={() => void start()} disabled={run.status === 'running'}>
            {run.status === 'running' ? <><span className="hs-spinner" aria-hidden="true" /> Listening for echo…</> : 'Run the echo test'}
          </button>
        </div>
      )}
      {run.status === 'done' && <EchoResult grade={run.grade} erleDb={run.erleDb} onRetry={() => void start()} />}
    </>
  );
}

function EchoResult({ grade, erleDb, onRetry }: { grade: EchoGrade; erleDb: number; onRetry: () => void }) {
  const body: Record<EchoGrade, { title: string; text: ReactNode; tone: 'ok' | 'warn' | 'muted' }> = {
    good: {
      title: 'No echo',
      text: 'Herald cannot hear itself here, so you can talk over it to interrupt.',
      tone: 'ok',
    },
    marginal: {
      title: 'A little echo',
      text: 'Herald can faintly hear itself. Talking over it is off, so it never answers its own voice. Headphones fix this completely.',
      tone: 'warn',
    },
    poor: {
      title: 'Herald can hear itself',
      text: 'Its voice comes back into the microphone, which would make it answer itself. Talking over it is off; hold to talk works as always. Headphones fix this completely.',
      tone: 'warn',
    },
    unmeasured: {
      title: 'Could not measure',
      text: 'This device did not report an echo reading. To be safe, talking over Herald stays off. With headphones you can turn it on in Advanced.',
      tone: 'muted',
    },
  };
  const b = body[grade];
  return (
    <div className={`hs-result hs-result--${b.tone}`} role="status">
      <div className="hs-result__head">
        <span className="hs-result__icon" aria-hidden="true">{b.tone === 'ok' ? <IconCheck size={16} /> : '!'}</span>
        <span className="hs-result__title">{b.title}</span>
        {grade !== 'unmeasured' && <span className="hs-result__metric">{Math.round(erleDb)} dB</span>}
      </div>
      <p className="hs-result__text">{b.text}</p>
      <button type="button" className="hs-link" onClick={onRetry}>Run it again</button>
    </div>
  );
}

function WakeStep({ flow, dispatch }: { flow: SetupFlowState; dispatch: Dispatch }) {
  const input = useHeraldVoiceInputCtx();
  const [armed, setArmed] = useState(false);
  const [keep, setKeep] = useState(flow.profile === 'headphones' || flow.profile === 'phone');
  const before = useRef(input.prefs.handsFree);
  const inputRef = useRef(input);
  inputRef.current = input;
  const keepRef = useRef(keep);
  keepRef.current = keep;
  const armedRef = useRef(armed);
  armedRef.current = armed;

  // The wake word fired: that is the test. Drop the capture that follows.
  const wakeLive = input.state.source === 'wake' && input.state.phase !== 'idle';
  useEffect(() => {
    if (!armed || !wakeLive) return;
    inputRef.current.cancel();
    dispatch({ type: 'wake' });
  }, [armed, wakeLive, dispatch]);

  // Leaving the step: hands-free goes back to how it was unless kept.
  useEffect(() => () => {
    if (armedRef.current && !before.current && !(keepRef.current && flow.wakeHeard)) inputRef.current.setHandsFree(false);
  }, [flow.wakeHeard]);

  const start = () => {
    setArmed(true);
    if (!input.prefs.handsFree) input.setHandsFree(true); // inside the click: may prompt for the mic
  };

  return (
    <>
      {!flow.wakeHeard ? (
        <div className="hs-wake">
          <div className={`hs-wake__phrase${armed && input.handsFreeActive ? ' hs-wake__phrase--live' : ''}`}>“Hey Jarvis”</div>
          {!armed ? (
            <button type="button" className="herald-btn herald-btn--primary hs-cta" onClick={start} disabled={!input.handsFreeAvailable}>
              Start listening
            </button>
          ) : (
            <p className="hs-mic__status" aria-live="polite">
              {input.handsFreeActive ? 'Listening for the wake word. Say it now.' : input.handsFreeNote ?? 'Starting…'}
            </p>
          )}
        </div>
      ) : (
        <div className="hs-result hs-result--ok" role="status">
          <div className="hs-result__head">
            <span className="hs-result__icon" aria-hidden="true"><IconCheck size={16} /></span>
            <span className="hs-result__title">Heard you</span>
          </div>
          <p className="hs-result__text">Say “Hey Jarvis”, then your question, whenever hands-free is on.</p>
          {!before.current && (
            <button type="button" role="switch" aria-checked={keep} className="hs-toggle" onClick={() => setKeep((k) => !k)}>
              <span>
                <span className="hs-toggle__label">Keep hands-free on</span>
                <span className="hs-toggle__hint">The mic stays open for the wake word on this device.</span>
              </span>
              <Switch on={keep} />
            </button>
          )}
        </div>
      )}
      <p className="hs-note">
        Audio leaves this device only after the wake word. Dictation apps such as Wispr Flow may see the open mic as a
        meeting: turn off their meeting detection, or pause them while hands-free is on.
      </p>
    </>
  );
}

function chordText(c: string): string {
  return displayChordText(c, isMacDesktop()) ?? 'Off';
}

function TriggerStep({ flow, dispatch, platform }: { flow: SetupFlowState; dispatch: Dispatch; platform: NativePlatform }) {
  const input = useHeraldVoiceInputCtx();
  const { prefs, shortcuts, info } = useNativeHeraldState();

  // Take the next press (native shortcut, earbud, or a remote trigger) as the test.
  useEffect(() => {
    const p = nativeHeraldStore.get().prefs;
    nativeHeraldStore.setProbe((a) => {
      if (a === 'talk_up') return;
      const label = platform === 'android' || platform === 'ios'
        ? 'Earbud button'
        : a === 'talk_down' ? chordText(p.talkChord) : a === 'brief' ? chordText(p.briefChord) : chordText(p.toggleChord);
      dispatch({ type: 'trigger', label });
    });
    setTriggerProbe((action) => dispatch({ type: 'trigger', label: `Remote trigger (${action})` }));
    return () => {
      nativeHeraldStore.setProbe(null);
      setTriggerProbe(null);
    };
  }, [platform, dispatch]);

  const fired = flow.triggerFired && (
    <div className="hs-result hs-result--ok" role="status">
      <div className="hs-result__head">
        <span className="hs-result__icon" aria-hidden="true"><IconCheck size={16} /></span>
        <span className="hs-result__title">Got it: {flow.triggerFired}</span>
      </div>
      <p className="hs-result__text">That press reaches Herald from any app.</p>
    </div>
  );
  const waiting = !flow.triggerFired && (
    <p className="hs-waiting" aria-live="polite"><span className="hs-pulse" aria-hidden="true" /> Waiting for a press…</p>
  );

  if (platform === 'desktop') {
    const failed = new Map(shortcuts.filter((r) => !r.ok).map((r) => [r.name, r]));
    const rows: Array<{ name: 'talk' | 'toggle' | 'brief'; label: string; chord: string }> = [
      { name: 'talk', label: 'Hold to talk', chord: prefs.talkChord },
      { name: 'toggle', label: 'Listen / stop', chord: prefs.toggleChord },
      { name: 'brief', label: 'Brief me', chord: prefs.briefChord },
    ];
    return (
      <>
        {!prefs.globalShortcuts ? (
          <button type="button" className="herald-btn herald-btn--primary hs-cta" onClick={() => nativeHeraldStore.setPref('globalShortcuts', true)}>
            Turn on system-wide shortcuts
          </button>
        ) : (
          <div className="hs-keys">
            {rows.map((r) => (
              <div key={r.name} className={`hs-keys__row${failed.has(r.name) ? ' hs-keys__row--bad' : ''}`}>
                <span className="hs-keys__label">{r.label}</span>
                <kbd className="hs-kbd">{chordText(r.chord)}</kbd>
                {failed.has(r.name) && <span className="hs-keys__warn">Taken by another app</span>}
              </div>
            ))}
          </div>
        )}
        {fired || waiting}
        {info?.wayland && (
          <p className="hs-note hs-note--warn">
            Wayland only delivers these while a Companion window is focused. For a key that works everywhere, bind a desktop
            shortcut to the trigger script (Help &gt; Triggers).
          </p>
        )}
        <p className="hs-note">
          Map a mouse button (the MX Master thumb button in Logi Options+) to the Listen / stop shortcut for one-press talk
          mid-game. Change the keys in Advanced.
        </p>
      </>
    );
  }

  if (platform === 'android' || platform === 'ios') {
    return (
      <>
        {!prefs.earbudButton ? (
          <button type="button" className="herald-btn herald-btn--primary hs-cta" onClick={() => nativeHeraldStore.setPref('earbudButton', true)}>
            Let the earbud button talk to Herald
          </button>
        ) : (
          <p className="hs-body-text">Tap play/pause on your earbuds now. Tap to ask; tap again to stop Herald.</p>
        )}
        {fired || waiting}
        {platform === 'ios' && (
          <p className="hs-note">iOS gives the button only to the app playing audio, so Herald pauses your music while it speaks.</p>
        )}
      </>
    );
  }

  return (
    <>
      <div className="hs-keys">
        <div className="hs-keys__row">
          <span className="hs-keys__label">Hold to talk (this tab)</span>
          <kbd className="hs-kbd">{input.chordLabel}</kbd>
        </div>
        <div className="hs-keys__row">
          <span className="hs-keys__label">Brief me (this tab)</span>
          <kbd className="hs-kbd">{input.briefChordLabel}</kbd>
        </div>
      </div>
      <p className="hs-body-text">
        Browser shortcuts only work while this tab has focus. For a key or mouse button that works from any app, even a
        full-screen game, set up a trigger, then fire it to test.
      </p>
      {fired || waiting}
      <details className="hs-details">
        <summary>Set up a trigger</summary>
        <TriggersGuide />
      </details>
    </>
  );
}

function ControlStep({ dispatch }: { dispatch: Dispatch }) {
  const { device } = useHeraldData();
  const wasActive = useRef(device.isActive);
  const [asked, setAsked] = useState(false);
  useEffect(() => {
    if (asked && device.isActive) dispatch({ type: 'control' });
  }, [asked, device.isActive, dispatch]);
  const other = device.activeDevice && device.activeDevice.id !== device.selfId ? device.activeDevice.label : null;
  return (
    <>
      <p className="hs-body-text">
        One device at a time is Herald's main device: it plays the tones, runs hands-free and answers remote triggers.
      </p>
      <div className="hs-device">
        <span className={`hs-device__dot${device.isActive ? ' hs-device__dot--on' : ''}`} aria-hidden="true" />
        <span className="hs-device__text">
          {device.isActive ? (
            <><strong>{device.label}</strong> is the main device{wasActive.current ? '' : ' now'}.</>
          ) : (
            <>Main device now: <strong>{other ?? 'another device'}</strong></>
          )}
        </span>
      </div>
      {!device.isActive && (
        <button
          type="button"
          className="herald-btn herald-btn--primary hs-cta"
          onClick={() => { setAsked(true); device.takeControl(); }}
        >
          Make this my main device
        </button>
      )}
      <button type="button" role="switch" aria-checked={device.keepPinned} className="hs-toggle" onClick={() => device.setKeepPinned(!device.keepPinned)}>
        <span>
          <span className="hs-toggle__label">Keep it here</span>
          <span className="hs-toggle__hint">Using another device does not move it; only Take control there does.</span>
        </span>
        <Switch on={device.keepPinned} />
      </button>
    </>
  );
}

function DoneStep({ flow }: { flow: SetupFlowState }) {
  const setup = useHeraldSetupCtx();
  const lines = summarize(flow, { profile: (id) => PROFILES[id].name });
  return (
    <div className="hs-summary">
      <ul className="hs-summary__list">
        {lines.map((l) => (
          <li key={l.step} className={`hs-summary__row hs-summary__row--${l.tone}`}>
            <span className="hs-summary__icon" aria-hidden="true">{l.tone === 'ok' ? <IconCheck size={13} /> : l.tone === 'warn' ? '!' : '–'}</span>
            <span className="hs-summary__label">{l.label}</span>
            <span className="hs-summary__value">{l.value}</span>
          </li>
        ))}
      </ul>
      <p className="hs-note">
        Change the profile any time from the Herald menu, where the device check also lives.
        {setup.platform === 'desktop' && ' The floating orb shows Herald over other apps while it works.'}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------- shell

const COPY: Record<SetupStep, { title: string; lede: string }> = {
  profile: { title: 'How are you listening?', lede: 'Pick what fits this device. It sets a dozen voice settings at once; you can fine-tune later.' },
  mic: { title: 'Let Herald hear you', lede: 'A quick check that your words arrive clearly.' },
  echo: { title: 'Can Herald hear itself?', lede: 'Through speakers Herald can pick up its own voice. This decides whether you can talk over it.' },
  wake: { title: 'Try the wake word', lede: 'Hands-free: say it from across the room. Optional.' },
  trigger: { title: 'One button, anywhere', lede: 'Talk to Herald without switching windows, even mid-game.' },
  control: { title: 'Make this your main device?', lede: 'Several devices can have Herald open. Pick where it speaks up.' },
  done: { title: 'You are set', lede: 'Here is how this device is set up.' },
};

function orbFor(step: SetupStep, input: ReturnType<typeof useHeraldVoiceInputCtx>, speaking: boolean): HeraldOrbState {
  if (input.state.phase === 'listening' || input.state.phase === 'starting') return 'listening';
  if (speaking) return 'speaking';
  if (step === 'done') return 'idle';
  return 'idle';
}

/** The device check: a guided, skippable walk through this device's voice setup. */
export function HeraldSetup() {
  const setup = useHeraldSetupCtx();
  if (!setup.checkOpen) return null;
  return createPortal(<SetupDialog />, document.body);
}

function SetupDialog() {
  const setup = useHeraldSetupCtx();
  const input = useHeraldVoiceInputCtx();
  const voice = useHeraldVoiceCtx();
  const { device, displayName } = useHeraldData();
  const env = useMemo(
    () => ({ platform: setup.platform, wakeAvailable: input.handsFreeAvailable, devicesSupported: device.supported && !!device.selfId }),
    [setup.platform, input.handsFreeAvailable, device.supported, device.selfId],
  );
  const [flow, rawDispatch] = useReducer(setupReducer, undefined, () => initialSetupState(env, setup.state.profile ?? setup.recommended));
  const dispatch = useCallback<Dispatch>((a) => rawDispatch(a), []);
  useEffect(() => { rawDispatch({ type: 'env', env }); }, [env]);
  const step = currentStep(flow);
  const { at, of } = progress(flow);
  const closeCheck = setup.closeCheck;
  const applyProfile = setup.applyProfile;

  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    dialogRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeCheck();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [closeCheck]);

  const next = () => {
    if (step === 'profile' && flow.profile) applyProfile(flow.profile);
    if (step === 'done') {
      closeCheck();
      return;
    }
    dispatch({ type: 'next' });
  };
  const copy = COPY[step];
  const produced =
    (step === 'profile' && !!flow.profile) || (step === 'mic' && !!flow.heard) || (step === 'echo' && !!flow.echo) ||
    (step === 'wake' && flow.wakeHeard) || (step === 'trigger' && !!flow.triggerFired) || (step === 'control' && flow.tookControl);
  const orb = orbFor(step, input, voice.supported && voice.speaking);

  return (
    <div className="hs-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) closeCheck(); }}>
      <div
        className="hs-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="hs-title"
        tabIndex={-1}
        ref={dialogRef}
      >
        <div className="hs-glow" aria-hidden="true" />
        <header className="hs-top">
          <div className="hs-dots" aria-label={step === 'done' ? 'Finished' : `Step ${at + 1} of ${of}`}>
            {Array.from({ length: of }, (_, i) => (
              <span key={i} className={`hs-dots__dot${i < at ? ' hs-dots__dot--done' : ''}${i === at ? ' hs-dots__dot--on' : ''}`} />
            ))}
          </div>
          <button type="button" className="herald-icon-btn" onClick={closeCheck} aria-label="Close the device check" title="Close (Esc)">
            <IconClose size={18} />
          </button>
        </header>
        <div className="hs-scroll">
          <div className="hs-hero">
            <HeraldOrb presence={orb} size={step === 'done' ? 84 : 64} />
          </div>
          <div className="hs-step" key={step}>
            <p className="hs-eyebrow">{step === 'done' ? `${displayName} device check` : `${at + 1} of ${of} · ${STEP_NAME[step]}`}</p>
            <h2 className="hs-title" id="hs-title">{copy.title}</h2>
            <p className="hs-lede">{copy.lede}</p>
            <div className="hs-content">
              {step === 'profile' && <ProfileStep flow={flow} dispatch={dispatch} />}
              {step === 'mic' && <MicStep flow={flow} dispatch={dispatch} />}
              {step === 'echo' && <EchoStep flow={flow} dispatch={dispatch} />}
              {step === 'wake' && <WakeStep flow={flow} dispatch={dispatch} />}
              {step === 'trigger' && <TriggerStep flow={flow} dispatch={dispatch} platform={setup.platform} />}
              {step === 'control' && <ControlStep dispatch={dispatch} />}
              {step === 'done' && <DoneStep flow={flow} />}
            </div>
          </div>
        </div>
        <footer className="hs-foot">
          {flow.index > 0 && step !== 'done' ? (
            <button type="button" className="herald-btn herald-btn--ghost" onClick={() => dispatch({ type: 'back' })}>Back</button>
          ) : <span />}
          <span className="hs-foot__right">
            {step !== 'done' && !produced && (
              <button type="button" className="hs-skip" onClick={() => dispatch({ type: 'skip' })}>Skip</button>
            )}
            <button type="button" className="herald-btn herald-btn--primary hs-next" onClick={next}>
              {step === 'done' ? 'Done' : step === 'profile' ? 'Use this profile' : 'Continue'}
            </button>
          </span>
        </footer>
      </div>
    </div>
  );
}
