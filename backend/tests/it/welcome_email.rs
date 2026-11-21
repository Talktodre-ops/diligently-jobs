//! The two getting-started emails: a welcome once the address is confirmed,
//! and a note when the first tailored CV is ready. Each goes out once.

use crate::common;
use crate::fixture;

use axum::http::StatusCode;
use common::{verified_user, TestApp};
use fixture::{ready_user, started};
use serde_json::json;

const EMAIL: &str = "ada@example.com";

fn count(app: &TestApp, subject: &str) -> usize {
    app.mail
        .sent()
        .iter()
        .filter(|m| m.to == EMAIL && m.subject.starts_with(subject))
        .count()
}

#[tokio::test]
async fn confirming_the_email_sends_one_welcome() {
    let app = TestApp::spawn().await;
    let c = app.client();
    let res = c
        .post(
            "/v1/auth/signup",
            json!({ "email": EMAIL, "password": "a long enough passphrase" }),
        )
        .await;
    assert_eq!(res.status, StatusCode::CREATED, "{}", res.body);
    assert_eq!(
        count(&app, "Welcome"),
        0,
        "not before the address is confirmed"
    );

    // Type the code, then follow the link too: still one welcome.
    let code = app.mail.last_to(EMAIL).unwrap().subject[..6].to_string();
    let link = app.mail.last_to(EMAIL).unwrap().text;
    let r = c
        .post("/v1/auth/verify-code", json!({ "code": code }))
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let i = link.find("token=").unwrap() + 6;
    let r = c
        .post("/v1/auth/verify", json!({ "token": &link[i..i + 43] }))
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);

    assert_eq!(count(&app, "Welcome to Diligently"), 1);
    let mail = app.mail.last_to(EMAIL).unwrap();
    assert!(mail.text.contains("Tailor my first CV"), "{}", mail.text);
    assert!(!mail.text.contains('\u{2014}'), "no em dashes");
}

#[tokio::test]
async fn the_first_tailored_cv_is_announced_once() {
    let app = TestApp::spawn().await;
    let c = ready_user(&app, EMAIL).await;
    let first = started(&app, &c).await;

    assert_eq!(count(&app, "Your CV for"), 1);
    let mail = app
        .mail
        .sent()
        .into_iter()
        .rev()
        .find(|m| m.subject.starts_with("Your CV for"))
        .unwrap();
    assert!(
        mail.text.contains(&format!("/applications/{first}")),
        "{}",
        mail.text
    );
    assert!(mail.text.contains("cover letter"), "{}", mail.text);
    assert!(!mail.text.contains('\u{2014}'), "no em dashes");

    // The second job is not announced.
    started(&app, &c).await;
    assert_eq!(count(&app, "Your CV for"), 1);
}

#[tokio::test]
async fn people_who_joined_before_get_neither_email_late() {
    let app = TestApp::spawn().await;
    let c = verified_user(&app, EMAIL).await;
    // As the migration leaves an account that already had applications.
    sqlx::query("update users set first_cv_mailed_at = now() where email = $1")
        .bind(EMAIL)
        .execute(&app.state.db)
        .await
        .unwrap();
    let r = c
        .send(
            axum::http::Method::PUT,
            "/v1/cv/master",
            Some(json!({ "doc": fixture::master_cv() })),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    started(&app, &c).await;
    assert_eq!(count(&app, "Your CV for"), 0);
}
