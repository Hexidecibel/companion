# Companion

A mobile companion for your AI coding CLI. Daemon runs on a Linux server, watches coding sessions, and exposes a WebSocket API. Web client + Tauri wrapper provides desktop, Android, and iOS apps from a single codebase.

## Project Structure

```
daemon/         # Node.js/TypeScript daemon (runs on server)
web/            # React + Vite + TypeScript client (shared by all platforms)
desktop/        # Tauri 2.0 wrapper (desktop + mobile native builds)
```

## Daemon

**Install location:** `/opt/companion`
**Config:** `/etc/companion/config.json`
**Service:** `companion` (systemd)

### Daemon Restart Safety

**NEVER restart or stop the companion daemon without explicit user sign-off in the current conversation.** This applies to `systemctl --user restart/stop companion` and `bin/companion restart/stop/start`. `KillMode=process` now protects spawned tmux sessions across a restart, but restarting still drops in-flight debugging state — notably pending-AUQ tmux-pane scrape state that is NOT persisted to disk. A PreToolUse hook (`.claude/hooks/guard-daemon-restart.sh`) enforces this and blocks the commands. Only override after the user approves, by including `COMPANION_ALLOW_RESTART=1` in the command. Daemon *builds* (`npm run build`) are not affected.

### Key files
- `src/index.ts` - Entry point, initializes all services
- `src/watcher.ts` - Watches `~/.claude/projects/` for JSONL conversation files
- `src/parser.ts` - Parses JSONL, detects "waiting for input" state
- `src/input-injector.ts` - Sends responses via `tmux send-keys`
- `src/websocket.ts` - WebSocket server, auth, message routing
- `src/push.ts` - Firebase push notifications (optional)
- `src/escalation.ts` - 2-tier notification escalation (browser -> push)
- `src/mdns.ts` - Bonjour/mDNS discovery

### Commands
```bash
# First-time setup (auto-builds daemon + web, creates config)
bin/companion setup

# Start daemon (background by default)
bin/companion start

# Start in foreground (for debugging)
bin/companion start -f

# Manage
bin/companion stop
bin/companion restart
bin/companion status
bin/companion logs

# Configure remote_capabilities (exec / dispatch / write) interactively
bin/companion enable-remote
```

**Note:** Each non-interactive `enable-remote` invocation (flags like `--dispatch`, `--write-root`, `--allowed-origin`, etc.) **replaces** the entire `remote_capabilities` block — it does not merge with the existing config. Specify the complete desired state on every call. Interactive mode (no flags) uses existing values as defaults and lets you edit from there.

### Config options
```json
{
  "port": 9877,
  "token": "your-secret-token",
  "tls": false,
  "tmux_session": "claude",
  "code_home": "/home/user/.claude",
  "mdns_enabled": true
}
```

Config path is resolved from `COMPANION_CONFIG` (preferred), falling back to `CONFIG_PATH` (legacy alias), then `~/.companion/config.json`.

**First run / setup mode:** with no config file the daemon writes one with `setup_complete: false` and serves the setup wizard (web app) until it is finished; an existing config without that key is never in setup mode. Secrets can live in `~/.companion/secrets.env` (0600; the wizard writes the Anthropic key there; the environment always wins). Setup code: `daemon/src/setup/` (protocol mirrored to `web/src/types/setup.ts`), web: `web/src/components/setup/`. End-to-end test of a true first run: `bin/e2e-setup-wizard [out-dir]` (needs `PLAYWRIGHT_CORE`; uses `bin/herald-sandbox --fresh` on port 9573 with a private tmux server). `remote_capabilities` may be set at the root of a legacy flat config, or per-listener in the `listeners: [...]` array form.

### Herald (conversational front layer) and daemon secrets

Herald's brain runs in the daemon (`daemon/src/herald/`). Config block `herald: {enabled, display_name, provider: 'openai_compatible'|'anthropic', base_url, model, echo_delay_ms, timeout_ms, max_tokens, state_dir, monthly_budget_usd, prompt_cache, cache_ttl, pricing, trigger_home_hosts, trigger_public_listen, trigger_trusted_proxies}` (set one with `bin/companion herald-set <key> <json>`). State lives in `~/.companion/herald/state.json` (override: `herald.state_dir` or env `COMPANION_HERALD_STATE_DIR`). Secrets never go in config.json or git: the anthropic provider reads `ANTHROPIC_API_KEY` from the daemon's environment only.

```bash
# Materialize secrets from .cush-secrets (Infisical) into ~/.companion/herald.env (chmod 600,
# outside the repo) and install a systemd drop-in (companion.service.d/secrets.conf) with
# EnvironmentFile=-~/.companion/herald.env. Runs daemon-reload; never restarts the daemon.
bin/companion install-secrets                    # --no-unit: env file only; --refresh-on-start: also
                                                 # re-run inject in ExecStartPre (failures never block start)

# Point Herald at Haiku in the live config (idempotent; preserves everything else):
bin/companion herald-provider anthropic          # [--model NAME] [--config PATH]

# Isolated test daemon from THIS checkout: port 9887, own HOME/config/state, mDNS off,
# no remote capabilities, key injected into that process's env only. Reads real sessions.
# The user talks to this one: its conversation is live history. Never probe it.
bin/herald-sandbox start|stop|status|logs|env

# Throwaway PROBE instance for automated checks: port 9888 (HERALD_SANDBOX_PORT overrides),
# own HOME/config/state under ~/.cache/companion-herald-sandbox-probe, same isolation, and a
# fresh conversation on every start. herald-probe.js targets it by default.
bin/herald-sandbox --instance probe start|stop|status|logs|env
node daemon/scripts/herald-probe.js [--reset] "Anything for me?"   # measures TTFT/latency;
                                                 # auto-CANCELS any proposed action
bin/herald-sandbox --instance probe stop         # always stop it afterwards (verifies the port is free)
```

Both key and provider changes take effect only on the next daemon restart (needs explicit user sign-off). `bin/companion start` / `start -f` also source `~/.companion/herald.env` when it exists. The sandbox must use its own HOME: the daemon writes its PID file, audit log and push state under `$HOME/.companion`, so a second daemon sharing HOME would overwrite (and on exit delete) production's `daemon.pid`. It does still read the shared `code_home`; the script sets `COMPANION_SANDBOX=1` (implies `COMPANION_READONLY_SHARED_STATE=1`), so the sandbox never writes `~/.claude/companion-session-mappings.json` / `companion-sessions-snapshot.json`, never registers push devices or sends pushes, and never auto-approves tools. It reuses production's auth token (never printed). `HERALD_DEBUG_TOOLS=1` (on by default in the sandbox) logs tool calls and results, which include session text.

Herald also has read-only knowledge tools (`daemon/src/herald/knowledge/`): `search_infra` (`/mnt/hexinas/apps/INFRASTRUCTURE.md`), `cush_tools_help` (cush-tools docs + the cush-tools section of `~/.claude/CLAUDE.md`), `cush_status`, `search_project_notes` (CLAUDE/plan/todo/FEATURES/README of `~/local/src/*` projects with a CLAUDE.md or plan.md) and `search_memory` (`<code_home>/projects/*/memory/*.md`). All reads go through `knowledge/redact.ts` (path denylist + token redaction). `propose_cush_command` runs only `extend`/`close`/`serve`/`tunnel`/`drop` via execFile (tiers in `danger.ts` `classifyCushCommand`); everything else is refused in code. Paths derive from `code_home`; override with `HERALD_USER_HOME`, `HERALD_INFRA_DOC`, `HERALD_CUSH_TOOLS_DIR`, `HERALD_PROJECTS_ROOT`.

Session actions (`actions.ts`, tiers in `danger.ts`): `propose_input` (free text / choice), `propose_interrupt` (echo; Ctrl+C via `InputInjector.cancelInput`, only while the session is working, re-checked at send) and `propose_spawn_session` (always hard_confirm; folder must resolve to a real path inside `~/local/src` or `HERALD_SPAWN_ROOTS`, colon-separated; uses the app's own path `daemon/src/session-spawn.ts`, shared with `create_tmux_session`; a session parked at Claude's trust prompt / bypass-permissions warning is reported, never answered, and gets its first prompt once ready). Ask-and-report (`asks.ts`): every free-text send opens an awaiting-reply link (persisted in state.json, 30 min timeout); the reply to THAT prompt becomes "<session> answered your question: ..." (grounded in the reply only; a number the reply never states falls back to its first sentence) and an inbox item with `answer: true` that replaces the generic finished note and leads "brief me"; a choice box on screen is reported as "needs your input". Answers are `quiet` messages (never spoken) unless the user spoke to Herald in the last 2 minutes. Voice confirmation (`voice-confirm.ts`): hard_confirm cards carry `confirmPhrase` ("confirm deploy") and 3 `voiceAttemptsLeft`; `herald_confirm {method:'voice', phrase, streamId?}` is verified against the voice service's OWN transcript of that client's mic (`voiceEvidence`), only from the active device, captured after Herald's estimated playback end, through the echo filter; a bare "yes" never confirms. Web hook: `web/src/services/voice/confirmPhrase.ts` (runs before the voice-command matcher).

#### Herald voice (local voice service)

`bin/herald-voice` runs a Python/aiohttp service from `voice/herald_voice/` (venv + models in `~/.local/share/herald-voice`, logs in `~/.cache/herald-voice/voice.log`): Kokoro TTS (fp32 ONNX, 6 threads), faster-whisper STT (`base.en` int8, 4 threads) and openWakeWord (`hey_jarvis`), each on a single-worker executor with a bounded queue, launched with `nice -n 10`. It has NO auth and binds 127.0.0.1 only; the daemon is its only client (`herald.voice_url`, env `HERALD_VOICE_URL`, default `http://127.0.0.1:9889`; `herald.voice_enabled=false` turns voice off). Browser traffic goes over the authenticated WS: `herald_voice_status`, `herald_tts`, `herald_tts_cancel`, `herald_voice_stream_start` / `herald_voice_audio` (fire-and-forget PCM16 chunks, never logged) / `herald_voice_stream_end`, `herald_handsfree`, plus per-client `herald_voice_event` pushes. That protocol section lives in `daemon/src/herald/protocol.ts` and must stay byte-identical in `web/src/types/herald.ts` (enforced by `web/src/types/__tests__/heraldProtocolMirror.test.ts`). No audio is written to disk; transcripts are logged only with `HERALD_DEBUG_TOOLS`.

```bash
bin/herald-voice install        # venv (uv), deps, Kokoro + Whisper + openWakeWord models (idempotent)
bin/herald-voice install-unit   # production: systemd user unit herald-voice.service (runs
                                # `bin/herald-voice run` from THIS checkout, nice 10, Restart=on-failure,
                                # WantedBy=default.target). Once installed, start/stop/restart use systemctl.
bin/herald-voice uninstall-unit # stop, disable and remove the unit
bin/herald-voice start|stop|restart|status|logs   # status exits 1 unless all engines are ready
bin/herald-voice test           # Python endpoint tests (fake engines)
bin/herald-voice say "text" [voice] [out.wav]
bin/herald-sandbox https [on|off|status] [--tunnel]   # mic needs a secure origin: Tailscale serve
                                # https://<node>.ts.net:9890 -> 127.0.0.1:9887 (tailnet only, sudo -n)
node daemon/scripts/herald-voice-probe.js status|tts|stt|wake "text"   # PROBE instance only
```

Quiet by default: Herald never speaks up on its own. New inbox items play a tone (`web/src/services/tts/chime.ts`, signature G-C-E motif) on ONE device, the "announcer" elected by the daemon from `herald_presence` reports (hands-free device first, else most recently used; `announcer` voice event). Spoken input goes through `web/src/services/voice/voiceCommands.ts` (whole-utterance commands: stop, repeat, shorter, go on, slower/faster, what's up) and `voiceCommandRouter.ts`; `herald_send` carries `mode` ('voice' -> a brief per-turn `[Reply style]` note placed between the snapshot and the user's words, never at the end, where Haiku parrots it) and `intent` ('shorter' | 'more' | 'brief'). Reply length (`verbosity`: auto/brief/normal/detailed) lives in Herald state (`herald_set_verbosity`, or the brain's `set_verbosity` tool). The web speaks at most 2 sentences / 40 words of a reply (setting: Spoken length). STT gets vocabulary hints (`HeraldService.sttHints()`: live session names + jargon -> Whisper `initial_prompt` + `hotwords` via `/stt?prompt=&hotwords=`). Probe voice turns with `herald-probe.js "[voice] ..."`, `"[shorter] Shorter."`, `"[brief] What's up?"`.

Conversation feel (web, `web/src/services/voice/`): after Herald SPEAKS its reply to a turn that came by voice from the active device, a follow-up window listens 6 s (4-10 s; `followUp.ts` decides when, `VoiceAutomation.followUp()` captures, source `followup`, cleaned mic, echo tail skipped, self-echo filter + loop breaker apply); no wake word or key needed; silence closes it quietly; on for Headphones/Phone profiles, off for Gaming/Desk (automatic = headphones, never in Gaming/Desk). A tick (`chime.ts` `tick`, under 80 ms) plays at end-of-speech; an optional thinking shimmer after 1.5 s without audio (`turnCues.ts`, off by default). UNDO ("undo that", "don't send that", "cancel that") cancels the newest pending echo-tier action through `herald_confirm` (`voiceUndo.ts`). Speech pronunciation (`services/tts/pronounce.ts`, last step of `normalizeForSpeech`): versions as words, `Out4` -> "Out four", hyphen-spelled acronyms (spaced letters after "the" are read as the article), plus the user's list in Herald state (`herald_set_pronunciations`, `HeraldState.pronunciations`). STT hints include versions from recent text, and `daemon/src/herald/voice/versions.ts` rewrites a spoken run that spells one exactly ("two or seven" -> 2.0.7).

Remote triggers and the active device: ONE device is active (the announcer: tones, hands-free, remote triggers). Election in `HeraldVoiceService`: a device claimed by hand (`herald_claim_device {pin, deviceId?}`; pinned = until another claim or it disconnects, with a 60 s reconnect grace by `deviceKey`; unpinned = until another device is used), else the hands-free device, else the most recently used, else the most recently seen. `herald_presence` carries a friendly `label` + `deviceKey` and answers with the `clientId`; `HeraldState.activeDevice/devices` and the `devices` herald_event expose it (web: `web/src/services/heraldDevice.ts`, `components/herald/HeraldDevices.tsx`: Take control, "Keep on this device", menu device list + rename; a device that loses a claim shows "Now on <device>" and pauses hands-free). `POST /herald/trigger` (Authorization: Bearer <trigger token>; body `{action, device?, pin?, session?}`; actions brief/listen/stop/repeat/toggle/claim/show; `device` claims that device first; `show` sends a `navigate` event, `session` optional) and the `herald_trigger` WS request are routed by `daemon/src/herald/trigger.ts` to the active device as a `trigger` herald_event (409 no_active_device, 404 unknown_device, 429 over 10 per 10 s; every attempt audit-logged as `herald_trigger`). The trigger token is a separate credential that can ONLY fire triggers (a WS session authenticated with it is refused every other message type): a 0600 file outside the repo (`~/.companion/herald-trigger.token`, env `COMPANION_HERALD_TRIGGER_TOKEN_FILE`), re-read on change (no restart), constant-time compared. Web handling: `web/src/services/voice/heraldTrigger.ts` (works with the tab hidden; listen = one VAD-ended utterance via `VoiceAutomation.listen()`, sent as its own voice turn, never through the composer; failures = error tone + notice on next focus). Ready-made triggers (AutoHotkey v2, Raycast, curl) and setup: `triggers/README.md`.

One voice across devices (AEC only cancels Herald on the device that PLAYS it): every Herald line carries `speakOn` (`HeraldService.speakOnFor`): a reply goes to the connection that sent the turn (the device a trigger was routed to sends it), anything said unasked to the active device; the asker gone mid-reply -> the active device, else `null` (nobody); a turn from a connection that never reported presence (older client) leaves it absent = every device decides as before. The web speaks only lines whose `speakOn` is its own `selfId` (`heraldSpeech.ts` via `services/voice/fleetSpeaking.ts` `shouldSpeakLine`); a line routed elsewhere also cuts what this device is still playing. The speaking device reports `herald_speaking {state:'start'|'end', utteranceId, approxEndAt, sentAt}` (start repeated every 1 s as a heartbeat; `SpeakingReporter`, stops itself on a hub without it), the hub (`herald/voice/speaking.ts` `SpeakingTracker`: 2.5 s heartbeat timeout, 30 s cap, 800 ms tail) broadcasts a `speaking` herald_event, and every OTHER device (`FleetSpeakingTracker`) drops hands-off captures while it lasts plus the tail (`fleetDecision`: barge-in, follow-up, hands-free/wake are dropped; push-to-talk, hotkeys, triggers, buttons pass), shows "Speaking on <device>" with a Stop button (`herald_stop_speaking` -> a `stop_speaking` event to the speaker only). A wake word on such a device stays quiet (no chime / listening UI) and only acts when "stop" follows it at once (`stopAfterWake`, checked early on the last 3 s because the mic hears one long utterance), which stops the speaker. "stop" / a stop trigger on any device stops the remote speaker too. Backstop: the daemon drops a `herald_send` with `mode:'voice'` from a device inside another device's speaking window unless it carries `gesture: true` (set by the web for gesture captures via `gestureLedger`), `{ ignored: 'speaking' }`, logged with `console.debug`. E2E: two headless devices on the probe, A's synthesized audio fed into B's fake mic.

"Show me" (navigation): `web/src/services/voice/voiceCommands.ts` `matchShowCommand` (whole utterance: "show me", "open it", "pull it up", "show me Out4", "... on my phone" / "here"; a target with question words goes to the brain) -> `showCommand.ts` (device words resolved by `services/voice/deviceAlias.ts`, byte-identical to `daemon/src/herald/device-alias.ts` and mirror-tested: PC/computer/desktop/Windows/gaming PC -> the Windows device, Mac/MacBook/laptop -> macOS, phone/Android/iPhone, tablet/iPad, here/this one = this device; by the platform each device reports with `herald_presence` (`platform {os, app}`), else its label; several -> "Which one, A or B?" answered in the follow-up window (sessions or devices); a device phrase that matches nothing says "I don't see a PC connected." and never falls back to the active device; a leading "a"/"an" before the name is dropped; not_found -> brain) -> `herald_show {session?, device?}` -> `HeraldService.show` (`herald/show.ts` `pickShowTarget`: named = `resolveSession`; unnamed = newest pending card, else the latest Herald message's first chip, else the newest unheard inbox item) -> a `navigate` herald_event to that ONE device (default the active one; never changes it). The receiving web emits `herald-show-session` (Dashboard opens it; `services/sessionFocus.ts` makes `MessageList` scroll to the last `.question-block` / `.msg-approval-prompt` and flash it, else the bottom), and the desktop app comes forward (`shouldBringToFront` source `show`: even in Gaming). The brain has `show_session(session, device?)` (device = the user's words, resolved by `show.ts` `resolveShowDevice` from the asking device); triggers have `show` (ack=true: the target says "Here's Out4.", a tick in Gaming). Herald's own session refs carry serverId `local`; the web maps them to the Herald host (`services/heraldNav.ts`).

Trigger tokens are per device: `herald-trigger-tokens.json` (0600) holds names + SHA-256 only, each secret is `~/.companion/herald-triggers/<name>.token`; the original `herald-trigger.token` keeps working as "default" (`migrate` registers it). Audit entries carry the token name, `network` and the client behind the proxy. Mic-opening triggers (`listen`; `toggle` gets `allowListen:false`) only from localhost / LAN / tailnet / the home's public IP (`trigger_home_hosts`, hairpin NAT through dev.cush.rocks; production config sets `["dev.cush.rocks"]`); X-Forwarded-For is believed only from `trigger_trusted_proxies` (default loopback = HAProxy on this host); else 403 `untrusted_origin` unless `trigger_public_listen`. Optional signed mode: `X-Herald-Ts` + `X-Herald-Sig` (HMAC-SHA256 keyed with the token's SHA-256 hex over `ts.action.device`, 60 s skew, replay-guarded). A remote listen plays the distinct `remote` tone.

```bash
bin/companion trigger-token create|rotate|revoke|show-path <name>   # e.g. gaming-pc; never prints the token
bin/companion trigger-token list|migrate
bin/herald-sandbox --instance probe trigger-token create probe-pc  # the probe instance's own tokens
```

Cost: the Anthropic provider caches tools + system (~5.9K tokens, Haiku 4.5's minimum is 4096) with one breakpoint on the system block (plus one on the newest tool result inside tool loops); keep that prefix byte-stable (nothing volatile in `prompt.ts`/tool specs: the snapshot timestamp lives in the user turn). `herald/usage.ts` meters tokens + dollars per day/month in Herald state (rates in `DEFAULT_PRICING`, override `herald.pricing`); `monthly_budget_usd` (or the menu's budget, `herald_set_budget`) warns once at 80% and at 100% switches to the fallback brain until next month or a raised cap. "How much have you cost me" is answered from the meter, no LLM. `herald/fallback.ts`: when the LLM fails (network, timeout, 5xx/529, 429, 401/403, 402/credit, budget) answers are templated from the inbox + session listing, the reason is told once per outage, `HeraldState.brain` / the `brain` event drive the header badge, retries back off and a 1-token health check recovers automatically. Simulate on the probe only (`ANTHROPIC_BASE_URL=http://127.0.0.1:9` for unreachable).

Web: `web/src/services/tts/` (`HybridTtsEngine` = neural `ServerTtsEngine` with per-sentence Web Speech fallback) and `web/src/services/voice/` (capture worklet, uplink, push-to-talk controller, Silero VAD via `@ricky0123/vad-web`, `voiceAutomation.ts` for interrupt + wake). Self-echo guard (Herald hearing itself through speakers; WKWebView never cancels our WebAudio playback): `services/voice/echoGuard.ts` (`SpokenLog`: what was queued/played in the last 10 s, fed by wrapping the TTS engine) drops transcripts that fuzzy-match it (`echoMatch.ts`, byte-identical to `daemon/src/herald/voice/echo-match.ts`, mirror-tested); barge-in only stops Herald once a quick transcript of what the VAD heard is not echo, plus a 600 ms tail after speech; `voiceLoopBreaker.ts` pauses hands-off auto-send after >3 sends in 20 s with no interaction ("Paused — possible echo"); "Interrupt by talking" defaults OFF unless headphones are detected (`headphones.ts`); the daemon ignores a voice `herald_send` that replays its last two replies (benign `{ ignored: 'echo' }` ack) using the strict `isLikelyTextEcho` (5+ content words, 80 % in order within one close span, never a question or an unsaid command word, never with `gesture: true`); the web uses the same strict rule for push-to-talk / hotkey / trigger captures, the looser `isLikelyEcho` only for hands-off ones. VAD assets (worklet, model, ORT wasm) are emitted under `<base>vad/` by the `herald-vad-assets` plugin in `web/vite.config.ts`; never load them from a CDN. Settings live in the Herald panel's overflow menu (Voice / Voice input). Custom wake word later: train an openWakeWord model, set `HERALD_WAKE_MODELS=/path/hey_herald.onnx`, add its spellings to `WAKE_NAMES` in `daemon/src/herald/voice/wake-phrase.ts`.

Volume and stop: Herald's own volume per device (`web/src/services/tts/volume.ts`, localStorage `herald_volume`: voice 0-150 %, tones own level or following the voice; Gaming profile 80 %, others 100 %, applied when a profile is picked) is a gain inside the audio graph (voice bus / tone bus -> playback bus -> output clamp; the AEC reference is the clamp's output, i.e. exactly what plays). Slider in the main menu, tones in Advanced, tray submenu on desktop, voice "louder" / "quieter" / "softer" / "volume up|down" / "volume 50" (whole utterance, 15 % steps, said back at the new level). In the Windows volume mixer the app's audio is listed as "Microsoft Edge WebView2". STOP (voice "stop", Esc anywhere in the app, the stop shortcut, tray Stop speaking, the orb's stop button, the AHK `stop_key`) = `stopCommand` -> `planStop` (`fleetSpeaking.ts`): quiet here, and `herald_stop_speaking` to the hub whenever another device is the known speaker or this one was not speaking. Holding hold-to-talk while Herald speaks stops it on key-down, then listens.

Audio layer (echo cancellation, devices; `web/src/services/voice/`): ONE AudioContext (`audioGraph.ts`) carries everything Herald plays (TTS via `WebAudioSink`, chimes) through a playback bus that is the reference of an in-graph WebRTC AEC3 echo canceller (`aec/aecWorklet.ts` + `aec/aecCore.ts`, `@ennuicastr/webrtcaec3.js`; the page fetches the local `.wasm` and hands the bytes to the worklet; the `herald-aec-strip` worker plugin in `vite.config.ts` drops the glue's unusable embedded base64 copy). The mic is opened RAW (browser AEC/NS/AGC off) when the canceller runs, and always passes the AEC worklet (bypassed but still measuring when the browser/platform cancels) into a cleaned bus that capture, VAD and wake hang off, so a mic switch never interrupts them. Detection (VAD) listens to the CLEANED mic; talk-over transcripts and the wake stream use a time-aligned RAW tap (`rawTap.ts`), because AEC3's suppressor clamps the user during double-talk. `audioEnvironment.ts` implements the shared contract (`getAudioEnvironment`, `onAudioEnvironmentChange`, `measureEchoSuppression` = playback -> cleaned-mic suppression in dB + the real VAD run on the cleaned mic) plus the barge-in decision (`bargeInMode.ts`: 'vad' = instant stop only with measured or passive evidence; transcript-gated otherwise; one false instant stop drops that setup back). `audioDevices.ts` classifies labels / native routes and picks the mic (Bluetooth headset mic replaced by built-in/USB: setting "Use built-in mic with Bluetooth headphones", driven by the phone profile's `micPreference`); a macOS "External Headphones" jack is NOT headphones. Native (`nativeAudio.ts` + `tauri-plugin-herald-native`): route info everywhere (`get_audio_route`, `audioRoute` events on mobile; macOS `system_profiler` / Linux `pactl` in `src/route.rs`); Android captures the mic natively (`start_capture`, VOICE_RECOGNITION on the built-in mic, no SCO) into a `herald-pcm-source` worklet; iOS drops `.allowBluetooth` (HFP) and prefers the built-in mic. Switches: localStorage `herald.aec=off`, `herald.androidNativeAec=1`. Real-device steps: `docs/herald-real-device-checklist.md`.

Diagnostics and logs: Help > Diagnostics (or say "diagnostics"; `components/herald/setup/HeraldDiagnostics.tsx`, store `services/diagnostics.ts`: the voice pipeline writes `diag.*`, hooks `registerDiagnostics(name, fn)`) shows live mic permission/device/level, AEC mode + last ERLE, VAD state, hands-free state + stand-down reason, speaking-elsewhere suppression, wake streaming / last score / last outcome, asset load status, active + speakOn device, hub round trip and (desktop) shortcuts with mode, errors and macOS Input Monitoring; "Copy diagnostics" copies redacted JSON (no tokens, transcripts or audio). The daemon logs (rate limited, `herald/voice/rate-log.ts`) `Herald voice: wake stream start|end ... woke= bestScore=`, `wake detected ... score=` and hands-free on/off/stood-down lines; herald-voice logs `wake: ... detected (score)` and `wake: stream <id> ended, best score` to `~/.cache/herald-voice/voice.log` (`bin/herald-voice logs`; its journal stays empty by design). Hands-free pitfalls fixed 2026-10-01: the voice-event subscription and `herald_handsfree` now follow the Herald hub (`hostId`; with several servers the preferred hub often connects second and `connected` stays true, so wake events went to the old hub's socket and every woken stream was discarded); a VAD misfire after the wake word transcribes instead of dropping; the desktop app keeps listening when hidden by default (`handsFreeInBackground` auto = on for Tauri desktop) and its webview never throttles in the background (`backgroundThrottling: disabled`, WebView2 `CalculateNativeWinOcclusion` off, same args on the overlay window: `WEBVIEW2_ARGS` in `lib.rs`). Floating orb (`desktop/src-tauri/src/overlay.rs`): the window has no menu (`remove_menu()` right after build; Windows/Linux otherwise attach the app menu, which showed as a stuck "Companion File Edit View Window" strip), is denylisted from the window-state plugin, and every update reconciles the window with the LATEST wanted view under one lock (a hide racing the first show's window creation used to leave it visible and empty; the cursor poller hides it as a backstop). Native gate `herald_overlay_set_enabled` (the web's "Show floating orb" for the current profile; tray "Hide floating orb" / "Show floating orb" flips it and sends `herald-native {action:'orb', value}` back). Web `OverlayPresenter` always sends its first view (a reloaded page hides an orb left up), hides an activity unchanged for 2 min, and `heraldSetupStore.reload()` runs after `initStorage()` so a Gaming profile restored from the native store holds from the first frame. Take-control nudge: `services/heraldTakeControlNudge.ts` + `HeraldDeviceBar` ("Use Herald here?", once per session, never switches by itself).

**Production deploy (done 2026-09-30; repeat for updates):** `bin/herald-voice install-unit` (once), `bin/companion install-secrets`, `bin/companion herald-provider anthropic`, `bin/test` (known failures: daemon `usage-tracker`, `get_highlights` in `websocket.test`/`multi-session.test`; web 2 `ServerConnection` tests), `cd daemon && npm run build` (web `npm run build` runs inside `bin/test`; never `build:desktop` into `web/dist`), then one user-approved `COMPANION_ALLOW_RESTART=1 systemctl --user restart companion`. Verify: journal shows `Herald: started ... anthropic` and `Herald voice: service reachable`, new pid owns 9877/9878 (`ss -ltnp`). Production Herald state: `~/.companion/herald/state.json`. Browsers need a hard refresh for the new bundle.

Ports used by Herald's sandbox and voice work (not yet in `/mnt/hexinas/apps/INFRASTRUCTURE.md`; add them there): **9887** herald sandbox (user's), **9888** herald probe sandbox, **9889** herald voice service (127.0.0.1 only), **9890** Tailscale serve HTTPS front for 9887 (tailnet only).

### Stuck-session detection (daemon)
Code in `daemon/src/stuck/` (`signals.ts` pure analysis, `normalize.ts` failure keys / pane reading, `detector.ts` state + guarded captures, `store.ts` settings), handlers in `daemon/src/handlers/stuck.ts`, plan in `plan.md`.
- **Protocol:** `daemon/src/stuck/protocol.ts` is mirrored byte-for-byte by `web/src/types/stuck.ts` (mirror test). Requests `stuck_list` / `stuck_snooze` / `stuck_dismiss` / `stuck_ask` / `stuck_interrupt` / `stuck_get_settings` / `stuck_set_settings`; GLOBAL event `stuck_update` (full visible list).
- **Deterministic and cheap:** analysis walks the current turn of the parsed transcript (`ToolCall.isError` comes from `tool_result.is_error`; `status` stays `completed`, an `error` status would fire error-detected escalations). Only while working; findings clear on idle / waiting / a new prompt / recovery.
- **Pane captures** (time-based signals only: no_progress, stalled_tool) go through `StuckDetector.capture`: in-flight dedupe per session, our own timeout on top of `defaultCapturePane`'s SIGKILL, liveness against the watcher's live list (no subprocess), at most 2 per tick, >= 2 min apart per session. Never add another capture path.
- **Herald:** one `stuck` inbox item per session (key = session + turn: tones once per turn, own `stuck` tone, never spoken), `[looks stuck]` briefing lines, tools `stuck_sessions` / `snooze_stuck`, banner actions through `relayAsk` and `HeraldService.proposeInterrupt` (echo tier). Quiet hours (escalation config) keep items off the inbox.
- **Settings:** `~/.companion/stuck/settings.json` (`COMPANION_STUCK_STATE_DIR`); snoozes and "not stuck" are memory only.
- **Live test:** the probe with `TMUX_TMPDIR=<short private dir>` and `TMUX` unset sees only an isolated tmux server (socket path must stay under 108 chars); Claude Code blocks `sleep N && cmd`, so make the failing test itself slow.

### Code Review 2.0 (daemon)
Authoritative plan: `docs/code-review-2-plan.md`. Code lives in `daemon/src/review/`, handlers in `daemon/src/handlers/review.ts`.
- **Protocol:** `daemon/src/review/protocol.ts` is mirrored byte-for-byte by `web/src/types/review.ts` (web mirror test enforces it). Change both or neither; only add optional fields.
- **Two sources of truth:** the transcript ledger (`ledger.ts`, async byte-offset JSONL tail, turns + per-edit `structuredPatch` hunks, subagent files attributed via their `.meta.json` `toolUseId`) for turns / chips / live / summaries; git for the net "by file" view (`net-view.ts`: temp-index snapshot of now vs checkpoint snapshot / baseline / HEAD, one tree-to-tree `git diff -M` per repo, unattributed = changed but claimed by no transcript).
- **GitRunner is the ONLY way review code runs git** (`git-runner.ts`): execFile (no shell), SIGKILL timeouts, 8 MB maxBuffer, in-flight dedupe, concurrency 3 + queue 20, per-repo breaker, `config.git=false` honoured, and no pathspecs in argv (it refuses `--`; `add` reads pathspecs from stdin, everything else diffs whole trees and filters in JS). Never add `exec`/shell git calls on a hot path again (fork-bomb history: 3058a0a).
- **No subprocess per `conversation_update`:** watcher events only tail the JSONL (300 ms debounce/session). Git runs when the files view is requested (memo 2 s), on mark/approve (one snapshot per repo), on revert, and once at the end of a turn that ran Bash.
- **Events are GLOBAL** (`review_summary`, `review_reverted`; `review_live` only to connections that sent `review_watch`) with `sessionId` in the payload — a session-scoped broadcast only reaches one pane.
- **State:** `~/.companion/review/state.json` (checkpoints, baselines, polish cache; `COMPANION_REVIEW_STATE_DIR` overrides), revert backups in `~/.companion/review/backups/` (24 h / 200 MB), audit in `~/.companion/audit.log` (`review_revert`, `review_revert_undo`, `review_ask`).
- **Marks must stick:** the web sends a pending mark for the session it was made in (the provider is reused across session switches) with `through` = server `computedAt`; the daemon re-snapshots whenever `through` covers every claimed edit, so unattributed changes clear even if the time cannot move. Unattributed changes are `summary.unattributedFiles`, never `unreviewedFiles`. Ledger scan budgets are per `update()` call, never per ledger lifetime (a lifetime cap froze sessions with 100 MB+ of subagent transcripts).
- **Reverts** refuse in the sandbox (`COMPANION_SANDBOX=1`) by design: test them only in jest temp repos (`daemon/src/review/__tests__/revert.test.ts`).
- **Herald:** `review_changes` tool, risk alerts as inbox items with `review` (resolved by `review_mark_reviewed`), `relayAsk` for "Ask why", `polishGists` for `review_polish_summaries` (metered as Herald usage). `get_session_diff` (response `session_diff`) is a compat shim on the same ledger + one bounded diff.


## Web Client

React + Vite + TypeScript SPA. Connects to multiple daemons simultaneously via WebSocket. Serves as the UI for all platforms (browser, desktop, Android, iOS).

### Key files
- `src/App.tsx` - Screen routing (status | servers | editServer)
- `src/services/ServerConnection.ts` - Single server WS connection
- `src/services/ConnectionManager.ts` - Multi-server orchestrator
- `src/services/storage.ts` - localStorage CRUD for servers
- `src/services/push.ts` - FCM push notification registration
- `src/context/ConnectionContext.tsx` - React context wrapping ConnectionManager
- `src/components/Dashboard.tsx` - Main dashboard (responsive: sidebar on desktop, card list on mobile)
- `src/components/MobileDashboard.tsx` - Mobile-optimized server/session list
- `src/components/SessionView.tsx` - Conversation view with bottom toolbar on mobile
- `src/utils/platform.ts` - Platform detection (browser, Tauri desktop, Tauri mobile)

### Commands
```bash
cd web && npm install
npm run dev             # Vite dev server (proxies WS to localhost:9877)
npm run build           # Production build to web/dist/
npm run typecheck       # Type check only
```

### Serving
The daemon serves `web/dist/` at `http://<host>:9877/web`. After building, restart the daemon or it will pick up the dist directory on next start. During development, use `npm run dev` and access via the Vite dev server directly.

## Desktop / Mobile (Tauri)

Tauri 2.0 wraps the web client as a native app for desktop (Linux, macOS, Windows) and mobile (Android, iOS).

### Key files
- `desktop/src-tauri/tauri.conf.json` - Tauri configuration
- `desktop/src-tauri/src/lib.rs` - Rust entry point, plugin registration
- `desktop/src-tauri/plugins/tauri-plugin-fcm/` - Custom FCM/APNs plugin
- `desktop/scripts/setup-android.sh` - Android project patches (FCM, cleartext, back nav)
- `desktop/google-services.json` - Firebase config (gitignored, place manually)
- `desktop/debug.keystore` - APK signing key (gitignored)

### Commands
```bash
# Desktop
cd desktop && npm run dev       # Dev with hot reload
cd desktop && npm run build     # Release build (.deb, .dmg, etc.)

# Android
cd desktop && cargo tauri android init          # One-time setup
cd desktop && bash scripts/setup-android.sh     # Patch for FCM
cd desktop && npm run android:build              # Build APK (auto-increments versionCode)

# iOS (requires macOS + Xcode)
cd desktop && cargo tauri ios init              # One-time setup
cd desktop && cargo tauri ios build             # Build for device
cd desktop && cargo tauri ios build --export-method app-store-connect  # TestFlight
```

### Native Herald (voice)
- Desktop: `src-tauri/src/herald.rs` registers the Herald global shortcuts (the web layer sends the
  chords via `herald_set_shortcuts`: talk Ctrl+Alt+Space hold, toggle Ctrl+Alt+Shift+H, brief
  Ctrl+Alt+Shift+B, stop Ctrl+Alt+Shift+S; on macOS Ctrl becomes Cmd: ⌘⌥Space, ⌘⌥⇧H, ⌘⌥⇧B,
  ⌘⌥⇧S, never a Control+Option chord (`MAC_NATIVE_CHORDS` in `useNativeHerald.ts`; untouched
  old defaults migrate once, flag `macChords` in `herald_native_prefs`; a failed registration
  shows "could not be registered" with a one-click alternative, `suggestChord`), adds the tray actions (Brief me, Toggle listening,
  Stop speaking, Herald volume submenu, Mute tones), and grants the mic to the app's own origin
  (WebKitGTK / WebView2). It only emits `herald-native` events `{ action, value? }`.
- Passthrough shortcuts (`src-tauri/src/passthrough/`): per shortcut, "Let other apps see this key
  too" (`passthrough: {talk,toggle,brief,stop}`; default ON for hold-to-talk on Windows/macOS so
  Discord Push to Mute on the same chord still works). Such a chord is NOT registered with the
  exclusive plugin; it is observed by a WH_KEYBOARD_LL hook (Windows, own thread + message loop,
  always CallNextHookEx, callback only posts to a channel) or a listen-only CGEventTap (macOS, needs
  Input Monitoring: `herald_request_input_monitoring`). One worker thread runs the pure
  `ChordWatcher` (exact modifiers, release on main key or a modifier, auto-repeat ignored; unit
  tested without the OS). Linux keeps exclusive (X11 XRecord not wired; Wayland unsupported). A
  failed passthrough falls back to exclusive with `passthroughError`. Windows also reports an
  elevated foreground window (`herald-native-status`): an admin game's keys never reach a
  non-elevated hook (run Companion as admin). Cross-check from Linux with check-only shims
  (`llvm-rc` for msvc, fake `cc`/`ar` for aarch64-apple-darwin) + `cargo clippy --target ...`.
- Mobile: `src-tauri/plugins/tauri-plugin-herald-native/` (Kotlin + Swift): earbud play-pause ->
  plugin event `media` `{ action: 'toggle' }`, `set_media_session`, `set_audio_focus` (ducking).
- Web: `web/src/services/nativeBridge.ts` + `web/src/hooks/useNativeHerald.ts` route all of it to
  the existing push-to-talk / remote-trigger handlers; `nativePlatform()` in `utils/platform.ts`
  gates it. Mic permissions: `setup-android.sh` (RECORD_AUDIO), `setup-ios.sh`
  (NSMicrophoneUsageDescription), `src-tauri/Info.plist` + `Entitlements.plist` (macOS).
- CI: pushing a `native/**` branch runs `release.yml` as an artifact-only build (no TestFlight, no
  release, no tag needed).

### Desktop signing + auto-update
- **Version:** `1.0.<git commit count>` from `desktop/scripts/desktop-version.cjs` (overlay `src-tauri/desktop-version.conf.json`, used by `npm run build`; CI needs `fetch-depth: 0`). No tags.
- **Updater:** `src-tauri/src/updater.rs` (startup + every 6h, background download, tray "Restart to update", install on quit). Feed: `https://dev.cush.rocks/updates/stable/latest.json`, served by the daemon from `~/.companion/updates` (`daemon/src/update-feed.ts`; `COMPANION_UPDATES_DIR` overrides). Linux updates only the AppImage; deb installs and dev builds never self-update.
- **Publish:** `bin/companion publish-update --run <id|latest>` (CI `updater-*` artifacts) or `--from <dir>`; verifies every signature against `plugins.updater.pubkey` first.
- **Keys:** `bin/desktop-signing` (`csr`, `import-devid <.cer>`, `updater-keygen`, `status`). Private material lives in `~/.companion/signing` + GH secrets + `inf://prod/companion/*`. Rotating the updater key strands installed apps.
- **macOS:** with `APPLE_DEVID_CERT_P12_B64`/`APPLE_DEVID_CERT_PASSWORD` set, CI signs with Developer ID (hardened runtime; Tauri signs only), then `desktop/scripts/macos-notarize.sh` notarizes + staples the app (retried submit, polling in rounds that survive network blips and a slow Apple queue, up to 3 h), re-packs + re-signs the updater `.app.tar.gz`, rebuilds the dmg from the stapled app, notarizes + staples the dmg, and logs `codesign`/`spctl`; otherwise ad-hoc.

### Android in-app updates (sideload)
`bin/companion publish-update --apk <signed.apk>` writes `<feed>/stable/android.json` (`versionCode`, `versionName`, `url`, `sha256`, `size`, `certSha256`) + `Companion_<versionName>_android-<versionCode>.apk` (helpers + tests: `daemon/scripts/android-feed.js`, `daemon/__tests__/android-feed.test.ts`); it refuses an older-or-equal versionCode and a different signing certificate. The app (`web/src/hooks/useAndroidUpdater.ts`, `components/AndroidUpdateBanner.tsx`) checks on launch + every 6 h and shows "Update available (1.0.N)"; one tap runs `tauri-plugin-herald-native` `app_update_install` (`ApkUpdater.kt`: download to cache/updates, sha256, PackageManager check of package + versionCode + SAME signing certs (`UpdateChecks.kt`, JVM tests: `./gradlew :tauri-plugin-herald-native:testReleaseUnitTest` in `src-tauri/gen/android`), then the system installer via the app FileProvider; the user always confirms). Without "Install unknown apps" it deep-links to that setting. Manifest bits (REQUEST_INSTALL_PACKAGES, FileProvider `cache/updates`) come from `setup-android.sh`. versionName = `1.0.<commit count>` (`android-version.cjs`), like desktop. iOS is untouched.

### APK Signing
```bash
apksigner sign --ks desktop/debug.keystore --ks-pass pass:android --key-pass pass:android \
  --out /tmp/companion-tauri.apk \
  desktop/src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release-unsigned.apk
```

## Conversation Parser

The JSONL conversation parser has been extracted into a standalone package at `/home/hexi/local/src/claude-conversation-parser/`. The daemon still has its own copy in `daemon/src/parser.ts` (not yet wired to the package). When making parser changes, consider syncing to the standalone package.

## MCP Server (companion-remote)

Lives at `mcp/`. Exposes cross-daemon dispatch tools (`remote_list_servers`, `remote_read`, `remote_get_conversation`, `remote_dispatch`, `remote_send_input`, `remote_cancel`, `remote_exec`, `remote_write`) over stdio MCP. Consumed by any Claude Code session that registers it with `claude mcp add --scope user companion-remote -- node /home/hexi/local/src/companion/mcp/dist/index.js`.

Build: `cd mcp && npm install && npm run build`. Rebuild after changes — Claude Code re-invokes the stdio binary per session, so the next session picks up new output.

Full setup and tool reference: `mcp/README.md`. Daemon-side capability enablement (`remote_capabilities`) is covered in the Daemon config section above; flip caps per-host with `bin/companion enable-remote`.

## Architecture

1. User runs the CLI in tmux: `tmux new -s claude && claude`
2. Daemon watches `~/.claude/projects/*.jsonl` for changes
3. Parses conversations, detects when the CLI is waiting for input
4. Broadcasts updates via WebSocket to connected apps
5. App can send text/images back, daemon injects via tmux
6. Escalation: browser notification (immediate) -> push notification (after configurable delay)

## WebSocket Protocol

**Port:** 9877 (default)
**Auth:** Token in `authenticate` message

Message types:
- `authenticate` - Login with token
- `subscribe` - Start receiving updates
- `get_highlights` / `get_full` - Fetch conversation
- `send_input` - Send text to the CLI
- `send_image` - Send image (base64)
- `register_push` - Register FCM token for push notifications

## Troubleshooting

```bash
# Check if daemon is running
sudo systemctl status companion

# View logs
sudo journalctl -u companion -f

# Check config
cat /etc/companion/config.json

# Test WebSocket manually
wscat -c ws://localhost:9877
```

---

## Implementation Patterns

### Adding a Daemon Endpoint

1. Add message handler in `daemon/src/websocket.ts` switch statement:
```typescript
case 'my_endpoint':
  const result = await this.handleMyEndpoint(message.payload);
  this.sendResponse(ws, message.type, result, message.requestId);
  break;
```

2. Add handler method:
```typescript
private async handleMyEndpoint(payload: unknown): Promise<{ success: boolean; payload?: unknown; error?: string }> {
  try {
    // Implementation
    return { success: true, payload: { data: 'result' } };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}
```

3. Call from web client via `connectionManager.sendRequest(serverId, 'my_endpoint', { data })`.

### Adding Types

- **Web types:** `web/src/types/index.ts`
- **Daemon types:** `daemon/src/types.ts`
- Keep types in sync between web and daemon for shared interfaces

### Code Style

- **Colors:** Dark theme - `#111827` (bg), `#1f2937` (card), `#374151` (border), `#f3f4f6` (text), `#9ca3af` (secondary text)
- **Accent colors:** `#3b82f6` (blue), `#10b981` (green), `#f59e0b` (amber), `#ef4444` (red)
- **No emojis** in code unless user requests
- **Functional components** with hooks, no class components
- **localStorage** for persistence in web (with tauri-plugin-store write-through on mobile)
- **Console.log** for daemon logging (gets captured by journalctl)

### Hooks Pattern

Hooks in `web/src/hooks/`:
```typescript
export function useMyHook(param: string) {
  const [state, setState] = useState<MyType | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Setup, subscriptions
    return () => { /* cleanup */ };
  }, [param]);

  const doAction = useCallback(async () => {
    // Action logic
  }, [param]);

  return { state, loading, doAction };
}
```

### Testing Changes

1. **Daemon:** Run `npm run build && node dist/index.js` in `daemon/`
2. **Web:** Run `npm run dev` in `web/`, or `npm run build` for production
3. **Desktop:** Run `npm run dev` in `desktop/`
4. **Android:** `/apk` skill to build, sign, and install
5. **Type check:** `cd web && npx tsc --noEmit`

### Building

- **No builds without explicit user approval**
- APK build: `/apk` skill
- iOS build: `/ios` skill (requires macOS)
- Desktop: `cd desktop && npm run build`

---

## Foreman Mode (MANDATORY)

**You are a foreman. You do NOT do implementation work on the main thread. Ever.**

The main conversation thread is EXCLUSIVELY for: talking with the user, making decisions, giving status updates, and dispatching work. ALL implementation work — file reads, edits, writes, builds, tests, git operations, research — MUST be dispatched to subagents via the Task tool.

### Rules (non-negotiable)

1. **NEVER edit, write, or create files on the main thread.** Dispatch a `general-purpose` agent.
2. **NEVER run builds, tests, or git commands on the main thread.** Dispatch a `Bash` agent.
3. **NEVER do multi-file research on the main thread.** Dispatch an `Explore` agent.
4. **The ONLY tools the main thread should use are:** Task (to dispatch), AskUserQuestion (to clarify), and brief single-file Read/Grep when you need a quick answer to make a decision.
5. **Launch multiple agents in parallel** when tasks don't depend on each other.
6. **Give agents detailed, self-contained prompts** — they can't see our conversation. Include file paths, context, and exact instructions.
7. **Report back concisely** — when agents finish, summarize results to the user. Don't parrot full output.

### Why

The Companion app shows subagents in a real-time dispatch panel. The user can watch agents work while continuing to talk to you. This is the core UX of the app — you staying available while work happens in the background. If you do work on the main thread, the user is blocked waiting for you.

### Agent types for dispatch

- `general-purpose` — Full tool access. Use for: code changes, multi-step implementation, commit flows, anything requiring Read+Edit+Bash.
- `Bash` — Shell commands only. Use for: builds, tests, git operations, installs.
- `Explore` — Read-only codebase exploration. Use for: finding files, understanding architecture, researching patterns.
- `Plan` — Architecture planning. Use for: designing implementation approaches before coding.

### Skill flows (/commit, /apk, etc.)

When a skill is invoked, dispatch the ENTIRE skill flow to a `general-purpose` agent. Pass the full skill instructions as the agent's prompt. Do not execute skill steps on the main thread.

---

## Tracking Files

Four files track the lifecycle of work items:

| File | Purpose |
|------|---------|
| `todo.md` | Quick capture for ideas and tasks. Items are raw, unplanned. |
| `plan.md` | Detailed implementation plans with status, design, file lists, and steps. |
| `FEATURES.md` | Completed features — living changelog of what's been shipped. |
| `backlog.md` | Deferred ideas, long-term research, and items not in the daily workflow. |

**Flow:** `todo.md` (idea) -> `plan.md` (planned -> in-progress -> done) -> `FEATURES.md` (shipped)
**Deferred:** Items moved from `todo.md` to `backlog.md` when not prioritized.

When committing (`/commit`), update all three:
1. Remove completed items from `todo.md`
2. Set status to `done` in `plan.md` (clear done plans when all complete)
3. Add/update entries in `FEATURES.md`
