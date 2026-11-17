//! Sign in with Google: OpenID Connect authorization code flow with PKCE.
//!
//! `start` makes a random `state` and PKCE verifier, stores the state's
//! SHA-256 with the verifier and the `next` path, sets the raw state in a
//! short-lived HttpOnly cookie scoped to these routes, and redirects to
//! Google. `callback` requires the returned state to equal the cookie
//! (constant time), claims the stored row exactly once, exchanges the code
//! with the verifier, reads userinfo and insists on a verified email. The
//! cookie binds the flow to the browser that started it, which stops a
//! forged callback link from signing someone into another person's account.
//!
//! With `link=1` a signed-in user connects Google to their own account: the
//! stored flow remembers who started it, and the callback sets that user's
//! Google subject instead of signing in, then lands on
//! `/settings?google=connected`, `in_use` (the subject belongs to another
//! account) or `error`.
//!
//! Every other callback failure redirects to `/signin?error=google`; the
//! reason is logged, never shown.

use axum::extract::rejection::QueryRejection;
use axum::extract::State;
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use base64::prelude::{Engine, BASE64_URL_SAFE_NO_PAD};
use chrono::{DateTime, Duration, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::routes::ClientMeta;
use super::{session, token};
use crate::config::{GoogleConfig, WebConfig};
use crate::error::AppError;
use crate::extract::{Json, Query};
use crate::rate_limit as rl;
use crate::validate;
use crate::AppState;

const STATE_COOKIE: &str = "dl_oauth";
const STATE_COOKIE_PATH: &str = "/v1/auth/google";
const STATE_TTL: Duration = Duration::minutes(10);
const CALLBACK_PATH: &str = "/v1/auth/google/callback";
const HTTP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
const MAX_NEXT_LEN: usize = 512;

/// GET /v1/auth/providers
pub async fn providers(State(state): State<AppState>) -> Json<Value> {
    Json(json!({ "google": state.config.google.is_some() }))
}

fn disabled() -> AppError {
    AppError::coded(
        StatusCode::NOT_FOUND,
        "provider_disabled",
        "Google sign-in is not available.",
    )
}

/// `next` must be a path on this site: one leading `/`, visible ASCII, no
/// backslash (browsers read `/\host` as `//host`). Anything else becomes `/`.
pub fn safe_next(next: Option<&str>) -> String {
    match next {
        Some(n)
            if n.len() <= MAX_NEXT_LEN
                && n.starts_with('/')
                && !n.starts_with("//")
                && n.bytes().all(|b| (0x21..=0x7e).contains(&b) && b != b'\\') =>
        {
            n.to_string()
        }
        _ => "/".to_string(),
    }
}

fn redirect_uri(web: &WebConfig) -> String {
    format!("{}{CALLBACK_PATH}", web.app_base_url)
}

fn state_cookie(web: &WebConfig, value: &str, max_age: i64) -> HeaderValue {
    let secure = if web.cookie_secure { "; Secure" } else { "" };
    let s = format!(
        "{STATE_COOKIE}={value}; Path={STATE_COOKIE_PATH}; HttpOnly; SameSite=Lax; Max-Age={max_age}{secure}"
    );
    // The value is base64url and the rest fixed ASCII.
    HeaderValue::from_str(&s).expect("cookie header is ASCII")
}

fn redirect(location: &str, cookies: Vec<HeaderValue>) -> Result<Response, AppError> {
    let loc = HeaderValue::from_str(location)
        .map_err(|_| anyhow::anyhow!("redirect location is not a valid header value"))?;
    let mut resp = StatusCode::FOUND.into_response();
    resp.headers_mut().insert(header::LOCATION, loc);
    for c in cookies {
        resp.headers_mut().append(header::SET_COOKIE, c);
    }
    Ok(resp)
}

#[derive(Deserialize)]
pub struct StartQuery {
    pub next: Option<String>,
    /// `1` connects Google to the signed-in account instead of signing in.
    pub link: Option<String>,
}

/// Where a connect-Google flow lands, with its outcome in the query.
const LINK_LANDING: &str = "/settings";

/// GET /v1/auth/google/start?next=/path, or `?link=1` from Settings to
/// connect Google to the signed-in account.
pub async fn start(
    State(state): State<AppState>,
    meta: ClientMeta,
    headers: HeaderMap,
    Query(q): Query<StartQuery>,
) -> Result<Response, AppError> {
    let g = state.config.google.as_ref().ok_or_else(disabled)?;
    state.limiter.check(rl::OAUTH_IP, meta.ip_key())?;
    let link_user = if q.link.as_deref() == Some("1") {
        let signed_in = match session::token_from_headers(&headers) {
            Some(raw) => session::lookup(&state.db, &raw).await?,
            None => None,
        };
        match signed_in {
            Some(s) => Some(s.user_id),
            None => {
                return redirect(
                    &format!(
                        "{}{LINK_LANDING}?google=error",
                        state.config.web.app_base_url
                    ),
                    vec![],
                )
            }
        }
    } else {
        None
    };
    let next = if link_user.is_some() {
        LINK_LANDING.to_string()
    } else {
        safe_next(q.next.as_deref())
    };
    let raw_state = token::generate();
    // 43 base64url characters: inside the 43 to 128 unreserved characters
    // RFC 7636 allows for a verifier.
    let verifier = token::generate();
    let challenge = BASE64_URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));

    sqlx::query("delete from oauth_states where expires_at < now()")
        .execute(&state.db)
        .await?;
    sqlx::query(
        r#"
        insert into oauth_states (state_hash, provider, pkce_verifier, next_path, expires_at, link_user_id)
        values ($1, 'google', $2, $3, $4, $5)
        "#,
    )
    .bind(token::hash(&raw_state))
    .bind(&verifier)
    .bind(&next)
    .bind(Utc::now() + STATE_TTL)
    .bind(link_user)
    .execute(&state.db)
    .await?;

    let url = reqwest::Url::parse_with_params(
        &g.auth_url,
        &[
            ("response_type", "code"),
            ("client_id", g.client_id.as_str()),
            ("redirect_uri", redirect_uri(&state.config.web).as_str()),
            ("scope", "openid email profile"),
            ("state", raw_state.as_str()),
            ("code_challenge", challenge.as_str()),
            ("code_challenge_method", "S256"),
        ],
    )
    .map_err(|e| anyhow::anyhow!("GOOGLE_AUTH_URL is not a valid URL: {e}"))?;
    redirect(
        url.as_str(),
        vec![state_cookie(
            &state.config.web,
            &raw_state,
            STATE_TTL.num_seconds(),
        )],
    )
}

#[derive(Deserialize)]
pub struct CallbackQuery {
    pub code: Option<String>,
    pub state: Option<String>,
    pub error: Option<String>,
}

/// GET /v1/auth/google/callback?code=&state=
pub async fn callback(
    State(state): State<AppState>,
    meta: ClientMeta,
    headers: HeaderMap,
    q: Result<axum::extract::Query<CallbackQuery>, QueryRejection>,
) -> Result<Response, AppError> {
    let g = state.config.google.as_ref().ok_or_else(disabled)?;
    let web = &state.config.web;
    let clear = state_cookie(web, "", 0);
    let query = q.ok().map(|axum::extract::Query(q)| q);
    let flow = match claim(&state, &meta, &headers, query).await {
        Ok(f) => f,
        Err(Refused { link_user, why }) => {
            tracing::warn!(reason = %format!("{why:#}"), "google callback refused");
            let to = if link_user.is_some() {
                format!("{}{LINK_LANDING}?google=error", web.app_base_url)
            } else {
                format!("{}/signin?error=google", web.app_base_url)
            };
            return redirect(&to, vec![clear]);
        }
    };
    if let Some(user_id) = flow.link_user {
        let outcome = match identify(&state, g, &flow).await {
            Ok(who) => link(&state, user_id, &who).await,
            Err(e) => Err(e),
        };
        let result = match outcome {
            Ok(Linked::Connected) => "connected",
            Ok(Linked::InUse) => "in_use",
            Err(why) => {
                tracing::warn!(reason = %format!("{why:#}"), "google connect refused");
                "error"
            }
        };
        return redirect(
            &format!("{}{LINK_LANDING}?google={result}", web.app_base_url),
            vec![clear],
        );
    }
    match sign_in(&state, g, &meta, &flow).await {
        Ok(session_raw) => redirect(
            &format!("{}{}", web.app_base_url, flow.next),
            vec![clear, session::set_cookie(web, &session_raw)],
        ),
        Err(why) => {
            tracing::warn!(reason = %format!("{why:#}"), "google sign-in refused");
            redirect(
                &format!("{}/signin?error=google", web.app_base_url),
                vec![clear],
            )
        }
    }
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
}

#[derive(Deserialize)]
struct UserInfo {
    sub: String,
    email: Option<String>,
    email_verified: Option<Value>,
}

/// A callback whose state checked out: the flow it belongs to.
struct Flow {
    code: String,
    verifier: String,
    next: String,
    /// Set when a signed-in user is connecting Google to their account.
    link_user: Option<Uuid>,
}

/// A verified Google identity.
struct Identity {
    sub: String,
    email: String,
}

/// Why a callback was refused, and whether it belonged to a connect flow
/// (known only once the stored flow was claimed).
struct Refused {
    link_user: Option<Uuid>,
    why: anyhow::Error,
}

impl Refused {
    fn early(why: impl Into<anyhow::Error>) -> Self {
        Self {
            link_user: None,
            why: why.into(),
        }
    }
}

/// Check the returned state against this browser's cookie and claim the
/// stored flow exactly once. The flow is claimed before a provider error is
/// looked at, so a refusal at Google still lands on the right page.
async fn claim(
    state: &AppState,
    meta: &ClientMeta,
    headers: &HeaderMap,
    query: Option<CallbackQuery>,
) -> Result<Flow, Refused> {
    use anyhow::anyhow;

    state
        .limiter
        .check(rl::OAUTH_IP, meta.ip_key())
        .map_err(|_| Refused::early(anyhow!("rate limited")))?;
    let q = query.ok_or_else(|| Refused::early(anyhow!("unreadable query")))?;
    let returned_state = q.state.unwrap_or_default();
    let cookie_state = session::cookie_from_headers(headers, STATE_COOKIE).unwrap_or_default();
    if !token::looks_valid(&returned_state)
        || !token::ct_eq(returned_state.as_bytes(), cookie_state.as_bytes())
    {
        return Err(Refused::early(anyhow!("state does not match this browser")));
    }

    // Single use: whoever deletes the row owns the flow. Expired rows are
    // deleted too, then refused.
    let (verifier, next, expires_at, link_user): (String, String, DateTime<Utc>, Option<Uuid>) =
        sqlx::query_as(
            r#"
            delete from oauth_states where state_hash = $1 and provider = 'google'
            returning pkce_verifier, next_path, expires_at, link_user_id
            "#,
        )
        .bind(token::hash(&returned_state))
        .fetch_optional(&state.db)
        .await
        .map_err(Refused::early)?
        .ok_or_else(|| Refused::early(anyhow!("unknown or already used state")))?;
    let refuse = |why: anyhow::Error| Refused { link_user, why };
    if expires_at <= Utc::now() {
        return Err(refuse(anyhow!("state expired")));
    }
    if let Some(e) = q.error {
        let e: String = e.chars().filter(char::is_ascii_graphic).take(64).collect();
        return Err(refuse(anyhow!("provider returned error {e}")));
    }
    let code = q
        .code
        .filter(|c| !c.is_empty() && c.len() <= 2048)
        .ok_or_else(|| refuse(anyhow!("missing code")))?;
    Ok(Flow {
        code,
        verifier,
        next,
        link_user,
    })
}

/// Exchange the code (with the PKCE verifier) and read a verified identity.
async fn identify(state: &AppState, g: &GoogleConfig, flow: &Flow) -> anyhow::Result<Identity> {
    use anyhow::{anyhow, bail, Context};

    let http = reqwest::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .context("build http client")?;
    let resp = http
        .post(&g.token_url)
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", flow.code.as_str()),
            ("redirect_uri", redirect_uri(&state.config.web).as_str()),
            ("client_id", g.client_id.as_str()),
            ("client_secret", g.client_secret.as_str()),
            ("code_verifier", flow.verifier.as_str()),
        ])
        .send()
        .await
        .context("token request failed")?;
    if !resp.status().is_success() {
        bail!("token endpoint returned {}", resp.status());
    }
    let tokens: TokenResponse = resp.json().await.context("token response shape")?;

    let resp = http
        .get(&g.userinfo_url)
        .bearer_auth(&tokens.access_token)
        .send()
        .await
        .context("userinfo request failed")?;
    if !resp.status().is_success() {
        bail!("userinfo endpoint returned {}", resp.status());
    }
    let info: UserInfo = resp.json().await.context("userinfo response shape")?;
    if info.email_verified != Some(Value::Bool(true)) {
        bail!("email not verified by Google");
    }
    let sub = info.sub.trim();
    if sub.is_empty() || sub.len() > 255 || sub.chars().any(char::is_control) {
        bail!("unusable subject");
    }
    let email = validate::email("email", info.email.as_deref().unwrap_or(""))
        .map_err(|_| anyhow!("unusable email"))?;
    Ok(Identity {
        sub: sub.to_string(),
        email,
    })
}

/// Sign in (or up) with the identity and return the new session token.
async fn sign_in(
    state: &AppState,
    g: &GoogleConfig,
    meta: &ClientMeta,
    flow: &Flow,
) -> anyhow::Result<String> {
    use anyhow::anyhow;

    let who = identify(state, g, flow).await?;
    let user_id = resolve_user(&state.db, &who.sub, &who.email).await?;
    sqlx::query("update users set last_sign_in_at = now() where id = $1")
        .bind(user_id)
        .execute(&state.db)
        .await?;
    let raw = session::create(
        &state.db,
        user_id,
        meta.user_agent.as_deref(),
        meta.ip.as_deref(),
    )
    .await
    .map_err(|e| anyhow!("create session: {e}"))?;
    Ok(raw)
}

enum Linked {
    Connected,
    /// That Google account already belongs to another user.
    InUse,
}

/// Connect the identity to the signed-in user who started the flow. The
/// Google address may differ from the account's; the subject is what counts.
async fn link(state: &AppState, user_id: Uuid, who: &Identity) -> anyhow::Result<Linked> {
    let owner: Option<Uuid> = sqlx::query_scalar("select id from users where google_sub = $1")
        .bind(&who.sub)
        .fetch_optional(&state.db)
        .await?;
    match owner {
        Some(id) if id == user_id => return Ok(Linked::Connected),
        Some(_) => return Ok(Linked::InUse),
        None => {}
    }
    let res = sqlx::query("update users set google_sub = $2 where id = $1")
        .bind(user_id)
        .bind(&who.sub)
        .execute(&state.db)
        .await;
    match res {
        Ok(r) if r.rows_affected() == 1 => {}
        Ok(_) => anyhow::bail!("the account that started the flow is gone"),
        // Another account took this subject in the meantime.
        Err(sqlx::Error::Database(e)) if e.is_unique_violation() => return Ok(Linked::InUse),
        Err(e) => return Err(e.into()),
    }
    crate::notify::google_connected(state, user_id, &who.email).await;
    Ok(Linked::Connected)
}

/// Find or create the account for a verified Google identity.
///
/// An existing account whose email was never verified may have been
/// registered by someone who does not own the address. Google has just proven
/// who does, so that account is handed over: the password is cleared, every
/// session ends, and outstanding email links (a pending email change could
/// otherwise move the account away) and codes are spent.
async fn resolve_user(db: &sqlx::PgPool, sub: &str, email: &str) -> anyhow::Result<Uuid> {
    let mut tx = db.begin().await?;
    if let Some(id) = sqlx::query_scalar::<_, Uuid>("select id from users where google_sub = $1")
        .bind(sub)
        .fetch_optional(&mut *tx)
        .await?
    {
        tx.commit().await?;
        return Ok(id);
    }

    let existing: Option<(Uuid, Option<DateTime<Utc>>, Option<String>)> = sqlx::query_as(
        "select id, email_verified_at, google_sub from users where lower(email) = lower($1) for update",
    )
    .bind(email)
    .fetch_optional(&mut *tx)
    .await?;

    let id = match existing {
        Some((_, _, Some(_))) => {
            anyhow::bail!("this email is linked to a different Google account")
        }
        Some((id, Some(_), None)) => {
            sqlx::query("update users set google_sub = $2 where id = $1")
                .bind(id)
                .bind(sub)
                .execute(&mut *tx)
                .await?;
            id
        }
        Some((id, None, None)) => {
            sqlx::query(
                r#"
                update users set google_sub = $2, email_verified_at = now(), password_hash = null
                where id = $1
                "#,
            )
            .bind(id)
            .bind(sub)
            .execute(&mut *tx)
            .await?;
            sqlx::query("delete from sessions where user_id = $1")
                .bind(id)
                .execute(&mut *tx)
                .await?;
            sqlx::query(
                "update email_tokens set used_at = now() where user_id = $1 and used_at is null",
            )
            .bind(id)
            .execute(&mut *tx)
            .await?;
            sqlx::query("delete from verification_codes where user_id = $1")
                .bind(id)
                .execute(&mut *tx)
                .await?;
            id
        }
        None => {
            sqlx::query_scalar(
                r#"
                insert into users (email, password_hash, email_verified_at, google_sub)
                values ($1, null, now(), $2)
                returning id
                "#,
            )
            .bind(email)
            .bind(sub)
            .fetch_one(&mut *tx)
            .await?
        }
    };
    tx.commit().await?;
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn next_must_be_a_local_path() {
        assert_eq!(safe_next(Some("/jobs?x=1")), "/jobs?x=1");
        assert_eq!(safe_next(Some("/")), "/");
        for bad in [
            "",
            "jobs",
            "//evil.example",
            "/\\evil.example",
            "https://evil.example",
            "/a b",
            "/caf\u{e9}",
            "/x\r\nSet-Cookie: a=b",
        ] {
            assert_eq!(safe_next(Some(bad)), "/", "{bad:?}");
        }
        assert_eq!(safe_next(None), "/");
        assert_eq!(safe_next(Some(&format!("/{}", "a".repeat(600)))), "/");
    }
}
