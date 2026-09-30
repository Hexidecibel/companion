# Herald real-device checklist

Things unit tests and headless screenshots cannot prove. Run on the real
machines after a native build. Each section is owned by the work that added it.

## Setup, profiles, floating orb (setup layer)

### Device check, per device
Clear the setup state first (Herald menu > Device check re-runs it; a fresh
install opens it by itself the first time Herald connects).

- [ ] **Mac, external speakers + mic:** profile preselects Desk speakers. Mic
      test shows a moving meter and the right transcript. Echo test: Herald's
      line plays; a failing result says so plainly and Interrupt ends up off
      (Advanced > Voice input). No echo loop afterwards when hands-free is on.
- [ ] **Windows gaming PC, headset + Discord in a call:** pick Gaming. Hands-free
      is off; Discord teammates talking never wake or interrupt Herald. Trigger
      step shows the system-wide shortcuts and turns green on a press of
      Ctrl+Alt+Space and of the MX Master thumb button (mapped in Logi Options+).
- [ ] **Android + Bluetooth earbuds:** profile preselects Phone + earbuds. Trigger
      step turns green on an earbud tap. Music ducks (not stops) while Herald
      speaks; "Lower other audio" in Advanced turns ducking off.
- [ ] **iPad (app):** Phone + earbuds offered; the check is a full-screen sheet
      in portrait and landscape; safe areas respected; earbud step explains the
      iOS Now Playing limit.
- [ ] **Browser tab (any):** trigger step explains triggers and turns green when
      a remote trigger (AutoHotkey / Raycast / curl) fires, without Herald starting
      to listen.
- [ ] Every step's Skip works; closing (X or Esc) marks the check done so it
      does not reopen; Help > Run the device check reopens it.
- [ ] Wake word step: "Hey Jarvis" turns it green; the capture that follows is
      not sent to Herald; hands-free goes back off unless "Keep hands-free on".
- [ ] Wispr Flow with hands-free on: confirm the meeting-detection note is
      accurate, and that pausing Wispr Flow clears its "in a meeting" state.

### Profile auto-suggest
- [ ] Desk speakers profile, plug in wired headphones: "Headphones connected.
      Switch to the Headphones profile?" appears in the panel. Switch applies it
      (Interrupt on); Not now never repeats for that change.
- [ ] Unplug: suggests Desk speakers. Bluetooth headphones connect/disconnect the
      same (needs the audio layer's device-change detection).
- [ ] Gaming profile + plug a headset in/out: no suggestion.
- [ ] Advanced > Switch profile automatically: the switch happens by itself with
      a short "Switched to ..." note.

### Floating orb (desktop app)
- [ ] Companion minimized / behind another app: hold the talk shortcut. The orb
      appears (listening, then thinking with your words, then speaking with the
      reply's first words) and fades out a few seconds after Herald stops.
- [ ] Companion focused: no orb.
- [ ] Click-through: clicking on the caption area hits the app underneath; the
      orb drags; double-click opens Companion; the stop button stops Herald.
- [ ] Drag it, quit and relaunch: same position. Unplug that monitor: it comes
      back at the bottom centre of the primary screen.
- [ ] **Windows, full-screen game (borderless):** the orb shows over the game and
      the game keeps focus and input (no alt-tab, no minimize). Exclusive
      full-screen DirectX games cover all windows; expect no orb there.
- [ ] **Windows:** the orb has no taskbar button and never shows in Alt+Tab.
- [ ] **macOS:** the orb appears on every Space and over a full-screen app
      (e.g. a full-screen browser or game); it never steals key focus.
- [ ] **Linux:** X11 transparency with a compositor; on Wayland the orb may not
      stay on top and click-through may be ignored (known limits).
- [ ] Gaming profile: no orb unless Advanced > Show floating orb is turned on.
- [ ] A news tone with Companion in the background: the orb pulses amber with
      the session's headline.

### Bring to front
- [ ] Advanced > Bring Companion to front on wake: "Hey Jarvis" and a remote
      trigger show and focus the Companion window (off by default).
- [ ] Gaming profile: never happens, even with the setting on.

### Help and tips
- [ ] Ask Herald "how do I use hands-free?" and "what profile should I use for
      gaming?": short, correct answers.
- [ ] Tips appear once each (first hands-free, first tone, first red card, first
      remote trigger) and never again after dismissing, across restarts
      (native apps: also after the WebView data is cleared).
