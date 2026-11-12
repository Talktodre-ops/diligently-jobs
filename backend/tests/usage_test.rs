//! The metering gate around every AI call, and the monthly allowance.

mod common;

use axum::http::StatusCode;
use common::{Client, TestApp};
use diligently_api::ai::LlmRequest;
use diligently_api::error::AppError;
use diligently_api::usage;
use serde_json::json;
use uuid::Uuid;

async fn user(app: &TestApp) -> (Client<'_>, Uuid) {
    let c = app.client();
    c.post(
        "/v1/auth/signup",
        json!({ "email": "ada@example.com", "password": "a long enough passphrase" }),
    )
    .await;
    let id = c.get("/v1/auth/me").await.body["user"]["id"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    (c, id)
}

fn req() -> LlmRequest {
    LlmRequest {
        task: "probe",
        system: "s".into(),
        user_text: "u".into(),
        pdf_base64: None,
        schema: json!({}),
        max_tokens: 100,
        effort: "low",
    }
}

#[tokio::test]
async fn a_metered_call_lands_in_the_ledger_with_its_cost() {
    let app = TestApp::spawn().await;
    let (_, uid) = user(&app).await;
    app.ai.answer("probe", json!({ "ok": true }));
    let res = usage::call(&app.state, uid, None, req()).await.unwrap();
    assert_eq!(res.value["ok"], true);
    let (task, input, output, cost): (String, i64, i64, i64) = sqlx::query_as(
        "select task, input_tokens, output_tokens, cost_micros from ai_usage where user_id = $1",
    )
    .bind(uid)
    .fetch_one(&app.state.db)
    .await
    .unwrap();
    assert_eq!((task.as_str(), input, output), ("probe", 1000, 200));
    // The fake model is unknown, so it is priced at the high fallback rate.
    assert_eq!(cost, 1000 * 5 + 200 * 25);
}

#[tokio::test]
async fn kill_switch_refuses_without_calling_the_model() {
    let app = TestApp::spawn_with(|c| c.limits.ai_disabled = true).await;
    let (_, uid) = user(&app).await;
    app.ai.answer("probe", json!({}));
    let err = usage::call(&app.state, uid, None, req()).await.unwrap_err();
    assert!(matches!(
        err,
        AppError::Unavailable {
            code: "ai_unavailable",
            ..
        }
    ));
    assert_eq!(app.ai.calls("probe"), 0);
}

#[tokio::test]
async fn daily_platform_cap_stops_further_calls() {
    let app = TestApp::spawn_with(|c| c.limits.daily_cap_micros = 50_000).await;
    let (_, uid) = user(&app).await;
    app.ai.answer("probe", json!({}));
    sqlx::query(
        "insert into ai_usage (user_id, task, model, cost_micros) values ($1, 'x', 'm', 50000)",
    )
    .bind(uid)
    .execute(&app.state.db)
    .await
    .unwrap();
    assert!(usage::call(&app.state, uid, None, req()).await.is_err());
    assert_eq!(app.ai.calls("probe"), 0);

    // Yesterday's spend does not count.
    sqlx::query("update ai_usage set created_at = now() - interval '2 days'")
        .execute(&app.state.db)
        .await
        .unwrap();
    assert!(usage::call(&app.state, uid, None, req()).await.is_ok());
}

#[tokio::test]
async fn one_user_cannot_hammer_the_model() {
    let app = TestApp::spawn().await;
    let (_, uid) = user(&app).await;
    app.ai.answer("probe", json!({}));
    let mut limited = false;
    for _ in 0..41 {
        if let Err(AppError::RateLimited { .. }) = usage::call(&app.state, uid, None, req()).await {
            limited = true;
            break;
        }
    }
    assert!(limited);
    assert_eq!(app.ai.calls("probe"), 40);
}

#[tokio::test]
async fn failed_calls_record_no_usage_and_map_to_clear_codes() {
    let app = TestApp::spawn().await;
    let (_, uid) = user(&app).await;
    app.ai.fail(
        "probe",
        diligently_api::ai::LlmError::Refused {
            category: Some("cyber".into()),
        },
    );
    let err = usage::call(&app.state, uid, None, req()).await.unwrap_err();
    assert!(
        matches!(
            err,
            AppError::Unprocessable {
                code: "ai_declined",
                ..
            }
        ),
        "{err:?}"
    );
    let n: i64 = sqlx::query_scalar("select count(*) from ai_usage")
        .fetch_one(&app.state.db)
        .await
        .unwrap();
    assert_eq!(n, 0);
}

#[tokio::test]
async fn usage_endpoint_and_monthly_allowance() {
    let app = TestApp::spawn_with(|c| {
        c.limits.plan_limits.insert("free".into(), 2);
    })
    .await;
    let (c, uid) = user(&app).await;
    let res = c.get("/v1/usage").await;
    assert_eq!(res.status, StatusCode::OK);
    assert_eq!(res.body["plan"], "free");
    assert_eq!(res.body["applications_this_month"], 0);
    assert_eq!(res.body["monthly_limit"], 2);
    assert!(res.body["resets_on"].as_str().unwrap().ends_with("-01"));

    for _ in 0..2 {
        usage::ensure_can_start_application(&app.state, uid, "free")
            .await
            .unwrap();
        c.post("/v1/applications", json!({ "jd_raw": "JD" })).await;
    }
    let err = usage::ensure_can_start_application(&app.state, uid, "free")
        .await
        .unwrap_err();
    assert!(matches!(
        err,
        AppError::Unprocessable {
            code: "plan_limit_reached",
            ..
        }
    ));
    // Last month's applications do not count.
    sqlx::query("update applications set created_at = now() - interval '40 days'")
        .execute(&app.state.db)
        .await
        .unwrap();
    usage::ensure_can_start_application(&app.state, uid, "free")
        .await
        .unwrap();
}
