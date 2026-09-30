import { useEffect, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import type { HeraldVoiceInput, VoiceInputPrefs } from '../../hooks/useHeraldVoiceInput';
import { chordFromEvent, formatChord } from '../../services/voice/hotkeys';
import { IconListen, IconMic, IconMicOff, IconX } from './heraldIcons';

/**
 * Hold-to-talk mic button for the composer. Pointer capture keeps the hold
 * alive if the finger drifts off the button; keyboard users hold Enter/Space
 * on it. preventDefault on pointerdown keeps focus (and the caret) in the box.
 */
export function HeraldMicButton({ input }: { input: HeraldVoiceInput }) {
  const { state, available, unavailableReason, chordLabel, prefs } = input;
  const active = state.phase === 'starting' || state.phase === 'listening';
  const busy = state.phase === 'transcribing';

  const down = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // not capturable (synthetic event)
    }
    input.start('button');
  };
  const up = () => {
    if (input.state.source === 'button') input.stop();
  };
  const key = (e: ReactKeyboardEvent<HTMLButtonElement>, isDown: boolean) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    e.stopPropagation();
    if (isDown && !e.repeat) input.start('button');
    else if (!isDown) up();
  };

  const hint = !available
    ? unavailableReason ?? 'Voice input unavailable'
    : prefs.spaceToTalk
      ? `Hold to talk. Or hold Space in an empty box, or ${chordLabel} anywhere.`
      : `Hold to talk, or ${chordLabel} anywhere.`;

  return (
    <button
      type="button"
      className={`herald-composer__mic${active ? ' herald-composer__mic--live' : ''}${busy ? ' herald-composer__mic--busy' : ''}${available ? '' : ' herald-composer__mic--off'}`}
      aria-label={active ? 'Listening. Release to send' : 'Hold to talk'}
      aria-pressed={active}
      aria-disabled={!available}
      title={hint}
      onPointerDown={down}
      onPointerUp={up}
      onPointerCancel={up}
      onLostPointerCapture={up}
      onKeyDown={(e) => key(e, true)}
      onKeyUp={(e) => key(e, false)}
      onContextMenu={(e) => e.preventDefault()}
    >
      {available ? <IconMic size={18} /> : <IconMicOff size={18} />}
    </button>
  );
}

const METER_BARS = 7;

/** Live listening indicator with a level meter; also shows voice-input errors. */
export function HeraldListeningBar({ input }: { input: HeraldVoiceInput }) {
  const { state } = input;
  if (state.phase === 'idle' && !state.error) return null;
  if (state.phase === 'idle' && state.error) {
    return (
      <div className="herald-listening herald-listening--error" role="status">
        <IconMicOff size={14} />
        <span className="herald-listening__label">{state.error}</span>
        <button type="button" className="herald-icon-btn herald-icon-btn--sm" onClick={() => input.controller.clearError()} aria-label="Dismiss">
          <IconX size={13} />
        </button>
      </div>
    );
  }
  const transcribing = state.phase === 'transcribing';
  const label = transcribing
    ? 'Transcribing…'
    : state.phase === 'starting'
      ? 'Opening microphone…'
      : state.source === 'interrupt' || state.source === 'wake' || state.source === 'trigger'
        ? 'Listening… (pause to send)'
        : 'Listening… release to send';
  return (
    <div className={`herald-listening${transcribing ? ' herald-listening--busy' : ''}`} role="status" aria-live="polite">
      <span className="herald-listening__meter" aria-hidden="true">
        {Array.from({ length: METER_BARS }, (_, i) => {
          // Center bars react most; edges trail off.
          const w = 1 - Math.abs(i - (METER_BARS - 1) / 2) / METER_BARS;
          const h = transcribing ? 0.25 : Math.max(0.12, Math.min(1, state.level * (0.6 + w)));
          return <span key={i} style={{ transform: `scaleY(${h.toFixed(3)})` }} />;
        })}
      </span>
      <span className="herald-listening__label">{label}</span>
      {!transcribing && (
        <button type="button" className="herald-speaking__stop" onClick={() => input.cancel()} title="Cancel (Esc)">
          <IconX size={13} /> Cancel
        </button>
      )}
    </div>
  );
}

function Switch({ on }: { on: boolean }) {
  return <span className={`herald-switch${on ? ' herald-switch--on' : ''}`} aria-hidden="true" />;
}

/** Voice input section of the overflow menu. */
export function VoiceInputSettings({ input }: { input: HeraldVoiceInput }) {
  const { prefs, setPref, available, unavailableReason } = input;
  const [capturing, setCapturing] = useState<null | 'chord' | 'briefChord'>(null);

  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        setCapturing(null);
        return;
      }
      const c = chordFromEvent(e);
      if (!c) return; // modifiers alone, or no Ctrl/Alt/Meta: keep waiting
      setPref(capturing, formatChord(c));
      setCapturing(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [capturing, setPref]);

  return (
    <div className="herald-voice-set" role="group" aria-label="Voice input settings">
      <div className="herald-menu__label">Voice input</div>
      {!available && unavailableReason && <div className="herald-voice-set__engine herald-voice-set__warn">{unavailableReason}</div>}
      <button type="button" role="menuitemcheckbox" aria-checked={!prefs.reviewBeforeSend} className="herald-menu__item" onClick={() => setPref('reviewBeforeSend', !prefs.reviewBeforeSend)}>
        Send when I stop talking
        <Switch on={!prefs.reviewBeforeSend} />
      </button>
      <button type="button" role="menuitemcheckbox" aria-checked={prefs.spaceToTalk} className="herald-menu__item" onClick={() => setPref('spaceToTalk', !prefs.spaceToTalk)}>
        Hold Space to talk (empty box)
        <Switch on={prefs.spaceToTalk} />
      </button>
      <button type="button" role="menuitemcheckbox" aria-checked={prefs.interrupt} className="herald-menu__item" onClick={() => setPref('interrupt', !prefs.interrupt)}>
        Interrupt by talking
        <Switch on={prefs.interrupt} />
      </button>
      {prefs.interrupt && (
        <label className="herald-voice-set__rate">
          <span className="herald-voice-set__rate-label">Sensitivity</span>
          <select
            className="herald-voice-set__select herald-voice-set__select--sm"
            value={prefs.sensitivity}
            onChange={(e) => setPref('sensitivity', e.target.value as VoiceInputPrefs['sensitivity'])}
          >
            <option value="low">Low (noisy room)</option>
            <option value="normal">Normal</option>
            <option value="high">High (quiet room)</option>
          </select>
        </label>
      )}
      {prefs.interrupt && !input.micGranted && available && (
        <div className="herald-voice-set__engine">Allow the mic once (hold to talk) to enable interrupt.</div>
      )}
      <button
        type="button"
        role="menuitemcheckbox"
        aria-checked={prefs.handsFree}
        className="herald-menu__item"
        onClick={() => input.setHandsFree(!prefs.handsFree)}
        disabled={!input.handsFreeAvailable && !prefs.handsFree}
        title={input.handsFreeAvailable ? 'Always listening for the wake word on this device' : 'Needs the voice service with the wake word loaded'}
      >
        Hands-free: say "Hey Jarvis"
        <Switch on={prefs.handsFree} />
      </button>
      {prefs.handsFree && (
        <button type="button" role="menuitemcheckbox" aria-checked={prefs.handsFreeInBackground} className="herald-menu__item herald-menu__item--sub" onClick={() => setPref('handsFreeInBackground', !prefs.handsFreeInBackground)}>
          Keep listening when this tab is hidden
          <Switch on={prefs.handsFreeInBackground} />
        </button>
      )}
      {input.handsFreeNote && <div className="herald-voice-set__engine">{input.handsFreeNote}</div>}
      <button type="button" role="menuitem" className="herald-menu__item" onClick={() => setCapturing('chord')}>
        Talk shortcut
        <kbd className="herald-voice-set__kbd">{capturing === 'chord' ? 'Press keys…' : input.chordLabel}</kbd>
      </button>
      <button type="button" role="menuitem" className="herald-menu__item" onClick={() => setCapturing('briefChord')}>
        Brief me shortcut
        <kbd className="herald-voice-set__kbd">{capturing === 'briefChord' ? 'Press keys…' : input.briefChordLabel}</kbd>
      </button>
    </div>
  );
}

/**
 * Privacy indicator: visible whenever hands-free is listening for the wake
 * word on this device. Click to turn it off.
 */
export function HandsFreeIndicator({ input }: { input: HeraldVoiceInput }) {
  if (!input.handsFreeActive) return null;
  return (
    <button
      type="button"
      className="herald-handsfree"
      onClick={() => input.setHandsFree(false)}
      title='Hands-free is on: listening for "Hey Jarvis". Audio leaves this device only while someone is talking. Click to turn off.'
      aria-label="Hands-free listening is on. Turn off"
    >
      <span className="herald-handsfree__dot" aria-hidden="true" />
      <IconListen size={13} />
      <span className="herald-handsfree__label">Hey Jarvis</span>
    </button>
  );
}
