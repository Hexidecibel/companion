import AVFoundation
import MediaPlayer
import SwiftRs
import Tauri
import UIKit
import WebKit

class ActiveArgs: Decodable {
  let active: Bool
}

class PreferArgs: Decodable {
  let on: Bool
}

/// Matches NativePort / NativeAudioRoute in web/src/services/voice/audioDevices.ts.
struct RoutePort: Encodable {
  let type: String
  let name: String
  let profile: String?
}

struct AudioRoute: Encodable {
  let platform = "ios"
  let outputs: [RoutePort]
  let inputs: [RoutePort]
  let availableInputs: [RoutePort]
}

/// Herald voice glue for iOS / iPadOS.
///
/// Audio session: `.playAndRecord` (the mic is used) routed to the speaker or
/// Bluetooth, playing through the silent switch. By default it also ducks other
/// audio: the session is activated only while Herald speaks
/// (`setAudioFocus`), so music dips under Herald and comes back afterwards.
///
/// Earbud button (`setMediaSession`): iOS sends remote commands (AirPods
/// play/pause, headset button) only to the "Now Playing" app, and an app that
/// mixes or ducks can never be that. So while the earbud control is on, the
/// session is non-mixable: Herald speaking pauses other audio instead of ducking
/// it, and play/pause becomes a `media` plugin event `{ action: "toggle" }`
/// (run like a remote trigger `toggle`). It works while Companion is in the
/// foreground; iOS suspends the app soon after it goes to the background.
///
/// Bluetooth (`setPreferBuiltInMic`, on by default: the setting "Use built-in
/// mic with Bluetooth headphones"): `.allowBluetooth` lets iOS route the MIC to
/// a Bluetooth headset, which forces HFP (a phone call: mono, narrowband) on the
/// output too. Without it, and with the built-in mic preferred, AirPods keep
/// playing in A2DP (`.allowBluetoothA2DP`) while Herald listens on the iPhone /
/// iPad mic. Mode stays `.default`: `.voiceChat` would force HFP back on and its
/// echo canceller does not see WebKit's playback anyway (the page cancels echo
/// itself, in its audio graph).
///
/// Route changes (headphones in / out, AirPods connecting) go to the page as
/// `audioRoute` events; `getAudioRoute` returns the current one.
class HeraldNativePlugin: Plugin {
  private var mediaSessionOn = false
  private var preferBuiltInMic = true
  private var targets: [(MPRemoteCommand, Any)] = []
  private var routeObserver: NSObjectProtocol?

  @objc public override func load(webview: WKWebView) {
    applyCategory()
    routeObserver = NotificationCenter.default.addObserver(
      forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main
    ) { [weak self] _ in
      self?.routeChanged()
    }
  }

  deinit {
    if let o = routeObserver { NotificationCenter.default.removeObserver(o) }
  }

  private func applyCategory() {
    var options: AVAudioSession.CategoryOptions = [.defaultToSpeaker, .allowBluetoothA2DP]
    if !preferBuiltInMic {
      options.insert(.allowBluetooth)
    }
    if !mediaSessionOn {
      options.insert(.duckOthers)
    }
    do {
      try AVAudioSession.sharedInstance().setCategory(.playAndRecord, mode: .default, options: options)
    } catch {
      Logger.error("[HeraldNative] audio session category: \(error)")
    }
    applyPreferredInput()
  }

  /// Listen on the built-in mic when preferred (WebKit's capture follows the session's input).
  private func applyPreferredInput() {
    let session = AVAudioSession.sharedInstance()
    if preferBuiltInMic {
      if let mic = session.availableInputs?.first(where: { $0.portType == .builtInMic }),
        session.preferredInput?.portType != .builtInMic
      {
        do {
          try session.setPreferredInput(mic)
        } catch {
          Logger.error("[HeraldNative] preferred input: \(error)")
        }
      }
    } else if session.preferredInput != nil {
      try? session.setPreferredInput(nil)
    }
  }

  private func routeChanged() {
    // A headset came or went: iOS may have reset the preferred input.
    applyPreferredInput()
    try? trigger("audioRoute", data: currentRoute())
  }

  private func port(_ p: AVAudioSessionPortDescription) -> RoutePort {
    var type = "unknown"
    var profile: String? = nil
    switch p.portType {
    case .builtInSpeaker, .carAudio: type = "builtin-speaker"
    case .builtInReceiver: type = "builtin-receiver"
    case .builtInMic: type = "builtin-mic"
    case .headphones: type = "wired-headphones"
    case .headsetMic: type = "wired-headset"
    case .bluetoothA2DP:
      type = "bluetooth"
      profile = "a2dp"
    case .bluetoothHFP:
      type = "bluetooth"
      profile = "hfp"
    case .bluetoothLE:
      type = "bluetooth"
      profile = "le"
    case .usbAudio: type = "usb"
    case .HDMI: type = "hdmi"
    case .airPlay: type = "airplay"
    case .lineOut, .lineIn: type = "jack"
    default:
      // iOS 14+ names, by raw value (deployment target is iOS 13).
      switch p.portType.rawValue {
      case "DisplayPort": type = "hdmi"
      case "Virtual": type = "virtual"
      default: break
      }
    }
    return RoutePort(type: type, name: p.portName, profile: profile)
  }

  private func currentRoute() -> AudioRoute {
    let session = AVAudioSession.sharedInstance()
    let route = session.currentRoute
    return AudioRoute(
      outputs: route.outputs.map(port),
      inputs: route.inputs.map(port),
      availableInputs: (session.availableInputs ?? []).map(port)
    )
  }

  @objc public func getAudioRoute(_ invoke: Invoke) throws {
    invoke.resolve(currentRoute())
  }

  @objc public func setPreferBuiltInMic(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(PreferArgs.self)
    DispatchQueue.main.async {
      if self.preferBuiltInMic != args.on {
        self.preferBuiltInMic = args.on
        self.applyCategory()
      }
      invoke.resolve()
    }
  }

  @objc public func setAudioFocus(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(ActiveArgs.self)
    let session = AVAudioSession.sharedInstance()
    if args.active {
      try? session.setActive(true)
    } else if !mediaSessionOn {
      // Let ducked audio come back. Fails harmlessly while the mic is still
      // running (hands-free), which is what we want then anyway.
      try? session.setActive(false, options: .notifyOthersOnDeactivation)
    }
    invoke.resolve()
  }

  @objc public func setMediaSession(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(ActiveArgs.self)
    DispatchQueue.main.async {
      self.mediaSession(args.active)
    }
    invoke.resolve()
  }

  private func mediaSession(_ on: Bool) {
    if on == mediaSessionOn { return }
    mediaSessionOn = on
    applyCategory()
    let center = MPRemoteCommandCenter.shared()
    if on {
      UIApplication.shared.beginReceivingRemoteControlEvents()
      for command in [center.togglePlayPauseCommand, center.playCommand, center.pauseCommand] {
        command.isEnabled = true
        let token = command.addTarget { [weak self] _ in
          self?.emitToggle()
          return .success
        }
        targets.append((command, token))
      }
      MPNowPlayingInfoCenter.default().nowPlayingInfo = [
        MPMediaItemPropertyTitle: "Herald",
        MPMediaItemPropertyArtist: "Companion",
      ]
      try? AVAudioSession.sharedInstance().setActive(true)
    } else {
      for (command, token) in targets {
        command.removeTarget(token)
      }
      targets.removeAll()
      MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
      UIApplication.shared.endReceivingRemoteControlEvents()
    }
  }

  private func emitToggle() {
    trigger("media", data: ["action": "toggle"])
  }
}

@_cdecl("init_plugin_herald_native")
func initPlugin() -> Plugin {
  return HeraldNativePlugin()
}
