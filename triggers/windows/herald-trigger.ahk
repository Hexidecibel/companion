; herald-trigger.ahk - fire Herald remote triggers from anywhere on Windows,
; including mid-game. AutoHotkey v2.
;
; Reads its settings from herald-trigger.ini next to this script (copy
; herald-trigger.example.ini). Environment variables override the ini:
;   HERALD_TRIGGER_URL    e.g. https://dev.cush.rocks
;   HERALD_TRIGGER_TOKEN  the trigger token (bin/companion trigger-token create)
;   HERALD_TRIGGER_DEVICE this machine's Herald device name (optional, see below)
;
; device= (optional): the name this PC's browser / app has in Herald (menu >
; Devices > Rename this device, e.g. "Windows PC"). When set, every trigger
; from this script first makes that device active (pinned unless pin=false),
; so the key always acts on THIS machine. Empty: act on whichever device is
; active. claim_key just takes control, without doing anything else.
;
; Default keys (change them in the ini):
;   Ctrl+Alt+Shift+H  toggle  (Herald talking: stop; listening: cancel; else listen)
;   Ctrl+Alt+Shift+B  brief   (spoken rundown of what is new)
; Optional: listen_key, stop_key, repeat_key, claim_key (needs device=),
;   show_key (open the session Herald last talked about on the active device;
;   show_session= names a fixed session instead, e.g. Out4).
;
; signed=true (optional, off by default): the token is never sent. Each
; request carries X-Herald-Ts + X-Herald-Sig instead (HMAC-SHA256 keyed with
; the token's SHA-256, over "<ts>.<action>.<device>", plus ".<session>" when
; show names one, via Windows CNG), which
; the daemon refuses after 60 s or on reuse. Needs a correct clock (Windows
; time sync is on by default).
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
BindKey("claim_key", "claim", "")
BindKey("show_key", "show", "")

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
  device := EnvGet("HERALD_TRIGGER_DEVICE")
  if (device = "")
    device := read("device")
  return {
    url: RTrim(url, "/"),
    token: token,
    device: device,
    showSession: read("show_session"),
    pin: StrLower(read("pin", "true")) != "false",
    signed: StrLower(read("signed", "false")) = "true",
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
  if (action = "claim" && Cfg.device = "") {
    Notify("claim_key needs device= in herald-trigger.ini", true)
    return
  }
  session := action = "show" ? Cfg.showSession : ""
  body := '{"action":"' action '"'
  if (Cfg.device != "")
    body .= ',"device":"' JsonEscape(Cfg.device) '","pin":' (Cfg.pin ? "true" : "false")
  if (session != "")
    body .= ',"session":"' JsonEscape(session) '"'
  body .= "}"
  try {
    req := ComObject("WinHttp.WinHttpRequest.5.1")
    ; resolve, connect, send, receive
    req.SetTimeouts(Cfg.timeoutMs, Cfg.timeoutMs, Cfg.timeoutMs, Cfg.timeoutMs)
    req.Open("POST", Cfg.url "/herald/trigger", true)
    if (Cfg.signed) {
      ts := DateDiff(A_NowUTC, "19700101000000", "Seconds")
      req.SetRequestHeader("X-Herald-Ts", ts)
      msg := ts "." action "." Cfg.device (session != "" ? "." session : "")
      req.SetRequestHeader("X-Herald-Sig", HmacSha256Hex(Sha256Hex(Cfg.token), msg))
    } else {
      req.SetRequestHeader("Authorization", "Bearer " Cfg.token)
    }
    req.SetRequestHeader("Content-Type", "application/json")
    req.Send(body)
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

; --- signed mode: SHA-256 / HMAC-SHA256 through Windows CNG (bcrypt.dll) ---
Sha256Hex(str) => CngSha256(str, "")
HmacSha256Hex(key, msg) => CngSha256(msg, key)

CngSha256(data, key) {
  d := Utf8(data)
  k := key = "" ? 0 : Utf8(key)
  hAlg := 0, hHash := 0
  ; BCRYPT_ALG_HANDLE_HMAC_FLAG = 0x8
  if DllCall("bcrypt\BCryptOpenAlgorithmProvider", "Ptr*", &hAlg, "WStr", "SHA256", "Ptr", 0, "UInt", k ? 0x8 : 0, "UInt") != 0
    throw Error("BCryptOpenAlgorithmProvider failed")
  out := Buffer(32, 0)
  try {
    if DllCall("bcrypt\BCryptCreateHash", "Ptr", hAlg, "Ptr*", &hHash, "Ptr", 0, "UInt", 0
        , "Ptr", k ? k.buf.Ptr : 0, "UInt", k ? k.len : 0, "UInt", 0, "UInt") != 0
      throw Error("BCryptCreateHash failed")
    try {
      if DllCall("bcrypt\BCryptHashData", "Ptr", hHash, "Ptr", d.buf.Ptr, "UInt", d.len, "UInt", 0, "UInt") != 0
        throw Error("BCryptHashData failed")
      if DllCall("bcrypt\BCryptFinishHash", "Ptr", hHash, "Ptr", out.Ptr, "UInt", 32, "UInt", 0, "UInt") != 0
        throw Error("BCryptFinishHash failed")
    } finally {
      DllCall("bcrypt\BCryptDestroyHash", "Ptr", hHash)
    }
  } finally {
    DllCall("bcrypt\BCryptCloseAlgorithmProvider", "Ptr", hAlg, "UInt", 0)
  }
  hex := ""
  Loop 32
    hex .= Format("{:02x}", NumGet(out, A_Index - 1, "UChar"))
  return hex
}

; UTF-8 bytes of a string: {buf, len} (len excludes the terminating NUL).
Utf8(str) {
  n := StrPut(str, "UTF-8")
  buf := Buffer(n, 0)
  StrPut(str, buf, "UTF-8")
  return {buf: buf, len: n - 1}
}

JsonEscape(s) {
  s := StrReplace(s, "\", "\\")
  return StrReplace(s, '"', '\"')
}

Explain(status, body) {
  ; The daemon answers {"success":false,"error":"...","code":"..."}; show its words.
  if RegExMatch(body, '"error"\s*:\s*"((?:[^"\\]|\\.)*)"', &m)
    return m[1] " (" status ")"
  switch status {
    case 401: return "bad or revoked trigger token, or signed=true with a wrong clock (401)"
    case 403: return "listening is only allowed from your home network or tailnet (403)"
    case 404: return "not found (404): old daemon, no device named as in device=, or (show) no such session / nothing to show"
    case 409: return "no active device: open Companion somewhere (409)"
    case 429: return "too many triggers, slow down (429)"
  }
  return "HTTP " status
}

Notify(msg, isError := false) {
  TrayTip(msg, "Herald", isError ? "Iconx Mute" : "Iconi Mute")
  SetTimer(() => TrayTip(), -4000)
}
