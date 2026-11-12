//! Download my data and delete my account.

mod common;
#[path = "support/pipeline_fixture.rs"]
mod fixture;

use axum::http::{header, Method, StatusCode};
use common::TestApp;
use fixture::{ready_user, started};
use serde_json::{json, Value};
use uuid::Uuid;

/// Every table with a user_id column and how many rows it holds for `uid`.
async fn rows_owned(app: &TestApp, uid: Uuid) -> Vec<(String, i64)> {
    let tables: Vec<String> = sqlx::query_scalar(
        "select table_name::text from information_schema.columns where table_schema = 'public' and column_name = 'user_id' order by 1",
    )
    .fetch_all(&app.state.db)
    .await
    .unwrap();
    let mut out = Vec::new();
    for t in tables {
        let n: i64 = sqlx::query_scalar(&format!("select count(*) from {t} where user_id = $1"))
            .bind(uid)
            .fetch_one(&app.state.db)
            .await
            .unwrap();
        out.push((t, n));
    }
    out
}

async fn uid(c: &common::Client<'_>) -> Uuid {
    c.get("/v1/auth/me").await.body["user"]["id"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap()
}

#[tokio::test]
async fn export_contains_everything_and_no_secrets() {
    let app = TestApp::spawn().await;
    let c = ready_user(&app, "ada@example.com").await;
    let id = started(&app, &c).await;
    c.post(&format!("/v1/applications/{id}/render"), json!({}))
        .await;
    app.drain_jobs().await;

    let res = c.get("/v1/account/export").await;
    assert_eq!(res.status, StatusCode::OK);
    let cd = res.headers[header::CONTENT_DISPOSITION].to_str().unwrap();
    assert!(
        cd.starts_with("attachment; filename=\"diligently-export-"),
        "{cd}"
    );
    let raw = String::from_utf8(res.raw.clone()).unwrap();
    for secret in ["password_hash", "token_hash", "$argon2"] {
        assert!(!raw.contains(secret), "{secret} leaked into the export");
    }
    let e: Value = res.body;
    assert_eq!(e["account"]["email"], "ada@example.com");
    assert_eq!(e["applications"][0]["company"], "Halcyon Health");
    assert_eq!(e["gaps"].as_array().unwrap().len(), 3);
    assert_eq!(e["rewrites"].as_array().unwrap().len(), 2);
    assert!(!e["cover_letters"].as_array().unwrap().is_empty());
    assert!(!e["ai_usage"].as_array().unwrap().is_empty());
    assert!(e["applications"][0].get("user_id").is_none());
    let files = e["files"]["items"].as_array().unwrap();
    assert!(files
        .iter()
        .any(|f| f["key"].as_str().unwrap().ends_with(".pdf")));
    let url = files[0]["url"].as_str().unwrap();
    assert_eq!(
        reqwest::get(url).await.unwrap().status(),
        200,
        "file links work"
    );
}

#[tokio::test]
async fn export_is_only_the_users_own_data() {
    let app = TestApp::spawn().await;
    let a = ready_user(&app, "a@example.com").await;
    let b = ready_user(&app, "b@example.com").await;
    started(&app, &a).await;
    let e = b.get("/v1/account/export").await.body;
    assert_eq!(e["account"]["email"], "b@example.com");
    assert_eq!(e["applications"], json!([]));
    assert_eq!(e["ai_usage"], json!([]));
    assert_eq!(e["files"]["items"], json!([]));
}

#[tokio::test]
async fn deleting_the_account_removes_every_row_and_file_and_nothing_else() {
    let app = TestApp::spawn().await;
    let a = ready_user(&app, "a@example.com").await;
    let b = ready_user(&app, "b@example.com").await;
    let a_id = uid(&a).await;
    let b_id = uid(&b).await;
    let ida = started(&app, &a).await;
    let idb = started(&app, &b).await;
    for (c, id) in [(&a, &ida), (&b, &idb)] {
        c.post(
            &format!("/v1/applications/{id}/render"),
            json!({ "include_letter": true }),
        )
        .await;
        c.post(
            &format!("/v1/applications/{id}/applied"),
            json!({ "reminder_days": 5 }),
        )
        .await;
    }
    app.drain_jobs().await;
    assert!(
        rows_owned(&app, a_id)
            .await
            .iter()
            .filter(|(_, n)| *n > 0)
            .count()
            >= 10,
        "A owns data in many tables"
    );
    assert!(!app
        .state
        .r2
        .list_keys(&format!("u/{a_id}/"))
        .await
        .unwrap()
        .is_empty());

    let wrong = a
        .send(
            Method::DELETE,
            "/v1/account",
            Some(json!({ "password": "not my password" })),
        )
        .await;
    assert_eq!(wrong.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        a.get("/v1/auth/me").await.status,
        StatusCode::OK,
        "still there"
    );

    let res = a
        .send(
            Method::DELETE,
            "/v1/account",
            Some(json!({ "password": "a long enough passphrase" })),
        )
        .await;
    assert_eq!(res.status, StatusCode::NO_CONTENT);
    assert!(a.session_token().is_none(), "signed out");

    let left: Vec<_> = rows_owned(&app, a_id)
        .await
        .into_iter()
        .filter(|(_, n)| *n > 0)
        .collect();
    assert!(left.is_empty(), "rows left behind: {left:?}");
    let users: i64 = sqlx::query_scalar("select count(*) from users where id = $1")
        .bind(a_id)
        .fetch_one(&app.state.db)
        .await
        .unwrap();
    assert_eq!(users, 0);
    assert!(
        app.state
            .r2
            .list_keys(&format!("u/{a_id}/"))
            .await
            .unwrap()
            .is_empty(),
        "files removed"
    );

    // B is untouched.
    assert!(
        rows_owned(&app, b_id)
            .await
            .iter()
            .filter(|(_, n)| *n > 0)
            .count()
            >= 10
    );
    assert!(!app
        .state
        .r2
        .list_keys(&format!("u/{b_id}/"))
        .await
        .unwrap()
        .is_empty());
    assert_eq!(
        b.get(&format!("/v1/applications/{idb}/brief")).await.status,
        StatusCode::OK
    );

    // The email can be used again.
    let again = app.client();
    let r = again
        .post(
            "/v1/auth/signup",
            json!({ "email": "a@example.com", "password": "a long enough passphrase" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::CREATED);
}
