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

use super::{client_ip, password, session, token, CurrentUser};
use crate::error::AppError;
use crate::extract::{Json, Path};
use crate::mail;
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
}

#[derive(Debug, Serialize)]
pub struct UserOut {
    pub id: Uuid,
    pub email: String,
    pub email_verified: bool,
    pub plan: String,
    pub created_at: DateTime<Utc>,
}

impl From<UserRow> for UserOut {
    fn from(u: UserRow) -> Self {
        UserOut {
            id: u.id,
            email: u.email,
            email_verified: u.email_verified_at.is_some(),
            plan: u.plan,
            created_at: u.created_at,
        }
    }
}

#[derive(Serialize)]
struct UserEnvelope {
    user: UserOut,
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

fn with_cookie(status: StatusCode, cookie: HeaderValue, body: impl Serialize) -> Response {
    let mut resp = (status, Json(body)).into_response();
    resp.headers_mut().append(header::SET_COOKIE, cookie);
    resp
}

async fn load_user(db: &PgPool, id: Uuid) -> Result<UserRow, AppError> {
    sqlx::query_as::<_, UserRow>(
        "select id, email, email_verified_at, plan, created_at from users where id = $1",
    )
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

async fn send_verification(state: &AppState, user_id: Uuid, email: &str) -> Result<(), AppError> {
    let (id, raw) = create_email_token(&state.db, user_id, "verify", VERIFY_TTL, None).await?;
    let msg = mail::verify_email(
        email,
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
    let email = validate::email("email", &req.email)?;
    password::check_policy(&req.password, &email)?;
    let hash = password::hash(&req.password).await?;

    let inserted = sqlx::query_as::<_, UserRow>(
        r#"
        insert into users (email, password_hash) values ($1, $2)
        on conflict (lower(email)) do nothing
        returning id, email, email_verified_at, plan, created_at
        "#,
    )
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
    Json(req): Json<TokenRequest>,
) -> Result<Response, AppError> {
    let claimed = claim_email_token(&state.db, req.token.trim(), "verify").await?;
    sqlx::query(
        "update users set email_verified_at = coalesce(email_verified_at, now()) where id = $1",
    )
    .bind(claimed.user_id)
    .execute(&state.db)
    .await?;
    Ok(Json(Ok { ok: true }).into_response())
}

/// POST /v1/auth/resend-verification
pub async fn resend_verification(
    State(state): State<AppState>,
    user: CurrentUser,
) -> Result<Response, AppError> {
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
    Json(req): Json<ForgotRequest>,
) -> Result<Response, AppError> {
    let accepted = (StatusCode::ACCEPTED, Json(Ok { ok: true })).into_response();
    let Ok(email) = validate::email("email", &req.email) else {
        return Ok(accepted);
    };
    let found: Option<(Uuid, String)> = sqlx::query_as(
        "select id, email from users where lower(email) = lower($1) and password_hash is not null",
    )
    .bind(&email)
    .fetch_optional(&state.db)
    .await?;
    if let Some((user_id, address)) = found {
        let (id, raw) = create_email_token(&state.db, user_id, "reset", RESET_TTL, None).await?;
        let msg = mail::reset_password(
            &address,
            &link(&state, "/reset-password", &raw),
            format!("reset-{id}"),
        );
        mail::send_best_effort(state.mailer.as_ref(), msg).await;
    }
    Ok(accepted)
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
    let email: String = sqlx::query_scalar(
        r#"
        update users set password_hash = $2, email_verified_at = coalesce(email_verified_at, now())
        where id = $1 returning email
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

    mail::send_best_effort(
        state.mailer.as_ref(),
        mail::password_changed(&email, format!("pwchanged-{}", Uuid::new_v4())),
    )
    .await;
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
    user: CurrentUser,
    Json(req): Json<ChangePasswordRequest>,
) -> Result<Response, AppError> {
    check_current_password(&state.db, user.id, &req.current_password).await?;
    password::check_policy(&req.new_password, &user.email)?;
    let hash = password::hash(&req.new_password).await?;
    sqlx::query("update users set password_hash = $2 where id = $1")
        .bind(user.id)
        .bind(&hash)
        .execute(&state.db)
        .await?;
    session::revoke_all_except(&state.db, user.id, Some(user.session_id)).await?;
    mail::send_best_effort(
        state.mailer.as_ref(),
        mail::password_changed(&user.email, format!("pwchanged-{}", Uuid::new_v4())),
    )
    .await;
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
        &link(&state, "/confirm-email", &raw),
        format!("chemail-{id}"),
    );
    mail::send_best_effort(state.mailer.as_ref(), msg).await;
    Ok((StatusCode::ACCEPTED, Json(Ok { ok: true })).into_response())
}

/// POST /v1/auth/confirm-email
pub async fn confirm_email(
    State(state): State<AppState>,
    Json(req): Json<TokenRequest>,
) -> Result<Response, AppError> {
    let claimed = claim_email_token(&state.db, req.token.trim(), "change_email").await?;
    let new_email = claimed
        .new_email
        .ok_or_else(|| anyhow::anyhow!("change_email token without new_email"))?;
    let res = sqlx::query("update users set email = $2, email_verified_at = now() where id = $1")
        .bind(claimed.user_id)
        .bind(&new_email)
        .execute(&state.db)
        .await;
    match res {
        Ok(_) => Ok(Json(Ok { ok: true }).into_response()),
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
