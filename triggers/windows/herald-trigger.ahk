; herald-trigger.ahk - fire Herald remote triggers from anywhere on Windows,
; including mid-game. AutoHotkey v2.
;
; Reads its settings from herald-trigger.ini next to this script (copy
; herald-trigger.example.ini). Environment variables override the ini:
;   HERALD_TRIGGER_URL    e.g. https://dev.cush.rocks
;   HERALD_TRIGGER_TOKEN  the trigger token (bin/companion trigger-token create)
;
; Default keys (change them in the ini):
;   Ctrl+Alt+Shift+H  toggle  (Herald talking: stop; listening: cancel; else listen)
;   Ctrl+Alt+Shift+B  brief   (spoken rundown of what is new)
; Optional: listen_key, stop_key, repeat_key.
;
; Errors show as a tray tip only; nothing ever steals focus from the game.
; The token is never shown.

#Requires AutoHotkey v2.0
#SingleInstance Force
#UseHook true
InstallKeybdHook()
Persistent()

A_IconTip := "Herald trigger"
global Cfg := LoadConfig()
global LastFire := Map()

BindKey("toggle_key", "toggle", "^!+h")
BindKey("brief_key", "brief", "^!+b")
BindKey("listen_key", "listen", "")
BindKey("stop_key", "stop", "")
BindKey("repeat_key", "repeat", "")

if (Cfg.url = "" || Cfg.token = "")
  Notify("Herald trigger is not configured: set url and token in herald-trigger.ini", true)

LoadConfig() {
  ini := A_ScriptDir "\herald-trigger.ini"
  read(key, def := "") {
    try
      return Trim(IniRead(ini, "herald", key, def))
    catch
      return def
  }
  url := EnvGet("HERALD_TRIGGER_URL")
  if (url = "")
    url := read("url")
  token := EnvGet("HERALD_TRIGGER_TOKEN")
  if (token = "")
    token := read("token")
  timeout := read("timeout_ms", "4000")
  return {
    url: RTrim(url, "/"),
    token: token,
    timeoutMs: IsInteger(timeout) ? Integer(timeout) : 4000,
    ini: ini,
    readKey: read,
  }
}

BindKey(name, action, def) {
  key := Cfg.readKey.Call(name, def)
  if (key = "")
    return
  try
    Hotkey(key, (*) => Fire(action))
  catch as e
    Notify("Could not bind " name " (" key "): " e.Message, true)
}

Fire(action) {
  ; Debounce: a key auto-repeat or a double tap must not become two triggers.
  now := A_TickCount
  if (LastFire.Has(action) && now - LastFire[action] < 400)
    return
  LastFire[action] := now

  if (Cfg.url = "" || Cfg.token = "") {
    Notify("Herald trigger is not configured (herald-trigger.ini)", true)
    return
  }
  try {
    req := ComObject("WinHttp.WinHttpRequest.5.1")
    ; resolve, connect, send, receive
    req.SetTimeouts(Cfg.timeoutMs, Cfg.timeoutMs, Cfg.timeoutMs, Cfg.timeoutMs)
    req.Open("POST", Cfg.url "/herald/trigger", true)
    req.SetRequestHeader("Authorization", "Bearer " Cfg.token)
    req.SetRequestHeader("Content-Type", "application/json")
    req.Send('{"action":"' action '"}')
    if !req.WaitForResponse(Ceil(Cfg.timeoutMs / 1000) + 1) {
      Notify("Herald did not answer in time (" action ")", true)
      return
    }
    status := req.Status
    if (status = 200)
      return
    Notify("Herald " action ": " Explain(status, req.ResponseText), true)
  } catch as e {
    Notify("Herald " action ": cannot reach " Cfg.url " (" e.Message ")", true)
  }
}

Explain(status, body) {
  ; The daemon answers {"success":false,"error":"...","code":"..."}; show its words.
  if RegExMatch(body, '"error"\s*:\s*"((?:[^"\\]|\\.)*)"', &m)
    return m[1] " (" status ")"
  switch status {
    case 401: return "bad trigger token (401)"
    case 404: return "this daemon has no /herald/trigger yet (404)"
    case 409: return "no active device: open Companion somewhere (409)"
    case 429: return "too many triggers, slow down (429)"
  }
  return "HTTP " status
}

Notify(msg, isError := false) {
  TrayTip(msg, "Herald", isError ? "Iconx Mute" : "Iconi Mute")
  SetTimer(() => TrayTip(), -4000)
}
