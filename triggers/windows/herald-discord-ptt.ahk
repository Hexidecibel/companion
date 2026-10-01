; herald-discord-ptt.ahk - ONE button, two push-to-talks. AutoHotkey v2.
;
; Hold the button (default: the mouse thumb "back" button, XButton1) and:
;   - Herald's hold-to-talk combo is held (default Ctrl+Alt+Space): Herald listens;
;   - Discord's Push to Mute key is held (default F13): Discord mutes you, so your
;     teammates never hear what you say to Herald.
; Release it and both end. A held keyboard key's auto-repeat is ignored.
;
; You only need this as a fallback. The Companion desktop app's hold-to-talk
; already lets Discord see the same keys ("Let other apps see this key too",
; on by default on Windows), so Discord Push to Mute on Ctrl+Alt+Space just
; works without any script. Use this script when you want one mouse button for
; both, when your game runs as administrator (run this script elevated too, see
; triggers/README.md), or with an older Companion app.
;
; Settings: herald-discord-ptt.ini next to this script (optional), section [ptt]:
;   ptt_key=XButton1      the physical key or mouse button you hold (AutoHotkey key name)
;   herald_mods=^!        Herald's hold-to-talk modifiers: ^ Ctrl, ! Alt, + Shift, # Win
;   herald_key=Space      ...and its key (Companion: Herald menu > Advanced > System-wide shortcuts)
;   discord_key=F13       Discord's Push to Mute key; empty = Herald only
;   pass_button=false     true = the game also gets the button itself (e.g. "back")
;
; Binding F13 in Discord (no keyboard has an F13 key): run BIND MODE, then let
; this script press F13 for you while Discord is recording:
;   1. Tray icon > "Bind mode" (or run the script with the argument: bind).
;   2. Discord > User Settings > Keybinds > Add a Keybind > Action: Push to Mute >
;      click Record Keybind.
;   3. Press your talk button once: in bind mode the script sends ONLY F13, so
;      Discord records "F13". Click Stop Recording. Bind mode ends by itself.
;
; Nothing is sent anywhere: this script only presses keys on this PC.

#Requires AutoHotkey v2.0
#SingleInstance Force
#UseHook true
InstallKeybdHook()
InstallMouseHook()
Persistent()

A_IconTip := "Herald + Discord push-to-talk"

ReadSetting(key, def) {
  try
    return Trim(IniRead(A_ScriptDir "\herald-discord-ptt.ini", "ptt", key, def))
  catch
    return def
}

global PttKey := ReadSetting("ptt_key", "XButton1")
global HeraldMods := ReadSetting("herald_mods", "^!")
global HeraldKey := ReadSetting("herald_key", "Space")
global DiscordKey := ReadSetting("discord_key", "F13")
global PassButton := StrLower(ReadSetting("pass_button", "false")) = "true"

global Held := false        ; the talk button is down (auto-repeat guard)
global BindMode := false    ; the next press sends only the Discord key
global BindPress := false   ; the current press is a bind-mode press

prefix := (PassButton ? "~" : "") "*"
try {
  Hotkey(prefix PttKey, TalkDown)
  Hotkey(prefix PttKey " up", TalkUp)
} catch as e {
  MsgBox("Could not bind ptt_key=" PttKey ": " e.Message, "Herald push-to-talk", "Iconx")
  ExitApp()
}

A_TrayMenu.Add()
A_TrayMenu.Add("Bind mode: next press sends only " (DiscordKey = "" ? "(no discord_key)" : DiscordKey), (*) => ArmBind())
A_TrayMenu.Add("Release all keys", (*) => ReleaseAll())
OnExit((*) => ReleaseAll())

if (A_Args.Length > 0 && StrLower(A_Args[1]) = "bind")
  ArmBind()

; Modifier key names for Send, in press order.
ModNames() {
  names := []
  for ch in StrSplit(HeraldMods) {
    switch ch {
      case "^": names.Push("Ctrl")
      case "!": names.Push("Alt")
      case "+": names.Push("Shift")
      case "#": names.Push("LWin")
    }
  }
  return names
}

HoldHerald() {
  s := ""
  for name in ModNames()
    s .= "{" name " down}"
  Send("{Blind}" s "{" HeraldKey " down}")
}

ReleaseHerald() {
  s := "{" HeraldKey " up}"
  names := ModNames()
  Loop names.Length
    s .= "{" names[names.Length - A_Index + 1] " up}"
  Send("{Blind}" s)
}

TalkDown(*) {
  global Held, BindMode, BindPress
  if Held  ; auto-repeat of a held keyboard key
    return
  Held := true
  if BindMode {
    BindMode := false
    BindPress := true
    SetTimer(BindTimeout, 0)
    ToolTip()
    if (DiscordKey != "")
      Send("{" DiscordKey " down}")
    return
  }
  ; Discord first, so it is muted before Herald's mic opens.
  if (DiscordKey != "")
    Send("{Blind}{" DiscordKey " down}")
  HoldHerald()
}

TalkUp(*) {
  global Held, BindPress
  if !Held
    return
  Held := false
  if BindPress {
    BindPress := false
    if (DiscordKey != "")
      Send("{" DiscordKey " up}")
    TrayTip("Sent " DiscordKey ". In Discord click Stop Recording.", "Herald push-to-talk", "Iconi Mute")
    return
  }
  ReleaseHerald()
  if (DiscordKey != "")
    Send("{Blind}{" DiscordKey " up}")
}

ArmBind() {
  global BindMode
  if (DiscordKey = "") {
    TrayTip("Set discord_key in herald-discord-ptt.ini first.", "Herald push-to-talk", "Iconx Mute")
    return
  }
  BindMode := true
  ToolTip("Bind mode: in Discord click Record Keybind, then press " PttKey " once (sends " DiscordKey ").")
  SetTimer(BindTimeout, -60000)
}

BindTimeout() {
  global BindMode
  BindMode := false
  ToolTip()
}

ReleaseAll() {
  global Held, BindPress
  Held := false
  BindPress := false
  ReleaseHerald()
  if (DiscordKey != "")
    Send("{" DiscordKey " up}")
}
