//! Profile and preferences behind Onboarding, Profile and Settings.

mod common;

use axum::http::StatusCode;
use common::{Client, TestApp};
use serde_json::json;

async fn user<'a>(app: &'a TestApp, email: &str) -> Client<'a> {
    let c = app.client();
    c.post(
        "/v1/auth/signup",
        json!({ "email": email, "password": "a long enough passphrase" }),
    )
    .await;
    c
}

#[tokio::test]
async fn new_profile_has_sensible_defaults() {
    let app = TestApp::spawn().await;
    let c = user(&app, "ada@example.com").await;
    let res = c.get("/v1/profile").await;
    assert_eq!(res.status, StatusCode::OK);
    let p = &res.body["profile"];
    assert_eq!(p["paper_size"], "a4");
    assert_eq!(p["theme"], "system");
    assert_eq!(p["onboarding_step"], "upload");
    assert_eq!(p["notifications"]["follow_ups"], true);
    assert_eq!(p["notifications"]["product_news"], false);
    assert_eq!(p["target_roles"], json!([]));
}

#[tokio::test]
async fn patch_updates_only_what_is_sent() {
    let app = TestApp::spawn().await;
    let c = user(&app, "ada@example.com").await;
    let res = c
        .patch(
            "/v1/profile",
            json!({
                "full_name": "  Ada Okafor ",
                "location": "Lagos",
                "target_roles": ["Backend Engineer", "backend engineer", "Platform Engineer"],
                "work_settings": ["remote", "hybrid", "remote"],
                "paper_size": "letter",
                "notifications": { "product_news": true },
                "onboarding_step": "done"
            }),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.body);
    let p = &res.body["profile"];
    assert_eq!(p["full_name"], "Ada Okafor");
    assert_eq!(
        p["target_roles"],
        json!(["Backend Engineer", "Platform Engineer"])
    );
    assert_eq!(p["work_settings"], json!(["remote", "hybrid"]));
    assert_eq!(p["paper_size"], "letter");
    assert_eq!(p["notifications"]["product_news"], true);
    assert_eq!(p["notifications"]["follow_ups"], true, "untouched");

    // A second patch leaves earlier fields alone and can clear one.
    let res = c.patch("/v1/profile", json!({ "location": "" })).await;
    let p = &res.body["profile"];
    assert_eq!(p["location"], serde_json::Value::Null);
    assert_eq!(p["full_name"], "Ada Okafor");
    assert_eq!(p["paper_size"], "letter");
}

#[tokio::test]
async fn patch_rejects_bad_values() {
    let app = TestApp::spawn().await;
    let c = user(&app, "ada@example.com").await;
    for (body, field) in [
        (json!({ "paper_size": "a3" }), "paper_size"),
        (json!({ "theme": "neon" }), "theme"),
        (json!({ "work_settings": ["moon"] }), "work_settings"),
        (json!({ "onboarding_step": "skip" }), "onboarding_step"),
        (json!({ "full_name": "x".repeat(121) }), "full_name"),
        (json!({ "target_roles": vec!["r"; 11] }), "target_roles"),
    ] {
        let res = c.patch("/v1/profile", body.clone()).await;
        assert_eq!(res.status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
        assert_eq!(res.body["error"]["field"], field, "{body}");
    }
    let res = c
        .patch("/v1/profile", json!({ "favourite_colour": "red" }))
        .await;
    assert_eq!(
        res.status,
        StatusCode::BAD_REQUEST,
        "unknown fields are refused"
    );
}

#[tokio::test]
async fn profiles_are_per_user() {
    let app = TestApp::spawn().await;
    let a = user(&app, "a@example.com").await;
    let b = user(&app, "b@example.com").await;
    a.patch("/v1/profile", json!({ "full_name": "Ada" })).await;
    assert_eq!(
        b.get("/v1/profile").await.body["profile"]["full_name"],
        serde_json::Value::Null
    );
    assert_eq!(
        app.client().get("/v1/profile").await.status,
        StatusCode::UNAUTHORIZED
    );
}
