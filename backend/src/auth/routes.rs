//! Account endpoints under /v1/auth.
//!
//! Responses that could reveal whether an email has an account (forgot
//! password, resend verification) are identical either way. Sign-in failures
//! share one message and take the same time whether or not the email exists.

use axum::extract::{ConnectInfo, FromRequestParts, State};
use axum::http::request::Parts;
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgPool};
use std::net::SocketAddr;
use uuid::Uuid;

use super::{client_ip, code, password, session, token, CurrentUser};
use crate::error::AppError;
use crate::extract::{Json, Path};
use crate::mail;
use crate::rate_limit::{self as rl, RateLimiter};
use crate::validate;
use crate::AppState;

const VERIFY_TTL: Duration = Duration::hours(24);
const RESET_TTL: Duration = Duration::hours(1);
const CHANGE_EMAIL_TTL: Duration = Duration::hours(24);

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, FromRow)]
pub struct UserRow {
    pub id: Uuid,
    pub email: String,
    pub email_verified_at: Option<DateTime<Utc>>,
    pub plan: String,
    pub created_at: DateTime<Utc>,
    pub has_password: bool,
    pub google_connected: bool,
    pub password_changed_at: Option<DateTime<Utc>>,
}

/// Columns for `UserRow`, usable in select and returning lists.
pub const USER_COLS: &str = "id, email, email_verified_at, plan, created_at, \
    password_hash is not null as has_password, google_sub is not null as google_connected, \
    password_changed_at";

#[derive(Debug, Serialize)]
pub struct UserOut {
    pub id: Uuid,
    pub email: String,
    pub email_verified: bool,
    pub plan: String,
    pub created_at: DateTime<Utc>,
    pub has_password: bool,
    pub google_connected: bool,
    pub password_changed_at: Option<DateTime<Utc>>,
}

impl From<UserRow> for UserOut {
    fn from(u: UserRow) -> Self {
        UserOut {
            id: u.id,
            email: u.email,
            email_verified: u.email_verified_at.is_some(),
            plan: u.plan,
            created_at: u.created_at,
            has_password: u.has_password,
            google_connected: u.google_connected,
            password_changed_at: u.password_changed_at,
        }
    }
}

#[derive(Serialize)]
pub struct UserEnvelope {
    pub user: UserOut,
}

#[derive(Serialize)]
struct Ok {
    ok: bool,
}

/// IP and user agent of the caller, for sessions and rate limits.
pub struct ClientMeta {
    pub ip: Option<String>,
    pub user_agent: Option<String>,
}

impl FromRequestParts<AppState> for ClientMeta {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, AppError> {
        let peer = parts.extensions.get::<ConnectInfo<SocketAddr>>();
        Ok(ClientMeta {
            ip: client_ip(&parts.headers, peer, state.config.web.trust_proxy),
            user_agent: super::user_agent(&parts.headers).map(str::to_string),
        })
    }
}

impl ClientMeta {
    /// Rate-limit key for the caller. Without a known IP (tests, odd proxies)
    /// everyone shares one bucket, which errs on the side of limiting.
    pub(crate) fn ip_key(&self) -> &str {
        self.ip.as_deref().unwrap_or("unknown")
    }
}

fn limit(limiter: &RateLimiter, l: rl::Limit, key: &str) -> Result<(), AppError> {
    limiter.check(l, key)
}

fn with_cookie(status: StatusCode, cookie: HeaderValue, body: impl Serialize) -> Response {
    let mut resp = (status, Json(body)).into_response();
    resp.headers_mut().append(header::SET_COOKIE, cookie);
    resp
}

pub async fn load_user(db: &PgPool, id: Uuid) -> Result<UserRow, AppError> {
    sqlx::query_as::<_, UserRow>(&format!("select {USER_COLS} from users where id = $1"))
        .bind(id)
        .fetch_optional(db)
        .await?
        .ok_or(AppError::Unauthorized(
            "Your session has ended. Sign in again.",
        ))
}

/// Create a single-use email token and return (row id, raw token).
async fn create_email_token(
    db: &PgPool,
    user_id: Uuid,
    purpose: &str,
    ttl: Duration,
    new_email: Option<&str>,
) -> Result<(Uuid, String), AppError> {
    let raw = token::generate();
    let id: Uuid = sqlx::query_scalar(
        r#"
        insert into email_tokens (user_id, purpose, token_hash, new_email, expires_at)
        values ($1, $2, $3, $4, $5)
        returning id
        "#,
    )
    .bind(user_id)
    .bind(purpose)
    .bind(token::hash(&raw))
    .bind(new_email)
    .bind(Utc::now() + ttl)
    .fetch_one(db)
    .await?;
    Ok((id, raw))
}

#[derive(FromRow)]
struct ClaimedToken {
    user_id: Uuid,
    new_email: Option<String>,
}

/// Atomically mark a live token used and return its owner. Exactly one caller
/// can claim a token, so a double-clicked link cannot apply twice.
async fn claim_email_token(
    db: &PgPool,
    raw: &str,
    purpose: &str,
) -> Result<ClaimedToken, AppError> {
    let invalid = || {
        AppError::unprocessable(
            "token_invalid",
            "This link is invalid or has expired. Ask for a new one.",
        )
    };
    if !token::looks_valid(raw) {
        return Err(invalid());
    }
    sqlx::query_as::<_, ClaimedToken>(
        r#"
        update email_tokens set used_at = now()
        where token_hash = $1 and purpose = $2 and used_at is null and expires_at > now()
        returning user_id, new_email
        "#,
    )
    .bind(token::hash(raw))
    .bind(purpose)
    .fetch_optional(db)
    .await?
    .ok_or_else(invalid)
}

fn link(state: &AppState, path: &str, raw: &str) -> String {
    format!("{}{path}?token={raw}", state.config.web.app_base_url)
}

/// One email with both a fresh 6-digit code (replacing any earlier one) and
/// a new single-use link.
async fn send_verification(state: &AppState, user_id: Uuid, email: &str) -> Result<(), AppError> {
    let (id, raw) = create_email_token(&state.db, user_id, "verify", VERIFY_TTL, None).await?;
    let verify_code = code::issue(&state.db, user_id, code::Purpose::Verify).await?;
    let msg = mail::verify_email(
        email,
        &state.config.web.app_base_url,
        &verify_code,
        &link(state, "/verify-email", &raw),
        format!("verify-{id}"),
    );
    mail::send_best_effort(state.mailer.as_ref(), msg).await;
    Ok(())
}

// ---------------------------------------------------------------------------
// Sign up, sign in, sign out, me
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct Credentials {
    pub email: String,
    pub password: String,
}

/// POST /v1/auth/signup
pub async fn signup(
    State(state): State<AppState>,
    meta: ClientMeta,
    Json(req): Json<Credentials>,
) -> Result<Response, AppError> {
    limit(&state.limiter, rl::SIGNUP_IP, meta.ip_key())?;
    let email = validate::email("email", &req.email)?;
    password::check_policy(&req.password, &email)?;
    let hash = password::hash(&req.password).await?;

    let inserted = sqlx::query_as::<_, UserRow>(&format!(
        r#"
        insert into users (email, password_hash, password_changed_at) values ($1, $2, now())
        on conflict (lower(email)) do nothing
        returning {USER_COLS}
        "#
    ))
    .bind(&email)
    .bind(&hash)
    .fetch_optional(&state.db)
    .await?;
    let user = inserted.ok_or_else(|| {
        AppError::conflict(
            "email_taken",
            "An account with this email already exists. Sign in instead.",
        )
    })?;

    send_verification(&state, user.id, &user.email).await?;
    crate::devices::remember(&state, user.id, meta.user_agent.as_deref()).await;
    let raw = session::create(
        &state.db,
        user.id,
        meta.user_agent.as_deref(),
        meta.ip.as_deref(),
    )
    .await?;
    Ok(with_cookie(
        StatusCode::CREATED,
        session::set_cookie(&state.config.web, &raw),
        UserEnvelope { user: user.into() },
    ))
}

#[derive(FromRow)]
struct SignInRow {
    id: Uuid,
    password_hash: Option<String>,
}

/// POST /v1/auth/signin
pub async fn signin(
    State(state): State<AppState>,
    meta: ClientMeta,
    Json(req): Json<Credentials>,
) -> Result<Response, AppError> {
    limit(&state.limiter, rl::SIGNIN_IP, meta.ip_key())?;
    limit(&state.limiter, rl::SIGNIN_EMAIL, req.email.trim())?;
    let bad = || AppError::Unauthorized("That email and password do not match.");
    let Ok(email) = validate::email("email", &req.email) else {
        password::verify_dummy(&req.password).await;
        return Err(bad());
    };
    if req.password.chars().count() > password::MAX_LEN {
        return Err(bad());
    }
    let row = sqlx::query_as::<_, SignInRow>(
        "select id, password_hash from users where lower(email) = lower($1)",
    )
    .bind(&email)
    .fetch_optional(&state.db)
    .await?;

    let user_id = match row {
        Some(SignInRow {
            id,
            password_hash: Some(phc),
        }) => {
            if !password::verify(&req.password, &phc).await? {
                return Err(bad());
            }
            id
        }
        _ => {
            password::verify_dummy(&req.password).await;
            return Err(bad());
        }
    };

    sqlx::query("update users set last_sign_in_at = now() where id = $1")
        .bind(user_id)
        .execute(&state.db)
        .await?;
    crate::devices::signed_in(
        &state,
        user_id,
        meta.user_agent.as_deref(),
        meta.ip.as_deref(),
        crate::devices::Method::Password,
    )
    .await;
    let raw = session::create(
        &state.db,
        user_id,
        meta.user_agent.as_deref(),
        meta.ip.as_deref(),
    )
    .await?;
    let user = load_user(&state.db, user_id).await?;
    Ok(with_cookie(
        StatusCode::OK,
        session::set_cookie(&state.config.web, &raw),
        UserEnvelope { user: user.into() },
    ))
}

/// POST /v1/auth/signout. Always clears the cookie, signed in or not.
pub async fn signout(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
) -> Result<Response, AppError> {
    if let Some(raw) = session::token_from_headers(&headers) {
        if let Some(s) = session::lookup(&state.db, &raw).await? {
            session::revoke(&state.db, s.session_id).await?;
        }
    }
    let mut resp = StatusCode::NO_CONTENT.into_response();
    resp.headers_mut()
        .append(header::SET_COOKIE, session::clear_cookie(&state.config.web));
    Ok(resp)
}

/// GET /v1/auth/me
pub async fn me(State(state): State<AppState>, user: CurrentUser) -> Result<Response, AppError> {
    let u = load_user(&state.db, user.id).await?;
    Ok(Json(UserEnvelope { user: u.into() }).into_response())
}

// ---------------------------------------------------------------------------
// Email verification
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct TokenRequest {
    pub token: String,
}

/// POST /v1/auth/verify. Works without a session so the link can be opened
/// on another device.
pub async fn verify(
    State(state): State<AppState>,
    meta: ClientMeta,
    Json(req): Json<TokenRequest>,
) -> Result<Response, AppError> {
    limit(&state.limiter, rl::TOKEN_IP, meta.ip_key())?;
    let claimed = claim_email_token(&state.db, req.token.trim(), "verify").await?;
    sqlx::query(
        "update users set email_verified_at = coalesce(email_verified_at, now()) where id = $1",
    )
    .bind(claimed.user_id)
    .execute(&state.db)
    .await?;
    crate::notify::welcome(&state, claimed.user_id).await;
    Ok(Json(Ok { ok: true }).into_response())
}

#[derive(Deserialize)]
pub struct CodeRequest {
    pub code: String,
}

/// POST /v1/auth/verify-code. The signed-in user types the 6-digit code from
/// the email. Already verified answers 200 so a double submit is harmless.
pub async fn verify_code(
    State(state): State<AppState>,
    meta: ClientMeta,
    user: CurrentUser,
    Json(req): Json<CodeRequest>,
) -> Result<Response, AppError> {
    limit(&state.limiter, rl::VERIFY_CODE_IP, meta.ip_key())?;
    limit(&state.limiter, rl::VERIFY_CODE_USER, &user.id.to_string())?;
    if !user.is_verified() {
        match code::check(&state.db, user.id, code::Purpose::Verify, req.code.trim()).await? {
            code::Check::Matched => {
                sqlx::query(
                    "update users set email_verified_at = coalesce(email_verified_at, now()) where id = $1",
                )
                .bind(user.id)
                .execute(&state.db)
                .await?;
                crate::notify::welcome(&state, user.id).await;
            }
            code::Check::Wrong => {
                return Err(AppError::bad_field(
                    "invalid_code",
                    "code",
                    "That code is not right. Check the email and try again.",
                ))
            }
            code::Check::Gone => {
                return Err(AppError::coded(
                    StatusCode::GONE,
                    "code_expired",
                    "This code has expired. Ask for a new one.",
                ))
            }
        }
    }
    let u = load_user(&state.db, user.id).await?;
    Ok(Json(UserEnvelope { user: u.into() }).into_response())
}

/// POST /v1/auth/resend-verification
pub async fn resend_verification(
    State(state): State<AppState>,
    user: CurrentUser,
) -> Result<Response, AppError> {
    limit(&state.limiter, rl::RESEND_USER, &user.id.to_string())?;
    if !user.is_verified() {
        send_verification(&state, user.id, &user.email).await?;
    }
    Ok((StatusCode::ACCEPTED, Json(Ok { ok: true })).into_response())
}

// ---------------------------------------------------------------------------
// Password reset and change
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct ForgotRequest {
    pub email: String,
}

/// POST /v1/auth/forgot-password. Same 202 whether or not the account exists.
pub async fn forgot_password(
    State(state): State<AppState>,
    meta: ClientMeta,
    Json(req): Json<ForgotRequest>,
) -> Result<Response, AppError> {
    limit(&state.limiter, rl::FORGOT_IP, meta.ip_key())?;
    limit(&state.limiter, rl::FORGOT_EMAIL, req.email.trim())?;
    let accepted = (StatusCode::ACCEPTED, Json(Ok { ok: true })).into_response();
    let Ok(email) = validate::email("email", &req.email) else {
        return Ok(accepted);
    };
    let found: Option<(Uuid, String, bool)> = sqlx::query_as(
        // Google-only accounts have no password yet and may set one here; the
        // legacy owner (neither) stays unreachable.
        r#"
        select id, email, password_hash is not null from users
        where lower(email) = lower($1) and (password_hash is not null or google_sub is not null)
        "#,
    )
    .bind(&email)
    .fetch_optional(&state.db)
    .await?;
    if let Some((user_id, address, has_password)) = found {
        send_reset_link(&state, user_id, &address, has_password).await?;
    }
    Ok(accepted)
}

/// A single-use link to `/reset-password`: the reset email, or its "Set a
/// password" variant for an account that has none.
pub async fn send_reset_link(
    state: &AppState,
    user_id: Uuid,
    address: &str,
    has_password: bool,
) -> Result<(), AppError> {
    let (id, raw) = create_email_token(&state.db, user_id, "reset", RESET_TTL, None).await?;
    let url = link(state, "/reset-password", &raw);
    let key = format!("reset-{id}");
    let msg = if has_password {
        mail::reset_password(address, &state.config.web.app_base_url, &url, key)
    } else {
        mail::set_password(address, &state.config.web.app_base_url, &url, key)
    };
    mail::send_best_effort(state.mailer.as_ref(), msg).await;
    Ok(())
}

#[derive(Deserialize)]
pub struct ResetRequest {
    pub token: String,
    pub password: String,
}

/// POST /v1/auth/reset-password. Ends every existing session, then signs this
/// device in. Following the emailed link also proves the address, so the
/// email counts as verified.
pub async fn reset_password(
    State(state): State<AppState>,
    meta: ClientMeta,
    Json(req): Json<ResetRequest>,
) -> Result<Response, AppError> {
    limit(&state.limiter, rl::TOKEN_IP, meta.ip_key())?;
    if !token::looks_valid(req.token.trim()) {
        return Err(AppError::unprocessable(
            "token_invalid",
            "This link is invalid or has expired. Ask for a new one.",
        ));
    }
    // Check the policy before burning the token, so a too-short password does
    // not cost the user their link. The email is needed for the policy.
    let owner: Option<(Uuid, String)> = sqlx::query_as(
        r#"
        select u.id, u.email from email_tokens t join users u on u.id = t.user_id
        where t.token_hash = $1 and t.purpose = 'reset' and t.used_at is null and t.expires_at > now()
        "#,
    )
    .bind(token::hash(req.token.trim()))
    .fetch_optional(&state.db)
    .await?;
    if let Some((_, email)) = &owner {
        password::check_policy(&req.password, email)?;
    }
    let claimed = claim_email_token(&state.db, req.token.trim(), "reset").await?;
    let hash = password::hash(&req.password).await?;

    let mut tx = state.db.begin().await?;
    let first_password: bool = sqlx::query_scalar(
        r#"
        with old as (select password_hash from users where id = $1 for update)
        update users u set password_hash = $2, password_changed_at = now(),
            email_verified_at = coalesce(u.email_verified_at, now())
        from old where u.id = $1 returning old.password_hash is null
        "#,
    )
    .bind(claimed.user_id)
    .bind(&hash)
    .fetch_one(&mut *tx)
    .await?;
    sqlx::query("delete from sessions where user_id = $1")
        .bind(claimed.user_id)
        .execute(&mut *tx)
        .await?;
    // Any other outstanding reset links die with the old password.
    sqlx::query("update email_tokens set used_at = now() where user_id = $1 and purpose = 'reset' and used_at is null")
        .bind(claimed.user_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;

    crate::notify::password_changed(
        &state,
        claimed.user_id,
        meta.user_agent.as_deref(),
        first_password,
    )
    .await;
    // Following the emailed link proves the inbox, so this device joins the
    // list without an alert.
    crate::devices::remember(&state, claimed.user_id, meta.user_agent.as_deref()).await;
    let raw = session::create(
        &state.db,
        claimed.user_id,
        meta.user_agent.as_deref(),
        meta.ip.as_deref(),
    )
    .await?;
    let user = load_user(&state.db, claimed.user_id).await?;
    Ok(with_cookie(
        StatusCode::OK,
        session::set_cookie(&state.config.web, &raw),
        UserEnvelope { user: user.into() },
    ))
}

#[derive(Deserialize)]
pub struct ChangePasswordRequest {
    pub current_password: String,
    pub new_password: String,
}

async fn check_current_password(db: &PgPool, user_id: Uuid, given: &str) -> Result<(), AppError> {
    let phc: Option<String> = sqlx::query_scalar("select password_hash from users where id = $1")
        .bind(user_id)
        .fetch_optional(db)
        .await?
        .flatten();
    let ok = match phc {
        Some(phc) if given.chars().count() <= password::MAX_LEN => {
            password::verify(given, &phc).await?
        }
        _ => false,
    };
    if ok {
        Ok(())
    } else {
        Err(AppError::validation(
            "current_password",
            "That password is not right.",
        ))
    }
}

/// POST /v1/auth/change-password. Signs out every other device.
pub async fn change_password(
    State(state): State<AppState>,
    meta: ClientMeta,
    user: CurrentUser,
    Json(req): Json<ChangePasswordRequest>,
) -> Result<Response, AppError> {
    limit(
        &state.limiter,
        rl::PASSWORD_CHECK_USER,
        &user.id.to_string(),
    )?;
    check_current_password(&state.db, user.id, &req.current_password).await?;
    password::check_policy(&req.new_password, &user.email)?;
    let hash = password::hash(&req.new_password).await?;
    sqlx::query("update users set password_hash = $2, password_changed_at = now() where id = $1")
        .bind(user.id)
        .bind(&hash)
        .execute(&state.db)
        .await?;
    session::revoke_all_except(&state.db, user.id, Some(user.session_id)).await?;
    crate::notify::password_changed(&state, user.id, meta.user_agent.as_deref(), false).await;
    Ok(Json(Ok { ok: true }).into_response())
}

// ---------------------------------------------------------------------------
// Email change
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct ChangeEmailRequest {
    pub new_email: String,
    pub password: String,
}

async fn email_taken(db: &PgPool, email: &str) -> Result<bool, AppError> {
    Ok(sqlx::query_scalar::<_, bool>(
        "select exists(select 1 from users where lower(email) = lower($1))",
    )
    .bind(email)
    .fetch_one(db)
    .await?)
}

/// POST /v1/auth/change-email. Sends a confirmation link to the new address;
/// nothing changes until it is followed.
pub async fn change_email(
    State(state): State<AppState>,
    user: CurrentUser,
    Json(req): Json<ChangeEmailRequest>,
) -> Result<Response, AppError> {
    limit(
        &state.limiter,
        rl::PASSWORD_CHECK_USER,
        &user.id.to_string(),
    )?;
    check_current_password(&state.db, user.id, &req.password).await?;
    let new_email = validate::email("new_email", &req.new_email)?;
    if new_email == user.email {
        return Err(AppError::validation(
            "new_email",
            "That is already your email.",
        ));
    }
    if email_taken(&state.db, &new_email).await? {
        return Err(AppError::conflict(
            "email_taken",
            "Another account uses that email.",
        ));
    }
    let (id, raw) = create_email_token(
        &state.db,
        user.id,
        "change_email",
        CHANGE_EMAIL_TTL,
        Some(&new_email),
    )
    .await?;
    let msg = mail::confirm_new_email(
        &new_email,
        &state.config.web.app_base_url,
        &link(&state, "/confirm-email", &raw),
        format!("chemail-{id}"),
    );
    mail::send_best_effort(state.mailer.as_ref(), msg).await;
    Ok((StatusCode::ACCEPTED, Json(Ok { ok: true })).into_response())
}

/// POST /v1/auth/confirm-email
pub async fn confirm_email(
    State(state): State<AppState>,
    meta: ClientMeta,
    Json(req): Json<TokenRequest>,
) -> Result<Response, AppError> {
    limit(&state.limiter, rl::TOKEN_IP, meta.ip_key())?;
    let claimed = claim_email_token(&state.db, req.token.trim(), "change_email").await?;
    let new_email = claimed
        .new_email
        .ok_or_else(|| anyhow::anyhow!("change_email token without new_email"))?;
    let res: Result<Option<String>, sqlx::Error> = sqlx::query_scalar(
        r#"
        with old as (select email from users where id = $1 for update)
        update users u set email = $2, email_verified_at = now()
        from old where u.id = $1 returning old.email
        "#,
    )
    .bind(claimed.user_id)
    .bind(&new_email)
    .fetch_optional(&state.db)
    .await;
    match res {
        Ok(old_email) => {
            if let Some(old) = old_email.filter(|o| !o.eq_ignore_ascii_case(&new_email)) {
                crate::notify::email_changed(&state, claimed.user_id, &old, &new_email).await;
            }
            Ok(Json(Ok { ok: true }).into_response())
        }
        Err(sqlx::Error::Database(e)) if e.is_unique_violation() => Err(AppError::conflict(
            "email_taken",
            "Another account started using that email in the meantime.",
        )),
        Err(e) => Err(e.into()),
    }
}

// ---------------------------------------------------------------------------
// Sessions (signed-in devices)
// ---------------------------------------------------------------------------

#[derive(Serialize, FromRow)]
pub struct SessionOut {
    pub id: Uuid,
    pub user_agent: Option<String>,
    pub ip: Option<String>,
    pub created_at: DateTime<Utc>,
    pub last_seen_at: DateTime<Utc>,
    #[sqlx(skip)]
    pub current: bool,
}

#[derive(Serialize)]
struct SessionsEnvelope {
    sessions: Vec<SessionOut>,
}

/// GET /v1/auth/sessions
pub async fn list_sessions(
    State(state): State<AppState>,
    user: CurrentUser,
) -> Result<Response, AppError> {
    let mut sessions = sqlx::query_as::<_, SessionOut>(
        r#"
        select id, user_agent, ip, created_at, last_seen_at from sessions
        where user_id = $1 and expires_at > now() and absolute_expires_at > now()
        order by last_seen_at desc
        "#,
    )
    .bind(user.id)
    .fetch_all(&state.db)
    .await?;
    for s in &mut sessions {
        s.current = s.id == user.session_id;
    }
    Ok(Json(SessionsEnvelope { sessions }).into_response())
}

/// DELETE /v1/auth/sessions/{id}
pub async fn revoke_session(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<Uuid>,
) -> Result<Response, AppError> {
    let res = sqlx::query("delete from sessions where id = $1 and user_id = $2")
        .bind(id)
        .bind(user.id)
        .execute(&state.db)
        .await?;
    if res.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    Ok(StatusCode::NO_CONTENT.into_response())
}

/// POST /v1/auth/sessions/revoke-others
pub async fn revoke_other_sessions(
    State(state): State<AppState>,
    user: CurrentUser,
) -> Result<Response, AppError> {
    let n = session::revoke_all_except(&state.db, user.id, Some(user.session_id)).await?;
    Ok(Json(serde_json::json!({ "revoked": n })).into_response())
}
