import { useState } from 'react';

type Tab = 'windows' | 'mac' | 'any';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'windows', label: 'Windows + MX Master' },
  { id: 'mac', label: 'Mac + Raycast' },
  { id: 'any', label: 'Anything else' },
];

/**
 * The in-app version of triggers/README.md: fire Herald from a hotkey, a mouse
 * button or a script on any machine, even mid-game with no Companion window
 * in front. Condensed to what you need at the keyboard; the full README lives
 * in the repo.
 */
export function TriggersGuide({ initial }: { initial?: Tab }) {
  const [tab, setTab] = useState<Tab>(initial ?? (/Mac/.test(typeof navigator !== 'undefined' ? navigator.platform : '') ? 'mac' : 'windows'));
  return (
    <div className="hs-guide">
      <p className="hs-guide__lede">
        A trigger fires Herald from anywhere with one key, mouse button or tap. It goes to your <strong>main device</strong> (the
        one that took control), which acts even with its window in the background.
      </p>
      <ol className="hs-guide__steps hs-guide__steps--first">
        <li>
          <span className="hs-guide__step-title">Get a trigger token (once, on the server)</span>
          <code className="hs-code">bin/companion trigger-token create</code>
          It can only fire triggers: it cannot read sessions or send anything.
        </li>
        <li>
          <span className="hs-guide__step-title">Use the mic here once</span>
          So this device remembers the microphone permission; a background tab cannot ask for it.
        </li>
      </ol>
      <div className="hs-seg" role="tablist" aria-label="Trigger setup">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={`hs-seg__btn${tab === t.id ? ' hs-seg__btn--on' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'windows' && (
        <ol className="hs-guide__steps" role="tabpanel">
          <li>
            <span className="hs-guide__step-title">Install AutoHotkey v2</span>
            Then copy <code>triggers/windows/herald-trigger.ahk</code> and the example ini into a folder, rename the ini to{' '}
            <code>herald-trigger.ini</code>, and set <code>url</code>, <code>token</code> and <code>device</code> (this PC's name in
            Herald, e.g. <em>Windows PC</em>).
          </li>
          <li>
            <span className="hs-guide__step-title">Keys</span>
            <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>H</kbd> toggles (ask, or cut Herald off),{' '}
            <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>B</kbd> briefs you.
          </li>
          <li>
            <span className="hs-guide__step-title">MX Master gesture button</span>
            Logi Options+ &gt; the thumb button &gt; Keyboard shortcut &gt; press <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>H</kbd>,
            under All applications (and any game profile).
          </li>
          <li>
            <span className="hs-guide__step-title">Games and Discord</span>
            A game running as administrator blocks the script: start it from Task Scheduler with highest privileges.
            Keep Discord's push-to-talk off these keys, and use push-to-talk in Discord so your question to Herald does not
            go to the channel.
          </li>
        </ol>
      )}
      {tab === 'mac' && (
        <ol className="hs-guide__steps" role="tabpanel">
          <li>
            <span className="hs-guide__step-title">Token into the Keychain</span>
            <code className="hs-code">security add-generic-password -s herald-trigger -a "$USER" -w</code>
          </li>
          <li>
            <span className="hs-guide__step-title">URL and device name</span>
            Put the server URL in <code>~/.config/herald-trigger/url</code> and this Mac's Herald name in{' '}
            <code>~/.config/herald-trigger/device</code>.
          </li>
          <li>
            <span className="hs-guide__step-title">Add the scripts to Raycast</span>
            Settings &gt; Extensions &gt; + &gt; Add Script Directory &gt; the <code>triggers/mac</code> folder. Give Herald Toggle a
            hotkey (e.g. <kbd>Ctrl</kbd>+<kbd>Opt</kbd>+<kbd>Shift</kbd>+<kbd>H</kbd>).
          </li>
          <li>
            <span className="hs-guide__step-title">Mouse button</span>
            Logi Options+ on the Mac can map any button to that Raycast hotkey.
          </li>
        </ol>
      )}
      {tab === 'any' && (
        <ol className="hs-guide__steps" role="tabpanel">
          <li>
            <span className="hs-guide__step-title">One HTTP call</span>
            <code className="hs-code">curl -X POST https://your-server/herald/trigger -H "Authorization: Bearer $TOKEN" -d '{`{"action":"toggle"}`}'</code>
          </li>
          <li>
            <span className="hs-guide__step-title">Actions</span>
            <code>toggle</code>, <code>brief</code>, <code>listen</code>, <code>stop</code>, <code>repeat</code>, <code>claim</code>; add{' '}
            <code>"device": "Name"</code> to aim at one device. Stream Deck, Shortcuts and home-automation buttons work the same way.
          </li>
        </ol>
      )}
      <p className="hs-guide__foot">Full guide: <code>triggers/README.md</code> in the Companion repo.</p>
    </div>
  );
}
