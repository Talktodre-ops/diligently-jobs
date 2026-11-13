//! Sign in with Google against a local stand-in for Google's token and
//! userinfo endpoints. Nothing here talks to the real Google.

mod common;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use axum::extract::{Form, State};
use axum::http::{header, HeaderMap, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Router;
use base64::prelude::{Engine, BASE64_URL_SAFE_NO_PAD};
use common::{verified_user, TestApp, APP_ORIGIN};
use diligently_api::config::GoogleConfig;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const PW: &str = "a long enough passphrase";
const AUTH_URL: &str = "https://accounts.google.test/o/oauth2/v2/auth";

/// Fake Google: the access token it issues is the authorization code, and
/// userinfo answers with whatever profile the test registered for that code.
#[derive(Clone, Default)]
struct MockGoogle {
    profiles: Arc<Mutex<HashMap<String, Value>>>,
    token_forms: Arc<Mutex<Vec<HashMap<String, String>>>>,
}

impl MockGoogle {
    fn person(&self, code: &str, profile: Value) {
        self.profiles
            .lock()
            .unwrap()
            .insert(code.to_string(), profile);
    }

    fn last_token_form(&self) -> HashMap<String, String> {
        self.token_forms.lock().unwrap().last().cloned().unwrap()
    }
}

async fn token(State(m): State<MockGoogle>, Form(f): Form<HashMap<String, String>>) -> Response {
    m.token_forms.lock().unwrap().push(f.clone());
    let code = f.get("code").cloned().unwrap_or_default();
    if !m.profiles.lock().unwrap().contains_key(&code) {
        return (
            StatusCode::BAD_REQUEST,
            axum::Json(json!({ "error": "invalid_grant" })),
        )
            .into_response();
    }
    axum::Json(json!({ "access_token": code, "token_type": "Bearer", "expires_in": 3599 }))
        .into_response()
}

async fn userinfo(State(m): State<MockGoogle>, headers: HeaderMap) -> Response {
    let bearer = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or_default()
        .to_string();
    match m.profiles.lock().unwrap().get(&bearer) {
        Some(p) => axum::Json(p.clone()).into_response(),
        None => StatusCode::UNAUTHORIZED.into_response(),
    }
}

async fn spawn_google() -> (TestApp, MockGoogle) {
    let mock = MockGoogle::default();
    let router = Router::new()
        .route("/token", post(token))
        .route("/userinfo", get(userinfo))
        .with_state(mock.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    let app = TestApp::spawn_with(|c| {
        c.google = Some(GoogleConfig {
            client_id: "test-client-id".into(),
            client_secret: "test-client-secret".into(),
            auth_url: AUTH_URL.into(),
            token_url: format!("http://{addr}/token"),
            userinfo_url: format!("http://{addr}/userinfo"),
        })
    })
    .await;
    (app, mock)
}

fn cookie_value(res: &common::TestResponse, name: &str) -> Option<(String, String)> {
    res.headers
        .get_all(header::SET_COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .find_map(|v| {
            let rest = v.strip_prefix(&format!("{name}="))?;
            Some((rest.split(';').next().unwrap().to_string(), v.to_string()))
        })
}

fn location(res: &common::TestResponse) -> String {
    res.headers
        .get(header::LOCATION)
        .expect("a redirect")
        .to_str()
        .unwrap()
        .to_string()
}

struct Started {
    state: String,
    challenge: String,
    cookie: String,
}

/// GET /start with a raw (already encoded) query string.
async fn start(app: &TestApp, query: &str) -> Started {
    let res = app.get(&format!("/v1/auth/google/start{query}")).await;
    assert_eq!(res.status, StatusCode::FOUND, "{}", res.body);
    let url = reqwest::Url::parse(&location(&res)).unwrap();
    let params: HashMap<String, String> = url.query_pairs().into_owned().collect();
    let (cookie, _) = cookie_value(&res, "dl_oauth").expect("state cookie");
    Started {
        state: params["state"].clone(),
        challenge: params["code_challenge"].clone(),
        cookie,
    }
}

async fn callback(app: &TestApp, query: &str, cookie: Option<&str>) -> common::TestResponse {
    let c = cookie.map(|v| format!("dl_oauth={v}"));
    let mut headers: Vec<(&str, &str)> = Vec::new();
    if let Some(c) = c.as_deref() {
        headers.push(("cookie", c));
    }
    let res = app
        .request(
            Method::GET,
            &format!("/v1/auth/google/callback{query}"),
            None,
            &headers,
        )
        .await;
    assert_eq!(res.status, StatusCode::FOUND, "{}", res.body);
    res
}

/// A whole sign-in for `code`, landing on `next` (already encoded).
async fn sign_in(app: &TestApp, code: &str, next: &str) -> common::TestResponse {
    let s = start(app, &format!("?next={next}")).await;
    callback(
        app,
        &format!("?code={code}&state={}", s.state),
        Some(&s.cookie),
    )
    .await
}

fn failed(res: &common::TestResponse) -> bool {
    location(res) == format!("{APP_ORIGIN}/signin?error=google")
        && cookie_value(res, "dl_session").is_none()
}

/// A client holding the session the callback set.
fn client_from<'a>(app: &'a TestApp, res: &common::TestResponse) -> common::Client<'a> {
    let (session, _) = cookie_value(res, "dl_session").expect("session cookie");
    let c = app.client();
    c.set_session_token(Some(session));
    c
}

fn google_person(sub: &str, email: &str) -> Value {
    json!({ "sub": sub, "email": email, "email_verified": true, "name": "Ada Okafor" })
}

#[tokio::test]
async fn disabled_by_default() {
    let app = TestApp::spawn().await;
    assert_eq!(
        app.get("/v1/auth/providers").await.body,
        json!({ "google": false })
    );
    for path in [
        "/v1/auth/google/start?next=/",
        "/v1/auth/google/callback?code=x&state=y",
    ] {
        let res = app.get(path).await;
        assert_eq!(res.status, StatusCode::NOT_FOUND, "{path}");
        assert_eq!(res.body["error"]["code"], "provider_disabled");
    }
}

#[tokio::test]
async fn start_redirects_to_google_with_state_and_pkce() {
    let (app, _) = spawn_google().await;
    assert_eq!(
        app.get("/v1/auth/providers").await.body,
        json!({ "google": true })
    );
    let res = app.get("/v1/auth/google/start?next=/onboarding").await;
    assert_eq!(res.status, StatusCode::FOUND);
    let url = reqwest::Url::parse(&location(&res)).unwrap();
    assert!(url.as_str().starts_with(AUTH_URL));
    let p: HashMap<String, String> = url.query_pairs().into_owned().collect();
    assert_eq!(p["response_type"], "code");
    assert_eq!(p["client_id"], "test-client-id");
    assert_eq!(
        p["redirect_uri"],
        format!("{APP_ORIGIN}/v1/auth/google/callback")
    );
    assert_eq!(p["scope"], "openid email profile");
    assert_eq!(p["code_challenge_method"], "S256");
    assert_eq!(p["code_challenge"].len(), 43);
    assert!(!url.as_str().contains("test-client-secret"));

    let (value, full) = cookie_value(&res, "dl_oauth").unwrap();
    assert_eq!(value, p["state"]);
    for flag in [
        "HttpOnly",
        "SameSite=Lax",
        "Secure",
        "Path=/v1/auth/google",
        "Max-Age=600",
    ] {
        assert!(full.contains(flag), "{full}");
    }
    let (stored_hash, next): (Vec<u8>, String) =
        sqlx::query_as("select state_hash, next_path from oauth_states")
            .fetch_one(&app.state.db)
            .await
            .unwrap();
    assert_eq!(next, "/onboarding");
    assert_ne!(stored_hash, value.as_bytes(), "state stored hashed");
}

#[tokio::test]
async fn a_new_person_gets_a_verified_account_without_a_password() {
    let (app, google) = spawn_google().await;
    google.person("code-1", google_person("g-1", "New@Example.com"));
    let s = start(&app, "?next=/onboarding/upload").await;
    let res = callback(
        &app,
        &format!("?code=code-1&state={}", s.state),
        Some(&s.cookie),
    )
    .await;
    assert_eq!(location(&res), format!("{APP_ORIGIN}/onboarding/upload"));
    let (_, cleared) = cookie_value(&res, "dl_oauth").unwrap();
    assert!(cleared.contains("Max-Age=0"), "state cookie cleared");

    // PKCE: the verifier sent to the token endpoint hashes to the challenge.
    let form = google.last_token_form();
    let verifier = &form["code_verifier"];
    assert_eq!(
        BASE64_URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes())),
        s.challenge
    );
    assert_eq!(form["grant_type"], "authorization_code");
    assert_eq!(form["client_secret"], "test-client-secret");
    assert_eq!(
        form["redirect_uri"],
        format!("{APP_ORIGIN}/v1/auth/google/callback")
    );

    let c = client_from(&app, &res);
    let me = c.get("/v1/auth/me").await;
    assert_eq!(me.status, StatusCode::OK);
    assert_eq!(me.body["user"]["email"], "new@example.com");
    assert_eq!(me.body["user"]["email_verified"], true);
    let (hash, sub): (Option<String>, Option<String>) =
        sqlx::query_as("select password_hash, google_sub from users")
            .fetch_one(&app.state.db)
            .await
            .unwrap();
    assert!(hash.is_none());
    assert_eq!(sub.as_deref(), Some("g-1"));

    // The state is single use.
    let replay = callback(
        &app,
        &format!("?code=code-1&state={}", s.state),
        Some(&s.cookie),
    )
    .await;
    assert!(failed(&replay));

    // Password sign-in fails with the usual message; forgot-password lets
    // them set a password.
    let pw = app
        .client()
        .post(
            "/v1/auth/signin",
            json!({ "email": "new@example.com", "password": PW }),
        )
        .await;
    assert_eq!(pw.status, StatusCode::UNAUTHORIZED);
    assert_eq!(
        pw.body["error"]["message"],
        "That email and password do not match."
    );
    let forgot = app
        .client()
        .post(
            "/v1/auth/forgot-password",
            json!({ "email": "new@example.com" }),
        )
        .await;
    assert_eq!(forgot.status, StatusCode::ACCEPTED);
    assert!(app
        .mail
        .last_to("new@example.com")
        .expect("reset email")
        .text
        .contains("/reset-password?token="));

    // Signing in again finds the same account by its Google subject.
    google.person(
        "code-2",
        google_person("g-1", "renamed-at-google@example.com"),
    );
    let again = sign_in(&app, "code-2", "/").await;
    let me2 = client_from(&app, &again).get("/v1/auth/me").await;
    assert_eq!(me2.body["user"]["id"], me.body["user"]["id"]);
}

#[tokio::test]
async fn an_existing_verified_account_is_linked_and_keeps_its_password() {
    let (app, google) = spawn_google().await;
    let pw_client = verified_user(&app, "ada@example.com").await;
    let id = pw_client.get("/v1/auth/me").await.body["user"]["id"].clone();
    google.person("code-ada", google_person("g-ada", "ada@example.com"));

    let res = sign_in(&app, "code-ada", "/home").await;
    assert_eq!(location(&res), format!("{APP_ORIGIN}/home"));
    let me = client_from(&app, &res).get("/v1/auth/me").await;
    assert_eq!(me.body["user"]["id"], id);

    let (hash, sub): (Option<String>, Option<String>) =
        sqlx::query_as("select password_hash, google_sub from users")
            .fetch_one(&app.state.db)
            .await
            .unwrap();
    assert!(hash.is_some(), "password kept");
    assert_eq!(sub.as_deref(), Some("g-ada"));
    assert_eq!(
        pw_client.get("/v1/auth/me").await.status,
        StatusCode::OK,
        "other sessions untouched"
    );
}

#[tokio::test]
async fn an_unverified_account_is_handed_to_the_google_owner() {
    let (app, google) = spawn_google().await;
    // Someone registers the address without owning it.
    let squatter = app.client();
    squatter
        .post(
            "/v1/auth/signup",
            json!({ "email": "ada@example.com", "password": PW }),
        )
        .await;
    let mail = app.mail.last_to("ada@example.com").unwrap();
    let i = mail.text.find("token=").unwrap() + 6;
    let link_token = mail.text[i..i + 43].to_string();
    let code = mail.subject[..6].to_string();

    google.person("code-ada", google_person("g-ada", "ada@example.com"));
    let res = sign_in(&app, "code-ada", "/").await;
    assert_eq!(location(&res), format!("{APP_ORIGIN}/"));
    let owner = client_from(&app, &res);
    let me = owner.get("/v1/auth/me").await;
    assert_eq!(me.body["user"]["email_verified"], true);

    assert_eq!(
        squatter.get("/v1/auth/me").await.status,
        StatusCode::UNAUTHORIZED,
        "old sessions revoked"
    );
    let (hash, sub): (Option<String>, Option<String>) =
        sqlx::query_as("select password_hash, google_sub from users")
            .fetch_one(&app.state.db)
            .await
            .unwrap();
    assert!(hash.is_none(), "password cleared");
    assert_eq!(sub.as_deref(), Some("g-ada"));
    let pw = app
        .client()
        .post(
            "/v1/auth/signin",
            json!({ "email": "ada@example.com", "password": PW }),
        )
        .await;
    assert_eq!(pw.status, StatusCode::UNAUTHORIZED);

    // Links and codes sent before the handover are spent.
    let link = app
        .client()
        .post("/v1/auth/verify", json!({ "token": link_token }))
        .await;
    assert_eq!(link.status, StatusCode::UNPROCESSABLE_ENTITY);
    let codes: i64 = sqlx::query_scalar("select count(*) from verification_codes")
        .fetch_one(&app.state.db)
        .await
        .unwrap();
    assert_eq!(codes, 0, "code {code} removed");
}

#[tokio::test]
async fn an_unverified_google_email_is_refused() {
    let (app, google) = spawn_google().await;
    google.person(
        "c-false",
        json!({ "sub": "g-1", "email": "a@example.com", "email_verified": false }),
    );
    google.person(
        "c-string",
        json!({ "sub": "g-2", "email": "b@example.com", "email_verified": "true" }),
    );
    google.person(
        "c-missing",
        json!({ "sub": "g-3", "email": "c@example.com" }),
    );
    for code in ["c-false", "c-string", "c-missing"] {
        let res = sign_in(&app, code, "/").await;
        assert!(failed(&res), "{code}: {:?}", res.headers);
    }
    let users: i64 = sqlx::query_scalar("select count(*) from users")
        .fetch_one(&app.state.db)
        .await
        .unwrap();
    assert_eq!(users, 0);
}

#[tokio::test]
async fn a_bad_state_is_refused() {
    let (app, google) = spawn_google().await;
    google.person("code-1", google_person("g-1", "ada@example.com"));
    let s = start(&app, "?next=/").await;
    let other = start(&app, "?next=/").await;

    // No cookie: a forged link opened in someone else's browser.
    let res = callback(&app, &format!("?code=code-1&state={}", s.state), None).await;
    assert!(failed(&res));
    // Cookie from a different flow.
    let res = callback(
        &app,
        &format!("?code=code-1&state={}", s.state),
        Some(&other.cookie),
    )
    .await;
    assert!(failed(&res));
    // Matching cookie, but a state the server never issued.
    let made_up = "A".repeat(43);
    let res = callback(
        &app,
        &format!("?code=code-1&state={made_up}"),
        Some(&made_up),
    )
    .await;
    assert!(failed(&res));
    // Missing state, and Google reporting an error.
    assert!(failed(
        &callback(&app, "?code=code-1", Some(&s.cookie)).await
    ));
    assert!(failed(
        &callback(
            &app,
            &format!("?error=access_denied&state={}", s.state),
            Some(&s.cookie)
        )
        .await
    ));

    // Expired.
    let late = start(&app, "?next=/").await;
    sqlx::query("update oauth_states set expires_at = now() - interval '1 second'")
        .execute(&app.state.db)
        .await
        .unwrap();
    let res = callback(
        &app,
        &format!("?code=code-1&state={}", late.state),
        Some(&late.cookie),
    )
    .await;
    assert!(failed(&res));

    // A code Google does not recognise.
    let fresh = start(&app, "?next=/").await;
    let res = callback(
        &app,
        &format!("?code=nope&state={}", fresh.state),
        Some(&fresh.cookie),
    )
    .await;
    assert!(failed(&res));

    let users: i64 = sqlx::query_scalar("select count(*) from users")
        .fetch_one(&app.state.db)
        .await
        .unwrap();
    assert_eq!(users, 0);
}

#[tokio::test]
async fn an_unsafe_next_lands_on_the_home_path() {
    let (app, google) = spawn_google().await;
    for (i, next) in [
        "%2F%2Fevil.example",
        "https%3A%2F%2Fevil.example",
        "%2F%5Cevil.example",
        "jobs",
        "",
    ]
    .into_iter()
    .enumerate()
    {
        let code = format!("code-{i}");
        google.person(&code, google_person("g-1", "ada@example.com"));
        let res = sign_in(&app, &code, next).await;
        assert_eq!(location(&res), format!("{APP_ORIGIN}/"), "{next}");
    }
    // No next at all.
    google.person("code-x", google_person("g-1", "ada@example.com"));
    let s = start(&app, "").await;
    let res = callback(
        &app,
        &format!("?code=code-x&state={}", s.state),
        Some(&s.cookie),
    )
    .await;
    assert_eq!(location(&res), format!("{APP_ORIGIN}/"));
}
