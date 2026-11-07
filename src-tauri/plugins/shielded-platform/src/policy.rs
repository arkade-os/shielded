pub fn allowed_origin(
    scheme: &str,
    host: Option<&str>,
    port: Option<u16>,
    username: &str,
    password: Option<&str>,
) -> bool {
    port.is_none()
        && username.is_empty()
        && password.is_none()
        && ((scheme == "tauri" && host == Some("localhost"))
            || (matches!(scheme, "http" | "https") && host == Some("tauri.localhost")))
}

pub fn valid_seed(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_bundled_origins_can_access_native_services() {
        for (scheme, host) in [
            ("tauri", "localhost"),
            ("http", "tauri.localhost"),
            ("https", "tauri.localhost"),
        ] {
            assert!(allowed_origin(scheme, Some(host), None, "", None));
        }
        for (scheme, host, port, user, password) in [
            (
                "https",
                Some("shielded.mutinynet.arkade.sh"),
                None,
                "",
                None,
            ),
            ("http", Some("localhost"), Some(5173), "", None),
            ("http", Some("127.0.0.1"), None, "", None),
            ("tauri", Some("localhost.evil.test"), None, "", None),
            ("tauri", Some("localhost"), Some(80), "", None),
            ("tauri", Some("localhost"), None, "user", None),
            ("tauri", Some("localhost"), None, "", Some("pass")),
            ("file", None, None, "", None),
        ] {
            assert!(!allowed_origin(scheme, host, port, user, password));
        }
    }

    #[test]
    fn seed_records_are_exact_lowercase_32_byte_hex() {
        assert!(valid_seed(&"ab".repeat(32)));
        for seed in [
            String::new(),
            "a".repeat(63),
            "a".repeat(65),
            "AB".repeat(32),
            "gg".repeat(32),
            format!("{}\0", "a".repeat(63)),
        ] {
            assert!(!valid_seed(&seed));
        }
    }
}
