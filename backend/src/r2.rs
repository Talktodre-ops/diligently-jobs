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
    /// Signs download links. Same as `client` unless R2_PUBLIC_ENDPOINT
    /// gives the browser a different address for the bucket.
    presign_client: Client,
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

        let client = Self::client_for(&cfg.endpoint, &cfg.region, creds.clone()).await;
        let presign_client = match &cfg.public_endpoint {
            Some(public) if public != &cfg.endpoint => {
                Self::client_for(public, &cfg.region, creds).await
            }
            _ => client.clone(),
        };
        Self {
            client,
            presign_client,
            bucket: cfg.bucket.clone(),
        }
    }

    async fn client_for(endpoint: &str, region: &str, creds: Credentials) -> Client {
        let aws_cfg = aws_config::defaults(BehaviorVersion::latest())
            .region(Region::new(region.to_string()))
            .endpoint_url(endpoint.to_string())
            .credentials_provider(creds)
            .load()
            .await;
        // Path-style addressing: R2 does not support virtual-host style for
        // arbitrary bucket names on the standard endpoint.
        let s3_cfg = aws_sdk_s3::config::Builder::from(&aws_cfg)
            .force_path_style(true)
            .build();
        Client::from_conf(s3_cfg)
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
        let mut get = self
            .presign_client
            .get_object()
            .bucket(&self.bucket)
            .key(key);
        if let Some(name) = download_name {
            get = get.response_content_disposition(format!("attachment; filename=\"{name}\""));
        }
        let signed = get.presigned(cfg).await.context("sign download URL")?;
        Ok(signed.uri().to_string())
    }

    /// Every key under a prefix, following pagination.
    pub async fn list_keys(&self, prefix: &str) -> Result<Vec<String>> {
        let mut keys = Vec::new();
        let mut token: Option<String> = None;
        loop {
            let mut req = self
                .client
                .list_objects_v2()
                .bucket(&self.bucket)
                .prefix(prefix);
            if let Some(t) = &token {
                req = req.continuation_token(t);
            }
            let out = req
                .send()
                .await
                .with_context(|| format!("R2 ListObjectsV2 failed for prefix `{prefix}`"))?;
            keys.extend(
                out.contents()
                    .iter()
                    .filter_map(|o| o.key().map(str::to_string)),
            );
            match (out.is_truncated(), out.next_continuation_token()) {
                (Some(true), Some(t)) => token = Some(t.to_string()),
                _ => break,
            }
        }
        Ok(keys)
    }

    /// Delete everything under a prefix. Returns how many objects were
    /// deleted and how many failed, so the caller can log leftovers.
    pub async fn delete_prefix(&self, prefix: &str) -> Result<(usize, usize)> {
        let keys = self.list_keys(prefix).await?;
        let (mut ok, mut failed) = (0, 0);
        for k in keys {
            match self.delete(&k).await {
                Ok(()) => ok += 1,
                Err(e) => {
                    failed += 1;
                    tracing::error!(key = %k, error = %format!("{e:#}"), "storage delete failed");
                }
            }
        }
        Ok((ok, failed))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(public: Option<&str>) -> R2Config {
        R2Config {
            endpoint: "http://s3:8333".into(),
            public_endpoint: public.map(str::to_string),
            region: "us-east-1".into(),
            bucket: "b".into(),
            access_key_id: "k".into(),
            secret_access_key: "s".into(),
        }
    }

    #[tokio::test]
    async fn download_links_use_the_public_endpoint_when_set() {
        let ttl = std::time::Duration::from_secs(60);
        let r2 = R2::new(&cfg(Some("http://localhost:8339"))).await;
        let url = r2.presign_get("u/1/cv.pdf", ttl, None).await.unwrap();
        assert!(
            url.starts_with("http://localhost:8339/b/u/1/cv.pdf?"),
            "{url}"
        );

        let r2 = R2::new(&cfg(None)).await;
        let url = r2.presign_get("u/1/cv.pdf", ttl, None).await.unwrap();
        assert!(url.starts_with("http://s3:8333/b/u/1/cv.pdf?"), "{url}");
    }
}
