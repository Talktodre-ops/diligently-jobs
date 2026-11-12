pub mod applications;
pub mod ats_scores;
pub mod blobs;
pub mod cover_letters;
pub mod cv;
pub mod cv_versions;
pub mod events;
pub mod files;
pub mod gaps;
pub mod health;
pub mod home;
pub mod interviews;
pub mod jobs;
pub mod profile;
pub mod research;
pub mod review;
pub mod tracking;
pub mod uploads;
pub mod workspace;

use uuid::Uuid;

use crate::error::AppError;

/// 404 unless `application_id` exists and belongs to `user_id`. Called before
/// attaching anything to an application; the composite foreign keys in the
/// schema are the backstop if a handler forgets.
pub async fn ensure_application(
    db: &sqlx::PgPool,
    user_id: Uuid,
    application_id: Uuid,
) -> Result<(), AppError> {
    let found: bool = sqlx::query_scalar(
        "select exists(select 1 from applications where id = $1 and user_id = $2)",
    )
    .bind(application_id)
    .bind(user_id)
    .fetch_one(db)
    .await?;
    if found {
        Ok(())
    } else {
        Err(AppError::NotFound)
    }
}
