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
