//! The application pipeline: start, the five steps, progress, retries.

mod common;
#[path = "support/pipeline_fixture.rs"]
mod fixture;

use axum::http::StatusCode;
use common::{verified_user, TestApp};
use diligently_api::ai::LlmError;
use fixture::{answer_everything, ready_user, JD};
use serde_json::json;

async fn count(app: &TestApp, sql: &str, app_id: &str) -> i64 {
    sqlx::query_scalar(sql)
        .bind(app_id)
        .fetch_one(&app.state.db)
        .await
        .unwrap()
}

#[tokio::test]
async fn pasted_job_runs_every_step_and_reports_progress() {
    let app = TestApp::spawn().await;
    let c = ready_user(&app, "ada@example.com").await;
    answer_everything(&app);

    let res = c
        .post("/v1/applications/start", json!({ "jd_text": JD }))
        .await;
    assert_eq!(res.status, StatusCode::ACCEPTED, "{}", res.body);
    let app_id = res.body["application_id"].as_str().unwrap().to_string();
    let job_id = res.body["job_id"].as_str().unwrap().to_string();
    let steps = res.body["progress"].as_array().unwrap();
    assert_eq!(steps.len(), 5);
    assert!(steps.iter().all(|s| s["status"] == "pending"));

    assert_eq!(app.drain_jobs().await, 1);
    let job = c.get(&format!("/v1/jobs/{job_id}")).await;
    assert_eq!(job.body["status"], "done", "{}", job.body);
    assert!(
        job.body["progress"]
            .as_array()
            .unwrap()
            .iter()
            .all(|s| s["status"] == "done"),
        "{}",
        job.body
    );
    assert!(
        job.body.get("last_error").is_none(),
        "internal errors are not exposed"
    );

    let a = c.get(&format!("/v1/applications/{app_id}")).await.body;
    assert_eq!(a["company"], "Halcyon Health");
    assert_eq!(a["role"], "Senior Backend Engineer");

    let q = |t: &str| format!("select count(*) from {t} where application_id = $1::uuid");
    assert_eq!(count(&app, &q("application_gaps"), &app_id).await, 3);
    assert_eq!(count(&app, &q("tailored_bullets"), &app_id).await, 2);
    assert_eq!(count(&app, &q("company_research"), &app_id).await, 1);
    assert_eq!(count(&app, &q("cover_letters"), &app_id).await, 1);
    assert_eq!(count(&app, "select count(*) from ats_scores where application_id = $1::uuid and kind in ('before','projected')", &app_id).await, 2);
    // jd, score before, gaps, rewrites, projected score, research, letter.
    assert_eq!(
        count(
            &app,
            "select count(*) from ai_usage where application_id = $1::uuid",
            &app_id
        )
        .await,
        7
    );
}

#[tokio::test]
async fn options_can_skip_research_and_letter() {
    let app = TestApp::spawn().await;
    let c = ready_user(&app, "ada@example.com").await;
    answer_everything(&app);
    let res = c
        .post(
            "/v1/applications/start",
            json!({ "jd_text": JD, "research": false, "letter": false }),
        )
        .await;
    let job_id = res.body["job_id"].as_str().unwrap().to_string();
    app.drain_jobs().await;
    let job = c.get(&format!("/v1/jobs/{job_id}")).await;
    let status: Vec<&str> = job.body["progress"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["status"].as_str().unwrap())
        .collect();
    assert_eq!(status, vec!["done", "done", "done", "skipped", "skipped"]);
    assert_eq!(
        app.ai.calls("research_brief") + app.ai.calls("cover_letter"),
        0
    );
}

#[tokio::test]
async fn a_link_is_read_through_web_extract() {
    let app = TestApp::spawn().await;
    let c = ready_user(&app, "ada@example.com").await;
    answer_everything(&app);
    app.web.page("https://jobs.example.com/halcyon/123", JD);
    let res = c
        .post(
            "/v1/applications/start",
            json!({ "url": "https://jobs.example.com/halcyon/123" }),
        )
        .await;
    assert_eq!(res.status, StatusCode::ACCEPTED, "{}", res.body);
    let app_id = res.body["application_id"].as_str().unwrap().to_string();
    app.drain_jobs().await;
    let a = c.get(&format!("/v1/applications/{app_id}")).await.body;
    assert!(a["jd_raw"].as_str().unwrap().contains("Halcyon"));
    assert!(app.ai.requests()[0].user_text.contains("claims-processing"));
}

#[tokio::test]
async fn an_unreadable_link_fails_the_first_step() {
    let app = TestApp::spawn().await;
    let c = ready_user(&app, "ada@example.com").await;
    answer_everything(&app);
    app.web.unreadable("https://jobs.example.com/blocked");
    let res = c
        .post(
            "/v1/applications/start",
            json!({ "url": "https://jobs.example.com/blocked" }),
        )
        .await;
    let job_id = res.body["job_id"].as_str().unwrap().to_string();
    for _ in 0..2 {
        app.drain_jobs().await;
        sqlx::query("update jobs set scheduled_at = now()")
            .execute(&app.state.db)
            .await
            .unwrap();
    }
    let job = c.get(&format!("/v1/jobs/{job_id}")).await;
    assert_eq!(job.body["status"], "failed");
    assert_eq!(job.body["progress"][0]["status"], "failed");
    assert_eq!(app.ai.requests().len(), 0, "nothing paid for");
}

#[tokio::test]
async fn a_retry_does_not_repeat_finished_steps() {
    let app = TestApp::spawn().await;
    let c = ready_user(&app, "ada@example.com").await;
    answer_everything(&app);
    app.ai
        .fail("cover_letter", LlmError::Upstream("overloaded".into()));
    let res = c
        .post("/v1/applications/start", json!({ "jd_text": JD }))
        .await;
    let job_id = res.body["job_id"].as_str().unwrap().to_string();
    app.drain_jobs().await;
    let job = c.get(&format!("/v1/jobs/{job_id}")).await;
    assert_eq!(
        job.body["status"], "queued",
        "rescheduled for a second attempt"
    );
    assert_eq!(job.body["progress"][4]["status"], "failed");

    fixture::answer_everything(&app);
    sqlx::query("update jobs set scheduled_at = now()")
        .execute(&app.state.db)
        .await
        .unwrap();
    app.drain_jobs().await;
    let job = c.get(&format!("/v1/jobs/{job_id}")).await;
    assert_eq!(job.body["status"], "done", "{}", job.body);
    for task in ["jd_analysis", "gap_analysis", "rewrites", "research_brief"] {
        assert_eq!(
            app.ai.calls(task),
            1,
            "{task} ran once across both attempts"
        );
    }
    assert_eq!(
        app.ai.calls("ats_score"),
        2,
        "before and projected, once each"
    );
}

#[tokio::test]
async fn start_validates_input_and_prerequisites() {
    let app = TestApp::spawn_with(|cfg| {
        cfg.limits.plan_limits.insert("free".into(), 1);
    })
    .await;
    let unverified = app.client();
    unverified
        .post(
            "/v1/auth/signup",
            json!({ "email": "u@example.com", "password": "a long enough passphrase" }),
        )
        .await;
    assert_eq!(
        unverified
            .post("/v1/applications/start", json!({ "jd_text": JD }))
            .await
            .status,
        StatusCode::FORBIDDEN
    );

    let no_cv = verified_user(&app, "nocv@example.com").await;
    let res = no_cv
        .post("/v1/applications/start", json!({ "jd_text": JD }))
        .await;
    assert_eq!(res.body["error"]["code"], "no_master_cv");

    let c = ready_user(&app, "ada@example.com").await;
    for (body, field) in [
        (json!({ "jd_text": "too short" }), "jd_text"),
        (json!({}), "jd_text"),
        (json!({ "jd_text": JD, "url": "https://x.co/j" }), "jd_text"),
        (json!({ "url": "javascript:alert(1)" }), "url"),
    ] {
        let res = c.post("/v1/applications/start", body.clone()).await;
        assert_eq!(res.status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
        assert_eq!(res.body["error"]["field"], field, "{body}");
    }
    assert_eq!(
        c.post("/v1/applications/start", json!({ "jd_text": JD }))
            .await
            .status,
        StatusCode::ACCEPTED
    );
    let res = c
        .post("/v1/applications/start", json!({ "jd_text": JD }))
        .await;
    assert_eq!(res.body["error"]["code"], "plan_limit_reached");
}

#[tokio::test]
async fn a_zero_score_is_asked_again_and_never_stored() {
    let app = TestApp::spawn().await;
    let c = ready_user(&app, "ada@example.com").await;
    answer_everything(&app);
    app.ai.answer(
        "ats_score",
        json!({ "score": 0, "matched_keywords": ["Go"], "missing_keywords": [], "notes": "Strong match" }),
    );

    let res = c
        .post("/v1/applications/start", json!({ "jd_text": JD }))
        .await;
    let app_id = res.body["application_id"].as_str().unwrap().to_string();
    app.drain_jobs().await;

    assert_eq!(
        app.ai.calls("ats_score"),
        2,
        "one retry, then the step fails"
    );
    assert_eq!(
        count(
            &app,
            "select count(*) from ats_scores where application_id = $1::uuid",
            &app_id
        )
        .await,
        0,
        "a score of 0 is never stored"
    );
}
