use crate::config::R2Config;
use anyhow::{Context, Result};
use aws_config::BehaviorVersion;
use aws_credential_types::Credentials;
use aws_sdk_s3::config::Region;
use aws_sdk_s3::primitives::ByteStream;
use aws_sdk_s3::Client;

/// Cloudflare R2 client. R2 speaks the S3 API, so we use the AWS SDK with the
/// R2 endpoint URL and `region = "auto"`.
#[derive(Clone)]
pub struct R2 {
    pub client: Client,
    pub bucket: String,
}

impl R2 {
    pub async fn new(cfg: &R2Config) -> Self {
        let creds = Credentials::new(
            cfg.access_key_id.clone(),
            cfg.secret_access_key.clone(),
            None,
            None,
            "diligently-r2",
        );

        let aws_cfg = aws_config::defaults(BehaviorVersion::latest())
            .region(Region::new(cfg.region.clone()))
            .endpoint_url(cfg.endpoint.clone())
            .credentials_provider(creds)
            .load()
            .await;

        // R2 requires path-style addressing — virtual-host style isn't supported
        // for arbitrary bucket names on the standard endpoint.
        let s3_cfg = aws_sdk_s3::config::Builder::from(&aws_cfg)
            .force_path_style(true)
            .build();

        Self {
            client: Client::from_conf(s3_cfg),
            bucket: cfg.bucket.clone(),
        }
    }

    /// Cheap-ish ping for /health. HeadBucket is small and S3-standard.
    pub async fn ping(&self) -> Result<()> {
        self.client
            .head_bucket()
            .bucket(&self.bucket)
            .send()
            .await
            .with_context(|| format!("R2 HeadBucket failed for `{}`", self.bucket))?;
        Ok(())
    }

    /// Upload raw bytes to a key. Used by the render pipeline to store the
    /// generated PDF/DOCX blobs.
    pub async fn put(&self, key: &str, bytes: Vec<u8>, content_type: &str) -> Result<()> {
        self.client
            .put_object()
            .bucket(&self.bucket)
            .key(key)
            .body(ByteStream::from(bytes))
            .content_type(content_type)
            .send()
            .await
            .with_context(|| format!("R2 PutObject failed for key `{}`", key))?;
        Ok(())
    }

}
