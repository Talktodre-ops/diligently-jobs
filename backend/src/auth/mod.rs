//! Authentication: password accounts, cookie sessions, CSRF origin checks.
//!
//! Handlers take `CurrentUser` (any signed-in user) or `VerifiedUser` (email
//! confirmed, required for anything that spends AI budget) as an argument;
//! the extractor rejects with 401/403 before the handler runs.

pub mod code;
pub mod csrf;
pub mod google;
pub mod password;
pub mod routes;
pub mod session;
pub mod token;

use axum::extract::{ConnectInfo, FromRequestParts};
use axum::http::request::Parts;
use axum::http::{header, HeaderMap};
use chrono::{DateTime, Utc};
use std::net::{IpAddr, SocketAddr};
use uuid::Uuid;

use crate::error::AppError;
use crate::AppState;

#[derive(Debug, Clone)]
pub struct CurrentUser {
    pub id: Uuid,
    pub email: String,
    pub email_verified_at: Option<DateTime<Utc>>,
    pub plan: String,
    pub session_id: Uuid,
}

impl CurrentUser {
    pub fn is_verified(&self) -> bool {
        self.email_verified_at.is_some()
    }
}

impl FromRequestParts<AppState> for CurrentUser {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, AppError> {
        // Resolve once per request even if several extractors ask.
        if let Some(user) = parts.extensions.get::<CurrentUser>() {
            return Ok(user.clone());
        }
        let raw = session::token_from_headers(&parts.headers)
            .ok_or(AppError::Unauthorized("Sign in to continue."))?;
        let s = session::lookup(&state.db, &raw)
            .await?
            .ok_or(AppError::Unauthorized(
                "Your session has ended. Sign in again.",
            ))?;
        let user = CurrentUser {
            id: s.user_id,
            email: s.email,
            email_verified_at: s.email_verified_at,
            plan: s.plan,
            session_id: s.session_id,
        };
        parts.extensions.insert(user.clone());
        Ok(user)
    }
}

/// A signed-in user whose email is confirmed.
#[derive(Debug, Clone)]
pub struct VerifiedUser(pub CurrentUser);

impl FromRequestParts<AppState> for VerifiedUser {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, AppError> {
        let user = CurrentUser::from_request_parts(parts, state).await?;
        if !user.is_verified() {
            return Err(AppError::forbidden(
                "email_not_verified",
                "Confirm your email address to use this.",
            ));
        }
        Ok(VerifiedUser(user))
    }
}

/// Client IP for rate limiting and the session list.
///
/// Without `trust_proxy` it is the socket peer. With it, the address our own
/// proxy reports: `X-Real-IP` (Railway's edge sets it), else the last
/// `X-Forwarded-For` entry (the hop a Caddy or nginx in front appended). The
/// first entries of `X-Forwarded-For` are client-controlled and never read.
///
/// When that address is one of Cloudflare's, the request came through a
/// Cloudflare-proxied domain and the client is in `CF-Connecting-IP`. Only
/// Cloudflare can connect from those ranges, so a client sending the header
/// directly to the origin is ignored.
pub fn client_ip(
    headers: &HeaderMap,
    peer: Option<&ConnectInfo<SocketAddr>>,
    trust_proxy: bool,
) -> Option<String> {
    let peer = peer.map(|ConnectInfo(addr)| addr.ip());
    if !trust_proxy {
        return peer.map(|ip| ip.to_string());
    }
    let header_ip = |name: &str, last: bool| -> Option<IpAddr> {
        let v = headers.get(name)?.to_str().ok()?;
        let v = if last { v.rsplit(',').next()? } else { v };
        v.trim().parse().ok()
    };
    let hop = header_ip("x-real-ip", false)
        .or_else(|| header_ip("x-forwarded-for", true))
        .or(peer)?;
    if is_cloudflare(hop) {
        if let Some(client) = header_ip("cf-connecting-ip", false) {
            return Some(client.to_string());
        }
    }
    Some(hop.to_string())
}

/// Cloudflare's published edge ranges (cloudflare.com/ips). They change
/// rarely; when they do, an unlisted edge only means its visitors share that
/// edge's rate-limit bucket until this list is updated.
const CLOUDFLARE_V4: &[(u32, u8)] = &[
    (0xADF5_3000, 20), // 173.245.48.0/20
    (0x6715_F400, 22), // 103.21.244.0/22
    (0x6716_C800, 22), // 103.22.200.0/22
    (0x671F_0400, 22), // 103.31.4.0/22
    (0x8D65_4000, 18), // 141.101.64.0/18
    (0x6CA2_C000, 18), // 108.162.192.0/18
    (0xBE5D_F000, 20), // 190.93.240.0/20
    (0xBC72_6000, 20), // 188.114.96.0/20
    (0xC5EA_F000, 22), // 197.234.240.0/22
    (0xC629_8000, 17), // 198.41.128.0/17
    (0xA29E_0000, 15), // 162.158.0.0/15
    (0x6810_0000, 13), // 104.16.0.0/13
    (0x6818_0000, 14), // 104.24.0.0/14
    (0xAC40_0000, 13), // 172.64.0.0/13
    (0x8300_4800, 22), // 131.0.72.0/22
];
const CLOUDFLARE_V6: &[(u128, u8)] = &[
    (0x2400_cb00 << 96, 32),
    (0x2606_4700 << 96, 32),
    (0x2803_f800 << 96, 32),
    (0x2405_b500 << 96, 32),
    (0x2405_8100 << 96, 32),
    (0x2a06_98c0 << 96, 29),
    (0x2c0f_f248 << 96, 32),
];

fn is_cloudflare(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let a = u32::from(v4);
            CLOUDFLARE_V4
                .iter()
                .any(|&(net, len)| a >> (32 - len) == net >> (32 - len))
        }
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => is_cloudflare(IpAddr::V4(v4)),
            None => {
                let a = u128::from(v6);
                CLOUDFLARE_V6
                    .iter()
                    .any(|&(net, len)| a >> (128 - len) == net >> (128 - len))
            }
        },
    }
}

pub fn user_agent(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn headers(pairs: &[(&'static str, &'static str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.insert(*k, HeaderValue::from_static(v));
        }
        h
    }

    fn peer() -> ConnectInfo<SocketAddr> {
        ConnectInfo("127.0.0.1:5000".parse().unwrap())
    }

    #[test]
    fn untrusted_uses_the_socket_peer_whatever_the_headers_say() {
        let h = headers(&[
            ("x-forwarded-for", "6.6.6.6, 10.0.0.1"),
            ("x-real-ip", "6.6.6.6"),
            ("cf-connecting-ip", "6.6.6.6"),
        ]);
        assert_eq!(
            client_ip(&h, Some(&peer()), false).as_deref(),
            Some("127.0.0.1")
        );
    }

    #[test]
    fn trusted_reads_the_proxy_hop_never_the_client_supplied_ones() {
        // Railway: X-Real-IP is the edge's view of the client.
        let h = headers(&[
            ("x-real-ip", "105.127.11.2"),
            ("x-forwarded-for", "6.6.6.6, 79.127.178.82"),
        ]);
        assert_eq!(
            client_ip(&h, Some(&peer()), true).as_deref(),
            Some("105.127.11.2")
        );
        // Caddy or nginx: the last X-Forwarded-For entry.
        let h = headers(&[("x-forwarded-for", "6.6.6.6, 10.0.0.1")]);
        assert_eq!(
            client_ip(&h, Some(&peer()), true).as_deref(),
            Some("10.0.0.1")
        );
        // No proxy header: the peer. Nothing at all: unknown.
        assert_eq!(
            client_ip(&HeaderMap::new(), Some(&peer()), true).as_deref(),
            Some("127.0.0.1")
        );
        assert_eq!(client_ip(&HeaderMap::new(), None, true), None);
        // A header that is not an IP is not used as one.
        let h = headers(&[("x-real-ip", "not-an-ip")]);
        assert_eq!(
            client_ip(&h, Some(&peer()), true).as_deref(),
            Some("127.0.0.1")
        );
    }

    #[test]
    fn cloudflare_client_header_counts_only_when_cloudflare_connected() {
        let h = headers(&[
            ("x-real-ip", "172.70.1.9"),
            ("cf-connecting-ip", "105.127.11.2"),
        ]);
        assert_eq!(client_ip(&h, None, true).as_deref(), Some("105.127.11.2"));
        let h = headers(&[
            ("x-real-ip", "2a06:98c1::1"),
            ("cf-connecting-ip", "2001:db8::7"),
        ]);
        assert_eq!(client_ip(&h, None, true).as_deref(), Some("2001:db8::7"));
        // Sent straight to the origin by a client: ignored.
        let h = headers(&[
            ("x-real-ip", "105.127.11.2"),
            ("cf-connecting-ip", "6.6.6.6"),
        ]);
        assert_eq!(client_ip(&h, None, true).as_deref(), Some("105.127.11.2"));
    }

    #[test]
    fn cloudflare_ranges_match_their_edges_only() {
        for ip in [
            "173.245.48.1",
            "104.16.0.0",
            "104.23.255.255",
            "172.71.255.255",
            "162.159.1.1",
            "2606:4700::1111",
            "::ffff:104.21.2.116",
        ] {
            assert!(is_cloudflare(ip.parse().unwrap()), "{ip}");
        }
        for ip in [
            "104.15.255.255",
            "104.28.0.0",
            "172.72.0.0",
            "105.127.11.2",
            "79.127.178.82",
            "2606:4701::1",
        ] {
            assert!(!is_cloudflare(ip.parse().unwrap()), "{ip}");
        }
    }
}
