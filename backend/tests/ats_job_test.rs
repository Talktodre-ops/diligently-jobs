//! The ATS score job on Claude: scores the master CV against the job,
//! records the score and the metered usage.

mod common;

use axum::http::{Method, StatusCode};
use common::{verified_user, TestApp};
use serde_json::json;

#[tokio::test]
async fn ats_job_scores_and_meters() {
    let app = TestApp::spawn().await;
    let c = verified_user(&app, "ada@example.com").await;
    let doc = json!({
        "header": { "name": "Ada Okafor", "title": "Backend Engineer" },
        "experience": [{ "role": "Engineer", "company": "Northfold", "start": "2021", "end": "Now",
                         "bullets": ["Built Go services on Postgres"] }]
    });
    c.send(Method::PUT, "/v1/cv/master", Some(json!({ "doc": doc })))
        .await;
    let app_id = c
        .post(
            "/v1/applications",
            json!({ "jd_raw": "Senior Backend Engineer. Go, Postgres, GraphQL." }),
        )
        .await
        .body["id"]
        .as_str()
        .unwrap()
        .to_string();
    app.ai.answer(
        "ats_score",
        json!({ "score": 74, "matched_keywords": ["Go", "Postgres"], "missing_keywords": ["GraphQL"], "notes": "No GraphQL." }),
    );

    let res = c
        .post(&format!("/v1/applications/{app_id}/ats-score"), json!({}))
        .await;
    assert_eq!(res.status, StatusCode::ACCEPTED);
    app.drain_jobs().await;

    let score = c.get(&format!("/v1/applications/{app_id}/ats-score")).await;
    assert_eq!(score.body["score"], 74, "{}", score.body);
    assert_eq!(
        score.body["breakdown"]["missing_keywords"],
        json!(["GraphQL"])
    );
    let req = &app.ai.requests()[0];
    assert!(req
        .user_text
        .contains("[E1.B1] Built Go services on Postgres"));
    assert!(req.user_text.contains("<job_description>"));
    let metered: i64 = sqlx::query_scalar(
        "select count(*) from ai_usage where task = 'ats_score' and application_id = $1::uuid",
    )
    .bind(&app_id)
    .fetch_one(&app.state.db)
    .await
    .unwrap();
    assert_eq!(metered, 1);
}
