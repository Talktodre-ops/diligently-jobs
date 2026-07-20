use axum::Json;
use serde::Serialize;

#[derive(Serialize)]
pub struct MeResponse {
    pub ok: bool,
    pub message: &'static str,
}

/// GET /v1/me
///
/// Bearer-auth verification ping. Returns 200 with `{ok: true}` if the request
/// carried a valid `Authorization: Bearer <token>`. Used by the desktop client
/// (Track 9) to confirm sync is reachable, and by `curl` to verify a new token
/// pair is wired correctly.
pub async fn me() -> Json<MeResponse> {
    Json(MeResponse {
        ok: true,
        message: "bearer ok",
    })
}
