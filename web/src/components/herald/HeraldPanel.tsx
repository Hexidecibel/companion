import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { HeraldTonesVolume } from './HeraldVolume';
import type { HeraldAction, HeraldInboxItem, HeraldMessage, HeraldSessionRef, HeraldVerbosity, InboxPriority } from '../../types/herald';
import { requestReviewDrawer } from '../../services/reviewNav';
import { INTENT_LABELS, VOICE_COMMAND_HELP } from '../../services/voice/voiceCommands';
import { sortInbox, sortPendingByUrgency } from '../../services/heraldReducer';
import { useHeraldData, useHeraldSetupCtx, useHeraldUi, useHeraldVoiceCtx, useHeraldVoiceInputCtx } from '../../context/HeraldContext';
import { HeraldMenuMain, SetupAdvancedSettings } from './setup/HeraldMenuMain';
import { HeraldNotices } from './setup/HeraldNotices';
import { HeraldSetup } from './setup/HeraldSetup';
import { HeraldHelp } from './setup/HeraldHelp';
import { HeraldDiagnostics } from './setup/HeraldDiagnostics';
import type { HeraldVoiceInput } from '../../hooks/useHeraldVoiceInput';
import { HandsFreeIndicator, HeraldListeningBar, HeraldMicButton, VoiceInputSettings } from './HeraldVoiceControls';
import { HeraldDeviceBar, HeraldDevicesMenu } from './HeraldDevices';
import type { HeraldDeviceControl } from '../../context/HeraldContext';
import type { HeraldVoice } from '../../hooks/useHeraldVoice';
import { RATE_MAX, RATE_MIN } from '../../hooks/useHeraldVoice';
import { pickVoice, voicesForPicker } from '../../services/tts/voices';
import { HeraldOrb } from './HeraldOrb';
import { HeraldBrainBadge, HeraldUsageMeter } from './HeraldUsage';
import type { HeraldUsageSummary } from '../../types/herald';
import { AudioLockedNotice, HeraldVoiceExtras } from './HeraldVoiceExtras';
import { HeraldActionCard, HeraldPendingMarker, HeraldResolvedLine } from './HeraldActionCard';
import { HeraldComposer } from './HeraldComposer';
import { IconBack, IconBell, IconBrief, IconClose, IconDown, IconMore, IconPlay, IconRefresh, IconSpeaker, IconSpeakerOff, IconStop, IconTrash, IconX } from './heraldIcons';

type OpenSession = (serverId: string, sessionId: string) => void;

interface HeraldPanelProps {
  variant: 'docked' | 'screen';
  onOpenSession: OpenSession;
  onClose: () => void;
}

const SUGGESTIONS = ["Anything for me?", "What's everyone working on?", "What's blocked?"];

const PRIORITY_LABEL: Record<InboxPriority, string> = {
  blocked: 'Blocked',
  finished: 'Finished',
  progress: 'In progress',
};

function formatTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return time;
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
}

function formatAgo(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return 'now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

// ---------------------------------------------------------------------------
// Stream pieces
// ---------------------------------------------------------------------------

function RefChips({ refs, priorityBySession, onOpenSession }: {
  refs: HeraldSessionRef[];
  priorityBySession: Map<string, InboxPriority>;
  onOpenSession: OpenSession;
}) {
  return (
    <div className="herald-refs">
      {refs.map((r) => {
        const p = priorityBySession.get(`${r.serverId}:${r.sessionId}`);
        return (
          <button
            key={`${r.serverId}:${r.sessionId}`}
            type="button"
            className={`herald-ref${p ? ` herald-ref--${p}` : ''}`}
            onClick={() => onOpenSession(r.serverId, r.sessionId)}
            title={`Open ${r.sessionName}`}
          >
            <span className="herald-ref__dot" />
            {r.sessionName}
          </button>
        );
      })}
    </div>
  );
}

const HeraldLine = memo(function HeraldLine({ message, actionById, priorityBySession, onOpenSession }: {
  message: HeraldMessage;
  actionById: Map<string, HeraldAction>;
  priorityBySession: Map<string, InboxPriority>;
  onOpenSession: OpenSession;
}) {
  if (message.role === 'user') {
    if (message.intent) {
      // A spoken command ("shorter", "go on", "what's up"): a small chip, not the raw words.
      return (
        <div className="herald-msg herald-msg--user herald-msg--intent" title={`${formatTime(message.createdAt)} · you said "${message.text}"`}>
          <span className="herald-intent-chip">{INTENT_LABELS[message.intent]}</span>
        </div>
      );
    }
    return (
      <div className="herald-msg herald-msg--user" title={formatTime(message.createdAt)}>
        <time className="herald-msg__time" dateTime={new Date(message.createdAt).toISOString()}>{formatTime(message.createdAt)}</time>
        <p className="herald-msg__user-text">{message.text}</p>
      </div>
    );
  }
  const paragraphs = message.text.split(/\n{2,}/);
  const actions = (message.actionIds ?? [])
    .map((id) => actionById.get(id))
    .filter((a): a is HeraldAction => !!a);
  return (
    <div className={`herald-msg herald-msg--herald${message.streaming ? ' herald-msg--streaming' : ''}`}>
      <time className="herald-msg__time" dateTime={new Date(message.createdAt).toISOString()}>{formatTime(message.createdAt)}</time>
      <div className="herald-prose">
        {paragraphs.map((p, i) => (
          <p key={i}>
            {p}
            {message.streaming && i === paragraphs.length - 1 && <span className="herald-caret" aria-hidden="true" />}
          </p>
        ))}
      </div>
      {message.sessionRefs && message.sessionRefs.length > 0 && (
        <RefChips refs={message.sessionRefs} priorityBySession={priorityBySession} onOpenSession={onOpenSession} />
      )}
      {actions.length > 0 && (
        <div className="herald-msg__actions">
          {actions.map((a) =>
            a.status === 'pending'
              ? <HeraldPendingMarker key={a.id} action={a} />
              : <HeraldResolvedLine key={a.id} action={a} onOpenSession={onOpenSession} />,
          )}
        </div>
      )}
    </div>
  );
});

function Thinking({ name }: { name: string }) {
  return (
    <div className="herald-thinking" aria-label={`${name} is thinking`}>
      <span /><span /><span />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inbox strip
// ---------------------------------------------------------------------------

function InboxStrip({ items, unheardCount, canAsk, onAsk, onChip }: {
  items: HeraldInboxItem[];
  unheardCount: number;
  canAsk: boolean;
  onAsk: () => void;
  onChip: (item: HeraldInboxItem) => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="herald-inbox" role="list" aria-label="Session inbox">
      <button
        type="button"
        className="herald-chip herald-chip--ask"
        onClick={onAsk}
        disabled={!canAsk}
        role="listitem"
      >
        Anything for me?
        {unheardCount > 0 && <span className="herald-chip__badge" aria-label={`${unheardCount} new`}>{unheardCount}</span>}
      </button>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="listitem"
          className={`herald-chip herald-chip--${item.priority}${item.review ? ` herald-chip--review herald-chip--review-${item.review.level}` : ''}${item.stuck ? ' herald-chip--stuck' : ''}${item.heard ? '' : ' herald-chip--unheard'}`}
          onClick={() => onChip(item)}
          title={item.review ? `Risky change, open review: ${item.headline}` : item.stuck ? `Looks stuck, open it: ${item.stuck.summary}` : `${PRIORITY_LABEL[item.priority]}: ${item.headline}`}
        >
          <span className="herald-chip__dot" aria-hidden="true" />
          <span className="herald-chip__name">{item.sessionName}</span>
          {item.review && <span className="herald-chip__review">Review</span>}
          {item.stuck && <span className="herald-chip__stuck">Stuck?</span>}
          <span className="herald-chip__headline">{item.headline}</span>
          <span className="herald-chip__age">{formatAgo(item.createdAt, now)}</span>
          <span className="sr-only">{item.review ? 'Risky change' : item.stuck ? 'Looks stuck' : PRIORITY_LABEL[item.priority]}{item.heard ? '' : ', new'}</span>
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Overflow menu
// ---------------------------------------------------------------------------

function VoiceSettings({ voice }: { voice: HeraldVoice }) {
  const { neural, recommended, other } = useMemo(() => voicesForPicker(voice.voices), [voice.voices]);
  const auto = useMemo(() => pickVoice(voice.voices, null), [voice.voices]);
  const neuralDown = voice.serverStatus !== null && !voice.serverStatus.available;
  return (
    <div className="herald-voice-set" role="group" aria-label="Voice settings">
      {voice.supported && (
        <>
          <div className="herald-menu__label">Voice</div>
          <label className="herald-voice-set__row">
            <span className="sr-only">Voice</span>
            <select
              className="herald-voice-set__select"
              value={voice.voicePinned ? voice.voice?.id ?? '' : ''}
              onChange={(e) => voice.setVoiceId(e.target.value || null)}
              disabled={voice.voices.length === 0}
            >
              <option value="">
                {voice.voices.length === 0 ? 'System default voice' : `Automatic${auto ? ` (${auto.name})` : ''}`}
              </option>
              {neural.length > 0 && (
                <optgroup label="Herald voices (neural)">
                  {neural.map((v) => (
                    <option key={v.id} value={v.id}>{v.name}</option>
                  ))}
                </optgroup>
              )}
              {recommended.length > 0 && (
                <optgroup label={neural.length > 0 ? 'Browser voices' : 'English'}>
                  {recommended.map((v) => (
                    <option key={v.id} value={v.id}>{v.name}{v.local ? '' : ' · online'}</option>
                  ))}
                </optgroup>
              )}
              {other.length > 0 && (
                <optgroup label="Other">
                  {other.map((v) => (
                    <option key={v.id} value={v.id}>{v.name} ({v.lang})</option>
                  ))}
                </optgroup>
              )}
            </select>
          </label>
          <div className="herald-voice-set__engine" aria-live="polite">
            {voice.neural
              ? 'Neural voice (Kokoro, on your hub)'
              : neuralDown
                ? 'Voice service offline: using browser voice'
                : neural.length > 0 ? 'Browser voice' : 'Browser voice (hub has no neural voices)'}
          </div>
          <label className="herald-voice-set__rate">
            <span className="herald-voice-set__rate-label">Speed</span>
            <input
              type="range"
              min={RATE_MIN}
              max={RATE_MAX}
              step={0.05}
              value={voice.rate}
              onChange={(e) => voice.setRate(Number(e.target.value))}
              aria-valuetext={`${voice.rate.toFixed(2)} times`}
            />
            <span className="herald-voice-set__rate-val">{voice.rate.toFixed(2)}×</span>
          </label>
          <label className="herald-voice-set__rate">
            <span className="herald-voice-set__rate-label">Spoken</span>
            <select
              className="herald-voice-set__select herald-voice-set__select--sm"
              value={voice.spokenLength}
              onChange={(e) => voice.setSpokenLength(e.target.value === 'full' ? 'full' : 'short')}
              title="Short: the first sentence or two are read out, the rest stays on screen (say &quot;go on&quot;)"
            >
              <option value="short">Short (first sentence or two)</option>
              <option value="full">Full reply</option>
            </select>
          </label>
          <button type="button" role="menuitem" className="herald-menu__item" onClick={voice.testVoice}>
            <IconPlay size={14} /> Test voice
          </button>
        </>
      )}
      {voice.chimeSupported && (
        <button
          type="button"
          role="menuitemcheckbox"
          aria-checked={voice.chimeOn}
          className="herald-menu__item"
          onClick={() => voice.setChimeOn(!voice.chimeOn)}
        >
          <IconBell size={15} /> Tone when something is new
          <span className={`herald-switch${voice.chimeOn ? ' herald-switch--on' : ''}`} aria-hidden="true" />
        </button>
      )}
      {voice.chimeSupported && voice.chimeOn && <HeraldTonesVolume voice={voice} />}
      {voice.chimeSupported && voice.chimeOn && (
        <button
          type="button"
          role="menuitemcheckbox"
          aria-checked={voice.remind}
          className="herald-menu__item herald-menu__item--sub"
          onClick={() => voice.setRemind(!voice.remind)}
          title="Replay the tone once or twice if something blocked on you goes unheard for 5 minutes"
        >
          Remind me if a block goes unheard
          <span className={`herald-switch${voice.remind ? ' herald-switch--on' : ''}`} aria-hidden="true" />
        </button>
      )}
      {voice.chimeSupported && voice.chimeOn && !voice.announcer && (
        <div className="herald-voice-set__engine">Tones are playing on the active device (see Devices).</div>
      )}
    </div>
  );
}

const VERBOSITY_OPTIONS: Array<{ value: HeraldVerbosity; label: string }> = [
  { value: 'auto', label: 'Auto (brief spoken, normal typed)' },
  { value: 'brief', label: 'Brief' },
  { value: 'normal', label: 'Normal' },
  { value: 'detailed', label: 'Detailed' },
];

function ReplyLength({ value, onChange, disabled }: { value: HeraldVerbosity; onChange: (v: HeraldVerbosity) => void; disabled: boolean }) {
  return (
    <div className="herald-voice-set" role="group" aria-label="Reply length">
      <label className="herald-voice-set__rate">
        <span className="herald-voice-set__rate-label">Replies</span>
        <select
          className="herald-voice-set__select herald-voice-set__select--sm"
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value as HeraldVerbosity)}
          title='How much Herald says. Also: "keep it short from now on", "you can be more detailed"'
        >
          {VERBOSITY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </label>
    </div>
  );
}

function VoiceCommandsHelp() {
  const [open, setOpen] = useState(false);
  return (
    <div className="herald-voice-set" role="group" aria-label="Voice commands">
      <button type="button" className="herald-menu__item" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        Voice commands
        <span className={`herald-pending-more__chev${open ? ' herald-pending-more__chev--up' : ''}`} aria-hidden="true"><IconDown size={13} /></span>
      </button>
      {open && (
        <dl className="herald-cmds">
          {VOICE_COMMAND_HELP.map((c) => (
            <div key={c.does} className="herald-cmds__row">
              <dt>{c.say}</dt>
              <dd>{c.does}</dd>
            </div>
          ))}
          <p className="herald-cmds__note">Say one on its own (after "Hey Jarvis" when hands-free). "Stop the build" is still a message.</p>
        </dl>
      )}
    </div>
  );
}

function OverflowMenu({ model, onReset, onRefresh, disabled, voice, input, verbosity, onVerbosity, device, usage, onBudget }: {
  device: HeraldDeviceControl;
  usage: HeraldUsageSummary | undefined;
  onBudget: (monthlyUsd: number | null | undefined) => Promise<string | null>;
  verbosity: HeraldVerbosity | undefined;
  onVerbosity: (v: HeraldVerbosity) => void;
  model: string;
  onReset: () => Promise<boolean>;
  onRefresh: () => void;
  disabled: boolean;
  voice: HeraldVoice;
  input: HeraldVoiceInput;
}) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // The main view holds the few everyday controls; every other knob is in Advanced.
  const [advanced, setAdvanced] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => { setOpen(false); setConfirming(false); setAdvanced(false); }, []);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      // Esc steps back out of Advanced first.
      if (advanced && !confirming) setAdvanced(false);
      else close();
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open, advanced, confirming, close]);

  return (
    <div className="herald-menu" ref={rootRef}>
      <button
        type="button"
        className="herald-icon-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More"
        onClick={() => { if (open) close(); else setOpen(true); }}
      >
        <IconMore size={18} />
      </button>
      {open && (
        <div className={`herald-menu__pop${advanced ? ' herald-menu__pop--advanced' : ' herald-menu__pop--main'}`} role="menu">
          {!advanced && !confirming ? (
            <HeraldMenuMain onClose={close} onAdvanced={() => setAdvanced(true)} />
          ) : !confirming ? (
            <>
              <button type="button" className="herald-menu__item hm-back" onClick={() => setAdvanced(false)}>
                <IconBack size={15} /> Advanced
              </button>
              <div className="herald-menu__sep" role="separator" />
              <button type="button" role="menuitem" className="herald-menu__item" onClick={() => { onRefresh(); close(); }} disabled={disabled}>
                <IconRefresh size={15} /> Refresh
              </button>
              <button type="button" role="menuitem" className="herald-menu__item herald-menu__item--danger" onClick={() => setConfirming(true)} disabled={disabled}>
                <IconTrash size={15} /> Reset conversation
              </button>
              {verbosity !== undefined && (
                <>
                  <div className="herald-menu__sep" role="separator" />
                  <ReplyLength value={verbosity} onChange={onVerbosity} disabled={disabled} />
                </>
              )}
              {(voice.supported || voice.chimeSupported) && (
                <>
                  <div className="herald-menu__sep" role="separator" />
                  <VoiceSettings voice={voice} />
                </>
              )}
              {device.supported && device.selfId && (
                <>
                  <div className="herald-menu__sep" role="separator" />
                  <HeraldDevicesMenu device={device} onDone={close} />
                </>
              )}
              <div className="herald-menu__sep" role="separator" />
              <VoiceInputSettings input={input} />
              <div className="herald-menu__sep" role="separator" />
              <HeraldVoiceExtras input={input} voice={voice} />
              <div className="herald-menu__sep" role="separator" />
              <SetupAdvancedSettings />
              <div className="herald-menu__sep" role="separator" />
              <VoiceCommandsHelp />
            </>
          ) : (
            <div className="herald-menu__confirm">
              <p>Clear the whole conversation? Sessions are not affected.</p>
              <div className="herald-menu__confirm-row">
                <button type="button" className="herald-btn herald-btn--ghost herald-btn--sm" onClick={() => setConfirming(false)} autoFocus>Keep</button>
                <button
                  type="button"
                  className="herald-btn herald-btn--danger herald-btn--sm"
                  onClick={async () => { await onReset(); close(); }}
                >
                  Reset
                </button>
              </div>
            </div>
          )}
          {!confirming && <HeraldUsageMeter usage={usage} onBudget={onBudget} />}
          {model && <div className="herald-menu__foot">{model}</div>}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pending actions: most urgent in full, the rest behind a compact row
// ---------------------------------------------------------------------------

interface PendingStackProps {
  /** Pending actions, most urgent first. */
  actions: HeraldAction[];
  /** How many cards to show in full before collapsing the rest. */
  maxFull: number;
  skewMs: number | null;
  onDecide: (actionId: string, decision: 'confirm' | 'cancel') => Promise<unknown>;
  onOpenSession: OpenSession;
  disabled: boolean;
}

function PendingStack({ actions, maxFull, skewMs, onDecide, onOpenSession, disabled }: PendingStackProps) {
  const [expanded, setExpanded] = useState(false);
  const collapsible = actions.length > maxFull;
  // Once the stack drains back under the limit, the next overflow starts collapsed.
  useEffect(() => {
    if (!collapsible) setExpanded(false);
  }, [collapsible]);

  const shown = collapsible && !expanded ? actions.slice(0, maxFull) : actions;
  const hidden = collapsible ? actions.slice(maxFull) : [];
  const hiddenConfirms = hidden.filter((a) => a.tier === 'hard_confirm').length;
  const names = hidden.map((a) => a.sessionName);
  const nameList = names.length > 3 ? `${names.slice(0, 2).join(', ')} +${names.length - 2}` : names.join(', ');

  return (
    <div className="herald-pinned" aria-label="Pending actions">
      {shown.map((a) => (
        <HeraldActionCard
          key={a.id}
          action={a}
          skewMs={skewMs}
          onDecide={onDecide}
          onOpenSession={onOpenSession}
          disabled={disabled}
        />
      ))}
      {collapsible && (
        <button
          type="button"
          className={`herald-pending-more${hiddenConfirms > 0 && !expanded ? ' herald-pending-more--confirm' : ''}`}
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? (
            <span className="herald-pending-more__label">Show less</span>
          ) : (
            <>
              <span className="herald-pending-more__dots" aria-hidden="true">
                {hidden.slice(0, 4).map((a) => (
                  <span key={a.id} className={`herald-pending-more__dot herald-pending-more__dot--${a.tier}`} />
                ))}
              </span>
              <span className="herald-pending-more__label">
                +{hidden.length} more pending
                {hiddenConfirms > 0 && <span className="herald-pending-more__confirm"> · {hiddenConfirms} to confirm</span>}
              </span>
              <span className="herald-pending-more__names">{nameList}</span>
            </>
          )}
          <span className={`herald-pending-more__chev${expanded ? ' herald-pending-more__chev--up' : ''}`} aria-hidden="true">
            <IconDown size={14} />
          </span>
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export function HeraldPanel({ variant, onOpenSession, onClose }: HeraldPanelProps) {
  const ui = useHeraldUi();
  const h = useHeraldData();
  const voice = useHeraldVoiceCtx();
  const input = useHeraldVoiceInputCtx();
  const setup = useHeraldSetupCtx();
  const { state, messages, connected, supported, loaded, skewMs, presence, displayName, available } = h;
  const speaking = voice.supported && voice.speaking;
  const listening = input.state.phase === 'starting' || input.state.phase === 'listening';
  // Follow-up window: listening a few seconds for more (no wake word, no key).
  const followUp = input.followUpWindow;
  const orbState = listening ? 'listening' as const : speaking ? 'speaking' as const : followUp ? 'followup' as const : presence;

  const enabled = state?.enabled ?? true;
  const busy = (state?.busy ?? false) || h.sending;
  const canTalk = available && enabled;
  const inbox = useMemo(() => sortInbox(state?.inbox ?? []), [state?.inbox]);
  const actions = state?.actions ?? [];
  const actionById = useMemo(() => new Map(actions.map((a) => [a.id, a])), [actions]);
  const pending = useMemo(
    () => actions.filter((a) => a.status === 'pending').sort((a, b) => a.createdAt - b.createdAt),
    [actions],
  );
  const pendingByUrgency = useMemo(() => sortPendingByUrgency(actions), [actions]);
  const priorityBySession = useMemo(() => {
    const m = new Map<string, InboxPriority>();
    for (const i of inbox) {
      const k = `${i.serverId}:${i.sessionId}`;
      if (!m.has(k)) m.set(k, i.priority);
    }
    return m;
  }, [inbox]);

  // ---- scroll management -------------------------------------------------
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const [showJump, setShowJump] = useState(false);

  const scrollToBottom = useCallback((smooth: boolean) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    stickRef.current = true;
    setShowJump(false);
  }, []);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    stickRef.current = atBottom;
    if (atBottom) setShowJump(false);
  }, []);

  const lastMsg = messages[messages.length - 1];
  const contentKey = `${messages.length}:${lastMsg?.id}:${lastMsg?.text.length}:${busy}:${pending.length}`;
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (stickRef.current) el.scrollTop = el.scrollHeight;
    else setShowJump(true);
  }, [contentKey]);

  useEffect(() => {
    // New panel open / host switch: start at the latest line.
    requestAnimationFrame(() => scrollToBottom(false));
  }, [ui.hostId, scrollToBottom]);

  // ---- actions -----------------------------------------------------------
  const stopVoice = voice.stop;
  const send = useCallback(async (text: string, mode: 'voice' | 'text' = 'text') => {
    stickRef.current = true;
    stopVoice();
    return h.send(text, { mode });
  }, [h, stopVoice]);
  const briefMe = h.briefMe;

  const onChip = useCallback((item: HeraldInboxItem) => {
    if (!item.heard) h.markHeard([item.id]);
    if (item.review) {
      // A risky code change: open that session with its review drawer.
      requestReviewDrawer(item.serverId, item.sessionId, { scope: 'since_checkpoint', view: 'files' });
      onOpenSession(item.serverId, item.sessionId);
      return;
    }
    if (item.stuck) {
      // A stuck session: open it; its banner has the evidence and the actions.
      onOpenSession(item.serverId, item.sessionId);
      return;
    }
    if (canTalk && !busy) {
      void send(`Tell me about ${item.sessionName}`);
    } else {
      onOpenSession(item.serverId, item.sessionId);
    }
  }, [h, canTalk, busy, send, onOpenSession]);

  const cancelNewestEcho = useCallback(() => {
    const echo = [...pending].reverse().find((a) => a.tier === 'echo');
    if (echo) void h.confirm(echo.id, 'cancel');
  }, [pending, h]);

  // Errors are transient; auto-clear after a while.
  useEffect(() => {
    if (!h.error) return;
    const t = setTimeout(h.clearError, 8000);
    return () => clearTimeout(t);
  }, [h.error, h.clearError]);

  // Escape while speaking is a barge-in: it only stops the voice (runs in the
  // capture phase so it beats echo-cancel and panel-close).
  const cancelInput = input.cancel;
  const stopCommand = voice.stopCommand;
  const onKeyDownCapture = useCallback((e: ReactKeyboardEvent) => {
    if (e.key === 'Escape' && listening) {
      e.preventDefault();
      e.stopPropagation();
      cancelInput();
      return;
    }
    if (e.key === 'Escape' && speaking) {
      e.preventDefault();
      e.stopPropagation();
      stopCommand();
    }
  }, [speaking, stopCommand, listening, cancelInput]);

  // Escape closes the docked panel when focus is inside it.
  const onKeyDown = useCallback((e: ReactKeyboardEvent) => {
    if (e.key === 'Escape' && !e.defaultPrevented && variant === 'docked') {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'TEXTAREA' && (e.target as HTMLTextAreaElement).value) return;
      onClose();
    }
  }, [variant, onClose]);

  // ---- status copy -------------------------------------------------------
  let statusText: string;
  if (!ui.hostId) statusText = 'No server';
  else if (!connected) statusText = `Reaching ${ui.hostName || 'hub'}`;
  else if (supported === false) statusText = 'Unavailable';
  else if (!enabled) statusText = 'Paused';
  else if (listening) statusText = 'Listening';
  else if (voice.flash) statusText = voice.flash;
  else if (speaking) statusText = 'Speaking';
  else if (followUp) statusText = 'Listening for a follow-up';
  else if (busy) statusText = 'Thinking';
  else if (h.unheardBlocked > 0) statusText = `${h.unheardBlocked} waiting on you`;
  else statusText = 'Standing by';

  let offlineTitle = '';
  let offlineBody = '';
  if (!ui.hostId) {
    offlineTitle = 'No servers yet';
    offlineBody = `Add a server and ${displayName} will come online.`;
  } else if (!connected) {
    offlineTitle = `Reaching ${ui.hostName || 'the hub'}`;
    offlineBody = loaded
      ? 'Connection dropped. Everything below is from before; it will catch up on reconnect.'
      : `${displayName} lives on ${ui.hostName || 'your hub server'}. Waiting for it to connect.`;
  } else if (supported === false) {
    offlineTitle = `${ui.hostName || 'This server'} does not run ${displayName} yet`;
    offlineBody = 'Update its Companion daemon to wake it up.';
  } else if (!enabled) {
    offlineTitle = `${displayName} is paused`;
    offlineBody = state?.disabledReason || 'It has been turned off on the hub.';
  }
  const showOffline = !!offlineTitle;
  const isEmpty = messages.length === 0;

  return (
    <section
      className={`herald herald--${variant} herald--${presence}${speaking ? ' herald--speaking' : ''}${listening ? ' herald--listening' : ''}${state?.brain?.state === 'degraded' ? ' herald--degraded' : ''}`}
      aria-label={displayName}
      onKeyDown={onKeyDown}
      onKeyDownCapture={onKeyDownCapture}
    >
      <div className="herald__backdrop" aria-hidden="true" />

      <header className="herald-header">
        {variant === 'screen' && (
          <button type="button" className="herald-icon-btn" onClick={onClose} aria-label="Back">
            <IconBack size={20} />
          </button>
        )}
        <div className={`herald-header__orb${isEmpty && !showOffline ? ' herald-header__orb--hidden' : ''}`}>
          <HeraldOrb presence={orbState} size={34} mini countdown={followUp} />
        </div>
        <div className="herald-header__title">
          <span className="herald-header__name">{displayName}<HeraldBrainBadge brain={state?.brain} /></span>
          <span className={`herald-header__status herald-header__status--${listening ? 'listening' : voice.flash ? 'flash' : speaking ? 'speaking' : followUp ? 'followup' : presence}`} aria-live="polite">
            {statusText}
          </span>
        </div>
        <div className="herald-header__actions">
          <HandsFreeIndicator input={input} />
          {canTalk && (
            <button
              type="button"
              className={`herald-icon-btn herald-brief${h.unheardCount > 0 ? ' herald-brief--new' : ''}`}
              onClick={briefMe}
              disabled={busy}
              aria-label={h.unheardCount > 0 ? `Brief me: ${h.unheardCount} new` : 'Brief me'}
              title={`Brief me on what is new (${input.briefChordLabel}, or say "what's up")`}
            >
              <IconBrief size={17} />
              {h.unheardCount > 0 && <span className="herald-brief__badge" aria-hidden="true">{h.unheardCount}</span>}
            </button>
          )}
          {ui.hostOptions.length > 1 && (
            <label className="herald-host">
              <span className="sr-only">Herald host</span>
              <select
                value={ui.hostId ?? ''}
                onChange={(e) => ui.setHostId(e.target.value)}
                title="Which server hosts Herald"
              >
                {ui.hostOptions.map((o) => (
                  <option key={o.serverId} value={o.serverId}>
                    {o.name}{o.connected ? '' : ' (offline)'}
                  </option>
                ))}
              </select>
            </label>
          )}
          {voice.supported && (
            <button
              type="button"
              className={`herald-icon-btn herald-voice-toggle${voice.voiceOn ? ' herald-voice-toggle--on' : ''}${speaking ? ' herald-voice-toggle--live' : ''}`}
              onClick={() => voice.setVoiceOn(!voice.voiceOn)}
              aria-pressed={voice.voiceOn}
              aria-label={voice.voiceOn ? 'Voice replies on' : 'Voice replies off'}
              title={voice.voiceOn ? 'Voice replies on (click to mute)' : 'Voice replies off (click to hear replies)'}
            >
              {voice.voiceOn ? <IconSpeaker size={18} /> : <IconSpeakerOff size={18} />}
            </button>
          )}
          <OverflowMenu
            model={state?.model ?? ''}
            onReset={h.reset}
            onRefresh={h.refresh}
            disabled={!available}
            voice={voice}
            input={input}
            verbosity={state?.verbosity}
            onVerbosity={(v) => void h.setVerbosity(v)}
            device={h.device}
            usage={state?.usage}
            onBudget={h.setBudget}
          />
          {variant === 'docked' && (
            <button
              type="button"
              className="herald-icon-btn"
              onClick={onClose}
              aria-label={`Close ${displayName}`}
              title="Close (Ctrl+J)"
            >
              <IconClose size={18} />
            </button>
          )}
        </div>
      </header>
      <HeraldDeviceBar device={h.device} />

      {inbox.length > 0 && (
        <InboxStrip
          items={inbox}
          unheardCount={h.unheardCount}
          canAsk={canTalk && !busy}
          onAsk={briefMe}
          onChip={onChip}
        />
      )}

      <div className="herald-stream-wrap">
        <div
          className="herald-stream"
          ref={scrollRef}
          onScroll={onScroll}
          aria-live="polite"
          aria-relevant="additions text"
          aria-busy={busy}
        >
          {showOffline && (
            <div className={`herald-offline${loaded ? ' herald-offline--inline' : ''}`}>
              {!loaded && <HeraldOrb presence="disabled" size={88} />}
              <div className="herald-offline__title">{offlineTitle}</div>
              <div className="herald-offline__body">{offlineBody}</div>
            </div>
          )}

          {isEmpty && !showOffline && (
            <div className="herald-empty">
              <HeraldOrb presence={orbState} size={132} countdown={followUp} />
              <h2 className="herald-empty__title">Your sessions, at a glance.</h2>
              <p className="herald-empty__sub">
                Ask what is happening, what is blocked, or tell a session what to do next.
              </p>
              <div className="herald-empty__suggestions">
                {SUGGESTIONS.map((s) => (
                  <button key={s} type="button" className="herald-suggestion" disabled={!canTalk || busy} onClick={() => void send(s)}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((m) => (
            <HeraldLine
              key={m.id}
              message={m}
              actionById={actionById}
              priorityBySession={priorityBySession}
              onOpenSession={onOpenSession}
            />
          ))}

          {busy && !(lastMsg?.role === 'herald' && lastMsg.streaming) && <Thinking name={displayName} />}
        </div>

        {showJump && (
          <button type="button" className="herald-jump" onClick={() => scrollToBottom(true)}>
            <IconDown size={14} /> Latest
          </button>
        )}
      </div>

      <div className="herald-dock-bottom">
        {h.error && (
          <div className="herald-error" role="alert">
            <span>{h.error}</span>
            <button type="button" className="herald-icon-btn herald-icon-btn--sm" onClick={h.clearError} aria-label="Dismiss">
              <IconX size={14} />
            </button>
          </div>
        )}

        {pendingByUrgency.length > 0 && (
          <PendingStack
            actions={pendingByUrgency}
            // Phone screens get one full card; the wider docked panel has room for two.
            maxFull={variant === 'screen' ? 1 : 2}
            skewMs={skewMs}
            onDecide={h.confirm}
            onOpenSession={onOpenSession}
            disabled={!connected}
          />
        )}

        {input.echoPaused && (
          <div className="herald-echo-paused" role="alert">
            <span>
              <strong>Paused — possible echo.</strong> {displayName} may be hearing itself through the speakers, so voice
              messages now wait for you to send them. Use headphones, or turn off Interrupt.
            </span>
            <span className="herald-echo-paused__actions">
              {input.prefs.interrupt && (
                <button type="button" className="herald-echo-paused__btn" onClick={() => { input.setPref('interrupt', false); input.resumeAutoSend(); }}>
                  Turn off Interrupt
                </button>
              )}
              <button type="button" className="herald-echo-paused__btn" onClick={input.resumeAutoSend}>Resume</button>
            </span>
          </div>
        )}

        <AudioLockedNotice voice={voice} />

        <HeraldNotices />

        <HeraldListeningBar input={input} />

        {speaking && !listening && (
          <div className={`herald-speaking${input.handsFreeActive ? ' herald-speaking--handsfree' : ''}`} role="status">
            <span className="herald-speaking__bars" aria-hidden="true"><span /><span /><span /><span /></span>
            <span className="herald-speaking__label">
              Speaking…
              <span className="herald-speaking__hint">
                {input.prefs.interrupt || input.handsFreeActive ? ' say "stop", or press Esc' : ' press Esc to stop'}
              </span>
            </span>
            <button type="button" className="herald-speaking__stop" onClick={voice.stopCommand} title="Stop speaking (Esc, or say &quot;stop&quot;)">
              <IconStop size={13} /> Stop <kbd className="herald-speaking__kbd">Esc</kbd>
            </button>
          </div>
        )}

        {!speaking && voice.remoteSpeaking && (
          <div className="herald-speaking herald-speaking--remote" role="status">
            <span className="herald-speaking__bars" aria-hidden="true"><span /><span /><span /><span /></span>
            <span className="herald-speaking__label">Speaking on {voice.remoteSpeaking.label}</span>
            <button type="button" className="herald-speaking__stop" onClick={voice.stopRemote} title={`Stop Herald on ${voice.remoteSpeaking.label}`}>
              <IconStop size={13} /> Stop
            </button>
          </div>
        )}

        <HeraldComposer
          displayName={displayName}
          onSend={send}
          disabled={!canTalk}
          busy={busy}
          focusNonce={ui.focusNonce}
          onEscape={pending.some((a) => a.tier === 'echo') ? cancelNewestEcho : undefined}
          autoFocus={variant === 'screen' ? false : undefined}
          onTyping={speaking ? stopVoice : undefined}
          onVoiceKeyDown={input.onComposerKeyDown}
          onVoiceKeyUp={input.onComposerKeyUp}
          inject={input.transcript}
          onInjected={input.consumeTranscript}
          voiceSlot={<HeraldMicButton input={input} />}
          placeholderOverride={listening ? 'Listening…' : undefined}
        />
        <div className="herald-hint" aria-hidden="true">
          <kbd>Enter</kbd> send <span className="herald-hint__sep" /> <kbd>Shift</kbd>+<kbd>Enter</kbd> newline
          {input.available && input.prefs.spaceToTalk && <><span className="herald-hint__sep" /> hold <kbd>Space</kbd> talk</>}
          {listening
            ? <><span className="herald-hint__sep" /><kbd>Esc</kbd> cancel</>
            : speaking
            ? <><span className="herald-hint__sep" /><kbd>Esc</kbd> stop voice</>
            : pending.some((a) => a.tier === 'echo') && <><span className="herald-hint__sep" /><kbd>Esc</kbd> stop send</>}
        </div>
      </div>
      {setup.helpOpen && !setup.diagnosticsOpen && <HeraldHelp onClose={() => setup.setHelpOpen(false)} />}
      {setup.diagnosticsOpen && <HeraldDiagnostics onClose={() => setup.setDiagnosticsOpen(false)} />}
      {/* One device check at a time: the docked and full-screen panels can both be mounted. */}
      {(variant === 'screen' ? ui.screenOpen : ui.panelOpen && !ui.screenOpen) && <HeraldSetup />}
    </section>
  );
}
