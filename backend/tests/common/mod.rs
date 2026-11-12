//! Shared integration-test harness.
//!
//! Every test gets its own freshly migrated Postgres database on the local
//! test server (see `scripts/test-services.sh`) and the real router built from
//! the library crate. Storage points at the local S3 emulator. Nothing here can
//! reach the real database or bucket: the harness refuses any non-local host.
#![allow(dead_code)]

use axum::body::Body;
use axum::http::{header, Method, Request, StatusCode};
use axum::Router;
use http_body_util::BodyExt;
use serde_json::Value;
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;
use std::sync::Arc;
use tower::ServiceExt;
use uuid::Uuid;

use diligently_api::config::{Config, R2Config, WebConfig};
use diligently_api::r2::R2;
use diligently_api::{build_router, db, AppState};

pub const TEST_BUCKET: &str = "diligently-test";
pub const APP_ORIGIN: &str = "http://app.test";
pub const TEST_BEARER: &str = "test-bearer-token-0123456789abcdef0123456789";

pub struct TestApp {
    pub state: AppState,
    pub mail: Arc<diligently_api::mail::MemoryMailer>,
    pub router: Router,
    pub db_name: String,
    admin_url: String,
}

pub struct TestResponse {
    pub status: StatusCode,
    pub headers: axum::http::HeaderMap,
    pub body: Value,
    pub raw: Vec<u8>,
}

fn env_or_panic(key: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| {
        panic!("{key} is not set; run the suite through scripts/test.sh so it uses the local test services")
    })
}

/// Refuse to run against anything that is not on this machine. The real
/// database lives on Neon and must never be touched by tests.
fn assert_local(url: &str, what: &str) {
    let after_scheme = url.split("://").nth(1).unwrap_or("");
    let host_part = after_scheme.rsplit('@').next().unwrap_or("");
    let host = host_part
        .split(['/', '?'])
        .next()
        .unwrap_or("")
        .rsplit_once(':')
        .map(|(h, _)| h)
        .unwrap_or(host_part);
    assert!(
        host == "127.0.0.1" || host == "localhost",
        "{what} must point at localhost, got host `{host}`"
    );
}

fn with_database(url: &str, db_name: &str) -> String {
    let (base, query) = match url.split_once('?') {
        Some((b, q)) => (b, Some(q)),
        None => (url, None),
    };
    let base = base.rsplit_once('/').map(|(b, _)| b).unwrap_or(base);
    match query {
        Some(q) => format!("{base}/{db_name}?{q}"),
        None => format!("{base}/{db_name}"),
    }
}

impl TestApp {
    pub async fn spawn() -> Self {
        let admin_url = env_or_panic("TEST_DATABASE_URL");
        assert_local(&admin_url, "TEST_DATABASE_URL");
        let s3_endpoint = env_or_panic("TEST_S3_ENDPOINT");
        assert_local(&s3_endpoint, "TEST_S3_ENDPOINT");

        let db_name = format!("t_{}", Uuid::new_v4().simple());
        let admin = PgPoolOptions::new()
            .max_connections(1)
            .connect(&admin_url)
            .await
            .expect("connect to test postgres");
        sqlx::query(&format!(r#"create database "{db_name}""#))
            .execute(&admin)
            .await
            .expect("create test database");
        admin.close().await;

        let url = with_database(&admin_url, &db_name);
        let pool: PgPool = PgPoolOptions::new()
            .max_connections(5)
            .connect(&url)
            .await
            .expect("connect to per-test database");
        db::migrate(&pool).await.expect("migrations apply cleanly");

        let r2_cfg = R2Config {
            endpoint: s3_endpoint,
            region: "us-east-1".to_string(),
            bucket: TEST_BUCKET.to_string(),
            access_key_id: "test".to_string(),
            secret_access_key: "test".to_string(),
        };
        let r2 = R2::new(&r2_cfg).await;
        ensure_bucket(&r2).await;

        let config = Config {
            bind_addr: "127.0.0.1:0".parse().unwrap(),
            bearer_token: TEST_BEARER.to_string(),
            database_url: url,
            r2: r2_cfg,
            web: WebConfig {
                app_base_url: APP_ORIGIN.to_string(),
                allowed_origins: vec![APP_ORIGIN.to_string()],
                cookie_secure: true,
                trust_proxy: false,
            },
        };
        let mail = Arc::new(diligently_api::mail::MemoryMailer::default());
        let state = AppState {
            config: Arc::new(config),
            db: pool,
            r2,
            mailer: mail.clone(),
            limiter: Arc::new(diligently_api::rate_limit::RateLimiter::new()),
        };
        let router = build_router(state.clone());
        Self {
            state,
            mail,
            router,
            db_name,
            admin_url,
        }
    }

    pub async fn request(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
        headers: &[(&str, &str)],
    ) -> TestResponse {
        let mut builder = Request::builder().method(method).uri(path);
        for (k, v) in headers {
            builder = builder.header(*k, *v);
        }
        let req = match body {
            Some(json) => builder
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(json.to_string()))
                .unwrap(),
            None => builder.body(Body::empty()).unwrap(),
        };
        let resp = self
            .router
            .clone()
            .oneshot(req)
            .await
            .expect("router is infallible");
        let status = resp.status();
        let headers = resp.headers().clone();
        let raw = resp
            .into_body()
            .collect()
            .await
            .expect("read body")
            .to_bytes()
            .to_vec();
        let body = serde_json::from_slice(&raw).unwrap_or(Value::Null);
        TestResponse {
            status,
            headers,
            body,
            raw,
        }
    }

    pub async fn get(&self, path: &str) -> TestResponse {
        self.request(Method::GET, path, None, &[]).await
    }

    /// A browser-like client: sends the app Origin and keeps the session
    /// cookie between calls. Create one per simulated user.
    pub fn client(&self) -> Client<'_> {
        Client {
            app: self,
            cookie: std::sync::Mutex::new(None),
        }
    }

    /// Run queued jobs until none are ready. Deterministic stand-in for the
    /// background worker.
    pub async fn drain_jobs(&self) -> usize {
        let mut n = 0;
        while diligently_api::jobs::worker::process_one(&self.state)
            .await
            .expect("job claim")
        {
            n += 1;
            assert!(n < 200, "job queue did not drain");
        }
        n
    }
}

async fn ensure_bucket(r2: &R2) {
    if r2.ping().await.is_ok() {
        return;
    }
    // A concurrent test may create it between the check and the create; a
    // second create failing is fine as long as the bucket exists afterwards.
    let _ = r2.client.create_bucket().bucket(&r2.bucket).send().await;
    r2.ping().await.expect("test bucket exists");
}

impl Drop for TestApp {
    fn drop(&mut self) {
        let admin_url = self.admin_url.clone();
        let db_name = self.db_name.clone();
        // Drop runs outside async context, so tear down on a private runtime.
        // `with (force)` ends the test pool's connections, which belong to the
        // test's own runtime and cannot be closed from here.
        let _ = std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("teardown runtime");
            rt.block_on(async move {
                if let Ok(admin) = PgPoolOptions::new()
                    .max_connections(1)
                    .connect(&admin_url)
                    .await
                {
                    let _ = sqlx::query(&format!(
                        r#"drop database if exists "{db_name}" with (force)"#
                    ))
                    .execute(&admin)
                    .await;
                    admin.close().await;
                }
            });
        })
        .join();
    }
}

pub struct Client<'a> {
    pub app: &'a TestApp,
    cookie: std::sync::Mutex<Option<String>>,
}

impl Client<'_> {
    pub fn session_token(&self) -> Option<String> {
        self.cookie.lock().unwrap().clone()
    }

    pub fn set_session_token(&self, token: Option<String>) {
        *self.cookie.lock().unwrap() = token;
    }

    pub async fn send(&self, method: Method, path: &str, body: Option<Value>) -> TestResponse {
        let cookie = self.session_token().map(|t| format!("dl_session={t}"));
        let mut headers: Vec<(&str, &str)> = vec![("origin", APP_ORIGIN)];
        if let Some(c) = cookie.as_deref() {
            headers.push(("cookie", c));
        }
        let res = self.app.request(method, path, body, &headers).await;
        for v in res.headers.get_all(header::SET_COOKIE) {
            let v = v.to_str().unwrap_or("");
            if let Some(rest) = v.strip_prefix("dl_session=") {
                let value = rest.split(';').next().unwrap_or("");
                let cleared = v.contains("Max-Age=0") || value.is_empty();
                self.set_session_token(if cleared {
                    None
                } else {
                    Some(value.to_string())
                });
            }
        }
        res
    }

    pub async fn get(&self, path: &str) -> TestResponse {
        self.send(Method::GET, path, None).await
    }

    pub async fn post(&self, path: &str, body: Value) -> TestResponse {
        self.send(Method::POST, path, Some(body)).await
    }

    pub async fn patch(&self, path: &str, body: Value) -> TestResponse {
        self.send(Method::PATCH, path, Some(body)).await
    }

    pub async fn delete(&self, path: &str) -> TestResponse {
        self.send(Method::DELETE, path, None).await
    }
}
