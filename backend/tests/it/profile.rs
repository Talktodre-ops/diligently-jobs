//! Profile and preferences behind Onboarding, Profile and Settings.

use crate::common;

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

#[tokio::test]
async fn open_to_round_trips_and_clears() {
    let app = TestApp::spawn().await;
    let c = user(&app, "ada@example.com").await;
    assert_eq!(
        c.get("/v1/profile").await.body["profile"]["open_to"],
        serde_json::Value::Null,
        "unanswered until set"
    );
    let res = c
        .patch(
            "/v1/profile",
            json!({ "open_to": [" Remote anywhere ", "United Kingdom", "remote anywhere"] }),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.body);
    assert_eq!(
        res.body["profile"]["open_to"],
        json!(["Remote anywhere", "United Kingdom"])
    );
    assert_eq!(
        c.get("/v1/profile").await.body["profile"]["open_to"],
        json!(["Remote anywhere", "United Kingdom"])
    );

    // Another field alone leaves it as it was.
    let res = c.patch("/v1/profile", json!({ "location": "Lagos" })).await;
    assert_eq!(
        res.body["profile"]["open_to"],
        json!(["Remote anywhere", "United Kingdom"])
    );

    for clear in [json!(null), json!([])] {
        c.patch("/v1/profile", json!({ "open_to": ["Kenya"] }))
            .await;
        let res = c.patch("/v1/profile", json!({ "open_to": clear })).await;
        assert_eq!(res.status, StatusCode::OK, "{}", res.body);
        assert_eq!(
            res.body["profile"]["open_to"],
            serde_json::Value::Null,
            "{clear} clears"
        );
    }
}

#[tokio::test]
async fn open_to_errors_name_the_field() {
    let app = TestApp::spawn().await;
    let c = user(&app, "ada@example.com").await;
    for body in [
        json!({ "open_to": vec!["x"; 11] }),
        json!({ "open_to": ["x".repeat(81)] }),
        json!({ "open_to": ["  "] }),
        json!({ "open_to": [3] }),
        json!({ "open_to": "Remote" }),
    ] {
        let res = c.patch("/v1/profile", body.clone()).await;
        assert_eq!(res.status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
        assert_eq!(res.body["error"]["field"], "open_to", "{body}");
    }
    let ok = c
        .patch("/v1/profile", json!({ "open_to": ["x".repeat(80)] }))
        .await;
    assert_eq!(ok.status, StatusCode::OK, "80 characters is allowed");
}

#[tokio::test]
async fn first_job_is_an_onboarding_step() {
    let app = TestApp::spawn().await;
    let c = user(&app, "ada@example.com").await;
    let res = c
        .patch("/v1/profile", json!({ "onboarding_step": "first_job" }))
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.body);
    assert_eq!(res.body["profile"]["onboarding_step"], "first_job");
    let res = c
        .patch("/v1/profile", json!({ "onboarding_step": "done" }))
        .await;
    assert_eq!(res.body["profile"]["onboarding_step"], "done");
}

#[tokio::test]
async fn settings_groups_have_defaults_and_merge_field_by_field() {
    let app = TestApp::spawn().await;
    let c = user(&app, "ada@example.com").await;
    let p = c.get("/v1/profile").await.body["profile"].clone();
    assert_eq!(
        p["notifications"],
        json!({ "follow_ups": true, "weekly_summary": true, "running_low": true, "product_news": false })
    );
    assert!(p["notifications"].get("interview_prep").is_none());
    assert_eq!(
        p["reminders"],
        json!({ "follow_up_days": 7, "send_hour": 9, "time_zone": null, "skip_weekends": true })
    );
    assert_eq!(
        p["writing"],
        json!({ "spelling": null, "letter_tone": "direct" })
    );

    let res = c
        .patch(
            "/v1/profile",
            json!({
                "notifications": { "weekly_summary": false },
                "reminders": { "time_zone": "Africa/Lagos", "send_hour": 13 },
                "writing": { "spelling": "en-US" }
            }),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.body);
    let p = &res.body["profile"];
    assert_eq!(p["notifications"]["weekly_summary"], false);
    assert_eq!(p["notifications"]["running_low"], true, "untouched");
    assert_eq!(p["reminders"]["time_zone"], "Africa/Lagos");
    assert_eq!(p["reminders"]["send_hour"], 13);
    assert_eq!(p["reminders"]["follow_up_days"], 7, "untouched");
    assert_eq!(p["writing"]["spelling"], "en-US");

    let res = c
        .patch(
            "/v1/profile",
            json!({
                "reminders": { "follow_up_days": 14, "skip_weekends": false },
                "writing": { "spelling": null, "letter_tone": "warm" }
            }),
        )
        .await;
    let p = &res.body["profile"];
    assert_eq!(
        p["reminders"]["time_zone"], "Africa/Lagos",
        "absent keeps it"
    );
    assert_eq!(p["reminders"]["follow_up_days"], 14);
    assert_eq!(p["reminders"]["skip_weekends"], false);
    assert_eq!(p["writing"]["spelling"], serde_json::Value::Null);
    assert_eq!(p["writing"]["letter_tone"], "warm");

    let res = c
        .patch("/v1/profile", json!({ "reminders": { "time_zone": null } }))
        .await;
    assert_eq!(
        res.body["profile"]["reminders"]["time_zone"],
        serde_json::Value::Null
    );
}

#[tokio::test]
async fn settings_values_are_validated() {
    let app = TestApp::spawn().await;
    let c = user(&app, "ada@example.com").await;
    for (body, field) in [
        (
            json!({ "reminders": { "time_zone": "Mars/Olympus" } }),
            "time_zone",
        ),
        (json!({ "reminders": { "time_zone": "" } }), "time_zone"),
        (json!({ "reminders": { "time_zone": 3 } }), "time_zone"),
        (
            json!({ "reminders": { "follow_up_days": 6 } }),
            "follow_up_days",
        ),
        (json!({ "reminders": { "send_hour": 8 } }), "send_hour"),
        (json!({ "writing": { "spelling": "en-AU" } }), "spelling"),
        (
            json!({ "writing": { "letter_tone": "chirpy" } }),
            "letter_tone",
        ),
    ] {
        let res = c.patch("/v1/profile", body.clone()).await;
        assert_eq!(res.status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
        assert_eq!(res.body["error"]["code"], "invalid_input", "{body}");
        assert_eq!(res.body["error"]["field"], field, "{body}");
    }
    let gone = c
        .patch(
            "/v1/profile",
            json!({ "notifications": { "interview_prep": true } }),
        )
        .await;
    assert_eq!(
        gone.status,
        StatusCode::BAD_REQUEST,
        "interview_prep is gone"
    );
    let ok = c
        .patch(
            "/v1/profile",
            json!({ "reminders": { "time_zone": "America/Argentina/Buenos_Aires" } }),
        )
        .await;
    assert_eq!(ok.status, StatusCode::OK, "{}", ok.body);
}
