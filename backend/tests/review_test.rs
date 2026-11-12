//! Workspace brief, Review decisions, the tailored CV and rescoring.

mod common;
#[path = "support/pipeline_fixture.rs"]
mod fixture;

use axum::http::StatusCode;
use common::TestApp;
use fixture::{ready_user, started};
use serde_json::{json, Value};

fn rewrite_ids(v: &Value) -> Vec<String> {
    v["rewrites"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["id"].as_str().unwrap().to_string())
        .collect()
}

#[tokio::test]
async fn brief_summarises_the_workspace() {
    let app = TestApp::spawn().await;
    let c = ready_user(&app, "ada@example.com").await;
    let id = started(&app, &c).await;
    let b = c.get(&format!("/v1/applications/{id}/brief")).await;
    assert_eq!(b.status, StatusCode::OK, "{}", b.body);
    let b = b.body;
    assert_eq!(b["application"]["company"], "Halcyon Health");
    assert_eq!(b["pipeline"]["status"], "done");
    assert_eq!(b["score"]["before"], 72);
    assert_eq!(b["score"]["current"], 72, "nothing accepted yet");
    assert_eq!(b["score"]["pending"], 3, "two rewrites and the summary");
    assert_eq!(b["rewrites"]["total"], 2);
    assert_eq!(b["gaps"]["missing"], 2);
    assert_eq!(b["gaps"]["top"][0], "GraphQL API design");
    assert_eq!(b["research"]["talking_points"], 1);
    assert_eq!(b["letter"]["tone"], "direct");
}

#[tokio::test]
async fn decisions_shape_the_tailored_cv_and_the_score() {
    let app = TestApp::spawn().await;
    let c = ready_user(&app, "ada@example.com").await;
    let id = started(&app, &c).await;
    // Make the projected score differ from the before score.
    sqlx::query("update ats_scores set score = 90 where kind = 'projected'")
        .execute(&app.state.db)
        .await
        .unwrap();

    let list = c.get(&format!("/v1/applications/{id}/rewrites")).await.body;
    assert_eq!(
        list["summary"]["original"],
        "Backend engineer with 7 years in payments."
    );
    assert_eq!(list["rewrites"][1]["needs_number"], true);
    let ids = rewrite_ids(&list);

    let r = c
        .patch(
            &format!("/v1/rewrites/{}", ids[0]),
            json!({ "action": "accept" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(r.body["score"]["current"], 78, "72 + 18 * 1/3");
    let r = c
        .patch(&format!("/v1/rewrites/{}", ids[1]), json!({ "action": "edit", "text": "Designed Postgres partitioning for 400M rows, p95 queries under 50ms" }))
        .await;
    assert_eq!(r.body["rewrite"]["status"], "edited");
    let r = c
        .patch(
            &format!("/v1/applications/{id}/summary"),
            json!({ "action": "keep" }),
        )
        .await;
    assert_eq!(r.body["score"]["pending"], 0);
    assert_eq!(r.body["score"]["current"], 84);

    let cv = c.get(&format!("/v1/applications/{id}/cv")).await.body;
    let bullets = &cv["doc"]["experience"][0]["bullets"];
    assert_eq!(
        bullets[0],
        "Cut claims-style reconciliation time 60% with Go Kafka consumers"
    );
    assert!(
        bullets[1]
            .as_str()
            .unwrap()
            .contains("p95 queries under 50ms"),
        "the user's own edit"
    );
    assert_eq!(
        cv["doc"]["summary"], "Backend engineer with 7 years in payments.",
        "summary kept"
    );
    assert_eq!(cv["paper_size"], "a4");

    // Keep reverts a bullet to the master text.
    c.patch(
        &format!("/v1/rewrites/{}", ids[0]),
        json!({ "action": "keep" }),
    )
    .await;
    let cv = c.get(&format!("/v1/applications/{id}/cv")).await.body;
    assert_eq!(
        cv["doc"]["experience"][0]["bullets"][0],
        "Cut ledger reconciliation time by 60% with Kafka consumers in Go"
    );

    // The master CV is never touched.
    let master = c.get("/v1/cv/master").await.body;
    assert_eq!(
        master["cv"]["doc"]["experience"][0]["bullets"][1],
        "Designed Postgres partitioning for 400M rows"
    );
}

#[tokio::test]
async fn bad_decisions_are_refused() {
    let app = TestApp::spawn().await;
    let c = ready_user(&app, "ada@example.com").await;
    let id = started(&app, &c).await;
    let ids = rewrite_ids(&c.get(&format!("/v1/applications/{id}/rewrites")).await.body);
    for body in [
        json!({ "action": "maybe" }),
        json!({ "action": "edit" }),
        json!({ "action": "edit", "text": "x".repeat(601) }),
    ] {
        let r = c
            .patch(&format!("/v1/rewrites/{}", ids[0]), body.clone())
            .await;
        assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    }
}

#[tokio::test]
async fn rescore_scores_the_decided_version_once() {
    let app = TestApp::spawn().await;
    let c = ready_user(&app, "ada@example.com").await;
    let id = started(&app, &c).await;
    let ids = rewrite_ids(&c.get(&format!("/v1/applications/{id}/rewrites")).await.body);
    c.patch(
        &format!("/v1/rewrites/{}", ids[0]),
        json!({ "action": "accept" }),
    )
    .await;

    let r1 = c
        .post(&format!("/v1/applications/{id}/rescore"), json!({}))
        .await;
    let r2 = c
        .post(&format!("/v1/applications/{id}/rescore"), json!({}))
        .await;
    assert_eq!(r1.status, StatusCode::ACCEPTED);
    assert_eq!(
        r1.body["job_id"], r2.body["job_id"],
        "deduplicated while queued"
    );
    assert_eq!(
        r1.body["cv_version_id"], r2.body["cv_version_id"],
        "same decisions, same version"
    );
    app.ai.answer(
        "ats_score",
        json!({ "score": 81, "matched_keywords": [], "missing_keywords": [], "notes": "" }),
    );
    app.drain_jobs().await;
    let b = c.get(&format!("/v1/applications/{id}/brief")).await.body;
    assert_eq!(b["score"]["rescored"], 81);
    let scored_text = app.ai.requests().last().unwrap().user_text.clone();
    assert!(
        scored_text.contains("Cut claims-style reconciliation"),
        "scored the tailored text"
    );
}

#[tokio::test]
async fn another_user_cannot_touch_the_review() {
    let app = TestApp::spawn().await;
    let a = ready_user(&app, "a@example.com").await;
    let b = ready_user(&app, "b@example.com").await;
    let id = started(&app, &a).await;
    let ids = rewrite_ids(&a.get(&format!("/v1/applications/{id}/rewrites")).await.body);
    for path in ["brief", "rewrites", "cv"] {
        assert_eq!(
            b.get(&format!("/v1/applications/{id}/{path}")).await.status,
            StatusCode::NOT_FOUND,
            "{path}"
        );
    }
    assert_eq!(
        b.patch(
            &format!("/v1/rewrites/{}", ids[0]),
            json!({ "action": "accept" })
        )
        .await
        .status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        b.patch(
            &format!("/v1/applications/{id}/summary"),
            json!({ "action": "accept" })
        )
        .await
        .status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        b.post(&format!("/v1/applications/{id}/rescore"), json!({}))
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    let still = a.get(&format!("/v1/applications/{id}/rewrites")).await.body;
    assert_eq!(still["rewrites"][0]["status"], "pending");
}
