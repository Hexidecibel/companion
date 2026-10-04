//! Desktop mDNS browse for `_companion._tcp` (pairing: "Nearby" servers).
//! Mobile uses Android NSD / iOS NWBrowser in the native plugins; all three
//! return the same shape: `{ name, host, addresses, port, txt }`.

use serde_json::{json, Map, Value};

pub const SERVICE_TYPE: &str = "_companion._tcp.local.";

/// "Companion on box._companion._tcp.local." -> "Companion on box".
pub fn instance_name(fullname: &str) -> String {
    fullname
        .strip_suffix(SERVICE_TYPE)
        .map(|s| s.trim_end_matches('.'))
        .unwrap_or(fullname)
        .replace("\\032", " ")
        .replace("\\ ", " ")
}

/// One discovered service as JSON for the web layer.
pub fn service_json(fullname: &str, host: &str, port: u16, addresses: &[String], txt: &[(String, String)]) -> Value {
    let mut t = Map::new();
    for (k, v) in txt {
        t.insert(k.clone(), Value::String(v.clone()));
    }
    let mut addrs: Vec<String> = addresses.to_vec();
    // IPv4 first: the web layer prefers it and some WebViews mishandle scoped IPv6.
    addrs.sort_by_key(|a| (a.contains(':'), a.clone()));
    json!({
        "name": instance_name(fullname),
        "host": host.trim_end_matches('.'),
        "addresses": addrs,
        "port": port,
        "txt": Value::Object(t),
    })
}

#[cfg(desktop)]
pub fn browse(timeout_ms: u64) -> Result<Vec<Value>, String> {
    use mdns_sd::{ServiceDaemon, ServiceEvent};
    use std::collections::BTreeMap;
    use std::time::{Duration, Instant};

    let mdns = ServiceDaemon::new().map_err(|e| e.to_string())?;
    let rx = mdns.browse(SERVICE_TYPE).map_err(|e| e.to_string())?;
    let deadline = Instant::now() + Duration::from_millis(timeout_ms.clamp(500, 10_000));
    let mut found: BTreeMap<String, Value> = BTreeMap::new();
    while let Some(left) = deadline.checked_duration_since(Instant::now()) {
        match rx.recv_timeout(left) {
            Ok(ServiceEvent::ServiceResolved(info)) => {
                let addrs: Vec<String> = info
                    .addresses
                    .iter()
                    .filter(|a| !a.is_loopback())
                    .map(|a| a.to_ip_addr().to_string())
                    .collect();
                let txt: Vec<(String, String)> = info
                    .txt_properties
                    .iter()
                    .map(|p| (p.key().to_string(), p.val_str().to_string()))
                    .collect();
                found.insert(
                    info.fullname.clone(),
                    service_json(&info.fullname, &info.host, info.port, &addrs, &txt),
                );
            }
            Ok(_) => {}
            Err(_) => break,
        }
    }
    let _ = mdns.stop_browse(SERVICE_TYPE);
    let _ = mdns.shutdown();
    Ok(found.into_values().collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_the_service_type() {
        assert_eq!(instance_name("Companion on box._companion._tcp.local."), "Companion on box");
        assert_eq!(instance_name("Companion\\032probe._companion._tcp.local."), "Companion probe");
        assert_eq!(instance_name("weird"), "weird");
    }

    #[test]
    fn builds_the_shared_shape() {
        let v = service_json(
            "Box._companion._tcp.local.",
            "box.local.",
            9877,
            &["fe80::1".into(), "192.168.1.5".into()],
            &[("id".into(), "ab".into()), ("pairing".into(), "1".into())],
        );
        assert_eq!(v["name"], "Box");
        assert_eq!(v["host"], "box.local");
        assert_eq!(v["port"], 9877);
        assert_eq!(v["addresses"][0], "192.168.1.5");
        assert_eq!(v["txt"]["pairing"], "1");
    }
}

/// Live check against a real advertiser on this network:
/// `cargo test -- --ignored browse_live --nocapture`.
#[cfg(all(test, desktop))]
mod live {
    #[test]
    #[ignore]
    fn browse_live() {
        let found = super::browse(3000).expect("browse");
        println!("{}", serde_json::to_string_pretty(&found).unwrap());
    }
}
