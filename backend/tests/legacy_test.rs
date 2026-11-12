//! claim-legacy moves desktop-era rows from the placeholder owner to a real
//! account, and the account can then see them.

mod common;

use axum::http::StatusCode;
use common::TestApp;
use diligently_api::legacy;
use serde_json::json;
use uuid::Uuid;

async fn legacy_data(app: &TestApp) -> Uuid {
    let db = &app.state.db;
    let owner: Uuid = sqlx::query_scalar(
        "insert into users (email, password_hash) values ('legacy@diligently.local', null) returning id",
    )
    .fetch_one(db)
    .await
    .unwrap();
    let app_id: Uuid = sqlx::query_scalar(
        "insert into applications (jd_raw, company, user_id) values ('JD', 'Northfold', $1) returning id",
    )
    .bind(owner)
    .fetch_one(db)
    .await
    .unwrap();
    let cv: Uuid = sqlx::query_scalar(
        "insert into cv_versions (application_id, sections, user_id) values ($1, '{}', $2) returning id",
    )
    .bind(app_id)
    .bind(owner)
    .fetch_one(db)
    .await
    .unwrap();
    sqlx::query("insert into ats_scores (application_id, cv_version_id, score, user_id) values ($1, $2, 81, $3)")
        .bind(app_id)
        .bind(cv)
        .bind(owner)
        .execute(db)
        .await
        .unwrap();
    sqlx::query(
        "insert into cover_letters (application_id, body, user_id) values ($1, 'Dear', $2)",
    )
    .bind(app_id)
    .bind(owner)
    .execute(db)
    .await
    .unwrap();
    sqlx::query("insert into events (kind, user_id) values ('old', $1)")
        .bind(owner)
        .execute(db)
        .await
        .unwrap();
    app_id
}

#[tokio::test]
async fn claim_moves_everything_and_removes_the_placeholder() {
    let app = TestApp::spawn().await;
    let app_id = legacy_data(&app).await;
    let dre = app.client();
    dre.post(
        "/v1/auth/signup",
        json!({ "email": "dre@example.com", "password": "a long enough passphrase" }),
    )
    .await;

    let report = legacy::claim(&app.state.db, " DRE@example.com ")
        .await
        .unwrap();
    assert_eq!(report.total(), 5);

    let list = dre.get("/v1/applications").await;
    assert_eq!(list.body[0]["id"], app_id.to_string());
    let letter = dre
        .get(&format!("/v1/applications/{app_id}/cover-letters"))
        .await;
    assert_eq!(letter.status, StatusCode::OK);
    let score = dre
        .get(&format!("/v1/applications/{app_id}/ats-score"))
        .await;
    assert_eq!(score.body["score"], 81);

    let left: i64 =
        sqlx::query_scalar("select count(*) from users where email = 'legacy@diligently.local'")
            .fetch_one(&app.state.db)
            .await
            .unwrap();
    assert_eq!(left, 0);

    // Running it again is a harmless no-op.
    assert_eq!(
        legacy::claim(&app.state.db, "dre@example.com")
            .await
            .unwrap()
            .total(),
        0
    );
}

#[tokio::test]
async fn claim_refuses_an_unknown_account_and_changes_nothing() {
    let app = TestApp::spawn().await;
    legacy_data(&app).await;
    let err = legacy::claim(&app.state.db, "nobody@example.com")
        .await
        .unwrap_err();
    assert!(err.to_string().contains("sign up first"), "{err}");
    let owned_by_legacy: i64 = sqlx::query_scalar(
        "select count(*) from applications a join users u on u.id = a.user_id where u.email = 'legacy@diligently.local'",
    )
    .fetch_one(&app.state.db)
    .await
    .unwrap();
    assert_eq!(owned_by_legacy, 1);
}
