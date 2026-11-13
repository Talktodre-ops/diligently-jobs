//! The 6-digit verification code sent alongside the email link.

mod common;

use axum::http::{Method, StatusCode};
use common::{Client, TestApp, APP_ORIGIN};
use serde_json::json;

const PW: &str = "a long enough passphrase";
const EMAIL: &str = "ada@example.com";

async fn signup<'a>(app: &'a TestApp) -> Client<'a> {
    let c = app.client();
    let res = c
        .post("/v1/auth/signup", json!({ "email": EMAIL, "password": PW }))
        .await;
    assert_eq!(res.status, StatusCode::CREATED, "{}", res.body);
    c
}

/// The code from the newest email's subject, `<code> is your Diligently code`.
fn latest_code(app: &TestApp) -> String {
    let mail = app.mail.last_to(EMAIL).expect("verification email");
    mail.subject[..6].to_string()
}

fn another_code(code: &str) -> String {
    let n: u32 = code.parse().unwrap();
    format!("{:06}", (n + 1) % 1_000_000)
}

async fn submit(c: &Client<'_>, code: &str) -> common::TestResponse {
    c.post("/v1/auth/verify-code", json!({ "code": code }))
        .await
}

#[tokio::test]
async fn one_email_carries_the_code_on_its_own_line_and_the_link() {
    let app = TestApp::spawn().await;
    signup(&app).await;
    let sent = app.mail.sent();
    assert_eq!(sent.len(), 1, "one email, not two");
    let mail = &sent[0];
    let code = latest_code(&app);
    assert!(code.bytes().all(|b| b.is_ascii_digit()), "{code}");
    assert_eq!(mail.subject, format!("{code} is your Diligently code"));
    let line = mail
        .text
        .lines()
        .position(|l| l == code)
        .expect("code on its own line");
    let link = mail
        .text
        .lines()
        .position(|l| l.contains(&format!("{APP_ORIGIN}/verify-email?token=")))
        .expect("link in the email");
    assert!(line < link, "code comes before the link");

    let stored: Vec<u8> = sqlx::query_scalar("select code_hash from verification_codes")
        .fetch_one(&app.state.db)
        .await
        .unwrap();
    assert_eq!(stored.len(), 32);
    assert_ne!(stored, code.as_bytes(), "only a hash is stored");
}

#[tokio::test]
async fn the_right_code_verifies_and_a_second_submit_still_answers_200() {
    let app = TestApp::spawn().await;
    let c = signup(&app).await;
    let code = latest_code(&app);
    let res = submit(&c, &code).await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.body);
    assert_eq!(res.body["user"]["email"], EMAIL);
    assert_eq!(res.body["user"]["email_verified"], true);
    assert_eq!(
        c.get("/v1/auth/me").await.body["user"]["email_verified"],
        true
    );
    let left: i64 = sqlx::query_scalar("select count(*) from verification_codes")
        .fetch_one(&app.state.db)
        .await
        .unwrap();
    assert_eq!(left, 0, "a used code is gone");

    // Already verified: 200 with the user, whatever the code.
    let again = submit(&c, "000000").await;
    assert_eq!(again.status, StatusCode::OK, "{}", again.body);
    assert_eq!(again.body["user"]["email_verified"], true);
}

#[tokio::test]
async fn a_wrong_code_is_400_on_the_code_field() {
    let app = TestApp::spawn().await;
    let c = signup(&app).await;
    let code = latest_code(&app);
    for wrong in [another_code(&code), "12ab56".to_string()] {
        let res = submit(&c, &wrong).await;
        assert_eq!(res.status, StatusCode::BAD_REQUEST, "{}", res.body);
        assert_eq!(res.body["error"]["code"], "invalid_code");
        assert_eq!(res.body["error"]["field"], "code");
    }
    assert_eq!(
        c.get("/v1/auth/me").await.body["user"]["email_verified"],
        false
    );
}

#[tokio::test]
async fn five_wrong_attempts_burn_the_code() {
    let app = TestApp::spawn().await;
    let c = signup(&app).await;
    let code = latest_code(&app);
    for _ in 0..5 {
        let res = submit(&c, &another_code(&code)).await;
        assert_eq!(res.status, StatusCode::BAD_REQUEST, "{}", res.body);
    }
    let res = submit(&c, &code).await;
    assert_eq!(res.status, StatusCode::GONE, "{}", res.body);
    assert_eq!(res.body["error"]["code"], "code_expired");
    assert_eq!(
        c.get("/v1/auth/me").await.body["user"]["email_verified"],
        false
    );
}

#[tokio::test]
async fn an_expired_code_is_410() {
    let app = TestApp::spawn().await;
    let c = signup(&app).await;
    let code = latest_code(&app);
    sqlx::query("update verification_codes set expires_at = now() - interval '1 minute'")
        .execute(&app.state.db)
        .await
        .unwrap();
    let res = submit(&c, &code).await;
    assert_eq!(res.status, StatusCode::GONE, "{}", res.body);
    assert_eq!(res.body["error"]["code"], "code_expired");
}

#[tokio::test]
async fn the_code_expires_after_thirty_minutes() {
    let app = TestApp::spawn().await;
    signup(&app).await;
    let minutes: f64 = sqlx::query_scalar(
        "select extract(epoch from (expires_at - created_at))::float8 / 60 from verification_codes",
    )
    .fetch_one(&app.state.db)
    .await
    .unwrap();
    assert!((29.9..=30.1).contains(&minutes), "{minutes}");
}

#[tokio::test]
async fn resend_replaces_the_old_code() {
    let app = TestApp::spawn().await;
    let c = signup(&app).await;
    let mut old = latest_code(&app);
    let mut new = old.clone();
    // One in a million the new code equals the old; send again if so.
    for _ in 0..3 {
        let res = c.post("/v1/auth/resend-verification", json!({})).await;
        assert_eq!(res.status, StatusCode::ACCEPTED, "{}", res.body);
        new = latest_code(&app);
        if new != old {
            break;
        }
        old = new.clone();
    }
    assert_ne!(old, new);
    let mail = app.mail.last_to(EMAIL).unwrap();
    assert!(
        mail.text.contains("/verify-email?token="),
        "resend has the link too"
    );

    let res = submit(&c, &old).await;
    assert_eq!(
        res.status,
        StatusCode::BAD_REQUEST,
        "old code no longer works"
    );
    assert_eq!(res.body["error"]["code"], "invalid_code");
    let res = submit(&c, &new).await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.body);
}

#[tokio::test]
async fn the_link_still_works_alongside_the_code() {
    let app = TestApp::spawn().await;
    let c = signup(&app).await;
    let mail = app.mail.last_to(EMAIL).unwrap();
    let i = mail.text.find("token=").unwrap() + 6;
    let res = c
        .post("/v1/auth/verify", json!({ "token": &mail.text[i..i + 43] }))
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.body);
    assert_eq!(
        c.get("/v1/auth/me").await.body["user"]["email_verified"],
        true
    );
}

#[tokio::test]
async fn needs_a_session_and_the_app_origin() {
    let app = TestApp::spawn().await;
    let c = signup(&app).await;
    let code = latest_code(&app);
    let anon = submit(&app.client(), &code).await;
    assert_eq!(anon.status, StatusCode::UNAUTHORIZED);

    let cookie = format!("dl_session={}", c.session_token().unwrap());
    let res = app
        .request(
            Method::POST,
            "/v1/auth/verify-code",
            Some(json!({ "code": code })),
            &[("cookie", &cookie), ("origin", "https://evil.example")],
        )
        .await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
    assert_eq!(res.body["error"]["code"], "origin_not_allowed");
}

#[tokio::test]
async fn checks_are_rate_limited_per_user() {
    let app = TestApp::spawn().await;
    let c = signup(&app).await;
    let code = latest_code(&app);
    let wrong = another_code(&code);
    let mut last = None;
    for _ in 0..11 {
        last = Some(submit(&c, &wrong).await);
    }
    let res = last.unwrap();
    assert_eq!(res.status, StatusCode::TOO_MANY_REQUESTS, "{}", res.body);
    assert_eq!(res.body["error"]["code"], "rate_limited");
    assert!(res.headers.contains_key("retry-after"));
}
