import { useEffect, useState } from 'react';
import { nativeHeraldStore, useNativeHeraldState, type NativeHeraldPrefs } from '../../hooks/useNativeHerald';
import { chordFromEvent, formatChord, parseChord } from '../../services/voice/hotkeys';
import { nativePlatform, type NativePlatform } from '../../utils/platform';

type ChordKey = 'talkChord' | 'toggleChord' | 'briefChord';

const ROWS: { key: ChordKey; name: 'talk' | 'toggle' | 'brief'; label: string }[] = [
  { key: 'talkChord', name: 'talk', label: 'Hold to talk' },
  { key: 'toggleChord', name: 'toggle', label: 'Listen / stop (tap)' },
  { key: 'briefChord', name: 'brief', label: 'Brief me (tap)' },
];

function Switch({ on }: { on: boolean }) {
  return <span className={`herald-switch${on ? ' herald-switch--on' : ''}`} aria-hidden="true" />;
}

function chordLabel(chord: string): string {
  const c = parseChord(chord);
  return c ? formatChord(c) : 'Off';
}

/**
 * Native-app section of the Herald voice menu. Desktop: system-wide shortcuts
 * (hold-to-talk works while another app, e.g. a game, has focus). Mobile: the
 * earbud / headset button. Renders nothing in a browser.
 */
export function NativeHeraldSettings({ platform = nativePlatform() }: { platform?: NativePlatform }) {
  const { prefs, shortcuts, info } = useNativeHeraldState();
  const [capturing, setCapturing] = useState<ChordKey | null>(null);
  const set = <K extends keyof NativeHeraldPrefs>(k: K, v: NativeHeraldPrefs[K]) => nativeHeraldStore.setPref(k, v);

  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        setCapturing(null);
        return;
      }
      if (e.key === 'Backspace' || e.key === 'Delete') {
        nativeHeraldStore.setPref(capturing, '');
        setCapturing(null);
        return;
      }
      const c = chordFromEvent(e);
      if (!c) return; // modifiers alone, or no Ctrl/Alt/Meta: keep waiting
      nativeHeraldStore.setPref(capturing, formatChord(c));
      setCapturing(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [capturing]);

  if (platform === 'browser') return null;

  if (platform === 'android' || platform === 'ios') {
    return (
      <div className="herald-voice-set" role="group" aria-label="Earbud button">
        <div className="herald-menu__label">Earbuds</div>
        <button
          type="button"
          role="menuitemcheckbox"
          aria-checked={prefs.earbudButton}
          className="herald-menu__item"
          onClick={() => set('earbudButton', !prefs.earbudButton)}
        >
          Earbud button talks to Herald
          <Switch on={prefs.earbudButton} />
        </button>
        {prefs.earbudButton && (
          <div className="herald-voice-set__engine">
            {platform === 'ios'
              ? 'Play/pause listens or stops Herald while the app is open. Herald pauses your music while it speaks (iOS gives the button only to the app playing audio).'
              : 'Play/pause listens or stops Herald once Herald has spoken; playing music in another app takes the button back.'}
          </div>
        )}
      </div>
    );
  }

  const results = new Map(shortcuts.map((r) => [r.name, r]));
  return (
    <div className="herald-voice-set" role="group" aria-label="System-wide shortcuts">
      <div className="herald-menu__label">System-wide shortcuts</div>
      <button
        type="button"
        role="menuitemcheckbox"
        aria-checked={prefs.globalShortcuts}
        className="herald-menu__item"
        onClick={() => set('globalShortcuts', !prefs.globalShortcuts)}
        title="Work while any other app (a game, Discord) has focus"
      >
        Work in any app
        <Switch on={prefs.globalShortcuts} />
      </button>
      {prefs.globalShortcuts && ROWS.map(({ key, name, label }) => {
        const r = results.get(name);
        return (
          <div key={key}>
            <button
              type="button"
              role="menuitem"
              className="herald-menu__item herald-menu__item--sub"
              onClick={() => setCapturing(key)}
              title="Click, then press the keys. Backspace turns it off, Esc cancels."
            >
              {label}
              <kbd className="herald-voice-set__kbd">{capturing === key ? 'Press keys…' : chordLabel(prefs[key])}</kbd>
            </button>
            {r && !r.ok && (
              <div className="herald-voice-set__engine herald-voice-set__warn">
                {chordLabel(prefs[key])} is taken by another app. Pick another.
              </div>
            )}
          </div>
        );
      })}
      {prefs.globalShortcuts && info?.wayland && (
        <div className="herald-voice-set__engine herald-voice-set__warn">
          Wayland limits system-wide shortcuts: they only work while a Companion window is focused. For a key
          that works everywhere, bind a desktop shortcut to the trigger script (triggers/README.md).
        </div>
      )}
      <div className="herald-voice-set__engine">The tray icon also has Brief me, Toggle listening and Mute tones.</div>
    </div>
  );
}
