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
| `listen` | Earcon, mic opens, you ask one question; it ends when you pause (VAD) and is sent as a voice turn. "Stop", "repeat", "shorter" and the other voice commands still work |
| `stop`   | Stop talking and cancel any capture                                    |
| `repeat` | Say the last reply again                                               |
| `claim`  | Make `device` the active device (pinned unless `"pin": false`), nothing else |

Any action can carry `"device": "<name>"`: that device is made active first
(pinned unless `"pin": false`), then acts. Set it in each machine's script so
its keys always act on **that** machine's browser or app.

## The endpoint

```
POST https://<your daemon>/herald/trigger
Authorization: Bearer <trigger token>
Content-Type: application/json

{"action": "toggle"}
```

An empty body means `toggle`; `?action=brief&device=Windows%20PC` works too. Answers:

| Status | Meaning |
|--------|---------|
| 200 | Delivered: `{"success":true,"action":"toggle","delivered":true}` |
| 400 | Unknown action, or `claim` without `device` |
| 401 | Missing or wrong trigger token |
| 404 | `device` names no connected device (`unknown_device`) |
| 409 | No active device: open Companion (Herald) somewhere first |
| 429 | More than 10 triggers in 10 s (`Retry-After` header) |
| 503 | Herald voice is off on that daemon |

The daemon URL used below is `https://dev.cush.rocks` (the production listener on
9878 behind HAProxy, see `/mnt/hexinas/apps/INFRASTRUCTURE.md`). Swap in yours.

## The trigger token

A separate credential that can **only** fire triggers: it cannot read sessions,
send input or run anything, and over the WebSocket it is refused every other
message. On the server:

```bash
bin/companion trigger-token create      # once; prints only the path + a masked preview
bin/companion trigger-token rotate      # replace it (update every trigger machine)
bin/companion trigger-token show-path   # where it lives (~/.companion/herald-trigger.token, mode 600)
```

The daemon re-reads the file when it changes, so create and rotate need no
restart. Every trigger (and every bad-token attempt) is written to the audit log
(`~/.companion/audit.log`, action `herald_trigger`), never with the token.

Move the token to another machine without pasting it into chat, for example
with cush-tools (then close it straight away):

```bash
cat "$(bin/companion trigger-token show-path 2>/dev/null)" | ~/local/src/cush-tools/bin/exchange herald-trigger --bg
~/local/src/cush-tools/bin/status close herald-trigger
```

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

Files: `windows/herald-trigger.ahk`, `windows/herald-trigger.example.ini`.
Default keys: **Ctrl+Alt+Shift+H** = `toggle`, **Ctrl+Alt+Shift+B** = `brief`.

1. **Install AutoHotkey v2** from <https://www.autohotkey.com> (v2, not v1.1).
2. **Configure.** Copy `herald-trigger.ahk` and `herald-trigger.example.ini` into a
   folder of your own (e.g. `%USERPROFILE%\herald`), rename the ini to
   `herald-trigger.ini`, set `url=https://dev.cush.rocks` and `token=` (the
   trigger token). Set `device=` to this PC's Herald device name (e.g. `Windows
   PC`, see Devices above) so the keys always act on this PC; leave it empty to
   act on whichever device is active. Optionally bind `listen_key`, `stop_key`,
   `repeat_key`, `claim_key` (just take control).
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
   Ctrl+Shift+D) is not on Ctrl+Alt+Shift+H / B or on the gesture button. Herald
   hears you through the browser, and Discord hears the same mic: with Discord on
   voice activity your question goes to the channel too, so use push-to-talk there
   (and don't hold it while you talk to Herald). Some anti-cheat systems dislike
   AutoHotkey; if a game complains, close the script for that game.

## Mac: Raycast

Files: `mac/herald-toggle.sh`, `mac/herald-brief.sh`, `mac/herald-claim.sh`
(Raycast script commands), all calling `mac/herald-trigger.sh ACTION`.

1. **Token into the Keychain** (prompts, so it never lands in shell history):
   `security add-generic-password -s herald-trigger -a "$USER" -w`
2. **URL and device name:** `mkdir -p ~/.config/herald-trigger && echo https://dev.cush.rocks > ~/.config/herald-trigger/url`,
   then (optional, recommended) `echo "Work Mac" > ~/.config/herald-trigger/device`
   with this Mac's Herald device name, so its hotkeys act on this Mac
   (`HERALD_TRIGGER_PIN=false` in the environment to claim without pinning).
3. **Add the scripts to Raycast:** copy the `mac/` folder somewhere permanent
   (keep the three files together, executable), then Raycast > Settings >
   Extensions > **+** > Add Script Directory > that folder. "Herald Toggle",
   "Herald Brief" and "Herald Take Control" appear as commands. Test one from Raycast; the result shows as
   a short HUD (the first run may ask to allow Keychain access: choose Always
   Allow).
4. **Hotkeys:** in Raycast Settings > Extensions, select Herald Toggle and set a
   Hotkey (e.g. **Ctrl+Opt+Shift+H**); likewise Herald Brief (Ctrl+Opt+Shift+B).
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
(plus optional `device` / `pin`); it is answered with the same result as the
HTTP call (errors carry `payload.code`: `bad_request`, `rate_limited`,
`no_active_device`, `unknown_device`, `unavailable`, or `forbidden` for anything
other than `herald_trigger` on a trigger-token socket). Companion clients claim
with `herald_claim_device { pin, deviceId? }`.
