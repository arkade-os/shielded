use crate::transport::{PrivacyTransport, UpdateDownload, UpdateProgress};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    sync::{
        Arc, Mutex, MutexGuard,
        atomic::{AtomicBool, Ordering},
    },
};
use tauri::{AppHandle, State, WebviewWindow, ipc::Channel};

const UNAVAILABLE: &str = "Android updater unavailable";
const MAX_APK_BYTES: u64 = 128 * 1024 * 1024;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateRequest {
    url: String,
    bytes: u64,
    sha256: String,
    version_code: u64,
    package_name: String,
    signer_sha256: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StagedUpdate {
    id: String,
    version_code: u64,
}

struct StagedFile {
    path: PathBuf,
    owned: AtomicBool,
}
impl StagedFile {
    fn new(path: PathBuf, owned: bool) -> Self {
        Self {
            path,
            owned: AtomicBool::new(owned),
        }
    }
}
impl Drop for StagedFile {
    fn drop(&mut self) {
        if self.owned.load(Ordering::Acquire) {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

#[derive(Clone)]
struct Prepared {
    info: StagedUpdate,
    file: Arc<StagedFile>,
    request: UpdateRequest,
}

enum Phase {
    Idle,
    Downloading {
        id: String,
        generation: u64,
        cancelled: bool,
    },
    Ready(Prepared),
    Installing {
        prepared: Prepared,
        calling: bool,
    },
}

#[derive(Clone)]
pub struct AndroidUpdates {
    directory: PathBuf,
    state: Arc<Mutex<Phase>>,
    directory_ready: Arc<Mutex<bool>>,
}

impl AndroidUpdates {
    pub fn new(directory: PathBuf) -> Result<Self, String> {
        Ok(Self {
            directory,
            state: Arc::new(Mutex::new(Phase::Idle)),
            directory_ready: Arc::new(Mutex::new(false)),
        })
    }

    fn prepare_directory(&self) -> Result<(), String> {
        let mut ready = self.directory_ready.lock().map_err(|_| UNAVAILABLE)?;
        if *ready {
            return Ok(());
        }
        let directory = &self.directory;
        std::fs::create_dir_all(&directory).map_err(|_| UNAVAILABLE)?;
        if std::fs::symlink_metadata(&directory)
            .map_err(|_| UNAVAILABLE)?
            .file_type()
            .is_symlink()
        {
            return Err(UNAVAILABLE.into());
        }
        for entry in std::fs::read_dir(&directory).map_err(|_| UNAVAILABLE)? {
            let entry = entry.map_err(|_| UNAVAILABLE)?;
            let name = entry.file_name();
            let name = name.to_string_lossy();
            let Some((id, extension)) = name.rsplit_once('.') else {
                continue;
            };
            if matches!(extension, "part" | "apk")
                && uuid::Uuid::parse_str(id).is_ok()
                && entry.file_type().map_err(|_| UNAVAILABLE)?.is_file()
            {
                std::fs::remove_file(entry.path()).map_err(|_| UNAVAILABLE)?;
            }
        }
        *ready = true;
        Ok(())
    }

    fn lock(&self) -> Result<MutexGuard<'_, Phase>, String> {
        self.state.lock().map_err(|_| UNAVAILABLE.into())
    }

    fn reserve(&self, id: &str, generation: u64) -> Result<DownloadOwner, String> {
        if uuid::Uuid::parse_str(id).is_err() {
            return Err("Invalid update identifier".into());
        }
        self.prepare_directory()?;
        let mut state = self.lock()?;
        if !matches!(*state, Phase::Idle) {
            return Err("An Android update is already prepared or running".into());
        }
        let partial = Arc::new(StagedFile::new(
            self.directory
                .join(format!("{}.part", uuid::Uuid::new_v4())),
            false,
        ));
        *state = Phase::Downloading {
            id: id.into(),
            generation,
            cancelled: false,
        };
        Ok(DownloadOwner {
            updates: self.clone(),
            id: id.into(),
            partial,
            finished: false,
        })
    }

    fn snapshot(&self, info: &mut Value) -> Result<(), String> {
        let mut state = self.lock()?;
        if let Phase::Installing {
            prepared,
            calling: false,
        } = &*state
        {
            if info["installStatus"] == "installed" {
                *state = Phase::Idle;
            } else if matches!(info["installStatus"].as_str(), Some("idle" | "failed")) {
                *state = Phase::Ready(prepared.clone());
            }
        }
        match &*state {
            Phase::Downloading { id, .. } => info["downloading"] = json!({ "id": id }),
            Phase::Ready(prepared) | Phase::Installing { prepared, .. } => {
                info["staged"] = serde_json::to_value(&prepared.info).map_err(|_| UNAVAILABLE)?;
            }
            Phase::Idle => {}
        }
        Ok(())
    }

    fn begin_install(&self, id: &str) -> Result<InstallOwner, String> {
        let mut state = self.lock()?;
        let Phase::Ready(prepared) = &*state else {
            return Err("The verified update is not ready to install".into());
        };
        if prepared.info.id != id {
            return Err("This update has been replaced".into());
        }
        let prepared = prepared.clone();
        *state = Phase::Installing {
            prepared: prepared.clone(),
            calling: true,
        };
        Ok(InstallOwner {
            updates: self.clone(),
            prepared,
        })
    }

    fn cancel(&self, id: &str) -> Result<Option<u64>, String> {
        let mut state = self.lock()?;
        match &mut *state {
            Phase::Downloading {
                id: current,
                generation,
                cancelled,
            } if current == id => {
                *cancelled = true;
                Ok(Some(*generation))
            }
            Phase::Ready(prepared) if prepared.info.id == id => {
                *state = Phase::Idle;
                Ok(None)
            }
            Phase::Installing { prepared, .. } if prepared.info.id == id => {
                Err("Android is handling this installation; finish or cancel it there".into())
            }
            _ => Ok(None),
        }
    }
}

struct DownloadOwner {
    updates: AndroidUpdates,
    id: String,
    partial: Arc<StagedFile>,
    finished: bool,
}
impl DownloadOwner {
    async fn authorize(
        &self,
        request: &UpdateRequest,
        info: impl std::future::Future<Output = Result<Value, String>>,
    ) -> Result<(), String> {
        let info = info.await?;
        let state = self.updates.lock()?;
        if !matches!(&*state, Phase::Downloading { id, cancelled: false, .. } if id == &self.id) {
            return Err("Update download cancelled".into());
        }
        check_candidate(request, &info)
    }

    fn publish(
        &mut self,
        request: UpdateRequest,
        file: Arc<StagedFile>,
    ) -> Result<StagedUpdate, String> {
        let mut state = self.updates.lock()?;
        if !matches!(&*state, Phase::Downloading { id, cancelled: false, .. } if id == &self.id) {
            return Err("Update download cancelled".into());
        }
        let info = StagedUpdate {
            id: self.id.clone(),
            version_code: request.version_code,
        };
        *state = Phase::Ready(Prepared {
            info: info.clone(),
            file,
            request,
        });
        self.finished = true;
        Ok(info)
    }
}
impl Drop for DownloadOwner {
    fn drop(&mut self) {
        if self.finished {
            return;
        }
        if let Ok(mut state) = self.updates.lock() {
            if matches!(&*state, Phase::Downloading { id, .. } if id == &self.id) {
                *state = Phase::Idle;
            }
        }
    }
}

struct InstallOwner {
    updates: AndroidUpdates,
    prepared: Prepared,
}
impl InstallOwner {
    fn finish(&self, result: &Result<Value, String>) -> Result<(), String> {
        let mut state = self.updates.lock()?;
        if !matches!(&*state, Phase::Installing { prepared, .. } if prepared.info.id == self.prepared.info.id)
        {
            return Err(UNAVAILABLE.into());
        }
        if result
            .as_ref()
            .is_ok_and(|value| value["installStatus"] == "permission-required")
        {
            *state = Phase::Ready(self.prepared.clone());
        }
        Ok(())
    }
}
impl Drop for InstallOwner {
    fn drop(&mut self) {
        if let Ok(mut state) = self.updates.lock() {
            if let Phase::Installing { prepared, calling } = &mut *state {
                if prepared.info.id == self.prepared.info.id {
                    *calling = false;
                }
            }
        }
    }
}

fn signing_identity() -> Value {
    serde_json::from_str(include_str!("../android-signing.json"))
        .expect("invalid Android signing identity")
}

fn check_installation(info: &Value) -> Result<(), String> {
    let signing = signing_identity();
    if info["packageName"] != signing["packageName"]
        || info["signerSha256"] != signing["certificateSha256"]
    {
        return Err("This installation uses a different signing key. Keep this installation and its wallet data; it cannot accept this update in place.".into());
    }
    if info["installerPackageName"] == "com.android.vending" {
        return Err(
            "This installation is managed by Google Play. Update it through Google Play.".into(),
        );
    }
    Ok(())
}

fn check_candidate(request: &UpdateRequest, info: &Value) -> Result<(), String> {
    check_installation(info)?;
    let identity = signing_identity();
    if request.package_name != identity["packageName"].as_str().unwrap_or("")
        || request.signer_sha256 != identity["certificateSha256"].as_str().unwrap_or("")
        || request.bytes == 0
        || request.bytes > MAX_APK_BYTES
        || request.sha256.len() != 64
        || !request
            .sha256
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        || request.version_code <= info["versionCode"].as_u64().ok_or(UNAVAILABLE)?
        || !(100001..=2_100_000_000).contains(&request.version_code)
    {
        return Err("Update package identity, version or checksum is invalid".into());
    }
    if matches!(
        info["installStatus"].as_str(),
        Some("installing" | "confirmation-required")
    ) {
        return Err("Finish or cancel the current Android installation first".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn native_android_update_info(
    app: AppHandle,
    window: WebviewWindow,
    updates: State<'_, AndroidUpdates>,
) -> Result<Value, String> {
    crate::ensure_local(&window)?;
    let mut info = tauri_plugin_shielded_platform::android_update_info(&app).await?;
    updates.snapshot(&mut info)?;
    Ok(info)
}

#[tauri::command]
pub async fn native_android_update_download(
    app: AppHandle,
    window: WebviewWindow,
    updates: State<'_, AndroidUpdates>,
    transport: State<'_, PrivacyTransport>,
    generation: u64,
    request_id: String,
    update: UpdateRequest,
    on_progress: Channel<UpdateProgress>,
) -> Result<StagedUpdate, String> {
    crate::ensure_local(&window)?;
    let mut owner = updates.reserve(&request_id, generation)?;
    owner
        .authorize(
            &update,
            tauri_plugin_shielded_platform::android_update_info(&app),
        )
        .await?;
    let path = owner.partial.path.clone();
    let file = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .await
        .map_err(|_| "Could not create the private update file")?;
    owner.partial.owned.store(true, Ordering::Release);
    transport
        .download_update(
            generation,
            request_id,
            UpdateDownload {
                url: update.url.clone(),
                bytes: update.bytes,
                sha256: update.sha256.clone(),
            },
            file,
            move |progress| {
                let _ = on_progress.send(progress);
            },
        )
        .await?;
    let completed_path = path.with_extension("apk");
    tokio::fs::hard_link(&path, &completed_path)
        .await
        .map_err(|_| "Could not stage the verified update")?;
    let completed = Arc::new(StagedFile::new(completed_path, true));
    tauri_plugin_shielded_platform::android_verify_update(
        &app,
        json!({
            "path": completed.path, "sha256": update.sha256,
            "bytes": update.bytes, "versionCode": update.version_code
        }),
    )
    .await?;
    transport.finish_update(generation, || owner.publish(update, completed.clone()))
}

#[tauri::command]
pub fn native_android_update_cancel(
    window: WebviewWindow,
    updates: State<'_, AndroidUpdates>,
    transport: State<'_, PrivacyTransport>,
    id: String,
) -> Result<(), String> {
    crate::ensure_local(&window)?;
    let generation = updates
        .cancel(&id)?
        .unwrap_or(transport.status()?.generation);
    let _ = transport.cancel(generation, &id);
    Ok(())
}

#[tauri::command]
pub async fn native_android_update_permission(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<(), String> {
    crate::ensure_local(&window)?;
    check_installation(&tauri_plugin_shielded_platform::android_update_info(&app).await?)?;
    tauri_plugin_shielded_platform::android_update_permission(&app).await
}

#[tauri::command]
pub async fn native_android_update_install(
    app: AppHandle,
    window: WebviewWindow,
    updates: State<'_, AndroidUpdates>,
    id: String,
) -> Result<Value, String> {
    crate::ensure_local(&window)?;
    let info = tauri_plugin_shielded_platform::android_update_info(&app).await?;
    let owner = updates.begin_install(&id)?;
    check_candidate(&owner.prepared.request, &info)?;
    let request = &owner.prepared.request;
    let result = tauri_plugin_shielded_platform::android_install_update(&app, json!({ "path": owner.prepared.file.path, "sha256": request.sha256, "bytes": request.bytes, "versionCode": request.version_code })).await;
    owner.finish(&result)?;
    result
}

#[tauri::command]
pub async fn native_android_update_confirm(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<Value, String> {
    crate::ensure_local(&window)?;
    check_installation(&tauri_plugin_shielded_platform::android_update_info(&app).await?)?;
    tauri_plugin_shielded_platform::android_confirm_update(&app).await
}

#[cfg(test)]
mod tests {
    use super::*;
    fn info() -> Value {
        let signing = signing_identity();
        json!({ "packageName": signing["packageName"], "signerSha256": signing["certificateSha256"], "versionCode": 100099, "installerPackageName": null, "installStatus": "idle" })
    }
    fn request() -> UpdateRequest {
        UpdateRequest { url: "https://github.com/arkade-os/shielded/releases/download/native-mutinynet-aaaaaaaaaaaa-run99-attempt1/signed.apk".into(), bytes: 100, sha256: "a".repeat(64), version_code: 100100, package_name: "io.arkade.shielded".into(), signer_sha256: signing_identity()["certificateSha256"].as_str().unwrap().into() }
    }
    fn fixture() -> AndroidUpdates {
        let updates = AndroidUpdates::new(
            std::env::temp_dir().join(format!("shielded-update-test-{}", uuid::Uuid::new_v4())),
        )
        .unwrap();
        updates.prepare_directory().unwrap();
        updates
    }
    fn ready(updates: &AndroidUpdates) -> StagedUpdate {
        let mut owner = updates
            .reserve(&uuid::Uuid::new_v4().to_string(), 1)
            .unwrap();
        let file = Arc::new(StagedFile::new(
            owner.partial.path.with_extension("apk"),
            true,
        ));
        std::fs::write(&file.path, b"verified test package").unwrap();
        owner.publish(request(), file).unwrap()
    }
    #[test]
    fn candidate_refuses_legacy_signing_downgrades_wrong_packages_and_busy_installers() {
        assert!(check_candidate(&request(), &info()).is_ok());
        for (key, bad) in [
            ("signerSha256", json!("0".repeat(64))),
            ("packageName", json!("another.wallet")),
            ("versionCode", json!(100100)),
            ("installerPackageName", json!("com.android.vending")),
            ("installStatus", json!("installing")),
            ("installStatus", json!("confirmation-required")),
        ] {
            let mut value = info();
            value[key] = bad;
            assert!(check_candidate(&request(), &value).is_err(), "{key}");
        }
        for change in 0..6 {
            let mut candidate = request();
            match change {
                0 => candidate.package_name = "another.wallet".into(),
                1 => candidate.signer_sha256 = "0".repeat(64),
                2 => candidate.bytes = MAX_APK_BYTES + 1,
                3 => candidate.bytes = 0,
                4 => candidate.sha256 = "F".repeat(64),
                _ => candidate.version_code = 100098,
            }
            assert!(check_candidate(&candidate, &info()).is_err());
        }
    }
    #[test]
    fn only_one_owner_can_download_and_cancelled_owners_cannot_publish() {
        let updates = fixture();
        let id = uuid::Uuid::new_v4().to_string();
        let mut owner = updates.reserve(&id, 1).unwrap();
        assert!(
            updates
                .reserve(&uuid::Uuid::new_v4().to_string(), 1)
                .is_err()
        );
        assert_eq!(updates.cancel(&id).unwrap(), Some(1));
        assert!(
            owner
                .publish(
                    request(),
                    Arc::new(StagedFile::new(
                        updates.directory.join("cancelled.apk"),
                        true
                    ))
                )
                .is_err()
        );
        assert!(
            updates
                .reserve(&uuid::Uuid::new_v4().to_string(), 1)
                .is_err()
        );
        drop(owner);
        assert!(
            updates
                .reserve(&uuid::Uuid::new_v4().to_string(), 2)
                .is_ok()
        );
        std::fs::remove_dir(&updates.directory).unwrap();
    }
    #[test]
    fn partial_files_are_removed_when_their_download_owner_is_dropped() {
        let updates = fixture();
        let owner = updates
            .reserve(&uuid::Uuid::new_v4().to_string(), 1)
            .unwrap();
        let path = owner.partial.path.clone();
        std::fs::write(&path, b"partial").unwrap();
        owner.partial.owned.store(true, Ordering::Release);
        drop(owner);
        assert!(!path.exists());
        std::fs::remove_dir(&updates.directory).unwrap();
    }
    #[tokio::test]
    async fn cancellation_while_native_identity_is_pending_prevents_file_and_ready_publication() {
        let updates = fixture();
        let id = uuid::Uuid::new_v4().to_string();
        let mut owner = updates.reserve(&id, 1).unwrap();
        let path = owner.partial.path.clone();
        let (send, receive) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            owner
                .authorize(&request(), async { receive.await.unwrap() })
                .await?;
            std::fs::write(&owner.partial.path, b"must not be written").unwrap();
            owner.publish(
                request(),
                Arc::new(StagedFile::new(
                    owner.partial.path.with_extension("apk"),
                    true,
                )),
            )
        });
        updates.cancel(&id).unwrap();
        send.send(Ok(info())).unwrap();
        assert!(task.await.unwrap().is_err());
        assert!(!path.exists());
        assert!(matches!(*updates.lock().unwrap(), Phase::Idle));
        std::fs::remove_dir(&updates.directory).unwrap();
    }
    #[test]
    fn a_failed_exclusive_creation_cannot_delete_an_existing_file() {
        let updates = fixture();
        let path = updates.directory.join("existing.part");
        std::fs::write(&path, b"retain").unwrap();
        drop(StagedFile::new(path.clone(), false));
        assert_eq!(std::fs::read(&path).unwrap(), b"retain");
        std::fs::remove_file(&path).unwrap();
        std::fs::remove_dir(&updates.directory).unwrap();
    }
    #[test]
    fn install_owns_the_prepared_file_and_duplicate_calls_cannot_submit_it_again() {
        let updates = fixture();
        let prepared = ready(&updates);
        let owner = updates.begin_install(&prepared.id).unwrap();
        let path = owner.prepared.file.path.clone();
        assert!(updates.cancel(&prepared.id).is_err());
        assert!(updates.begin_install(&prepared.id).is_err());
        let mut installed = info();
        installed["installStatus"] = json!("installed");
        updates.snapshot(&mut installed).unwrap();
        assert!(path.exists());
        drop(owner);
        updates.snapshot(&mut installed).unwrap();
        assert!(!path.exists());
        std::fs::remove_dir(&updates.directory).unwrap();
    }
    #[test]
    fn lost_install_reply_requires_native_reconciliation_before_explicit_retry() {
        let updates = fixture();
        let prepared = ready(&updates);
        drop(updates.begin_install(&prepared.id).unwrap());
        assert!(updates.begin_install(&prepared.id).is_err());
        let mut pending = info();
        pending["installStatus"] = json!("confirmation-required");
        updates.snapshot(&mut pending).unwrap();
        assert!(updates.begin_install(&prepared.id).is_err());
        let mut failed = info();
        failed["installStatus"] = json!("failed");
        updates.snapshot(&mut failed).unwrap();
        assert!(failed["staged"].is_object());
        assert!(updates.begin_install(&prepared.id).is_ok());
    }
    #[test]
    fn unknown_and_replaced_ids_cannot_cancel_or_install_a_ready_package() {
        let updates = fixture();
        let prepared = ready(&updates);
        assert_eq!(updates.cancel("old-id").unwrap(), None);
        assert!(updates.begin_install("old-id").is_err());
        assert!(
            updates
                .reserve(&uuid::Uuid::new_v4().to_string(), 2)
                .is_err()
        );
        updates.cancel(&prepared.id).unwrap();
        std::fs::remove_dir(&updates.directory).unwrap();
    }
    #[test]
    fn startup_cleanup_only_removes_owned_regular_staging_files() {
        let updates = fixture();
        std::fs::write(updates.directory.join("wallet.json"), b"retain").unwrap();
        std::fs::write(
            updates
                .directory
                .join(format!("{}.part", uuid::Uuid::new_v4())),
            b"partial",
        )
        .unwrap();
        let nested = updates
            .directory
            .join(format!("{}.apk", uuid::Uuid::new_v4()));
        std::fs::create_dir(&nested).unwrap();
        let reopened = AndroidUpdates::new(updates.directory.clone()).unwrap();
        reopened.prepare_directory().unwrap();
        assert_eq!(std::fs::read_dir(&reopened.directory).unwrap().count(), 2);
        assert_eq!(
            std::fs::read(reopened.directory.join("wallet.json")).unwrap(),
            b"retain"
        );
        std::fs::remove_file(reopened.directory.join("wallet.json")).unwrap();
        std::fs::remove_dir(&nested).unwrap();
        std::fs::remove_dir(&reopened.directory).unwrap();
    }
    #[test]
    fn an_unusable_update_cache_does_not_block_wallet_startup() {
        let updates = fixture();
        let blocked = updates.directory.join("blocked-cache");
        std::fs::write(&blocked, b"retain").unwrap();
        let updater = AndroidUpdates::new(blocked.clone());
        assert!(
            updater.is_ok(),
            "Update cache errors must stay inside update actions"
        );
        assert!(
            updater
                .unwrap()
                .reserve(&uuid::Uuid::new_v4().to_string(), 1)
                .is_err()
        );
        assert_eq!(std::fs::read(&blocked).unwrap(), b"retain");
        std::fs::remove_file(blocked).unwrap();
        std::fs::remove_dir(&updates.directory).unwrap();
    }
}
