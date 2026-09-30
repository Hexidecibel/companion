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

## Echo cancellation, Bluetooth and device changes (audio layer)

Diagnostics while testing (browser devtools console, or the desktop app's web
inspector): `Herald voice: echo check N dB (acoustic A dB, cancelled C dB, mode)`,
`Herald voice: talk-over detection vad|gated (reason)`, `Herald audio: echo
suppression during replies p20 N dB`, `Herald voice: talk-over stopped Herald after
N ms (vad|gated)`. Switches (localStorage): `herald.aec = off` disables the in-app
canceller (browser AEC only, for comparisons); `herald.androidNativeAec = 1` uses
Android's platform canceller instead. Stored measurements: `herald.echoMeasurements`.

### Mac, external speakers + external mic (the key case)
- [ ] Device check > Echo: reads 25 dB or more and "No echo". If the speakers sit
      in the 3.5 mm jack, the output shows as unknown (macOS calls the jack
      "External Headphones"), never as headphones.
- [ ] With the echo check passed, Advanced > Voice input shows "Instant: echo
      cancelled". Herald reading a long reply at normal volume: it never stops by
      itself, never sends its own words (console: no "talk-over stopped" lines).
- [ ] Say "stop" over a reply: Herald goes quiet in well under a second; the
      transcript is your words (check the composer or the sent message).
- [ ] Turn the speakers up loud and repeat: if the check then fails (or a
      talk-over turns out to be Herald), the mode drops to "Checks your words
      first" and nothing loops.
- [ ] Hands-free on, speakers: "Hey Jarvis" while Herald talks still wakes it.

### Windows gaming PC, headset + Discord
- [ ] Output reads as headphones (Advanced / device check "Playing on ...").
      With Discord in a call on the same headset: Herald's echo check reads very
      high (no acoustic path) and talk-over is instant.
- [ ] If the default Windows input is a Bluetooth headset's "Hands-Free AG Audio"
      endpoint and the PC has another mic: Herald listens on the other mic and
      the headset stays in "Stereo" (Sound settings > Output shows the Stereo
      endpoint active while Herald listens).
- [ ] Discord keeps working with its own input device while Herald listens.

### Android + Bluetooth earbuds (music must stay A2DP quality)
- [ ] Play music, connect the earbuds, open Herald, start hands-free (or hold to
      talk): the music does NOT drop to call quality and does not move to the
      phone speaker. Optional proof: `adb shell dumpsys audio | grep -iE
      "mode|sco"` shows mode NORMAL and no SCO while Herald listens.
- [ ] Herald hears you through the phone's own mic (speak towards the phone);
      replies play in the earbuds.
- [ ] Settings > "Use built-in mic with Bluetooth headphones" off: capture moves
      to the earbuds' mic (call quality is then expected).
- [ ] No earbuds, phone speaker: the echo check passes (in-graph canceller) or
      reports honestly; talking over Herald works at normal volume.
- [ ] First use asks for the microphone once (the app's own prompt); denying it
      shows the mic-denied message, not a silent failure.
- [ ] Earbuds disconnect mid-reply: Herald continues on the phone speaker, the
      mic keeps working, the environment switches to speakers.

### iPad (app)
- [ ] AirPods connected: Herald plays in stereo A2DP quality while listening (no
      call-quality drop); Control Center shows AirPods as output and the iPad
      microphone is used. With the setting off, AirPods' mic is used (HFP).
- [ ] No headphones: echo check passes on the iPad speaker (in-graph canceller
      in WKWebView); talk-over works.

### Unplugging headphones mid-reply (any platform)
- [ ] Wired headphones out while Herald talks: playback continues on speakers,
      the mode drops to "Checks your words first" until the canceller proves
      itself again (a few seconds of Herald talking, or the echo check), and
      Herald does not interrupt itself.
- [ ] Mic unplugged mid-utterance (USB mic): "Microphone disconnected" shows,
      listening continues on the next mic; the utterance in progress is either
      sent or clearly reported, never silently dropped.
- [ ] Plugging a new default mic in (e.g. a USB headset): Herald switches to it
      ("Listening with ...") unless it is a Bluetooth headset mic with the
      setting on.
