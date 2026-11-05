//! The per-launch shared secret and the bootstrap token derived from it.
//!
//! The secret is written to the sidecar's stdin once and never appears in argv, env or logs. The
//! webview only ever sees `HMAC-SHA256(secret, "burrow-bootstrap-v1")`, which the server checks
//! before it sets its session cookie.

use hmac::{Hmac, Mac};
use sha2::Sha256;

/// Number of random bytes in the secret.
pub const SECRET_LEN: usize = 32;
const BOOTSTRAP_LABEL: &[u8] = b"burrow-bootstrap-v1";
const UPDATE_KEY_LABEL: &[u8] = b"burrow-update-key-v1";
const DIALOG_KEY_LABEL: &[u8] = b"burrow-dialog-key-v1";

/// Lowercase hex of `bytes`.
pub fn to_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

/// 32 bytes from the OS CSPRNG.
pub fn generate_secret() -> Result<[u8; SECRET_LEN], String> {
    let mut secret = [0u8; SECRET_LEN];
    getrandom::fill(&mut secret).map_err(|e| format!("OS random source failed: {e}"))?;
    Ok(secret)
}

/// HMAC-SHA256 (RFC 2104) via RustCrypto.
pub fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(key).expect("HMAC accepts any key length");
    mac.update(message);
    mac.finalize().into_bytes().into()
}

/// Hex token the webview presents to `/desktop/bootstrap`.
pub fn bootstrap_token(secret: &[u8]) -> String {
    to_hex(&hmac_sha256(secret, BOOTSTRAP_LABEL))
}

/// Key that authenticates `BURROW_UPDATE_REQUEST` lines: `HMAC-SHA256(secret, "burrow-update-key-v1")`.
/// The shell keeps only this key, never the raw secret.
pub fn update_mac_key(secret: &[u8]) -> [u8; 32] {
    hmac_sha256(secret, UPDATE_KEY_LABEL)
}

/// Key that authenticates the dialog protocol (folder picker and save dialog): `HMAC-SHA256(secret, "burrow-dialog-key-v1")`.
/// A different label from the update key, so a MAC made for one purpose can never be replayed for the other. The shell keeps
/// only this key, never the raw secret.
pub fn dialog_mac_key(secret: &[u8]) -> [u8; 32] {
    hmac_sha256(secret, DIALOG_KEY_LABEL)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_is_32_bytes_and_64_hex() {
        let secret = generate_secret().unwrap();
        assert_eq!(secret.len(), 32);
        let hex = to_hex(&secret);
        assert_eq!(hex.len(), 64);
        assert!(hex.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f')));
    }

    #[test]
    fn two_secrets_differ() {
        assert_ne!(generate_secret().unwrap(), generate_secret().unwrap());
    }

    #[test]
    fn bootstrap_token_matches_server_test_vector() {
        let mut secret = [0u8; 32];
        for (i, b) in secret.iter_mut().enumerate() {
            *b = i as u8;
        }
        assert_eq!(
            bootstrap_token(&secret),
            "e27e10659f15592fe08a248ad181e7d6e524013c19491e0c11a27836a53854fc"
        );
    }

    #[test]
    fn update_mac_key_matches_server_test_vector() {
        let mut secret = [0u8; 32];
        for (i, b) in secret.iter_mut().enumerate() {
            *b = i as u8;
        }
        assert_eq!(
            to_hex(&update_mac_key(&secret)),
            "d7a04009cce2a159b133fea3d6c6675258b1ad63e514b5dc6a78f8bf47dc681b"
        );
    }

    #[test]
    fn dialog_mac_key_matches_server_test_vector() {
        let mut secret = [0u8; 32];
        for (i, b) in secret.iter_mut().enumerate() {
            *b = i as u8;
        }
        assert_eq!(
            to_hex(&dialog_mac_key(&secret)),
            "0a89a8b731cd49c6037f32cd1ea9fdc74fb725f8cb6635954b2c2c0882fcf179"
        );
        assert_ne!(dialog_mac_key(&secret), update_mac_key(&secret));
        assert_ne!(dialog_mac_key(&[7u8; 32]), dialog_mac_key(&secret));
    }

    #[test]
    fn hmac_matches_rfc4231_case_2() {
        let mac = hmac_sha256(b"Jefe", b"what do ya want for nothing?");
        assert_eq!(
            to_hex(&mac),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
    }

    #[test]
    fn hmac_matches_rfc4231_case_6_long_key() {
        let mac = hmac_sha256(
            &[0xaa; 131],
            b"Test Using Larger Than Block-Size Key - Hash Key First",
        );
        assert_eq!(
            to_hex(&mac),
            "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54"
        );
    }
}
