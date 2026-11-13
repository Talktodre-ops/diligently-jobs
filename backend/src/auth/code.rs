//! Six-digit email verification codes, sent alongside the link.
//!
//! One live code per user: issuing a new one replaces the row. Only a salted
//! SHA-256 bound to the user id is stored. Every check counts as an attempt
//! before the comparison runs, so concurrent guesses cannot exceed the cap,
//! and the fifth attempt spends the code.
//!
//! A million possible codes means a stolen hash could be brute forced
//! offline; the hash keeps codes out of backups and logs, and anyone holding
//! the database could mark the account verified directly anyway. The online
//! guess rate is what matters, and that is capped here and by rate limits.

use chrono::{Duration, Utc};
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use uuid::Uuid;

use super::token;
use crate::error::AppError;

pub const TTL: Duration = Duration::minutes(30);
pub const MAX_ATTEMPTS: i32 = 5;

/// Largest multiple of 1,000,000 that fits in a u32. Values at or above it
/// are redrawn so every code is equally likely.
const UNBIASED_LIMIT: u32 = 4_294_000_000;

/// A uniformly random 6-digit code from the OS-seeded CSPRNG.
pub fn generate() -> String {
    loop {
        let mut b = [0u8; 4];
        rand::fill(&mut b[..]);
        let n = u32::from_le_bytes(b);
        if n < UNBIASED_LIMIT {
            return format!("{:06}", n % 1_000_000);
        }
    }
}

fn hash(user_id: Uuid, salt: &[u8], code: &str) -> Vec<u8> {
    let mut h = Sha256::new();
    h.update(b"diligently-verify-code\0");
    h.update(user_id.as_bytes());
    h.update(salt);
    h.update(code.as_bytes());
    h.finalize().to_vec()
}

fn well_formed(code: &str) -> bool {
    code.len() == 6 && code.bytes().all(|b| b.is_ascii_digit())
}

/// Create a fresh code for the user, replacing any earlier one, and return
/// the plain code for the email.
pub async fn issue(db: &PgPool, user_id: Uuid) -> Result<String, AppError> {
    let code = generate();
    let mut salt = [0u8; 16];
    rand::fill(&mut salt[..]);
    sqlx::query(
        r#"
        insert into verification_codes (user_id, code_hash, salt, expires_at)
        values ($1, $2, $3, $4)
        on conflict (user_id) do update set
            code_hash = excluded.code_hash,
            salt = excluded.salt,
            expires_at = excluded.expires_at,
            attempts = 0,
            created_at = now()
        "#,
    )
    .bind(user_id)
    .bind(hash(user_id, &salt, &code))
    .bind(&salt[..])
    .bind(Utc::now() + TTL)
    .execute(db)
    .await?;
    Ok(code)
}

#[derive(Debug, PartialEq, Eq)]
pub enum Check {
    Matched,
    Wrong,
    /// Expired, spent by too many attempts, or never issued.
    Gone,
}

/// Count an attempt against the user's live code and compare. A match
/// deletes the code so it cannot be used twice.
pub async fn check(db: &PgPool, user_id: Uuid, given: &str) -> Result<Check, AppError> {
    let live: Option<(Vec<u8>, Vec<u8>)> = sqlx::query_as(
        r#"
        update verification_codes set attempts = attempts + 1
        where user_id = $1 and expires_at > now() and attempts < $2
        returning code_hash, salt
        "#,
    )
    .bind(user_id)
    .bind(MAX_ATTEMPTS)
    .fetch_optional(db)
    .await?;
    let Some((stored, salt)) = live else {
        return Ok(Check::Gone);
    };
    // A malformed code still costs an attempt; it is hashed like any other so
    // the timing does not depend on its shape.
    let matched = token::ct_eq(&hash(user_id, &salt, given), &stored) && well_formed(given);
    if !matched {
        return Ok(Check::Wrong);
    }
    sqlx::query("delete from verification_codes where user_id = $1")
        .bind(user_id)
        .execute(db)
        .await?;
    Ok(Check::Matched)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_are_six_digits() {
        for _ in 0..200 {
            let c = generate();
            assert!(well_formed(&c), "{c}");
        }
    }

    #[test]
    fn hash_is_bound_to_user_and_salt() {
        let u1 = Uuid::new_v4();
        let u2 = Uuid::new_v4();
        assert_eq!(hash(u1, b"s", "123456"), hash(u1, b"s", "123456"));
        assert_ne!(hash(u1, b"s", "123456"), hash(u2, b"s", "123456"));
        assert_ne!(hash(u1, b"s", "123456"), hash(u1, b"t", "123456"));
    }
}
