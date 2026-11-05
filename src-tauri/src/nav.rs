//! Navigation policy for the main webview. The only trusted content is the local splash pages and
//! the Burrow server on `127.0.0.1:<port>`; everything else is either handed to the default
//! browser (web links, mailto) or dropped.

use url::{Host, Url};

/// What to do with a navigation or new-window request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NavDecision {
    /// Let the webview load it.
    Allow,
    /// Cancel it and open the URL in the user's default browser or mail client.
    External,
    /// Cancel it silently.
    Deny,
}

/// The local splash pages: exactly the platform's own origin, no port.
fn is_splash_origin(url: &Url) -> bool {
    if url.port().is_some() {
        return false;
    }
    if cfg!(windows) {
        url.scheme() == "http" && url.host_str() == Some("tauri.localhost")
    } else {
        url.scheme() == "tauri" && url.host_str() == Some("localhost")
    }
}

/// True for every spelling of "this machine": localhost (with or without a trailing dot) and any
/// `*.localhost`, 127.0.0.0/8, 0.0.0.0, `::1`, `::` and IPv4-mapped IPv6 loopback.
fn is_loopback(url: &Url) -> bool {
    match url.host() {
        Some(Host::Ipv4(ip)) => ip.is_loopback() || ip.is_unspecified(),
        Some(Host::Ipv6(ip)) => {
            ip.is_loopback()
                || ip.is_unspecified()
                || ip
                    .to_ipv4_mapped()
                    .is_some_and(|v4| v4.is_loopback() || v4.is_unspecified())
        }
        Some(Host::Domain(d)) => {
            let d = d.trim_end_matches('.').to_ascii_lowercase();
            d == "localhost" || d.ends_with(".localhost")
        }
        None => false,
    }
}

/// Classifies `url` given the sidecar's `port` (0 while the server is not up yet).
pub fn classify(url: &Url, port: u16) -> NavDecision {
    if is_splash_origin(url) {
        return NavDecision::Allow;
    }
    match url.scheme() {
        "http" | "https" => {
            if is_loopback(url) {
                let burrow = url.scheme() == "http"
                    && url.host() == Some(Host::Ipv4(std::net::Ipv4Addr::LOCALHOST))
                    && port != 0
                    && url.port_or_known_default() == Some(port);
                if burrow {
                    NavDecision::Allow
                } else {
                    NavDecision::Deny
                }
            } else {
                NavDecision::External
            }
        }
        // A mailto link sends nothing from Burrow: it only hands a draft to the default mail app, like the
        // Buy Burrow Pro button and Help > Report content (policy 11.16). The user sends it, or not.
        "mailto" => NavDecision::External,
        _ => NavDecision::Deny,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn c(s: &str, port: u16) -> NavDecision {
        classify(&Url::parse(s).unwrap(), port)
    }

    #[test]
    fn burrow_server_on_the_right_port_is_allowed() {
        assert_eq!(c("http://127.0.0.1:5000/", 5000), NavDecision::Allow);
        assert_eq!(
            c("http://127.0.0.1:5000/settings#data-storage", 5000),
            NavDecision::Allow
        );
        assert_eq!(
            c("http://127.0.0.1:5000/desktop/bootstrap?token=ab", 5000),
            NavDecision::Allow
        );
    }

    #[test]
    fn other_loopback_ports_and_hosts_are_denied() {
        assert_eq!(c("http://127.0.0.1:4321/", 5000), NavDecision::Deny);
        assert_eq!(c("http://localhost:5000/", 5000), NavDecision::Deny);
        assert_eq!(c("http://[::1]:5000/", 5000), NavDecision::Deny);
        assert_eq!(c("https://127.0.0.1:5000/", 5000), NavDecision::Deny);
        assert_eq!(c("http://127.0.0.1:5000/", 0), NavDecision::Deny);
    }

    #[test]
    fn loopback_equivalents_are_denied() {
        for u in [
            "http://localhost./",
            "http://LOCALHOST:5000/",
            "http://app.localhost:5000/",
            "http://a.b.localhost./",
            "http://127.0.0.2:5000/",
            "http://0.0.0.0:5000/",
            "http://[::]:5000/",
            "http://[::1]:5000/",
            "http://[::ffff:127.0.0.1]:5000/",
            "http://[::ffff:7f00:1]:5000/",
            "https://localhost/",
        ] {
            assert_eq!(c(u, 5000), NavDecision::Deny, "{u}");
        }
        // The URL parser normalises these to exactly 127.0.0.1, the allowed host.
        assert_eq!(c("http://127.0.0.1.:5000/", 5000), NavDecision::Allow);
        assert_eq!(c("http://127.1:5000/", 5000), NavDecision::Allow);
    }

    #[test]
    fn splash_origin_is_platform_specific_and_portless() {
        if cfg!(windows) {
            assert_eq!(
                c("http://tauri.localhost/error.html?log=x", 0),
                NavDecision::Allow
            );
            assert_eq!(c("tauri://localhost/index.html", 0), NavDecision::Deny);
        } else {
            assert_eq!(c("tauri://localhost/index.html", 0), NavDecision::Allow);
            assert_eq!(c("http://tauri.localhost/", 0), NavDecision::Deny);
        }
        assert_eq!(c("http://tauri.localhost:5000/", 5000), NavDecision::Deny);
        assert_eq!(c("http://tauri.localhost:5000/", 0), NavDecision::Deny);
        assert_eq!(c("https://tauri.localhost/", 0), NavDecision::Deny);
        assert_eq!(c("tauri://localhost:5000/", 0), NavDecision::Deny);
    }

    #[test]
    fn web_and_mail_links_go_to_the_default_app() {
        assert_eq!(
            c("https://ollama.com/download", 5000),
            NavDecision::External
        );
        assert_eq!(c("http://example.com/", 5000), NavDecision::External);
        assert_eq!(c("mailto:someone@example.com", 5000), NavDecision::External);
        assert_eq!(
            c("http://127.0.0.1.example.com:5000/", 5000),
            NavDecision::External
        );
    }

    #[test]
    fn dangerous_schemes_are_denied() {
        assert_eq!(c("javascript:alert(1)", 5000), NavDecision::Deny);
        assert_eq!(c("file:///C:/Windows/win.ini", 5000), NavDecision::Deny);
        assert_eq!(c("data:text/html,hi", 5000), NavDecision::Deny);
        assert_eq!(c("about:blank", 5000), NavDecision::Deny);
        assert_eq!(c("ftp://example.com/", 5000), NavDecision::Deny);
    }
}
