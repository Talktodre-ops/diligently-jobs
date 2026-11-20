//! Setup milestones on Home: read from the account's data, hidden for a week
//! on request, and gone once everything is done.

mod common;
#[path = "support/pipeline_fixture.rs"]
mod fixture;

use axum::http::StatusCode;
use common::{verified_user, TestApp};
use fixture::{ready_user, started};
use serde_json::{json, Value};

fn done(h: &Value) -> [bool; 4] {
    let s = &h["setup"];
    [
        s["cv"].as_bool().unwrap(),
        s["check"].as_bool().unwrap(),
        s["targets"].as_bool().unwrap(),
        s["first_application"].as_bool().unwrap(),
    ]
}

#[tokio::test]
async fn a_new_account_has_every_milestone_left() {
    let app = TestApp::spawn().await;
    let c = verified_user(&app, "ada@example.com").await;
    let h = c.get("/v1/home").await.body;
    assert_eq!(done(&h), [false; 4]);
    assert_eq!(h["setup"]["show"], true);
    assert_eq!(h["setup"]["hidden_until"], Value::Null);
}

#[tokio::test]
async fn milestones_follow_the_data_however_it_got_there() {
    let app = TestApp::spawn().await;
    let c = ready_user(&app, "ada@example.com").await;
    assert_eq!(
        done(&c.get("/v1/home").await.body),
        [true, false, false, false]
    );

    let res = c.post("/v1/setup/cv-checked", json!({})).await;
    assert_eq!(res.status, StatusCode::NO_CONTENT);
    let res = c
        .patch(
            "/v1/profile",
            json!({ "target_roles": ["Backend Engineer"] }),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.body);
    assert_eq!(
        done(&c.get("/v1/home").await.body),
        [true, true, true, false]
    );

    started(&app, &c).await;
    let h = c.get("/v1/home").await.body;
    assert_eq!(done(&h), [true; 4]);
    assert_eq!(h["setup"]["show"], false, "nothing left, no card");
}

#[tokio::test]
async fn hide_keeps_the_card_away_for_a_week_then_it_returns() {
    let app = TestApp::spawn().await;
    let c = verified_user(&app, "ada@example.com").await;
    let res = c.post("/v1/setup/hide", json!({})).await;
    assert_eq!(res.status, StatusCode::NO_CONTENT);

    let h = c.get("/v1/home").await.body;
    assert_eq!(h["setup"]["show"], false);
    let until: chrono::DateTime<chrono::Utc> = h["setup"]["hidden_until"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    let days = (until - chrono::Utc::now()).num_hours() as f64 / 24.0;
    assert!((6.9..=7.0).contains(&days), "{days}");

    // A week later the card is back, because the setup is still unfinished.
    sqlx::query("update profiles set setup_hidden_until = now() - interval '1 minute'")
        .execute(&app.state.db)
        .await
        .unwrap();
    let h = c.get("/v1/home").await.body;
    assert_eq!(h["setup"]["show"], true);
    assert_eq!(h["setup"]["hidden_until"], Value::Null);
}

#[tokio::test]
async fn hiding_is_per_account() {
    let app = TestApp::spawn().await;
    let ada = verified_user(&app, "ada@example.com").await;
    let ben = verified_user(&app, "ben@example.com").await;
    ada.post("/v1/setup/hide", json!({})).await;
    assert_eq!(ada.get("/v1/home").await.body["setup"]["show"], false);
    assert_eq!(ben.get("/v1/home").await.body["setup"]["show"], true);
}

#[tokio::test]
async fn setup_actions_need_a_session() {
    let app = TestApp::spawn().await;
    let anon = app.client();
    assert_eq!(
        anon.post("/v1/setup/hide", json!({})).await.status,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        anon.post("/v1/setup/cv-checked", json!({})).await.status,
        StatusCode::UNAUTHORIZED
    );
}
