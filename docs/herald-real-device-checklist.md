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

## Conversation feel: follow-up, tick, undo, pronunciation (voice UX)

Needs the new web bundle (hard refresh) and, for pronunciations saved on the hub
and spoken-version fixes, the daemon restarted on the new build.

### Tonight: Windows gaming PC, headset + Discord + MX Master trigger
- [ ] Hard-refresh the Companion tab, then click once in it: the amber "Sound is
      off until you click" banner (shown after any reload) goes away and a test
      line plays. Without that click Herald is silent mid-game.
- [ ] Profile is Gaming. Advanced > After a reply: "Listen for a follow-up" is OFF
      (also if Gaming was chosen before this build); Show floating orb is off.
- [ ] Full-screen game in front, MX button: the "go ahead" tone, ask a question,
      stop talking: a tiny tick right away (before any words come back), then a
      short spoken answer. Nothing listens after it (no follow-up in Gaming).
- [ ] Alt-tab back into the game while Herald answers: the answer keeps playing.
- [ ] A session finishes or blocks while you play: a tone plays (even with the
      browser tab hidden behind the game), nothing is spoken until you ask.
- [ ] Discord teammates talking right after Herald answers never become a turn.

### Follow-up window (Headphones / Phone + earbuds)
- [ ] Ask something by voice (hold to talk, trigger, or "Hey Jarvis"). After the
      spoken answer the orb turns soft violet with an emptying ring and the
      status reads "Listening for a follow-up". Just ask the next question: no
      key, no wake word. It is answered, and the window opens again after.
- [ ] Say nothing: the ring empties in about 6 s (Advanced: 4-10 s) and it closes
      without a tone or message. A cough re-opens what is left of the window.
- [ ] Typed questions never open it; neither does a reply on another device
      (only the active device listens); "stop" closes it.
- [ ] Speakers instead of headphones with the Headphones profile on: Herald's own
      last words are never taken as a follow-up (echo guard), and three hands-off
      sends in a row pause auto-send ("Paused - possible echo").
- [ ] Desktop app, Companion in the background: the floating orb shows "Follow-up?"
      with the countdown ring and disappears the moment the window closes.

### Tick and thinking tone
- [ ] Every voice turn: the tick lands the moment you stop talking (hold-to-talk
      release, trigger, hands-free, follow-up), quiet and short. Advanced > Tick
      when I finish talking turns it off.
- [ ] Advanced > Thinking tone on, ask something slow ("summarize every session"):
      a very soft shimmer after about 1.5 s that stops the instant Herald speaks.
      It never plays after "stop" or a local command.

### Undo that
- [ ] Ask Herald to send something to a session (an echo-tier card with a
      countdown). During the countdown say "undo that" (or "don't send that",
      "take that back"): the card shows cancelled and Herald says "Cancelled.".
- [ ] Say "undo that" with nothing pending: "Nothing to undo." While Herald is
      talking and nothing is pending, "cancel that" just stops it.
- [ ] "Undo the migration on Out4" goes to Herald as a normal question.

### Pronunciation and versions
- [ ] Herald says "Out four", "version two point twenty-eight" (v2.28.0), "two
      point oh point seven" (2.0.7), "A-P-K", "tee-mux", "H A proxy", "P-R".
- [ ] Advanced > Pronunciations: add "Kokoro -> ko-ko-ro", tap the entry to hear
      it, then check it is there on another device (saved on the hub).
- [ ] With 2.0.7 mentioned in a session, ask "is two oh seven on the phone?":
      the sent message reads "2.0.7"; "two or three tests" stays words.

## Asking sessions, interrupting, new sessions, voice confirm (actions)

Use a disposable session for anything that types into a session (e.g. a scratch
project under `~/local/src`), never a session with real work in flight.

### Ask a session and hear the answer back
- [ ] Type "ask <session> what it is working on". After "Sent to <session>.",
      wait for the session to finish: one tone (finished variant), a line
      "<session> answered your question: ..." with a chip that opens the
      session, and NO separate "<session> finished: ..." chip.
- [ ] The answer was not spoken (typed turn = quiet). "Brief me" / "what's up"
      says it first: "<session> answered your question: ...".
- [ ] Same by voice (hold to talk): the answer is spoken when it lands within
      about 2 minutes of your last voice turn, and brief me does not repeat it.
- [ ] If Herald is mid-reply when the answer lands, the answer waits for the
      reply to finish instead of cutting it off.
- [ ] Ask something that makes the session ask YOU (a choice / permission box):
      "<session> needs your input on ..." once; after you answer it, the real
      answer still comes back later.
- [ ] Ask two different sessions back to back: each answer comes back on its own.
- [ ] Restart the daemon (with sign-off) while an ask is open: the answer still
      arrives after the restart. With no reply in 30 minutes, nothing is said.
- [ ] A session in bypass mode running a long command is NOT reported as
      "needs your input".

### Interrupt
- [ ] While a session is working: "interrupt <session>" / "stop <session>" ->
      "Interrupting <session>", a 5 s countdown card, then Ctrl+C: the session
      shows "Interrupted" and stays open. Cancel on the card stops it.
- [ ] "interrupt <session>" while it is idle: Herald says there is nothing to
      interrupt (no card).
- [ ] Spoken right after Herald mentioned that session, "interrupt <session>"
      still goes through (not dropped as Herald's own echo).

### New session
- [ ] "Start a new session in <project> and have it run the tests": a red card
      "New session in <project>" with "permissions bypassed" in the reasons and
      "Or say "confirm launch"". Nothing starts until confirmed.
- [ ] A folder outside `~/local/src` or a made-up project is refused.
- [ ] In a folder Claude has never opened: Herald reports the trust prompt /
      bypass-permissions warning and does NOT answer it. Answer it in the app:
      Herald then sends the first prompt ("... is ready; sent your first
      prompt") and later reports the answer.
- [ ] The new session shows up in the session list with the folder's name and
      did not become the app's active session.

### Voice confirm (red cards), mid-game
Windows gaming PC, Gaming profile, headset + Discord in a call, game full screen,
MX Master trigger, Companion is the ACTIVE device.
- [ ] Ask Herald (trigger) to send something dangerous to a scratch session
      ("tell scratch to deploy to prod"). Herald: "That's a deploy to prod — say
      'confirm deploy' to go ahead." The card shows the phrase.
- [ ] Press the trigger again and say "confirm deploy": an OK tone, then "Sent to
      scratch." Without touching the mouse or alt-tabbing.
- [ ] Say "yes" / "do it" instead: nothing is sent; Herald says the phrase.
- [ ] Say the wrong words ("confirm push"): "That didn't match", tries left on
      the card go 2, 1; after three misses the card says "Voice tries used up"
      and only hold-to-confirm works (holding still works).
- [ ] Talk over Herald while it is still saying the phrase: refused ("I was
      still talking"), then saying it after Herald finishes works.
- [ ] Desk speakers (no headset): Herald's own "say 'confirm deploy' to go
      ahead" coming out of the speakers never confirms the card, even with
      hands-free on.
- [ ] Say "confirm deploy" on a device that is NOT the active one: refused
      ("only works on the active device"), no try used up on the card.
- [ ] Let the card expire (10 minutes): the phrase no longer works.
- [ ] Teammates on Discord saying "confirm" do nothing (hands-free is off in
      Gaming; only your trigger opens the mic).

## Show me (navigation)

Needs the daemon restarted with this build (older hubs only do a plain "show me"
on the same device, from the app's own copy of Herald's state). Have at least
two sessions with recent news, ideally one parked on a question or choice.

### Show me, on the device you are talking to
- [ ] Herald mentions a session ("Out4 finished"). Say "show me": Out4's view
      opens, scrolled to its latest message, and Herald says "Here's Out4."
      No reply from the brain, no chat line.
- [ ] A session is waiting on a question / choice: "show me" scrolls to that
      prompt and it glows blue for a couple of seconds.
- [ ] An echo or red card is pending: "show me" opens THAT card's session, even
      if Herald's last line was about another one.
- [ ] Each phrase works: "show me that", "show me it", "open it", "take me
      there", "pull it up", "let me see". With a name: "show me Out4", "open Doc
      Upload Site", "show me the deploy session".
- [ ] Two sessions match ("show me docs" with Docs and Docs API): Herald asks
      "Which one, Docs or Docs API?"; answer "the API one" (or "the second
      one") in the follow-up window and it opens.
- [ ] Negative: "show me how to deploy", "show me what Out4 did", "open a new
      session in companion" are answered by Herald normally (no jump).
      "Open the pod bay doors" goes to Herald too (no such session).
- [ ] Nothing recent ("show me" right after "brief me" marked everything
      heard, no cards): "Nothing to show right now."
- [ ] Session chips in Herald's replies still open the session (they now map
      the hub's own sessions to this server).

### Per platform
- [ ] Desktop app, window behind other windows / minimized: "show me" brings it
      to the front and focuses it. Also in the Gaming profile, with
      "Bring to front" turned off (an explicit request).
- [ ] Gaming profile: success is just a tick, no spoken "Here's Out4."
- [ ] Phone app (Herald full screen open): "show me" closes Herald and opens
      the session screen; Back returns to the dashboard in one press.
- [ ] Browser tab: navigates; the tab does not steal focus.

### Cross-device
- [ ] On the phone, say "show me on my computer": the PC (or Mac) opens it and
      comes forward; the phone says "Out4 is up on <device>." The active
      device does NOT change (the header bar still names the phone).
- [ ] "Show me Out4 on the Mac" / "on my phone" / "on <renamed device>" work;
      "show me here" opens on the device you spoke to even if another one is
      active.
- [ ] The named device is closed: "Your phone isn't connected."
- [ ] Two computers connected and neither active: "Which device, Chrome on
      Windows or Work Mac?"

### Brain and triggers
- [ ] "Can you pull up whatever Out4 is stuck on?": Out4 opens on the active
      device and Herald says what is waiting ("Here's Out4, it's asking which
      branch.").
- [ ] Raycast "Show Herald's Last Session" (empty argument): opens the session
      Herald last talked about on the Mac, which comes forward and says "Here's
      Out4." (tick in Gaming). With "Out4" as the argument: Out4.
- [ ] AutoHotkey `show_key` (and `show_session=Out4`): same on Windows, mid-game.
- [ ] Signed mode on (`signed=true` / `HERALD_TRIGGER_SIGNED=true`) with a
      session: works; an unknown session gives the tray tip / HUD "No session
      has that name".

## One voice across devices (fleet speaking)

Needs the daemon restarted with this build and both apps/tabs on the new web
bundle. Hands-free and "Interrupt by talking" on for both devices; speakers,
not headphones.

### Phone speaking next to the Mac
- [ ] Ask on the phone (push-to-talk or typed with voice on). Only the phone
      speaks the reply; the Mac shows the text silently and a grey bar
      "Speaking on <phone>" with a Stop button.
- [ ] While the phone talks, the Mac never shows listening, never chimes a
      wake, never sends a message (Herald's chat has no line from the Mac),
      even when the reply says "Jarvis".
- [ ] Mid-reply, hold the Mac's talk hotkey / mic button and ask something:
      it is sent, the phone goes quiet, and the Mac speaks its own answer.
- [ ] Typed on a device with voice off: nobody speaks the reply.

### Mac speaking next to the phone
- [ ] Same as above with the roles swapped (ask on the Mac, phone stays
      silent, shows "Speaking on <Mac>", sends nothing, no follow-up window).
- [ ] A remote trigger (AutoHotkey / Raycast `listen`) to the phone while the
      Mac talks still listens and sends.

### Stop from the other device
- [ ] Phone talking: press Stop on the Mac's "Speaking on" bar. The phone stops
      within a moment and flashes "Stopped from <Mac>".
- [ ] Phone talking: say "Hey Jarvis, stop" near the Mac. The phone stops
      (a couple of seconds); nothing is sent to Herald.
- [ ] "Hey Jarvis, what's up" near the Mac while the phone talks: ignored (use
      the hotkey instead); the phone keeps talking.
- [ ] Close the phone's tab mid-reply: the Mac's bar clears within ~3 s and the
      Mac listens normally again.

## Volume, quick stop, passthrough shortcuts (Discord on the same keys)

Native desktop app from the `native/herald-voice` CI build (Windows .exe, macOS .dmg).

### Discord Push to Mute on Ctrl+Alt+Space (Windows gaming PC, headset, in a call)
- [ ] Herald menu > Advanced > System-wide shortcuts: Hold to talk shows "Let
      other apps see this key too (recommended for push-to-talk)" ON; the other
      shortcuts OFF.
- [ ] Discord > Keybinds: Push to Mute = Ctrl+Alt+Space. In a call (voice
      activity), hold Ctrl+Alt+Space and ask Herald something: Discord shows
      you muted for the whole hold (teammates hear nothing) AND Herald hears and
      answers. Release: Discord unmutes.
- [ ] Hold it for 10+ seconds (key auto-repeat): one capture, no restarts; it
      ends the moment you let go of Space OR of Ctrl / Alt.
- [ ] Turn the switch OFF: Ctrl+Alt+Space is Companion's alone again (Discord no
      longer mutes). Turn it back on.
- [ ] Game focused (borderless, raw-input game): the same still works.
- [ ] **Elevated game** (a game or tool started with "Run as administrator"):
      while it has focus, hold-to-talk does nothing and the shortcut settings
      say the app in front runs as administrator. Run Companion as
      administrator: it works again. (Discord needs the same for its keybinds.)
- [ ] Fallback `triggers/windows/herald-discord-ptt.ahk`: bind mode records F13
      as Discord Push to Mute; holding the thumb button mutes Discord and Herald
      listens; release ends both.

### macOS passthrough
- [ ] First launch: hold-to-talk falls back to exclusive and the settings explain
      Input Monitoring; "Allow Input Monitoring…" shows the system prompt /
      opens System Settings. Allow Companion, quit and reopen: the note is gone
      and another app bound to the same chord still receives it.

### Quick stop
- [ ] Herald speaking: Ctrl+Alt+Shift+S from a game stops her at once (no other
      app reacts to the chord). Discord's own defaults are untouched.
- [ ] Herald speaking on the PHONE: Ctrl+Alt+Shift+S on the PC stops the phone.
- [ ] Herald speaking: press and hold Ctrl+Alt+Space: she stops on the key-down,
      the listening tone follows, and what you say is sent on release.
- [ ] Tray > Stop speaking, the floating orb's stop button, Esc in the app (focus
      anywhere in the window), "stop": each one stops her.
- [ ] AutoHotkey `herald-trigger.ahk` with `stop_key=^!+s` (Companion app closed):
      stops Herald on the active device.
- [ ] Help page lists the stop shortcut and the volume options.

### Volume
- [ ] Main menu Volume slider: 50 % and 150 % are clearly quieter / louder than
      100 %, independent of the Windows volume; 150 % may clip a little on
      loud words, never crackles.
- [ ] Say "louder", "quieter", "volume 50": each answers "Volume N." at the new
      level; the slider and the tray check follow; it survives a restart.
      "Turn up the logging" goes to Herald as a normal question.
- [ ] Tray > Herald volume: Louder / Quieter / 80 % change it; the checked level
      follows the slider.
- [ ] Advanced > Tones at 50 % with "Tones follow the voice volume" on and off:
      the news tone follows the voice level only when on.
- [ ] Pick the Gaming profile: volume goes to 80 %. Running the device check
      again does not reset a volume you changed.
- [ ] Echo cancellation at 150 %: with speakers and talk-over allowed, Herald
      at 150 % still does not hear itself (no self-echo sends).
- [ ] **Windows volume mixer** (Settings > System > Sound > Volume mixer, or the
      classic mixer): while Herald speaks, its audio appears as "Microsoft Edge
      WebView2" (the WebView2 process plays it); lowering that entry lowers
      Herald and its tones, nothing else. Note what it is actually called.
