//! Migrations apply on an empty database (the harness does that for every
//! test) and every down migration reverses its up cleanly.

mod common;

use common::TestApp;

#[tokio::test]
async fn accounts_tables_exist_with_case_insensitive_unique_email() {
    let app = TestApp::spawn().await;
    let db = &app.state.db;
    sqlx::query("insert into users (email, password_hash) values ('ada@example.com', 'x')")
        .execute(db)
        .await
        .unwrap();
    let dup =
        sqlx::query("insert into users (email, password_hash) values ('ADA@example.com', 'x')")
            .execute(db)
            .await;
    assert!(dup.is_err(), "emails must be unique regardless of case");
}

#[tokio::test]
async fn every_migration_reverts_cleanly() {
    let app = TestApp::spawn().await;
    let migrator = sqlx::migrate!("./migrations");
    // Undo everything, then apply again: both directions must succeed.
    migrator
        .undo(&app.state.db, 0)
        .await
        .expect("all down migrations run");
    migrator
        .run(&app.state.db)
        .await
        .expect("re-apply after full revert");
}

const BEFORE_TENANCY: i64 = 20261112000001;

#[tokio::test]
async fn tenancy_assigns_existing_rows_to_a_legacy_owner_who_cannot_sign_in() {
    let app = TestApp::spawn().await;
    let db = &app.state.db;
    let migrator = sqlx::migrate!("./migrations");
    migrator
        .undo(db, BEFORE_TENANCY)
        .await
        .expect("undo to before tenancy");

    // Desktop-era data, no owners.
    let app_id: uuid::Uuid =
        sqlx::query_scalar("insert into applications (jd_raw) values ('JD') returning id")
            .fetch_one(db)
            .await
            .unwrap();
    sqlx::query("insert into cv_versions (application_id, sections) values ($1, '{}')")
        .bind(app_id)
        .execute(db)
        .await
        .unwrap();
    sqlx::query("insert into events (kind) values ('x')")
        .execute(db)
        .await
        .unwrap();

    migrator
        .run(db)
        .await
        .expect("tenancy applies over existing data");

    let (legacy_id, hash): (uuid::Uuid, Option<String>) = sqlx::query_as(
        "select id, password_hash from users where email = 'legacy@diligently.local'",
    )
    .fetch_one(db)
    .await
    .unwrap();
    assert!(hash.is_none(), "legacy owner has no password");
    for table in ["applications", "cv_versions", "events"] {
        let owners: Vec<uuid::Uuid> =
            sqlx::query_scalar(&format!("select distinct user_id from {table}"))
                .fetch_all(db)
                .await
                .unwrap();
        assert_eq!(owners, vec![legacy_id], "{table} rows owned by legacy");
    }
}

#[tokio::test]
async fn tenancy_creates_no_legacy_owner_on_an_empty_database() {
    let app = TestApp::spawn().await;
    let n: i64 = sqlx::query_scalar("select count(*) from users")
        .fetch_one(&app.state.db)
        .await
        .unwrap();
    assert_eq!(n, 0);
}

#[tokio::test]
async fn child_rows_cannot_point_at_another_users_application() {
    let app = TestApp::spawn().await;
    let db = &app.state.db;
    let a: uuid::Uuid =
        sqlx::query_scalar("insert into users (email) values ('a@x.co') returning id")
            .fetch_one(db)
            .await
            .unwrap();
    let b: uuid::Uuid =
        sqlx::query_scalar("insert into users (email) values ('b@x.co') returning id")
            .fetch_one(db)
            .await
            .unwrap();
    let a_app: uuid::Uuid = sqlx::query_scalar(
        "insert into applications (jd_raw, user_id) values ('JD', $1) returning id",
    )
    .bind(a)
    .fetch_one(db)
    .await
    .unwrap();
    let res = sqlx::query(
        "insert into cover_letters (application_id, user_id, body) values ($1, $2, 'hi')",
    )
    .bind(a_app)
    .bind(b)
    .execute(db)
    .await;
    assert!(res.is_err(), "B cannot attach a letter to A's application");
}
