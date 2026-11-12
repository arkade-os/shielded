use super::{NativeRequest, PrivacyTransport, policy::check_request};
use serde::{Deserialize, Serialize};
use url::Url;

pub(super) const MAX_APK_BYTES: u64 = 128 * 1024 * 1024;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateDownload {
    pub url: String,
    pub bytes: u64,
    pub sha256: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProgress {
    pub received: u64,
    pub total: u64,
}

fn component(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_.".contains(&byte))
}

fn tls_url(value: &str) -> Result<Url, String> {
    if value.len() > 8192 {
        return Err("Update URL exceeds the allowed size".into());
    }
    let url = Url::parse(value).map_err(|_| "Invalid update URL")?;
    if url.scheme() != "https"
        || url.port_or_known_default() != Some(443)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || url.path().contains('%')
        || url.path().contains('\\')
        || url.path().contains("//")
    {
        return Err("Update URL is not an approved TLS target".into());
    }
    Ok(url)
}

pub(super) fn initial_url(value: &str) -> Result<Url, String> {
    let url = tls_url(value)?;
    let parts: Vec<_> = url.path().trim_start_matches('/').split('/').collect();
    if url.host_str() != Some("github.com")
        || url.query().is_some()
        || parts.len() != 6
        || parts[..4] != ["arkade-os", "shielded", "releases", "download"]
        || !component(parts[4])
        || !parts[4].starts_with("native-mutinynet-")
        || !component(parts[5])
        || !parts[5].starts_with("shielded-mutinynet-android-arm64-")
        || !parts[5].ends_with(".apk")
    {
        return Err("Update package must come from Shielded's Mutinynet releases".into());
    }
    Ok(url)
}

pub(super) fn redirect_url(value: &str) -> Result<Url, String> {
    let url = tls_url(value)?;
    let parts: Vec<_> = url.path().trim_start_matches('/').split('/').collect();
    if url.host_str() != Some("release-assets.githubusercontent.com")
        || parts.len() != 3
        || parts[0] != "github-production-release-asset"
        // Pin GitHub's numeric repository ID for arkade-os/shielded, not just its CDN host.
        || parts[1] != "1398591288"
        || uuid::Uuid::parse_str(parts[2]).is_err()
    {
        return Err("Update redirect is not a Shielded release asset".into());
    }
    Ok(url)
}

impl UpdateDownload {
    pub(super) fn validate(&self) -> Result<Url, String> {
        if self.bytes == 0
            || self.bytes > MAX_APK_BYTES
            || self.sha256.len() != 64
            || !self
                .sha256
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err("Update package size or checksum is invalid".into());
        }
        initial_url(&self.url)
    }
}

struct UpdateScope {
    transport: PrivacyTransport,
    generation: u64,
    id: String,
}

impl Drop for UpdateScope {
    fn drop(&mut self) {
        let _ = self.transport.close_scope(self.generation, &self.id);
    }
}

impl PrivacyTransport {
    pub fn finish_update<T>(
        &self,
        generation: u64,
        publish: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        self.inner.finish_update(generation, publish)
    }

    pub async fn download_update(
        &self,
        generation: u64,
        request_id: String,
        asset: UpdateDownload,
        file: tokio::fs::File,
        on_progress: impl Fn(UpdateProgress) + Send + Sync + 'static,
    ) -> Result<(), String> {
        asset.validate()?;
        let scope = self.inner.scope(generation, "update")?;
        let _scope = UpdateScope {
            transport: self.clone(),
            generation,
            id: scope.id.clone(),
        };
        let request = NativeRequest {
            generation,
            request_id,
            scope: scope.id,
            url: asset.url.clone(),
            method: "GET".into(),
            headers: Vec::new(),
            body_base64: None,
        };
        let checked = check_request(&request, false)?;
        let lease = self.inner.register(&request, &checked, None)?;
        super::wire::download(&lease, &asset, file, self.inner.tls.clone(), &on_progress).await
    }
}
