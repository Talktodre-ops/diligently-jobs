//! In-process rate limiting with token buckets.
//!
//! Each (limit, key) pair gets a bucket that holds up to `burst` tokens and
//! refills evenly over `per`. Handlers call `check` before doing work, keyed
//! by client IP and, where an email is involved, by the email too, so one
//! address cannot be hammered from many IPs.
//!
//! State lives in this process. With several API instances each enforces its
//! own budget, which is acceptable for abuse control at this size; move to
//! Postgres or Redis when running more than a couple of instances.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::error::AppError;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Limit {
    pub name: &'static str,
    pub burst: u32,
    pub per: Duration,
}

const fn minutes(n: u64) -> Duration {
    Duration::from_secs(n * 60)
}

pub const SIGNIN_IP: Limit = Limit {
    name: "signin_ip",
    burst: 20,
    per: minutes(15),
};
pub const SIGNIN_EMAIL: Limit = Limit {
    name: "signin_email",
    burst: 10,
    per: minutes(15),
};
pub const SIGNUP_IP: Limit = Limit {
    name: "signup_ip",
    burst: 10,
    per: minutes(60),
};
pub const FORGOT_IP: Limit = Limit {
    name: "forgot_ip",
    burst: 10,
    per: minutes(60),
};
pub const FORGOT_EMAIL: Limit = Limit {
    name: "forgot_email",
    burst: 3,
    per: minutes(60),
};
pub const TOKEN_IP: Limit = Limit {
    name: "token_ip",
    burst: 30,
    per: minutes(60),
};
pub const RESEND_USER: Limit = Limit {
    name: "resend_user",
    burst: 5,
    per: minutes(60),
};
/// AI calls per user: generous for real use, tight enough to stop a script.
pub const AI_USER: Limit = Limit {
    name: "ai_user",
    burst: 40,
    per: minutes(10),
};
pub const PASSWORD_CHECK_USER: Limit = Limit {
    name: "password_check_user",
    burst: 10,
    per: minutes(15),
};

struct Bucket {
    tokens: f64,
    updated: Instant,
}

#[derive(Default)]
pub struct RateLimiter {
    buckets: Mutex<HashMap<(&'static str, String), Bucket>>,
}

const PRUNE_ABOVE: usize = 50_000;

impl RateLimiter {
    pub fn new() -> Self {
        Self::default()
    }

    /// Take one token for `key` under `limit`, or fail with 429 and the number
    /// of seconds until a token is available.
    pub fn check(&self, limit: Limit, key: &str) -> Result<(), AppError> {
        self.check_at(limit, key, Instant::now())
    }

    fn check_at(&self, limit: Limit, key: &str, now: Instant) -> Result<(), AppError> {
        let rate = f64::from(limit.burst) / limit.per.as_secs_f64(); // tokens per second
        let mut map = self.buckets.lock().expect("rate limiter lock");
        if map.len() > PRUNE_ABOVE {
            // Drop buckets that have refilled completely; they carry no state.
            map.retain(|(name, _), b| {
                let per = limit_window(name).unwrap_or(limit.per);
                now.duration_since(b.updated) < per
            });
        }
        let bucket = map
            .entry((limit.name, key.to_lowercase()))
            .or_insert(Bucket {
                tokens: f64::from(limit.burst),
                updated: now,
            });
        let elapsed = now.duration_since(bucket.updated).as_secs_f64();
        bucket.tokens = (bucket.tokens + elapsed * rate).min(f64::from(limit.burst));
        bucket.updated = now;
        if bucket.tokens >= 1.0 {
            bucket.tokens -= 1.0;
            Ok(())
        } else {
            let wait = ((1.0 - bucket.tokens) / rate).ceil().max(1.0);
            Err(AppError::RateLimited {
                retry_after_secs: wait as u64,
            })
        }
    }
}

fn limit_window(name: &str) -> Option<Duration> {
    [
        SIGNIN_IP,
        SIGNIN_EMAIL,
        SIGNUP_IP,
        FORGOT_IP,
        FORGOT_EMAIL,
        TOKEN_IP,
        RESEND_USER,
        PASSWORD_CHECK_USER,
        AI_USER,
    ]
    .iter()
    .find(|l| l.name == name)
    .map(|l| l.per)
}

#[cfg(test)]
mod tests {
    use super::*;

    const L: Limit = Limit {
        name: "t",
        burst: 3,
        per: Duration::from_secs(60),
    };

    #[test]
    fn allows_burst_then_limits_then_refills() {
        let rl = RateLimiter::new();
        let t0 = Instant::now();
        for _ in 0..3 {
            rl.check_at(L, "k", t0).unwrap();
        }
        match rl.check_at(L, "k", t0) {
            Err(AppError::RateLimited { retry_after_secs }) => assert_eq!(retry_after_secs, 20),
            other => panic!("expected 429, got {other:?}"),
        }
        // One token refills every 20 seconds.
        rl.check_at(L, "k", t0 + Duration::from_secs(20)).unwrap();
        assert!(rl.check_at(L, "k", t0 + Duration::from_secs(21)).is_err());
    }

    #[test]
    fn keys_are_independent_and_case_insensitive() {
        let rl = RateLimiter::new();
        let t0 = Instant::now();
        for _ in 0..3 {
            rl.check_at(L, "Ada@Example.com", t0).unwrap();
        }
        assert!(rl.check_at(L, "ada@example.com", t0).is_err());
        rl.check_at(L, "bo@example.com", t0).unwrap();
    }
}
