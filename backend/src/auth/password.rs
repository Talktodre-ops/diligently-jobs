//! Password policy and argon2id hashing. Hashing is deliberately slow, so both
//! hash and verify run on the blocking pool instead of stalling the runtime.

use argon2::password_hash::phc::PasswordHash;
use argon2::password_hash::{PasswordHasher, PasswordVerifier};
use argon2::Argon2;

use crate::error::AppError;

pub const MIN_LEN: usize = 10;
pub const MAX_LEN: usize = 128;

/// Length bounds and "not your email". Length is the rule that matters most
/// for strength; composition rules mostly produce `Password1!`.
pub fn check_policy(password: &str, email: &str) -> Result<(), AppError> {
    let n = password.chars().count();
    if n < MIN_LEN {
        return Err(AppError::validation(
            "password",
            format!("Use at least {MIN_LEN} characters"),
        ));
    }
    if n > MAX_LEN {
        return Err(AppError::validation(
            "password",
            format!("Use at most {MAX_LEN} characters"),
        ));
    }
    if password.trim().eq_ignore_ascii_case(email.trim()) {
        return Err(AppError::validation(
            "password",
            "Your password cannot be your email address",
        ));
    }
    Ok(())
}

pub async fn hash(password: &str) -> Result<String, AppError> {
    let password = password.to_owned();
    tokio::task::spawn_blocking(move || {
        Argon2::default()
            .hash_password(password.as_bytes())
            .map(|h| h.to_string())
            .map_err(|e| anyhow::anyhow!("argon2 hash failed: {e}"))
    })
    .await
    .map_err(|e| anyhow::anyhow!("hash task panicked: {e}"))?
    .map_err(AppError::from)
}

/// True when `password` matches `phc`. A malformed stored hash is an error,
/// not a silent mismatch, so a data problem surfaces in the logs.
pub async fn verify(password: &str, phc: &str) -> Result<bool, AppError> {
    let password = password.to_owned();
    let phc = phc.to_owned();
    tokio::task::spawn_blocking(move || -> anyhow::Result<bool> {
        let parsed =
            PasswordHash::new(&phc).map_err(|e| anyhow::anyhow!("stored hash unreadable: {e}"))?;
        Ok(Argon2::default()
            .verify_password(password.as_bytes(), &parsed)
            .is_ok())
    })
    .await
    .map_err(|e| anyhow::anyhow!("verify task panicked: {e}"))?
    .map_err(AppError::from)
}

/// Burn roughly the time of a real verify so "no such account" and "wrong
/// password" take the same time and do not reveal which emails exist.
pub async fn verify_dummy(password: &str) {
    static DUMMY: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    let phc = match DUMMY.get() {
        Some(p) => p.clone(),
        None => match hash("dummy-password-for-timing").await {
            Ok(p) => DUMMY.get_or_init(|| p).clone(),
            Err(_) => return,
        },
    };
    let _ = verify(password, &phc).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn hash_then_verify_round_trips() {
        let h = hash("correct horse battery").await.unwrap();
        assert!(h.starts_with("$argon2id$"));
        assert!(verify("correct horse battery", &h).await.unwrap());
        assert!(!verify("wrong horse battery", &h).await.unwrap());
    }

    #[tokio::test]
    async fn malformed_stored_hash_is_an_error() {
        assert!(verify("x", "not-a-phc-string").await.is_err());
    }

    #[test]
    fn policy_enforces_length_and_email() {
        assert!(check_policy("short", "a@b.co").is_err());
        assert!(check_policy(&"x".repeat(129), "a@b.co").is_err());
        assert!(check_policy("ada@example.com", "ada@example.com").is_err());
        assert!(check_policy("a long enough passphrase", "ada@example.com").is_ok());
    }
}
