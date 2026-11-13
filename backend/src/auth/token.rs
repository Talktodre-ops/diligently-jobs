//! Opaque random tokens for sessions and email links. The raw token goes to
//! the client once; only its SHA-256 is stored.

use base64::prelude::{Engine, BASE64_URL_SAFE_NO_PAD};
use sha2::{Digest, Sha256};

/// 32 random bytes from the OS-seeded CSPRNG, base64url without padding.
pub fn generate() -> String {
    let mut bytes = [0u8; 32];
    rand::fill(&mut bytes[..]);
    BASE64_URL_SAFE_NO_PAD.encode(bytes)
}

pub fn hash(token: &str) -> Vec<u8> {
    Sha256::digest(token.as_bytes()).to_vec()
}

/// Cheap shape check before touching the database: a real token is exactly
/// 43 base64url characters.
pub fn looks_valid(token: &str) -> bool {
    token.len() == 43
        && token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Equality that takes the same time wherever the inputs differ, for
/// comparing secrets (hashes, state values). Lengths are not secret here.
pub fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let diff = a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y));
    std::hint::black_box(diff) == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_are_unique_and_well_formed() {
        let a = generate();
        let b = generate();
        assert_ne!(a, b);
        assert!(looks_valid(&a), "{a}");
        assert_eq!(hash(&a).len(), 32);
        assert_eq!(hash(&a), hash(&a));
    }

    #[test]
    fn ct_eq_matches_only_equal_input() {
        assert!(ct_eq(b"abc", b"abc"));
        assert!(!ct_eq(b"abc", b"abd"));
        assert!(!ct_eq(b"abc", b"abcd"));
        assert!(ct_eq(b"", b""));
    }

    #[test]
    fn shape_check_rejects_junk() {
        assert!(!looks_valid(""));
        assert!(!looks_valid("abc"));
        assert!(!looks_valid(&"*".repeat(43)));
    }
}
