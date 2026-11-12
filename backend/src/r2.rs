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

    /// Download an object's bytes.
    pub async fn get(&self, key: &str) -> Result<Vec<u8>> {
        let obj = self
            .client
            .get_object()
            .bucket(&self.bucket)
            .key(key)
            .send()
            .await
            .with_context(|| format!("R2 GetObject failed for key `{key}`"))?;
        let bytes = obj
            .body
            .collect()
            .await
            .with_context(|| format!("read R2 object `{key}`"))?;
        Ok(bytes.into_bytes().to_vec())
    }

    /// Delete one object. Missing objects are not an error.
    pub async fn delete(&self, key: &str) -> Result<()> {
        self.client
            .delete_object()
            .bucket(&self.bucket)
            .key(key)
            .send()
            .await
            .with_context(|| format!("R2 DeleteObject failed for key `{key}`"))?;
        Ok(())
    }

    /// A short-lived GET URL for one object. `download_name` sets the file
    /// name the browser saves it as.
    pub async fn presign_get(
        &self,
        key: &str,
        ttl: std::time::Duration,
        download_name: Option<&str>,
    ) -> Result<String> {
        let cfg = aws_sdk_s3::presigning::PresigningConfig::expires_in(ttl)
            .context("invalid presigning TTL")?;
        let mut get = self.client.get_object().bucket(&self.bucket).key(key);
        if let Some(name) = download_name {
            get = get.response_content_disposition(format!("attachment; filename=\"{name}\""));
        }
        let signed = get.presigned(cfg).await.context("sign download URL")?;
        Ok(signed.uri().to_string())
    }
}
