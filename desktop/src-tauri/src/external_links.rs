//! Keep every Companion webview on the app: a navigation to anything that is
//! not the app's own origin is refused and handed to the system browser.
//!
//! The web layer already routes link clicks through the opener (see
//! `web/src/utils/externalLinks.ts`); this is the backstop for whatever gets
//! past it (a script-set `location`, a redirect, a link the click handler did
//! not see). Without it the main window ends up on a foreign page with no way
//! back.

use std::sync::Mutex;
use tauri::{Manager, Runtime, Url};

/// What to do with a navigation request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    /// The app's own content: let the webview load it.
    Allow,
    /// Somewhere else: refuse it here and open it in the system browser.
    OpenExternally,
    /// Nothing the app loads and nothing a browser should get: refuse it.
    Block,
}

/// Hosts Tauri serves the app and its custom protocols from when the platform
/// has no custom-scheme support (Windows, Android): `http(s)://tauri.localhost`.
const INTERNAL_HOSTS: [&str; 2] = ["tauri.localhost", "asset.localhost"];

/// `dev_url` is the dev server (`build.devUrl`), passed only by dev builds.
/// A plain `http://localhost:3000` link in a conversation is NOT the app.
pub fn decide(url: &Url, dev_url: Option<&Url>) -> Decision {
    match url.scheme() {
        "tauri" | "asset" | "about" | "blob" => Decision::Allow,
        "http" | "https" => {
            let host = url.host_str().unwrap_or("");
            if INTERNAL_HOSTS.contains(&host) {
                return Decision::Allow;
            }
            if dev_url.is_some_and(|dev| same_origin(dev, url)) {
                return Decision::Allow;
            }
            Decision::OpenExternally
        }
        "mailto" | "tel" => Decision::OpenExternally,
        _ => Decision::Block,
    }
}

fn same_origin(a: &Url, b: &Url) -> bool {
    a.scheme() == b.scheme()
        && a.host_str() == b.host_str()
        && a.port_or_known_default() == b.port_or_known_default()
}

fn dev_url<R: Runtime>(app: &tauri::AppHandle<R>) -> Option<Url> {
    if tauri::is_dev() {
        app.config().build.dev_url.clone()
    } else {
        None
    }
}

/// The last app page the main window loaded, so a window that did get away can
/// be brought home (`restore_if_stranded`).
static MAIN_HOME: Mutex<Option<Url>> = Mutex::new(None);

/// The guard, for every webview of the app (main window, floating orb).
pub fn plugin<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::<R, ()>::new("external-links")
        .on_navigation(|webview, url| {
            let app = webview.app_handle();
            match decide(url, dev_url(app).as_ref()) {
                Decision::Allow => {
                    if webview.label() == "main" && url.scheme() != "about" && url.scheme() != "blob"
                    {
                        if let Ok(mut home) = MAIN_HOME.lock() {
                            *home = Some(url.clone());
                        }
                    }
                    true
                }
                Decision::OpenExternally => {
                    // Off the calling thread: on Android this is the UI thread (ANR).
                    let handle = app.clone();
                    let target = url.as_str().to_string();
                    std::thread::spawn(move || {
                        use tauri_plugin_opener::OpenerExt;
                        if let Err(e) = handle.opener().open_url(&target, None::<&str>) {
                            eprintln!("[external-links] could not open {target}: {e}");
                        }
                    });
                    false
                }
                Decision::Block => false,
            }
        })
        .build()
}

/// A main window that is somehow showing a foreign page goes back to the app.
#[cfg(desktop)]
pub fn restore_if_stranded<R: Runtime>(window: &tauri::WebviewWindow<R>) {
    let Ok(current) = window.url() else {
        return;
    };
    if decide(&current, dev_url(window.app_handle()).as_ref()) == Decision::Allow {
        return;
    }
    let home = MAIN_HOME.lock().ok().and_then(|h| h.clone());
    if let Some(home) = home {
        let _ = window.navigate(home);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(url: &str) -> Decision {
        decide(&Url::parse(url).unwrap(), None)
    }

    #[test]
    fn the_app_itself_is_allowed() {
        assert_eq!(d("tauri://localhost/"), Decision::Allow);
        assert_eq!(d("tauri://localhost/index.html#/session/1"), Decision::Allow);
        assert_eq!(d("http://tauri.localhost/"), Decision::Allow);
        assert_eq!(d("https://tauri.localhost/index.html"), Decision::Allow);
        assert_eq!(d("asset://localhost/tmp/a.png"), Decision::Allow);
        assert_eq!(d("about:blank"), Decision::Allow);
        assert_eq!(d("blob:tauri://localhost/1b2c"), Decision::Allow);
    }

    #[test]
    fn everything_else_on_the_web_goes_to_the_browser() {
        assert_eq!(d("https://github.com/a/b"), Decision::OpenExternally);
        assert_eq!(d("http://example.com"), Decision::OpenExternally);
        // A daemon's own web UI or a dev server a session mentions is not the app.
        assert_eq!(d("http://localhost:3000/"), Decision::OpenExternally);
        assert_eq!(d("http://127.0.0.1:9877/web"), Decision::OpenExternally);
        assert_eq!(d("https://dev.cush.rocks/web/"), Decision::OpenExternally);
        // Look-alikes of the internal host.
        assert_eq!(d("https://tauri.localhost.evil.com/"), Decision::OpenExternally);
        assert_eq!(d("https://evil.com/?tauri.localhost"), Decision::OpenExternally);
        assert_eq!(d("mailto:a@b.c"), Decision::OpenExternally);
        assert_eq!(d("tel:+15550100"), Decision::OpenExternally);
    }

    #[test]
    fn other_schemes_are_refused() {
        assert_eq!(d("file:///etc/passwd"), Decision::Block);
        assert_eq!(d("data:text/html,<h1>hi</h1>"), Decision::Block);
        assert_eq!(d("javascript:alert(1)"), Decision::Block);
        assert_eq!(d("ftp://example.com/a"), Decision::Block);
    }

    #[test]
    fn the_dev_server_is_the_app_only_in_dev() {
        let dev = Url::parse("http://localhost:5173").unwrap();
        let page = Url::parse("http://localhost:5173/index.html").unwrap();
        assert_eq!(decide(&page, Some(&dev)), Decision::Allow);
        assert_eq!(decide(&page, None), Decision::OpenExternally);
        // Same host, another port or scheme: not the dev server.
        let other = Url::parse("http://localhost:3000/").unwrap();
        assert_eq!(decide(&other, Some(&dev)), Decision::OpenExternally);
        let https = Url::parse("https://localhost:5173/").unwrap();
        assert_eq!(decide(&https, Some(&dev)), Decision::OpenExternally);
    }
}
