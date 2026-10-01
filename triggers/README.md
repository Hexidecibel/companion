# Herald remote triggers

Fire Herald from anywhere with one key, mouse button or tap, even when no
Companion window has focus (mid-game, in another app, from your phone). The
daemon hands the action to the **active device**: the one you took control
with (Herald header > Take control, optionally pinned), else the device running
hands-free, else the one you used most recently. That device acts on it, with
its tab or window in the background if need be.

| Action   | What happens on the active device                                      |
|----------|------------------------------------------------------------------------|
| `toggle` | Herald talking: stop. Listening: cancel. Otherwise: listen (the best one-button default) |
| `brief`  | Spoken rundown of what is new                                          |
| `listen` | A distinct "remote" tone (three rising notes), mic opens, you ask one question; it ends when you pause (VAD) and is sent as a voice turn. "Stop", "repeat", "shorter" and the other voice commands still work |
| `stop`   | Stop talking and cancel any capture                                    |
| `repeat` | Say the last reply again                                               |
| `claim`  | Make `device` the active device (pinned unless `"pin": false`), nothing else |
| `show`   | Open a session's view and scroll to the question or choice waiting there (else its latest message), with a short "Here's Out4." (a tick in the Gaming profile). Optional `"session": "Out4"`; without it, what Herald last talked about: its newest pending card, else the session in its latest reply, else the newest unheard inbox item. The desktop app comes forward, even in the Gaming profile (you asked to see it) |

`show` never opens a mic and works from anywhere with a valid token.

Any action can carry `"device": "<name>"`: that device is made active first
(pinned unless `"pin": false`), then acts. Set it in each machine's script so
its keys always act on **that** machine's browser or app.

Every remote trigger that opens a mic plays the remote tone on that device
before it listens, so a mic never opens silently (an error tone plays instead
when it cannot open).

## Who may open the mic

`listen`, and `toggle` when it would start listening, are honoured only from a
trusted network: this machine, the LAN (192.168.x, 10.x, 172.16-31.x), the
tailnet (100.64.0.0/10) or the home's own public IP (see below). From anywhere
else `listen` answers **403** (`untrusted_origin`) and `toggle` can only stop or
cancel (it plays the error tone instead of listening). `brief`, `stop`,
`repeat` and `claim` work from anywhere with a valid token. Set
`herald.trigger_public_listen` to `true` to allow listening from anywhere.

How the daemon knows where a request came from:

- Direct (LAN URL, tailnet URL, localhost): the TCP peer address.
- Through HAProxy (`https://dev.cush.rocks`): HAProxy runs on the same host,
  connects from 127.0.0.1 and **sets** `X-Forwarded-For` to the real client
  (it overwrites anything the client sent). The daemon believes
  `X-Forwarded-For` only from a trusted proxy (`herald.trigger_trusted_proxies`,
  default `["127.0.0.1", "::1"]`); a forwarded request from anyone else counts
  as the internet.
- **From home through the public domain:** a PC on the LAN that opens
  `https://dev.cush.rocks` goes out to the router and back in (hairpin NAT),
  so HAProxy sees the home's own public IP, not 192.168.x. List the public
  domain in `herald.trigger_home_hosts` and the daemon resolves it (cached 5
  minutes, follows dynamic-DNS changes) and treats requests from that address
  as home:

  ```bash
  bin/companion herald-set trigger_home_hosts '["dev.cush.rocks"]'   # next restart
  ```

  Only machines behind the home router can appear with that address.

Every trigger is audit-logged with its `network` (`local`, `lan`, `tailnet`,
`home`, `public`), the client address behind the proxy, and the token name.

## The endpoint

```
POST https://<your daemon>/herald/trigger
Authorization: Bearer <trigger token>
Content-Type: application/json

{"action": "toggle"}
```

An empty body means `toggle`; `?action=brief&device=Windows%20PC` (and
`?action=show&session=Out4`) works too. Answers:

| Status | Meaning |
|--------|---------|
| 200 | Delivered: `{"success":true,"action":"toggle","delivered":true}` |
| 400 | Unknown action, or `claim` without `device` |
| 401 | Missing, wrong or revoked trigger token; or a signed request that is stale (over 60 s), replayed or badly signed |
| 403 | `listen` from outside the home network / tailnet (`untrusted_origin`) |
| 404 | `device` names no connected device (`unknown_device`); `show`: `session` names no session (`unknown_session`), or nothing to show (`nothing_to_show`) |
| 409 | No active device: open Companion (Herald) somewhere first; `show`: `session` matches several (`ambiguous_session`, the names are in `error`) |
| 429 | More than 10 triggers in 10 s (`Retry-After` header) |
| 503 | Herald voice is off on that daemon |

The daemon URL used below is `https://dev.cush.rocks` (the production listener on
9878 behind HAProxy, see `/mnt/hexinas/apps/INFRASTRUCTURE.md`). Swap in yours.

## Trigger tokens (one per device)

A trigger token is a separate credential that can **only** fire triggers: it
cannot read sessions, send input or run anything, and over the WebSocket it is
refused every other message. Give each machine its own, so one can be revoked
without touching the others. On the server:

```bash
bin/companion trigger-token create gaming-pc   # prints only the secret file's path + a masked preview
bin/companion trigger-token list               # names, status, secret files
bin/companion trigger-token rotate gaming-pc   # new secret for that device
bin/companion trigger-token revoke gaming-pc   # refused from now on; its secret file is deleted
bin/companion trigger-token migrate            # register the original single token as "default"
bin/companion trigger-token show-path gaming-pc
```

The daemon only stores each token's name and SHA-256 (in
`~/.companion/herald-trigger-tokens.json`, mode 600); the secret itself is in
`~/.companion/herald-triggers/<name>.token` (mode 600) for copying to the
device. The original single token (`~/.companion/herald-trigger.token`) keeps
working as the token named **default** (deprecated: `migrate` registers it so
it shows in `list` and can be revoked by name). Both files are re-read when
they change, so create, rotate and revoke need no restart; a WebSocket session
opened with a token that is later revoked is refused on its next trigger.
Every trigger (and every bad-token attempt) is written to the audit log
(`~/.companion/audit.log`, action `herald_trigger`) with the token's name,
never the token.

Move a token to its machine without pasting it into chat, for example with
cush-tools (then close it straight away):

```bash
cat "$(bin/companion trigger-token show-path gaming-pc 2>/dev/null)" | ~/local/src/cush-tools/bin/exchange herald-trigger --bg
~/local/src/cush-tools/bin/status close herald-trigger
```

### Signed mode (optional)

By default a script sends the token as `Authorization: Bearer` over HTTPS. In
signed mode it never sends the token: each request carries
`X-Herald-Ts` (unix seconds) and `X-Herald-Sig` = hex HMAC-SHA256, keyed with
the token's SHA-256 (as lowercase hex text), over `<ts>.<action>.<device>`
(`device` empty when not set), plus `.<session>` when a `show` names a
session. The daemon refuses it when the clock differs by
more than 60 s, when that signature was already used, or when the device or
action was changed. Turn it on with `signed=true` in the AutoHotkey ini, or
`HERALD_TRIGGER_SIGNED=true` / `~/.config/herald-trigger/signed` for the shell
script. Both machines need a correct clock.

## Devices: names, taking control, pinning

Every browser tab / app that has Herald open is a device with a name
(auto-detected, like "Chrome on Windows" or "Companion app on Android"). Rename
it in the Herald menu > Devices > **Rename this device** (e.g. `Windows PC`,
`Work Mac`): that is the name `device=` in the scripts refers to (case does not
matter). The bar under the Herald header shows which device is active; **Take
control** moves it here, and **Keep on this device** pins it so using another
device does not steal it (only another claim does, or this device going away;
a quick reconnect keeps the pin). The menu's Devices list switches to any
connected device. A device that loses control shows "Now on <device>" and
pauses hands-free until control comes back.

**Before the first trigger:** on each device that should respond, open
Companion, use the Herald mic once (so the browser remembers the microphone
permission) and touch the page. A background tab can open the mic only when
permission was granted before; otherwise you hear a low error tone and see why
the next time you look at it.

## Windows: AutoHotkey + MX Master 3

**At home, in short:** `url=https://dev.cush.rocks`, `token=` the PC's own
trigger token, `device=` this PC's Herald device name. Every key works from
the home network (the server lists `dev.cush.rocks` in
`herald.trigger_home_hosts`, so your PC's trips through the router count as
home). If listen ever answers 403 at home, the server is missing that setting
or your public IP just changed; as a stopgap point `url=` at the server's LAN
address (`http://<server LAN IP>:9878`, plain HTTP on your own network) or its
tailnet name. Away from home only brief / stop / repeat / claim work, and
toggle only stops, by design.

Files: `windows/herald-trigger.ahk`, `windows/herald-trigger.example.ini`.
Default keys: **Ctrl+Alt+Shift+H** = `toggle`, **Ctrl+Alt+Shift+B** = `brief`,
**Ctrl+Alt+Shift+S** = `stop` (stop Herald talking on whichever device speaks).

1. **Install AutoHotkey v2** from <https://www.autohotkey.com> (v2, not v1.1).
2. **Configure.** Copy `herald-trigger.ahk` and `herald-trigger.example.ini` into a
   folder of your own (e.g. `%USERPROFILE%\herald`), rename the ini to
   `herald-trigger.ini`, set `url=https://dev.cush.rocks` and `token=` (this
   PC's trigger token: `bin/companion trigger-token create gaming-pc` on the
   server; the original single token also works). Set `device=` to this PC's Herald device name (e.g. `Windows
   PC`, see Devices above) so the keys always act on this PC; leave it empty to
   act on whichever device is active. Optionally bind `listen_key`, `stop_key`,
   `repeat_key`, `claim_key` (just take control) and `show_key` (open the
   session Herald last talked about; `show_session=Out4` makes it always open
   that session).
   Double-click the script; press Ctrl+Alt+Shift+H with a Companion tab open
   somewhere to test. Errors appear only as a tray tip.
3. **Start with Windows.** Press Win+R, run `shell:startup`, and put a shortcut to
   `herald-trigger.ahk` there. **If your game runs as administrator**, Windows
   blocks keys from a normal-privilege script while the game has focus: instead
   create a Task Scheduler task "At log on" that runs `AutoHotkey64.exe
   "C:\...\herald-trigger.ahk"` with **Run with highest privileges** (and remove
   the startup shortcut).
4. **Map the MX Master 3 gesture button.** Logi Options+ > MX Master 3 > the
   gesture button (thumb) > choose **Keyboard shortcut** instead of Gestures >
   click the recorder and press **Ctrl+Alt+Shift+H**. Do it under **All
   applications** (or also in any per-game profile you use). Options+ sends a
   single tap, not a hold, which is why the button maps to `toggle`: tap to ask,
   tap again to cut Herald off. Map another button to Ctrl+Alt+Shift+B for `brief`
   if you like.
5. **Keep Discord out of the way.** In Discord > Settings > Keybinds, make sure
   push-to-talk (and toggle-mute / deafen, which default to Ctrl+Shift+M /
   Ctrl+Shift+D) is not on Ctrl+Alt+Shift+H / B / S or on the gesture button. Herald
   hears you through the browser, and Discord hears the same mic: with Discord on
   voice activity your question goes to the channel too, so use push-to-talk there
   (and don't hold it while you talk to Herald). Some anti-cheat systems dislike
   AutoHotkey; if a game complains, close the script for that game.

## Windows: Herald and Discord on the same push-to-talk

**The Companion app does this by itself now.** Its system-wide hold-to-talk
(default **Ctrl+Alt+Space**) is a *passthrough* shortcut on Windows and macOS
(Herald menu > Advanced > System-wide shortcuts > "Let other apps see this key
too", on by default for hold-to-talk): Companion watches the keys without
taking them, so Discord bound to the same keys still gets them. Bind Discord's
**Push to Mute** to Ctrl+Alt+Space and holding it mutes you in Discord while
Herald listens. (Exclusive shortcuts, the old behaviour and still the default for
the tap shortcuts, take the keys away from every other app.)

Exceptions, and what to do:

- **Your game runs as administrator.** Windows does not show an elevated
  window's keys to a normal app, so neither Companion nor Discord see the keys
  while that game has focus (Companion's shortcut settings say so when it
  happens). Run Companion as administrator too (and Discord, for Discord's
  keybinds), or use the script below run elevated.
- **You want ONE mouse button for both** (e.g. the MX Master thumb button) or
  you use an older Companion app: use the fallback script below.

### Fallback: `windows/herald-discord-ptt.ahk`

Hold one physical key or mouse button (default **XButton1**, the mouse "back"
thumb button) and the script holds BOTH Herald's hold-to-talk combo
(Ctrl+Alt+Space) and a Discord **Push to Mute** key (**F13**, which no
keyboard has, so it never collides with anything). Release it and both end.
Settings (optional) go in `herald-discord-ptt.ini` next to the script:

```ini
[ptt]
ptt_key=XButton1
herald_mods=^!
herald_key=Space
discord_key=F13
pass_button=false
```

1. Install AutoHotkey v2, put the script in a folder of your own and
   double-click it.
2. **Bind F13 in Discord with bind mode** (you cannot type F13): tray icon >
   **Bind mode** (or run the script with the argument `bind`). In Discord >
   User Settings > Keybinds > **Add a Keybind** > Action **Push to Mute** >
   **Record Keybind**, then press your talk button once: in bind mode the
   script sends only F13, so Discord records F13. Click Stop Recording.
3. In Companion, keep hold-to-talk on Ctrl+Alt+Space (or set `herald_mods` /
   `herald_key` to match yours). The app's passthrough setting does not
   matter here; the script's key presses reach it either way.
4. Logi Options+: leave the thumb button as "Back" (or set it to send the key
   you put in `ptt_key`). Options+ only sends taps for keyboard shortcuts, so
   map the hold to a mouse button the script can see.
5. Start with Windows like the trigger script (`shell:startup`, or a Task
   Scheduler task with **Run with highest privileges** if the game runs as
   administrator).

## Mac: the Companion app's shortcuts

On macOS the desktop app maps Windows' Ctrl to Cmd and never binds a
Control+Option chord (macOS keeps those: Control+Option+Space is the emoji and
symbols picker / next input source):

| Action | macOS | Windows / Linux |
|--------|-------|-----------------|
| Hold to talk | **⌘⌥Space** (Cmd+Option+Space) | Ctrl+Alt+Space |
| Listen / stop (`toggle`) | **⌘⌥⇧H** | Ctrl+Alt+Shift+H |
| Brief me (`brief`) | **⌘⌥⇧B** | Ctrl+Alt+Shift+B |
| Stop speaking (`stop`) | **⌘⌥⇧S** | Ctrl+Alt+Shift+S |

A Mac install that still had the old Ctrl+Option defaults moves to these once,
on first start of this version; shortcuts you changed yourself are kept. Cmd+Option+Space is
Finder's search window on a stock Mac: if it is still bound there, the shortcut
settings say "could not be registered" and offer a free alternative in one
click (Herald menu > Advanced > System-wide shortcuts). Hold-to-talk is a
passthrough shortcut on macOS, which needs **Input Monitoring** (System Settings >
Privacy & Security > Input Monitoring > Companion on, then quit and reopen
Companion); the shortcut settings and Help > Diagnostics show whether it is
allowed and have a button that opens that pane. Without it the shortcut still
works, as an exclusive one.

## Mac: Raycast

Files: `mac/herald-toggle.sh`, `mac/herald-brief.sh`, `mac/herald-claim.sh`,
`mac/herald-show.sh` (Raycast script commands), all calling
`mac/herald-trigger.sh ACTION` (`herald-trigger.sh show [SESSION]` for show).

1. **Token into the Keychain** (prompts, so it never lands in shell history):
   `security add-generic-password -s herald-trigger -a "$USER" -w`
2. **URL and device name:** `mkdir -p ~/.config/herald-trigger && echo https://dev.cush.rocks > ~/.config/herald-trigger/url`,
   then (optional, recommended) `echo "Work Mac" > ~/.config/herald-trigger/device`
   with this Mac's Herald device name, so its hotkeys act on this Mac
   (`HERALD_TRIGGER_PIN=false` in the environment to claim without pinning).
3. **Add the scripts to Raycast:** copy the `mac/` folder somewhere permanent
   (keep the files together, executable), then Raycast > Settings >
   Extensions > **+** > Add Script Directory > that folder. "Herald Toggle",
   "Herald Brief", "Herald Take Control" and "Show Herald's Last Session"
   appear as commands (the last takes an optional session name: leave it
   empty for what Herald last talked about). Test one from Raycast; the result shows as
   a short HUD (the first run may ask to allow Keychain access: choose Always
   Allow).
4. **Hotkeys:** in Raycast Settings > Extensions, select Herald Toggle and set a
   Hotkey. With the Companion desktop app running on this Mac you do not need
   these: the app already owns the macOS defaults below, so give Raycast other
   keys (or none). Without the app, use the same keys the app would:
   **⌘⌥⇧H** (Cmd+Option+Shift+H) for Herald Toggle, **⌘⌥⇧B** for Herald Brief
   and, optionally, **⌘⌥⇧L** for Show Herald's Last Session. Never use
   Control+Option combos: macOS keeps them (Control+Option+Space opens the
   emoji and symbols picker / switches input source).
5. **Mouse button (optional):** Logi Options+ on the Mac can map the gesture (or
   any) button to **Keyboard shortcut** > the Raycast hotkey above.

## Anything else: curl

Stream Deck ("System: Open" / a shell action), iOS Shortcuts ("Get Contents of
URL": method POST, header `Authorization: Bearer <token>`, JSON body
`action` = `toggle`), Home Assistant, a Linux keybinding:

```bash
curl -fsS -X POST -H "Authorization: Bearer $HERALD_TRIGGER_TOKEN" \
  -H 'Content-Type: application/json' -d '{"action":"toggle"}' https://dev.cush.rocks/herald/trigger
```

Add `"device":"Windows PC"` to the JSON to act on (and make active) a specific
device. `mac/herald-trigger.sh` also works on Linux with `HERALD_TRIGGER_URL`,
`HERALD_TRIGGER_TOKEN` (and optionally `HERALD_TRIGGER_DEVICE`) set.

## Over the WebSocket

An authenticated Companion client (the main token) or a socket authenticated
with the trigger token can send `herald_trigger` with `{ "action": "brief" }`
(plus optional `device` / `pin`, and `session` for `show`); it is answered with the same result as the
HTTP call (errors carry `payload.code`: `bad_request`, `rate_limited`,
`no_active_device`, `unknown_device`, `unavailable`, or `forbidden` for anything
other than `herald_trigger` on a trigger-token socket). Companion clients claim
with `herald_claim_device { pin, deviceId? }`, and open a session somewhere with
`herald_show { session?, device? }` (the "show me" voice command; never changes
the active device).
