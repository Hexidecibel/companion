import { useEffect, useRef, type ReactNode } from 'react';
import { VOICE_COMMAND_HELP } from '../../../services/voice/voiceCommands';
import { PROFILES } from '../../../services/heraldSetup/profiles';
import { useHeraldData, useHeraldSetupCtx, useHeraldVoiceInputCtx } from '../../../context/HeraldContext';
import { IconBack, IconCheckup } from '../heraldIcons';
import { TriggersGuide } from './TriggersGuide';
import { useNativeHeraldState } from '../../../hooks/useNativeHerald';
import { displayChordText } from '../../../services/voice/hotkeys';
import { isMacDesktop } from '../../../hooks/useNativeHerald';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="hh-sec">
      <h3 className="hh-sec__title">{title}</h3>
      {children}
    </section>
  );
}

/**
 * Help page inside the Herald panel: a concise guide, the voice commands, and
 * the setup notes people trip over (dictation apps, triggers).
 */
export function HeraldHelp({ onClose }: { onClose: () => void }) {
  const setup = useHeraldSetupCtx();
  const input = useHeraldVoiceInputCtx();
  const { displayName } = useHeraldData();
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => { rootRef.current?.focus(); }, []);
  const mod = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? 'Cmd' : 'Ctrl';
  const desktopApp = setup.platform === 'desktop';
  const phoneApp = setup.platform === 'android' || setup.platform === 'ios';
  const { prefs: nativePrefs } = useNativeHeraldState();
  const macKeys = isMacDesktop(setup.platform);
  const label = (c: string) => displayChordText(c, macKeys);
  const shortcutsOn = desktopApp && nativePrefs.globalShortcuts;
  const stopKey = shortcutsOn ? label(nativePrefs.stopChord) : null;
  const talkKey = shortcutsOn ? label(nativePrefs.talkChord) : null;

  return (
    <div
      className="hh"
      role="region"
      aria-label={`${displayName} help`}
      tabIndex={-1}
      ref={rootRef}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}
    >
      <header className="hh-head">
        <button type="button" className="herald-icon-btn" onClick={onClose} aria-label="Back to Herald">
          <IconBack size={18} />
        </button>
        <h2 className="hh-head__title">Using {displayName}</h2>
      </header>
      <div className="hh-body">
        <button type="button" className="hh-check" onClick={() => { onClose(); setup.openCheck(); }}>
          <span className="hh-check__icon" aria-hidden="true"><IconCheckup size={18} /></span>
          <span>
            <span className="hh-check__title">Run the device check</span>
            <span className="hh-check__sub">About a minute: profile, mic, echo, wake word, trigger.</span>
          </span>
        </button>
        <button type="button" className="hh-check" onClick={() => setup.setDiagnosticsOpen(true)}>
          <span className="hh-check__icon" aria-hidden="true"><IconCheckup size={18} /></span>
          <span>
            <span className="hh-check__title">Diagnostics</span>
            <span className="hh-check__sub">Live: mic, echo canceller, wake word, hands-free, devices, shortcuts. Or say “diagnostics”.</span>
          </span>
        </button>

        <Section title="Talking to it">
          <ul className="hh-list">
            <li><strong>Hold to talk:</strong> the mic button, Space in an empty box, or <kbd>{input.chordLabel}</kbd> anywhere on the page.</li>
            <li><strong>Brief me:</strong> <kbd>{input.briefChordLabel}</kbd>, the button in the header, or say “what's up”.</li>
            <li><strong>Open or close:</strong> <kbd>{mod}</kbd>+<kbd>J</kbd>.</li>
            {desktopApp && <li><strong>From any app:</strong> the system-wide shortcuts (Advanced &gt; System-wide shortcuts) and the tray icon.</li>}
            <li>
              <strong>Stop her talking:</strong> say “stop”, press <kbd>Esc</kbd> in the app
              {stopKey && <>, <kbd>{stopKey}</kbd> from any app (stops whichever device is speaking)</>}
              {talkKey && <>, or just hold <kbd>{talkKey}</kbd> to talk over her</>}
              {desktopApp && <>; also the tray’s Stop speaking and the floating orb’s stop button</>}.
            </li>
            <li><strong>Volume:</strong> the slider in the menu, or say “louder”, “quieter”, “volume 50”. It is Herald’s own level on this device, separate from the system volume{desktopApp ? ' (also in the tray)' : ''}.</li>
            {phoneApp && <li><strong>Earbuds:</strong> tap play/pause to ask; tap again to stop Herald.</li>}
          </ul>
        </Section>

        <Section title="Profiles">
          <p className="hh-p">One choice per device that sets the voice settings for how you listen. Switch in the menu; everything else is under Advanced.</p>
          <dl className="hh-defs">
            {setup.profiles.map((id) => (
              <div key={id} className="hh-defs__row">
                <dt>{PROFILES[id].name}</dt>
                <dd>{PROFILES[id].tagline}</dd>
              </div>
            ))}
          </dl>
          <p className="hh-p">Plug in or remove headphones and Herald suggests the matching profile (or switches by itself, if you allow it).</p>
        </Section>

        <Section title="Hands-free">
          <p className="hh-p">
            Turn it on in the menu, then say “Hey Jarvis” and your question. It runs on one device at a time (the main device).
            The mic stays open for the wake word; audio leaves the device only after it. A dot in the header shows it is on.
          </p>
          <p className="hh-p hh-p--note">
            Other dictation apps: Herald keeps the mic open in hands-free, so apps such as Wispr Flow may think you are in a
            meeting. Turn off meeting detection in those apps, or pause them while hands-free is on.
          </p>
        </Section>

        <Section title="Talking over Herald">
          <p className="hh-p">
            With headphones you can interrupt by just talking. Through speakers Herald could hear itself, so this stays off unless
            the echo test in the device check passes. “Stop”, <kbd>Esc</kbd>{stopKey ? <> or <kbd>{stopKey}</kbd></> : null} always works.
          </p>
        </Section>

        <Section title="Main device and Take control">
          <p className="hh-p">
            One device plays the tones, runs hands-free and receives remote triggers. Take control (under the header) moves it
            here; Keep on this device pins it until another device takes it.
          </p>
        </Section>

        <Section title="Tones">
          <p className="hh-p">
            By default only things that need you make a sound: a question or approval waiting, or a new device that wants to
            pair. Finished turns, risky changes, stuck sessions and turns that ended with an error still appear in the inbox,
            silently; turn tones on for each under <strong>Tones for</strong> in the menu.
          </p>
          <p className="hh-p">
            No tone plays for the session you are looking at, or within a minute of using the app. At most one tone every two
            minutes (adjustable): anything else that arrives meanwhile is folded into the next one, and nothing is replayed
            when you come back. Reminders for an unheard question are off unless you turn them on (one, after 10 minutes).
          </p>
          <p className="hh-p">
            Need a break? The bell in the header, saying “quiet for an hour” or “stop the tones”, or the tray item on desktop
            silences tones for an hour (“tones back on” resumes). A session's menu can mute its tones on this device. The
            Gaming profile chimes only for what needs you.
          </p>
        </Section>

        <Section title="Cards">
          <p className="hh-p">
            When you ask Herald to tell a session something, a card shows exactly what will be sent. Safe ones send after a short
            countdown (Esc cancels). Red cards (deploys, deletes) wait for you to confirm.
          </p>
        </Section>

        {desktopApp && (
          <Section title="Floating orb">
            <p className="hh-p">
              While Herald listens, thinks or speaks and Companion is not in front, a small orb floats over your other apps with
              a one-line caption and a stop button. Drag it anywhere; double-click it to open Companion. Off by default in the
              Gaming profile.
            </p>
          </Section>
        )}

        <Section title="Voice commands">
          <p className="hh-p">Say one on its own (after “Hey Jarvis” when hands-free). “Stop the build” is still a message.</p>
          <dl className="hh-cmds">
            {VOICE_COMMAND_HELP.map((c) => (
              <div key={c.does} className="hh-cmds__row">
                <dt>{c.say}</dt>
                <dd>{c.does}</dd>
              </div>
            ))}
          </dl>
        </Section>

        <Section title="Triggers">
          <TriggersGuide />
        </Section>

        <p className="hh-foot">You can also just ask {displayName}: “how do I use hands-free?”</p>
      </div>
    </div>
  );
}
