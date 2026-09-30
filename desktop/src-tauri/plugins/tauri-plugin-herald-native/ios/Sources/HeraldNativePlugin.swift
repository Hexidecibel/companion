import AVFoundation
import MediaPlayer
import SwiftRs
import Tauri
import UIKit
import WebKit

class ActiveArgs: Decodable {
  let active: Bool
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
class HeraldNativePlugin: Plugin {
  private var mediaSessionOn = false
  private var targets: [(MPRemoteCommand, Any)] = []

  @objc public override func load(webview: WKWebView) {
    applyCategory()
  }

  private func applyCategory() {
    var options: AVAudioSession.CategoryOptions = [.defaultToSpeaker, .allowBluetooth, .allowBluetoothA2DP]
    if !mediaSessionOn {
      options.insert(.duckOthers)
    }
    do {
      try AVAudioSession.sharedInstance().setCategory(.playAndRecord, mode: .default, options: options)
    } catch {
      Logger.error("[HeraldNative] audio session category: \(error)")
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
