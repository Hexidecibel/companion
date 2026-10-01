import { useState, type FormEvent } from 'react';
import type { HeraldVoice } from '../../hooks/useHeraldVoice';
import type { HeraldVoiceInput } from '../../hooks/useHeraldVoiceInput';
import type { HeraldPronunciation } from '../../types/herald';
import { FOLLOW_UP_CHOICES } from '../../services/voice/followUp';
import { MAX_PRONUNCIATIONS, MAX_PRONUNCIATION_FROM, MAX_PRONUNCIATION_TO, applyPronunciations } from '../../services/tts/pronounce';
import { useHeraldSetupState } from '../../services/heraldSetup/setupStore';
import { IconX } from './heraldIcons';
import { useHeraldData } from '../../context/HeraldContext';

function Switch({ on }: { on: boolean }) {
  return <span className={`herald-switch${on ? ' herald-switch--on' : ''}`} aria-hidden="true" />;
}

/**
 * Advanced: the follow-up window and the turn sounds (tick, thinking tone).
 */
export function VoiceTurnSettings({ input, voice }: { input: HeraldVoiceInput; voice: HeraldVoice }) {
  const setup = useHeraldSetupState();
  const gaming = setup.profile === 'gaming';
  const on = input.followUpOn;
  return (
    <div className="herald-voice-set" role="group" aria-label="Conversation settings">
      <div className="herald-menu__label">After a reply</div>
      <button
        type="button"
        role="menuitemcheckbox"
        aria-checked={on}
        className="herald-menu__item"
        onClick={() => input.setPref('followUp', !on)}
        title="After Herald answers something you said, keep listening a few seconds: no wake word or key needed"
      >
        Listen for a follow-up
        <Switch on={on} />
      </button>
      {on && (
        <label className="herald-voice-set__rate">
          <span className="herald-voice-set__rate-label">For</span>
          <select
            className="herald-voice-set__select herald-voice-set__select--sm"
            value={input.prefs.followUpMs}
            onChange={(e) => input.setPref('followUpMs', Number(e.target.value))}
          >
            {FOLLOW_UP_CHOICES.map((ms) => (
              <option key={ms} value={ms}>{ms / 1000} seconds</option>
            ))}
          </select>
        </label>
      )}
      <div className="herald-voice-set__engine">
        {input.prefs.followUp === null
          ? `Automatic: ${on ? 'on (headphones)' : 'off until headphones are detected'}.`
          : gaming && !on
            ? 'Off in the Gaming profile (Discord voices would count as follow-ups).'
            : 'Only after a spoken reply to something you said, on the active device. Silence closes it.'}
      </div>
      <div className="herald-menu__label">Sounds</div>
      <button
        type="button"
        role="menuitemcheckbox"
        aria-checked={voice.ackTick}
        className="herald-menu__item"
        onClick={() => voice.setAckTick(!voice.ackTick)}
        title="A tiny tick the moment Herald hears you stop talking"
      >
        Tick when I finish talking
        <Switch on={voice.ackTick} />
      </button>
      <button
        type="button"
        role="menuitemcheckbox"
        aria-checked={voice.thinkingTone}
        className="herald-menu__item"
        onClick={() => voice.setThinkingTone(!voice.thinkingTone)}
        title="A very soft tone while Herald thinks, if the answer takes more than 1.5 seconds"
      >
        Thinking tone
        <Switch on={voice.thinkingTone} />
      </button>
    </div>
  );
}

/**
 * Advanced: how Herald says particular words. Saved on the hub, so the list
 * follows you to every device. Built-ins (versions, Out4, APK, tmux...) need
 * no entry; an entry here wins over them.
 */
export function PronunciationSettings({
  list,
  onSave,
  onTry,
  disabled,
}: {
  list: HeraldPronunciation[] | undefined;
  onSave: (next: HeraldPronunciation[]) => Promise<string | null>;
  /** Speak a sample (the "to" in context). */
  onTry?: (text: string) => void;
  disabled?: boolean;
}) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const items = list ?? [];
  const supported = list !== undefined;

  const save = async (next: HeraldPronunciation[]) => {
    setSaving(true);
    const err = await onSave(next);
    setSaving(false);
    setError(err);
    return !err;
  };
  const add = async (e: FormEvent) => {
    e.preventDefault();
    const f = from.trim();
    const t = to.trim();
    if (!f || !t) return;
    const next = [...items.filter((p) => p.from.toLowerCase() !== f.toLowerCase()), { from: f, to: t }];
    if (await save(next)) {
      setFrom('');
      setTo('');
    }
  };

  return (
    <div className="herald-voice-set herald-pron" role="group" aria-label="Pronunciations">
      <div className="herald-menu__label">Pronunciations</div>
      {!supported && <div className="herald-voice-set__engine">This hub is too old to keep pronunciations.</div>}
      {supported && items.length === 0 && (
        <div className="herald-voice-set__engine">
          Versions, session names like Out4, APK and tmux are handled already. Add words Herald gets wrong.
        </div>
      )}
      {items.length > 0 && (
        <ul className="herald-pron__list">
          {items.map((p) => (
            <li key={p.from.toLowerCase()} className="herald-pron__item">
              <button
                type="button"
                className="herald-pron__say"
                onClick={() => onTry?.(applyPronunciations(p.from))}
                title="Hear it"
                disabled={!onTry}
              >
                <span className="herald-pron__from">{p.from}</span>
                <span className="herald-pron__arrow" aria-hidden="true">→</span>
                <span className="herald-pron__to">{p.to}</span>
              </button>
              <button
                type="button"
                className="herald-icon-btn herald-icon-btn--sm"
                aria-label={`Remove ${p.from}`}
                disabled={saving || disabled}
                onClick={() => void save(items.filter((q) => q !== p))}
              >
                <IconX size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {supported && items.length < MAX_PRONUNCIATIONS && (
        <form className="herald-pron__add" onSubmit={(e) => void add(e)}>
          <input
            className="herald-pron__input"
            value={from}
            maxLength={MAX_PRONUNCIATION_FROM}
            placeholder="Word"
            aria-label="Word as written"
            onChange={(e) => setFrom(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
            disabled={disabled}
          />
          <input
            className="herald-pron__input"
            value={to}
            maxLength={MAX_PRONUNCIATION_TO}
            placeholder="Say it as"
            aria-label="How to say it"
            onChange={(e) => setTo(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
            disabled={disabled}
          />
          <button type="submit" className="herald-btn herald-btn--ghost herald-btn--sm" disabled={!from.trim() || !to.trim() || saving || disabled}>
            Add
          </button>
        </form>
      )}
      {error && <div className="herald-voice-set__engine herald-voice-set__warn" role="alert">{error}</div>}
    </div>
  );
}

/** Both Advanced sections, wired to Herald's state (one line in the menu). */
export function HeraldVoiceExtras({ input, voice }: { input: HeraldVoiceInput; voice: HeraldVoice }) {
  const h = useHeraldData();
  return (
    <>
      <VoiceTurnSettings input={input} voice={voice} />
      <div className="herald-menu__sep" role="separator" />
      <PronunciationSettings
        list={h.state ? h.state.pronunciations : []}
        onSave={h.setPronunciations}
        onTry={voice.supported ? (text) => voice.say(text) : undefined}
        disabled={!h.connected}
      />
    </>
  );
}
