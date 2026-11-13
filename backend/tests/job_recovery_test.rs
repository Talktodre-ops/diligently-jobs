//! Jobs whose worker went away (a restart, a deploy, a crash) go back to the
//! queue once their heartbeat is stale, and live jobs are left alone.

mod common;

use common::TestApp;
use diligently_api::jobs;
use uuid::Uuid;

async fn running_job(app: &TestApp, user_id: Uuid, heartbeat_age_secs: i64) -> Uuid {
    sqlx::query_scalar(
        r#"
        insert into jobs (user_id, kind, payload, status, attempts, started_at, heartbeat_at)
        values ($1, 'cv_render', '{}'::jsonb, 'running', 1,
                now() - interval '10 minutes', now() - make_interval(secs => $2))
        returning id
        "#,
    )
    .bind(user_id)
    .bind(heartbeat_age_secs as f64)
    .fetch_one(&app.state.db)
    .await
    .unwrap()
}

async fn status(app: &TestApp, id: Uuid) -> String {
    sqlx::query_scalar("select status from jobs where id = $1")
        .bind(id)
        .fetch_one(&app.state.db)
        .await
        .unwrap()
}

#[tokio::test]
async fn stale_heartbeat_requeues_and_fresh_heartbeat_does_not() {
    let app = TestApp::spawn().await;
    common::verified_user(&app, "ada@example.com").await;
    let user_id: Uuid = sqlx::query_scalar("select id from users where email = 'ada@example.com'")
        .fetch_one(&app.state.db)
        .await
        .unwrap();

    // Started long ago, but its worker stamped it 5 seconds ago: still alive.
    let live = running_job(&app, user_id, 5).await;
    // Its worker stopped stamping 3 minutes ago: lost.
    let lost = running_job(&app, user_id, 180).await;

    assert_eq!(jobs::recover_stuck(&app.state.db).await.unwrap(), 1);
    assert_eq!(status(&app, live).await, "running");
    assert_eq!(status(&app, lost).await, "queued");

    // A heartbeat keeps a long-running job alive.
    sqlx::query("update jobs set heartbeat_at = now() - interval '10 minutes' where id = $1")
        .bind(live)
        .execute(&app.state.db)
        .await
        .unwrap();
    jobs::heartbeat(&app.state.db, live).await.unwrap();
    assert_eq!(jobs::recover_stuck(&app.state.db).await.unwrap(), 0);
    assert_eq!(status(&app, live).await, "running");
}
