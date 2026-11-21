//! Unsubscribe links: no session, a token per user, one kind at a time.

use crate::common;

use axum::http::{header, Method, StatusCode};
use common::{verified_user, TestApp};
use serde_json::json;

async fn token(app: &TestApp, email: &str) -> String {
    sqlx::query_scalar("select unsubscribe_token from users where email = $1")
        .bind(email)
        .fetch_one(&app.state.db)
        .await
        .unwrap()
}

#[tokio::test]
async fn tokens_are_random_and_unique() {
    let app = TestApp::spawn().await;
    verified_user(&app, "ada.okafor@gmail.com").await;
    verified_user(&app, "bo@example.com").await;
    let a = token(&app, "ada.okafor@gmail.com").await;
    let b = token(&app, "bo@example.com").await;
    assert_eq!(a.len(), 64);
    assert!(a.bytes().all(|c| c.is_ascii_hexdigit()));
    assert_ne!(a, b);
}

#[tokio::test]
async fn unsubscribe_and_undo_without_signing_in() {
    let app = TestApp::spawn().await;
    let c = verified_user(&app, "ada.okafor@gmail.com").await;
    let t = token(&app, "ada.okafor@gmail.com").await;
    // A fresh browser: no cookie, and the web app's origin.
    let anon = app.client();

    let res = anon
        .post(
            "/v1/email/unsubscribe",
            json!({ "token": t, "kind": "weekly_summary" }),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.body);
    assert_eq!(
        res.body,
        json!({ "kind": "weekly_summary", "email": "ad***@gmail.com" })
    );
    let n = &c.get("/v1/profile").await.body["profile"]["notifications"];
    assert_eq!(n["weekly_summary"], false);
    assert_eq!(n["follow_ups"], true, "other kinds untouched");

    let res = anon
        .post(
            "/v1/email/resubscribe",
            json!({ "token": t, "kind": "weekly_summary" }),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK);
    assert_eq!(res.body["email"], "ad***@gmail.com");
    assert_eq!(
        c.get("/v1/profile").await.body["profile"]["notifications"]["weekly_summary"],
        true
    );
}

#[tokio::test]
async fn one_click_works_with_a_form_post_and_no_origin() {
    let app = TestApp::spawn().await;
    let c = verified_user(&app, "ada@example.com").await;
    let t = token(&app, "ada@example.com").await;
    // What Gmail sends: a form body and no Origin header or cookie.
    let req = axum::http::Request::builder()
        .method(Method::POST)
        .uri(format!(
            "/v1/email/unsubscribe/one-click?token={t}&kind=follow_ups"
        ))
        .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
        .body(axum::body::Body::from("List-Unsubscribe=One-Click"))
        .unwrap();
    use tower::ServiceExt;
    let resp = app.router.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    use http_body_util::BodyExt;
    let body = resp.into_body().collect().await.unwrap().to_bytes();
    assert!(body.is_empty());
    assert_eq!(
        c.get("/v1/profile").await.body["profile"]["notifications"]["follow_ups"],
        false
    );
}

#[tokio::test]
async fn unknown_tokens_and_kinds_are_refused() {
    let app = TestApp::spawn().await;
    verified_user(&app, "ada@example.com").await;
    let t = token(&app, "ada@example.com").await;
    let anon = app.client();

    for bad in ["0".repeat(64), "".to_string(), "x".repeat(500)] {
        let res = anon
            .post(
                "/v1/email/unsubscribe",
                json!({ "token": bad, "kind": "follow_ups" }),
            )
            .await;
        assert_eq!(res.status, StatusCode::NOT_FOUND);
        assert_eq!(res.body["error"]["code"], "not_found");
    }
    let res = app
        .request(
            Method::POST,
            &format!(
                "/v1/email/unsubscribe/one-click?token={}&kind=follow_ups",
                "f".repeat(64)
            ),
            None,
            &[],
        )
        .await;
    assert_eq!(res.status, StatusCode::NOT_FOUND);

    for kind in ["interview_prep", "everything", ""] {
        let res = anon
            .post("/v1/email/unsubscribe", json!({ "token": t, "kind": kind }))
            .await;
        assert_eq!(res.status, StatusCode::BAD_REQUEST, "{kind}");
        assert_eq!(res.body["error"]["field"], "kind");
    }
}
