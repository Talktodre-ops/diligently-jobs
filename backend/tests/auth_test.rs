//! Account flows through the real router, database and session cookies.

mod common;

use axum::http::{header, Method, StatusCode};
use common::{Client, TestApp, APP_ORIGIN};
use serde_json::json;

const PW: &str = "a long enough passphrase";

fn token_from(text: &str) -> String {
    let i = text.find("token=").expect("link with token") + "token=".len();
    text[i..i + 43].to_string()
}

async fn signup(c: &Client<'_>, email: &str) -> common::TestResponse {
    c.post("/v1/auth/signup", json!({ "email": email, "password": PW }))
        .await
}

async fn verify_latest(app: &TestApp, c: &Client<'_>, email: &str) {
    let mail = app.mail.last_to(email).expect("verification email");
    let res = c
        .post(
            "/v1/auth/verify",
            json!({ "token": token_from(&mail.text) }),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.body);
}

// --- sign up -----------------------------------------------------------------

#[tokio::test]
async fn signup_creates_account_session_and_sends_verification() {
    let app = TestApp::spawn().await;
    let c = app.client();
    let res = signup(&c, "  Ada@Example.com ").await;
    assert_eq!(res.status, StatusCode::CREATED, "{}", res.body);
    assert_eq!(res.body["user"]["email"], "ada@example.com");
    assert_eq!(res.body["user"]["email_verified"], false);
    assert_eq!(res.body["user"]["plan"], "free");
    assert!(res.body["user"].get("password_hash").is_none());

    let cookie = res
        .headers
        .get(header::SET_COOKIE)
        .unwrap()
        .to_str()
        .unwrap();
    for flag in ["HttpOnly", "SameSite=Lax", "Secure", "Path=/"] {
        assert!(cookie.contains(flag), "{cookie}");
    }

    let me = c.get("/v1/auth/me").await;
    assert_eq!(me.status, StatusCode::OK);
    assert_eq!(me.body["user"]["email"], "ada@example.com");

    let mail = app
        .mail
        .last_to("ada@example.com")
        .expect("verification sent");
    assert!(mail
        .text
        .contains(&format!("{APP_ORIGIN}/verify-email?token=")));

    let stored: String = sqlx::query_scalar("select password_hash from users")
        .fetch_one(&app.state.db)
        .await
        .unwrap();
    assert!(stored.starts_with("$argon2id$"), "password stored hashed");
}

#[tokio::test]
async fn signup_rejects_duplicate_email_in_any_case() {
    let app = TestApp::spawn().await;
    assert_eq!(
        signup(&app.client(), "ada@example.com").await.status,
        StatusCode::CREATED
    );
    let res = signup(&app.client(), "ADA@example.com").await;
    assert_eq!(res.status, StatusCode::CONFLICT);
    assert_eq!(res.body["error"]["code"], "email_taken");
}

#[tokio::test]
async fn signup_validates_email_and_password() {
    let app = TestApp::spawn().await;
    let c = app.client();
    let res = c
        .post(
            "/v1/auth/signup",
            json!({ "email": "nope", "password": PW }),
        )
        .await;
    assert_eq!(res.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(res.body["error"]["field"], "email");

    let res = c
        .post(
            "/v1/auth/signup",
            json!({ "email": "ada@example.com", "password": "short" }),
        )
        .await;
    assert_eq!(res.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(res.body["error"]["field"], "password");
    assert!(c.session_token().is_none(), "no session on failure");
}

// --- sign in / out -------------------------------------------------------------

#[tokio::test]
async fn signin_with_right_password_starts_a_session() {
    let app = TestApp::spawn().await;
    signup(&app.client(), "ada@example.com").await;
    let c = app.client();
    let res = c
        .post(
            "/v1/auth/signin",
            json!({ "email": "ADA@example.com", "password": PW }),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.body);
    assert!(c.session_token().is_some());
    assert_eq!(c.get("/v1/auth/me").await.status, StatusCode::OK);
}

#[tokio::test]
async fn signin_failures_are_indistinguishable() {
    let app = TestApp::spawn().await;
    signup(&app.client(), "ada@example.com").await;
    let c = app.client();
    let wrong_pw = c
        .post(
            "/v1/auth/signin",
            json!({ "email": "ada@example.com", "password": "wrong password!!" }),
        )
        .await;
    let no_user = c
        .post(
            "/v1/auth/signin",
            json!({ "email": "ghost@example.com", "password": PW }),
        )
        .await;
    assert_eq!(wrong_pw.status, StatusCode::UNAUTHORIZED);
    assert_eq!(no_user.status, StatusCode::UNAUTHORIZED);
    assert_eq!(wrong_pw.body, no_user.body, "same message either way");
    assert!(c.session_token().is_none());
}

#[tokio::test]
async fn signout_revokes_the_session_server_side() {
    let app = TestApp::spawn().await;
    let c = app.client();
    signup(&c, "ada@example.com").await;
    let stolen = c.session_token().unwrap();

    let res = c.post("/v1/auth/signout", json!({})).await;
    assert_eq!(res.status, StatusCode::NO_CONTENT);
    assert!(c.session_token().is_none(), "cookie cleared");

    // Replaying the old cookie must not work: the row is gone, not just the cookie.
    let replay = app.client();
    replay.set_session_token(Some(stolen));
    assert_eq!(
        replay.get("/v1/auth/me").await.status,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn me_without_session_or_with_junk_cookie_is_401() {
    let app = TestApp::spawn().await;
    let c = app.client();
    assert_eq!(c.get("/v1/auth/me").await.status, StatusCode::UNAUTHORIZED);
    c.set_session_token(Some("garbage".into()));
    assert_eq!(c.get("/v1/auth/me").await.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn expired_session_is_rejected() {
    let app = TestApp::spawn().await;
    let c = app.client();
    signup(&c, "ada@example.com").await;
    sqlx::query("update sessions set expires_at = now() - interval '1 minute'")
        .execute(&app.state.db)
        .await
        .unwrap();
    assert_eq!(c.get("/v1/auth/me").await.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn auth_posts_need_the_app_origin() {
    let app = TestApp::spawn().await;
    let res = app
        .request(
            Method::POST,
            "/v1/auth/signin",
            Some(json!({ "email": "ada@example.com", "password": PW })),
            &[("origin", "https://evil.example")],
        )
        .await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
}

// --- verification --------------------------------------------------------------

#[tokio::test]
async fn verification_link_verifies_once() {
    let app = TestApp::spawn().await;
    let c = app.client();
    signup(&c, "ada@example.com").await;
    let token = token_from(&app.mail.last_to("ada@example.com").unwrap().text);

    // From another device, no session needed.
    let other = app.client();
    let res = other
        .post("/v1/auth/verify", json!({ "token": token }))
        .await;
    assert_eq!(res.status, StatusCode::OK);
    assert_eq!(
        c.get("/v1/auth/me").await.body["user"]["email_verified"],
        true
    );

    let again = other
        .post("/v1/auth/verify", json!({ "token": token }))
        .await;
    assert_eq!(again.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(again.body["error"]["code"], "token_invalid");
}

#[tokio::test]
async fn expired_or_bogus_verification_tokens_fail() {
    let app = TestApp::spawn().await;
    let c = app.client();
    signup(&c, "ada@example.com").await;
    let token = token_from(&app.mail.last_to("ada@example.com").unwrap().text);
    sqlx::query("update email_tokens set expires_at = now() - interval '1 second'")
        .execute(&app.state.db)
        .await
        .unwrap();
    assert_eq!(
        c.post("/v1/auth/verify", json!({ "token": token }))
            .await
            .status,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        c.post("/v1/auth/verify", json!({ "token": "x".repeat(43) }))
            .await
            .status,
        StatusCode::UNPROCESSABLE_ENTITY
    );
}

#[tokio::test]
async fn resend_verification_sends_a_new_working_link() {
    let app = TestApp::spawn().await;
    let c = app.client();
    signup(&c, "ada@example.com").await;
    let res = c.post("/v1/auth/resend-verification", json!({})).await;
    assert_eq!(res.status, StatusCode::ACCEPTED);
    assert_eq!(app.mail.sent().len(), 2);
    verify_latest(&app, &c, "ada@example.com").await;

    // Already verified: still 202, but nothing more is sent.
    c.post("/v1/auth/resend-verification", json!({})).await;
    assert_eq!(app.mail.sent().len(), 2);
}

// --- password reset ------------------------------------------------------------

#[tokio::test]
async fn forgot_password_is_enumeration_safe() {
    let app = TestApp::spawn().await;
    signup(&app.client(), "ada@example.com").await;
    let sent_before = app.mail.sent().len();
    let c = app.client();
    let known = c
        .post(
            "/v1/auth/forgot-password",
            json!({ "email": "ada@example.com" }),
        )
        .await;
    let unknown = c
        .post(
            "/v1/auth/forgot-password",
            json!({ "email": "ghost@example.com" }),
        )
        .await;
    let malformed = c
        .post(
            "/v1/auth/forgot-password",
            json!({ "email": "not an email" }),
        )
        .await;
    assert_eq!(known.status, StatusCode::ACCEPTED);
    assert_eq!(known.status, unknown.status);
    assert_eq!(known.body, unknown.body);
    assert_eq!(known.body, malformed.body);
    assert_eq!(
        app.mail.sent().len(),
        sent_before + 1,
        "only the real account gets mail"
    );
}

#[tokio::test]
async fn reset_password_changes_password_and_ends_other_sessions() {
    let app = TestApp::spawn().await;
    let laptop = app.client();
    signup(&laptop, "ada@example.com").await;

    let phone = app.client();
    phone
        .post(
            "/v1/auth/forgot-password",
            json!({ "email": "ada@example.com" }),
        )
        .await;
    let token = token_from(&app.mail.last_to("ada@example.com").unwrap().text);

    // A too-short password is refused without using up the link.
    let weak = phone
        .post(
            "/v1/auth/reset-password",
            json!({ "token": token, "password": "short" }),
        )
        .await;
    assert_eq!(weak.status, StatusCode::UNPROCESSABLE_ENTITY);

    let res = phone
        .post(
            "/v1/auth/reset-password",
            json!({ "token": token, "password": "a brand new passphrase" }),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.body);
    assert_eq!(
        res.body["user"]["email_verified"], true,
        "reset proves the inbox"
    );
    assert!(
        phone.session_token().is_some(),
        "resetting device is signed in"
    );
    assert_eq!(
        laptop.get("/v1/auth/me").await.status,
        StatusCode::UNAUTHORIZED
    );

    let notice = app.mail.last_to("ada@example.com").unwrap();
    assert_eq!(notice.subject, "Your Diligently password was changed");

    let c = app.client();
    let old = c
        .post(
            "/v1/auth/signin",
            json!({ "email": "ada@example.com", "password": PW }),
        )
        .await;
    assert_eq!(old.status, StatusCode::UNAUTHORIZED);
    let new = c
        .post(
            "/v1/auth/signin",
            json!({ "email": "ada@example.com", "password": "a brand new passphrase" }),
        )
        .await;
    assert_eq!(new.status, StatusCode::OK);

    let reuse = app
        .client()
        .post(
            "/v1/auth/reset-password",
            json!({ "token": token, "password": "yet another passphrase" }),
        )
        .await;
    assert_eq!(reuse.status, StatusCode::UNPROCESSABLE_ENTITY, "single use");
}

// --- change password / email -----------------------------------------------------

#[tokio::test]
async fn change_password_needs_current_and_keeps_only_this_device() {
    let app = TestApp::spawn().await;
    let a = app.client();
    signup(&a, "ada@example.com").await;
    let b = app.client();
    b.post(
        "/v1/auth/signin",
        json!({ "email": "ada@example.com", "password": PW }),
    )
    .await;

    let wrong = a
        .post("/v1/auth/change-password", json!({ "current_password": "nope nope nope", "new_password": "a brand new passphrase" }))
        .await;
    assert_eq!(wrong.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(wrong.body["error"]["field"], "current_password");

    let ok = a
        .post(
            "/v1/auth/change-password",
            json!({ "current_password": PW, "new_password": "a brand new passphrase" }),
        )
        .await;
    assert_eq!(ok.status, StatusCode::OK);
    assert_eq!(a.get("/v1/auth/me").await.status, StatusCode::OK);
    assert_eq!(b.get("/v1/auth/me").await.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn change_email_applies_only_after_confirmation() {
    let app = TestApp::spawn().await;
    let c = app.client();
    signup(&c, "ada@example.com").await;
    signup(&app.client(), "taken@example.com").await;

    let taken = c
        .post(
            "/v1/auth/change-email",
            json!({ "new_email": "TAKEN@example.com", "password": PW }),
        )
        .await;
    assert_eq!(taken.status, StatusCode::CONFLICT);

    let res = c
        .post(
            "/v1/auth/change-email",
            json!({ "new_email": "ada.new@example.com", "password": PW }),
        )
        .await;
    assert_eq!(res.status, StatusCode::ACCEPTED);
    assert_eq!(
        c.get("/v1/auth/me").await.body["user"]["email"],
        "ada@example.com"
    );

    let token = token_from(&app.mail.last_to("ada.new@example.com").unwrap().text);
    let res = c
        .post("/v1/auth/confirm-email", json!({ "token": token }))
        .await;
    assert_eq!(res.status, StatusCode::OK);
    let me = c.get("/v1/auth/me").await;
    assert_eq!(me.body["user"]["email"], "ada.new@example.com");
    assert_eq!(me.body["user"]["email_verified"], true);
}

// --- sessions list ---------------------------------------------------------------

#[tokio::test]
async fn sessions_list_marks_current_and_can_revoke_others() {
    let app = TestApp::spawn().await;
    let a = app.client();
    signup(&a, "ada@example.com").await;
    let b = app.client();
    b.post(
        "/v1/auth/signin",
        json!({ "email": "ada@example.com", "password": PW }),
    )
    .await;

    let list = a.get("/v1/auth/sessions").await;
    let sessions = list.body["sessions"].as_array().unwrap();
    assert_eq!(sessions.len(), 2);
    assert_eq!(sessions.iter().filter(|s| s["current"] == true).count(), 1);

    let res = a.post("/v1/auth/sessions/revoke-others", json!({})).await;
    assert_eq!(res.body["revoked"], 1);
    assert_eq!(b.get("/v1/auth/me").await.status, StatusCode::UNAUTHORIZED);
    assert_eq!(a.get("/v1/auth/me").await.status, StatusCode::OK);
}

#[tokio::test]
async fn cannot_revoke_another_users_session() {
    let app = TestApp::spawn().await;
    let ada = app.client();
    signup(&ada, "ada@example.com").await;
    let bo = app.client();
    signup(&bo, "bo@example.com").await;
    let bo_session = bo.get("/v1/auth/sessions").await.body["sessions"][0]["id"]
        .as_str()
        .unwrap()
        .to_string();

    let res = ada.delete(&format!("/v1/auth/sessions/{bo_session}")).await;
    assert_eq!(res.status, StatusCode::NOT_FOUND);
    assert_eq!(bo.get("/v1/auth/me").await.status, StatusCode::OK);
}
