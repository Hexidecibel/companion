import { useEffect, useState } from 'react';
import { nativeHeraldStore, passthroughFor, useNativeHeraldState, type NativeHeraldPrefs } from '../../hooks/useNativeHerald';
import { requestInputMonitoring, type ShortcutName } from '../../services/nativeBridge';
import { chordFromEvent, formatChord, parseChord } from '../../services/voice/hotkeys';
import { nativePlatform, type NativePlatform } from '../../utils/platform';

type ChordKey = 'talkChord' | 'toggleChord' | 'briefChord' | 'stopChord';

const ROWS: { key: ChordKey; name: ShortcutName; label: string }[] = [
  { key: 'talkChord', name: 'talk', label: 'Hold to talk' },
  { key: 'stopChord', name: 'stop', label: 'Stop speaking (tap)' },
  { key: 'toggleChord', name: 'toggle', label: 'Listen / stop (tap)' },
  { key: 'briefChord', name: 'brief', label: 'Brief me (tap)' },
];

const PASSTHROUGH_LABEL = 'Let other apps see this key too';

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
  const { prefs, shortcuts, info, passthrough: ptStatus } = useNativeHeraldState();
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
  const canPassthrough = !!info?.passthrough;
  const mac = info?.os === 'macos';
  const needsPermission = mac && (ptStatus?.needsPermission || shortcuts.some((r) => r.passthroughError === 'needs_permission'));
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
                {chordLabel(prefs[key])} is taken by another app. Pick another
                {canPassthrough ? `, or turn on "${PASSTHROUGH_LABEL}"` : ''}.
              </div>
            )}
            {canPassthrough && prefs[key] && (
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={passthroughFor(prefs, name, info)}
                className="herald-menu__item herald-menu__item--sub herald-menu__item--fine"
                onClick={() => nativeHeraldStore.setPassthrough(name, !passthroughFor(prefs, name, info))}
                title="Companion watches the key without taking it, so Discord (or a game) bound to the same keys still gets them"
              >
                {PASSTHROUGH_LABEL}{name === 'talk' ? ' (recommended for push-to-talk)' : ''}
                <Switch on={passthroughFor(prefs, name, info)} />
              </button>
            )}
          </div>
        );
      })}
      {prefs.globalShortcuts && needsPermission && (
        <div className="herald-voice-set__engine herald-voice-set__warn">
          To let Discord and other apps see these keys too, macOS needs the Input Monitoring permission:
          Companion only watches for its own shortcuts and never records what you type. Until then the
          shortcut works but only Companion gets the keys.
          <button type="button" className="herald-btn herald-btn--ghost herald-btn--sm" onClick={() => void requestInputMonitoring()}>
            Allow Input Monitoring…
          </button>
          <span> Turn Companion on in System Settings, then quit and reopen Companion.</span>
        </div>
      )}
      {prefs.globalShortcuts && ptStatus?.foregroundElevated && (
        <div className="herald-voice-set__engine herald-voice-set__warn">
          The app in front runs as administrator, so Windows hides its keys from Companion. Run Companion as
          administrator too if your game runs as administrator.
        </div>
      )}
      {prefs.globalShortcuts && info?.wayland && (
        <div className="herald-voice-set__engine herald-voice-set__warn">
          Wayland limits system-wide shortcuts: they only work while a Companion window is focused. For a key
          that works everywhere, bind a desktop shortcut to the trigger script (triggers/README.md).
        </div>
      )}
      {prefs.globalShortcuts && info && !canPassthrough && !info.wayland && (
        <div className="herald-voice-set__engine">
          On Linux these keys belong to Companion alone (another app bound to the same keys will not get them).
        </div>
      )}
      <div className="herald-voice-set__engine">The tray icon also has Brief me, Toggle listening, Stop speaking, Herald volume and Mute tones.</div>
    </div>
  );
}
