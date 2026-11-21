//! Download my data and delete my account.

use crate::common;
use crate::fixture;

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

/// Make the signed-in user look like a Google-only account.
async fn google_only(app: &TestApp, c: &common::Client<'_>) -> Uuid {
    let id = uid(c).await;
    sqlx::query("update users set password_hash = null, password_changed_at = null, google_sub = 'g-1' where id = $1")
        .bind(id)
        .execute(&app.state.db)
        .await
        .unwrap();
    id
}

#[tokio::test]
async fn set_password_link_is_for_accounts_without_one() {
    let app = TestApp::spawn().await;
    let c = common::verified_user(&app, "ada@example.com").await;
    let has = c.post("/v1/account/set-password-link", json!({})).await;
    assert_eq!(has.status, StatusCode::CONFLICT);
    assert_eq!(has.body["error"]["code"], "has_password");

    google_only(&app, &c).await;
    let me = c.get("/v1/auth/me").await.body;
    assert_eq!(me["user"]["has_password"], false);
    assert_eq!(me["user"]["google_connected"], true);
    assert_eq!(me["user"]["password_changed_at"], Value::Null);

    let res = c.post("/v1/account/set-password-link", json!({})).await;
    assert_eq!(res.status, StatusCode::NO_CONTENT, "{}", res.body);
    let mail = app.mail.last_to("ada@example.com").unwrap();
    assert_eq!(mail.subject, "Set a password for Diligently");
    let i = mail.text.find("/reset-password?token=").unwrap() + 22;
    let token = mail.text[i..i + 43].to_string();

    // The existing reset page sets it.
    let reset = app
        .client()
        .post(
            "/v1/auth/reset-password",
            json!({ "token": token, "password": "a fresh new passphrase" }),
        )
        .await;
    assert_eq!(reset.status, StatusCode::OK, "{}", reset.body);
    assert_eq!(reset.body["user"]["has_password"], true);
    assert!(reset.body["user"]["password_changed_at"].is_string());
    let notice = app.mail.last_to("ada@example.com").unwrap();
    assert_eq!(
        notice.subject,
        "A password was set for your Diligently account"
    );
}

#[tokio::test]
async fn disconnecting_google_needs_a_password() {
    let app = TestApp::spawn().await;
    let c = common::verified_user(&app, "ada@example.com").await;
    let id = google_only(&app, &c).await;
    let res = c.post("/v1/account/google/disconnect", json!({})).await;
    assert_eq!(res.status, StatusCode::CONFLICT);
    assert_eq!(res.body["error"]["code"], "password_required");
    assert!(res.body["error"]["message"].is_string());

    sqlx::query("update users set password_hash = 'x' where id = $1")
        .bind(id)
        .execute(&app.state.db)
        .await
        .unwrap();
    let before = app.mail.sent().len();
    let res = c.post("/v1/account/google/disconnect", json!({})).await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.body);
    assert_eq!(res.body["user"]["google_connected"], false);
    assert_eq!(res.body["user"]["has_password"], true);
    let mails: Vec<_> = app.mail.sent().into_iter().skip(before).collect();
    assert_eq!(mails.len(), 1);
    assert_eq!(
        mails[0].subject,
        "Google was disconnected from your Diligently account"
    );
    // Already disconnected: same answer, no second email.
    let again = c.post("/v1/account/google/disconnect", json!({})).await;
    assert_eq!(again.status, StatusCode::OK);
    assert_eq!(app.mail.sent().len(), before + 1);
}

fn code_in(mail: &diligently_api::mail::Email) -> String {
    mail.subject[..6].to_string()
}

#[tokio::test]
async fn an_account_without_a_password_deletes_with_an_emailed_code() {
    let app = TestApp::spawn().await;
    let c = common::verified_user(&app, "ada@example.com").await;
    let has = c.post("/v1/account/delete-code", json!({})).await;
    assert_eq!(has.status, StatusCode::CONFLICT);
    assert_eq!(has.body["error"]["code"], "has_password");

    let id = google_only(&app, &c).await;
    // A sign-up code outstanding must not be touched by the delete code.
    diligently_api::auth::code::issue(
        &app.state.db,
        id,
        diligently_api::auth::code::Purpose::Verify,
    )
    .await
    .unwrap();

    let res = c.post("/v1/account/delete-code", json!({})).await;
    assert_eq!(res.status, StatusCode::NO_CONTENT, "{}", res.body);
    let mail = app.mail.last_to("ada@example.com").unwrap();
    assert!(mail
        .subject
        .ends_with("is your code to delete your Diligently account"));
    let good = code_in(&mail);
    assert!(mail.text.contains(&format!("\n{good}\n")));
    let codes: i64 =
        sqlx::query_scalar("select count(*) from verification_codes where user_id = $1")
            .bind(id)
            .fetch_one(&app.state.db)
            .await
            .unwrap();
    assert_eq!(codes, 2, "sign-up and delete codes live side by side");

    let wrong = if good == "000000" { "111111" } else { "000000" };
    let res = c
        .send(
            Method::DELETE,
            "/v1/account",
            Some(json!({ "code": wrong })),
        )
        .await;
    assert_eq!(res.status, StatusCode::BAD_REQUEST);
    assert_eq!(res.body["error"]["code"], "invalid_code");
    assert_eq!(res.body["error"]["field"], "code");
    let res = c
        .send(
            Method::DELETE,
            "/v1/account",
            Some(json!({ "password": "a long enough passphrase" })),
        )
        .await;
    assert_eq!(res.status, StatusCode::BAD_REQUEST, "no password to check");

    let res = c
        .send(Method::DELETE, "/v1/account", Some(json!({ "code": good })))
        .await;
    assert_eq!(res.status, StatusCode::NO_CONTENT, "{}", res.body);
    let users: i64 = sqlx::query_scalar("select count(*) from users")
        .fetch_one(&app.state.db)
        .await
        .unwrap();
    assert_eq!(users, 0);
    let bye = app.mail.last_to("ada@example.com").unwrap();
    assert_eq!(bye.subject, "Your Diligently account is deleted");
    assert!(bye.text.contains("(UTC)"));
    assert!(!bye.text.contains("Write to"), "no SUPPORT_EMAIL, no line");
}

#[tokio::test]
async fn delete_codes_expire() {
    let app = TestApp::spawn().await;
    let c = common::verified_user(&app, "ada@example.com").await;
    google_only(&app, &c).await;
    c.post("/v1/account/delete-code", json!({})).await;
    let good = code_in(&app.mail.last_to("ada@example.com").unwrap());
    sqlx::query("update verification_codes set expires_at = now() - interval '1 minute' where purpose = 'delete'")
        .execute(&app.state.db)
        .await
        .unwrap();
    let res = c
        .send(Method::DELETE, "/v1/account", Some(json!({ "code": good })))
        .await;
    assert_eq!(res.status, StatusCode::GONE);
    assert_eq!(res.body["error"]["code"], "code_expired");
}

#[tokio::test]
async fn the_deleted_email_names_support_when_configured() {
    let app = TestApp::spawn_with(|c| c.support_email = Some("help@example.com".into())).await;
    let c = common::verified_user(&app, "ada@example.com").await;
    c.patch(
        "/v1/profile",
        json!({ "reminders": { "time_zone": "Africa/Lagos" } }),
    )
    .await;
    let res = c
        .send(
            Method::DELETE,
            "/v1/account",
            Some(json!({ "password": "a long enough passphrase" })),
        )
        .await;
    assert_eq!(res.status, StatusCode::NO_CONTENT);
    let bye = app.mail.last_to("ada@example.com").unwrap();
    assert!(bye.text.contains("Write to help@example.com"));
    assert!(bye.text.contains("(Lagos time)"), "{}", bye.text);
}
