//! Desktop audio route: what the default output / input really are, beyond the
//! WebView's labels (WKWebView lists no outputs at all).
//!
//! - macOS: `system_profiler SPAudioDataType -json` (transport type per device,
//!   plus the built-in output's current source: "External Headphones" is the
//!   3.5 mm jack, which may be desk speakers, reported as `jack`).
//! - Linux: `pactl -f json` (PulseAudio 16+ / PipeWire): default sink / source,
//!   bus, Bluetooth profile, active port type.
//! - Windows: none (WebView2 labels already name the endpoint form factor).
//!
//! The JSON matches `NativeAudioRoute` in web/src/services/voice/audioDevices.ts.
//! Parsers are pure so they are tested on any platform.
use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Port {
    #[serde(rename = "type")]
    pub kind: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Route {
    pub platform: String,
    pub outputs: Vec<Port>,
    pub inputs: Vec<Port>,
}

fn port(kind: &str, name: &str, profile: Option<&str>) -> Port {
    Port {
        kind: kind.to_string(),
        name: name.to_string(),
        profile: profile.map(str::to_string),
    }
}

fn s<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}

// ---- macOS -----------------------------------------------------------------------

fn mac_kind(transport: &str, source: &str, output: bool) -> &'static str {
    let t = transport.to_ascii_lowercase();
    if t.contains("bluetooth") {
        "bluetooth"
    } else if t.contains("usb") {
        "usb"
    } else if t.contains("hdmi") || t.contains("displayport") || t.contains("thunderbolt") {
        "hdmi"
    } else if t.contains("airplay") {
        "airplay"
    } else if t.contains("virtual") || t.contains("aggregate") {
        "virtual"
    } else if t.contains("builtin") {
        let src = source.to_ascii_lowercase();
        if output {
            // The jack: headphones or desk speakers, CoreAudio cannot tell.
            if src.contains("headphone") || src.contains("line out") {
                "jack"
            } else {
                "builtin-speaker"
            }
        } else if src.contains("external") || src.contains("line in") {
            "wired-headset"
        } else {
            "builtin-mic"
        }
    } else {
        "unknown"
    }
}

/// Parse `system_profiler SPAudioDataType -json`.
pub fn parse_macos(json: &str) -> Option<Route> {
    let v: Value = serde_json::from_str(json).ok()?;
    let groups = v.get("SPAudioDataType")?.as_array()?;
    let mut outputs = Vec::new();
    let mut inputs = Vec::new();
    for g in groups {
        let Some(items) = g.get("_items").and_then(Value::as_array) else {
            continue;
        };
        for d in items {
            let name = s(d, "_name");
            let transport = s(d, "coreaudio_device_transport");
            if s(d, "coreaudio_default_audio_output_device") == "spaudio_yes" {
                let src = s(d, "coreaudio_output_source");
                let kind = mac_kind(transport, src, true);
                let label = if kind == "jack" && !src.is_empty() { src } else { name };
                outputs.push(port(kind, label, None));
            }
            if s(d, "coreaudio_default_audio_input_device") == "spaudio_yes" {
                let src = s(d, "coreaudio_input_source");
                inputs.push(port(mac_kind(transport, src, false), name, None));
            }
        }
    }
    if outputs.is_empty() && inputs.is_empty() {
        return None;
    }
    Some(Route {
        platform: "macos".into(),
        outputs,
        inputs,
    })
}

// ---- Linux (PulseAudio / PipeWire) ----------------------------------------------------

fn pulse_port(dev: &Value, output: bool) -> Port {
    let props = dev.get("properties").cloned().unwrap_or(Value::Null);
    let desc = s(dev, "description");
    let bus = s(&props, "device.bus");
    let form = s(&props, "device.form_factor");
    let profile = s(&props, "api.bluez5.profile");
    let active = s(dev, "active_port");
    let port_type = dev
        .get("ports")
        .and_then(Value::as_array)
        .and_then(|ps| ps.iter().find(|p| s(p, "name") == active))
        .map(|p| s(p, "type").to_ascii_lowercase())
        .unwrap_or_default();
    let name_l = s(dev, "name").to_ascii_lowercase();
    if bus == "bluetooth" || name_l.starts_with("bluez") {
        let prof = if profile.contains("a2dp") {
            Some("a2dp")
        } else if profile.contains("headset") || profile.contains("hfp") || profile.contains("hsp") {
            Some("hfp")
        } else {
            None
        };
        return port("bluetooth", desc, prof);
    }
    if name_l.contains(".monitor") || s(&props, "node.virtual") == "true" || name_l.contains("null") {
        return port("virtual", desc, None);
    }
    if bus == "usb" {
        return port("usb", desc, None);
    }
    let kind = match (port_type.as_str(), form) {
        ("hdmi", _) | (_, "tv") => "hdmi",
        ("headphones", _) | (_, "headphone") => {
            if output {
                "wired-headphones"
            } else {
                "wired-headset"
            }
        }
        ("headset", _) | (_, "headset") => "wired-headset",
        ("speaker", _) | (_, "speaker") | (_, "internal") => {
            if output {
                "builtin-speaker"
            } else {
                "builtin-mic"
            }
        }
        ("mic", _) | (_, "microphone") => "builtin-mic",
        ("line", _) => "jack",
        _ => "unknown",
    };
    port(kind, desc, None)
}

/// Parse `pactl -f json info`, `pactl -f json list sinks`, `pactl -f json list sources`.
pub fn parse_pulse(info: &str, sinks: &str, sources: &str) -> Option<Route> {
    let info: Value = serde_json::from_str(info).ok()?;
    let sinks: Value = serde_json::from_str(sinks).ok()?;
    let sources: Value = serde_json::from_str(sources).ok()?;
    let def_sink = s(&info, "default_sink_name");
    let def_source = s(&info, "default_source_name");
    let find = |list: &Value, name: &str| {
        list.as_array()
            .and_then(|a| a.iter().find(|d| s(d, "name") == name).cloned())
    };
    let outputs: Vec<Port> = find(&sinks, def_sink).map(|d| pulse_port(&d, true)).into_iter().collect();
    let inputs: Vec<Port> = find(&sources, def_source).map(|d| pulse_port(&d, false)).into_iter().collect();
    if outputs.is_empty() && inputs.is_empty() {
        return None;
    }
    Some(Route {
        platform: "linux".into(),
        outputs,
        inputs,
    })
}

// ---- probing ----------------------------------------------------------------------------

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn run(cmd: &str, args: &[&str]) -> Option<String> {
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};
    // Bounded: a hung audio daemon must never hang the app.
    let mut child = Command::new(cmd)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    return None;
                }
                break;
            }
            Ok(None) if start.elapsed() > Duration::from_secs(4) => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(_) => return None,
        }
    }
    let mut out = String::new();
    use std::io::Read;
    child.stdout.take()?.read_to_string(&mut out).ok()?;
    Some(out)
}

/// The current route, or None where it cannot be read (Windows, missing tools).
pub fn current() -> Option<Route> {
    #[cfg(target_os = "macos")]
    {
        return parse_macos(&run("/usr/sbin/system_profiler", &["SPAudioDataType", "-json"])?);
    }
    #[cfg(target_os = "linux")]
    {
        let info = run("pactl", &["-f", "json", "info"])?;
        let sinks = run("pactl", &["-f", "json", "list", "sinks"])?;
        let sources = run("pactl", &["-f", "json", "list", "sources"])?;
        return parse_pulse(&info, &sinks, &sources);
    }
    #[allow(unreachable_code)]
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn macos_speakers_usb_mic() {
        let json = r#"{"SPAudioDataType":[{"_name":"coreaudio_device","_items":[
          {"_name":"Mac mini Speakers","coreaudio_default_audio_output_device":"spaudio_yes","coreaudio_device_transport":"coreaudio_device_type_builtin","coreaudio_output_source":"Mac mini Speakers"},
          {"_name":"Yeti Stereo Microphone","coreaudio_default_audio_input_device":"spaudio_yes","coreaudio_device_transport":"coreaudio_device_type_usb"}]}]}"#;
        let r = parse_macos(json).unwrap();
        assert_eq!(r.outputs, vec![port("builtin-speaker", "Mac mini Speakers", None)]);
        assert_eq!(r.inputs, vec![port("usb", "Yeti Stereo Microphone", None)]);
    }

    #[test]
    fn macos_jack_is_ambiguous_and_airpods_are_bluetooth() {
        let json = r#"{"SPAudioDataType":[{"_name":"coreaudio_device","_items":[
          {"_name":"Mac mini Speakers","coreaudio_default_audio_output_device":"spaudio_yes","coreaudio_device_transport":"coreaudio_device_type_builtin","coreaudio_output_source":"External Headphones"},
          {"_name":"AirPods Pro","coreaudio_default_audio_input_device":"spaudio_yes","coreaudio_device_transport":"coreaudio_device_type_bluetooth"}]}]}"#;
        let r = parse_macos(json).unwrap();
        assert_eq!(r.outputs[0].kind, "jack");
        assert_eq!(r.outputs[0].name, "External Headphones");
        assert_eq!(r.inputs[0].kind, "bluetooth");
        assert!(parse_macos("{}").is_none());
        assert!(parse_macos("not json").is_none());
    }

    #[test]
    fn pulse_bluetooth_a2dp_and_builtin_mic() {
        let info = r#"{"default_sink_name":"bluez_output.AA_BB.1","default_source_name":"alsa_input.pci-0000_00_1f.3.analog-stereo"}"#;
        let sinks = r#"[{"name":"bluez_output.AA_BB.1","description":"WH-1000XM4","properties":{"device.bus":"bluetooth","api.bluez5.profile":"a2dp-sink"},"ports":[],"active_port":null}]"#;
        let sources = r#"[{"name":"alsa_input.pci-0000_00_1f.3.analog-stereo","description":"Built-in Audio Analog Stereo","properties":{"device.bus":"pci","device.form_factor":"internal"},"ports":[{"name":"analog-input-internal-mic","type":"Mic"}],"active_port":"analog-input-internal-mic"}]"#;
        let r = parse_pulse(info, sinks, sources).unwrap();
        assert_eq!(r.outputs, vec![port("bluetooth", "WH-1000XM4", Some("a2dp"))]);
        assert_eq!(r.inputs[0].kind, "builtin-mic");
    }

    #[test]
    fn pulse_headphones_port_and_speaker_port() {
        let info = r#"{"default_sink_name":"alsa_output.pci.analog-stereo","default_source_name":"x"}"#;
        let mk = |port_type: &str| {
            format!(r#"[{{"name":"alsa_output.pci.analog-stereo","description":"Built-in Audio","properties":{{"device.bus":"pci"}},"ports":[{{"name":"p","type":"{port_type}"}}],"active_port":"p"}}]"#)
        };
        let r = parse_pulse(info, &mk("Headphones"), "[]").unwrap();
        assert_eq!(r.outputs[0].kind, "wired-headphones");
        let r = parse_pulse(info, &mk("Speaker"), "[]").unwrap();
        assert_eq!(r.outputs[0].kind, "builtin-speaker");
        let r = parse_pulse(info, &mk("HDMI"), "[]").unwrap();
        assert_eq!(r.outputs[0].kind, "hdmi");
    }
}
