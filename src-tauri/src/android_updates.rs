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
const MISSING_PACKAGE: &str =
    "The downloaded update is no longer on this device. Try again to download it.";

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

/// Android's SELinux policy denies apps the `link` permission, so the verified
/// download is moved into place rather than hard-linked, and the move hands over ownership.
async fn stage_verified(partial: &StagedFile) -> Result<Arc<StagedFile>, String> {
    let completed = partial.path.with_extension("apk");
    tokio::fs::rename(&partial.path, &completed)
        .await
        .map_err(|error| format!("Could not stage the verified update: {error}"))?;
    partial.owned.store(false, Ordering::Release);
    Ok(Arc::new(StagedFile::new(completed, true)))
}

#[derive(Clone)]
struct Prepared {
    info: StagedUpdate,
    file: Arc<StagedFile>,
    request: UpdateRequest,
}
impl Prepared {
    fn available(&self) -> bool {
        std::fs::symlink_metadata(&self.file.path)
            .is_ok_and(|metadata| metadata.file_type().is_file())
    }

    fn same_file(&self, other: &Self) -> bool {
        self.info.id == other.info.id && Arc::ptr_eq(&self.file, &other.file)
    }
}

enum Phase {
    Idle,
    Downloading {
        id: String,
        generation: u64,
        cancelled: bool,
    },
    Ready(Prepared),
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
        // Android can evict this cache after initialization; recreate it and reject substituted symlinks.
        let directory = &self.directory;
        std::fs::create_dir_all(&directory).map_err(|_| UNAVAILABLE)?;
        if std::fs::symlink_metadata(&directory)
            .map_err(|_| UNAVAILABLE)?
            .file_type()
            .is_symlink()
        {
            return Err(UNAVAILABLE.into());
        }
        if *ready {
            return Ok(());
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
        let fields = info.as_object_mut().ok_or(UNAVAILABLE)?;
        fields.remove("staged");
        fields.remove("downloading");
        match &*self.lock()? {
            Phase::Downloading { id, .. } => info["downloading"] = json!({ "id": id }),
            Phase::Ready(prepared) => {
                info["staged"] = serde_json::to_value(&prepared.info).map_err(|_| UNAVAILABLE)?;
            }
            Phase::Idle => {}
        }
        Ok(())
    }

    /// The clone is the handoff's lease: discarding the stage cannot delete the file until it drops.
    fn prepared(&self, id: &str) -> Result<Prepared, String> {
        let prepared = match &*self.lock()? {
            Phase::Ready(prepared) if prepared.info.id == id => prepared.clone(),
            _ => return Err("The verified update is not ready or has been replaced".into()),
        };
        if prepared.available() {
            return Ok(prepared);
        }
        let mut state = self.lock()?;
        if matches!(&*state, Phase::Ready(current) if current.same_file(&prepared)) {
            *state = Phase::Idle;
        }
        Err(MISSING_PACKAGE.into())
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
                let previous = std::mem::replace(&mut *state, Phase::Idle);
                drop(state);
                drop(previous);
                Ok(None)
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
    let completed = stage_verified(&owner.partial).await?;
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

/// Android's own installer receives only the file this host verified and still stages; the
/// plugin checks the archive's identity and digest again right before it hands it over.
#[tauri::command]
pub async fn native_android_update_open(
    app: AppHandle,
    window: WebviewWindow,
    updates: State<'_, AndroidUpdates>,
    id: String,
) -> Result<(), String> {
    crate::ensure_local(&window)?;
    let prepared = updates.prepared(&id)?;
    let request = &prepared.request;
    check_candidate(
        request,
        &tauri_plugin_shielded_platform::android_update_info(&app).await?,
    )?;
    tauri_plugin_shielded_platform::android_open_update_installer(
        &app,
        json!({ "path": prepared.file.path, "sha256": request.sha256, "bytes": request.bytes, "versionCode": request.version_code }),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    fn info() -> Value {
        let signing = signing_identity();
        json!({ "packageName": signing["packageName"], "signerSha256": signing["certificateSha256"], "versionCode": 100099, "installerPackageName": null })
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
    fn prepared_path(updates: &AndroidUpdates) -> PathBuf {
        match &*updates.lock().unwrap() {
            Phase::Ready(prepared) => prepared.file.path.clone(),
            _ => panic!("No prepared file"),
        }
    }
    #[test]
    fn candidate_refuses_legacy_signing_downgrades_and_wrong_or_store_managed_packages() {
        assert!(check_candidate(&request(), &info()).is_ok());
        for (key, bad) in [
            ("signerSha256", json!("0".repeat(64))),
            ("packageName", json!("another.wallet")),
            ("versionCode", json!(100100)),
            ("installerPackageName", json!("com.android.vending")),
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
    #[tokio::test]
    async fn a_verified_download_is_moved_into_place_not_hard_linked() {
        let updates = fixture();
        let owner = updates
            .reserve(&uuid::Uuid::new_v4().to_string(), 1)
            .unwrap();
        std::fs::write(&owner.partial.path, b"verified test package").unwrap();
        owner.partial.owned.store(true, Ordering::Release);
        let staged = stage_verified(&owner.partial).await.unwrap();
        assert!(!owner.partial.path.exists());
        assert_eq!(
            std::fs::read(&staged.path).unwrap(),
            b"verified test package"
        );
        let path = staged.path.clone();
        drop(owner);
        assert!(path.exists());
        drop(staged);
        assert!(!path.exists());
        std::fs::remove_dir(&updates.directory).unwrap();
    }
    #[tokio::test]
    async fn a_failed_staging_keeps_and_still_owns_the_download() {
        let updates = fixture();
        let owner = updates
            .reserve(&uuid::Uuid::new_v4().to_string(), 1)
            .unwrap();
        std::fs::write(&owner.partial.path, b"verified test package").unwrap();
        owner.partial.owned.store(true, Ordering::Release);
        let blocked = owner.partial.path.with_extension("apk");
        std::fs::create_dir(&blocked).unwrap();
        std::fs::write(blocked.join("occupied"), b"").unwrap();
        let error = stage_verified(&owner.partial).await.err().unwrap();
        assert!(
            error.starts_with("Could not stage the verified update: "),
            "{error}"
        );
        assert!(owner.partial.path.exists());
        let partial = owner.partial.path.clone();
        drop(owner);
        assert!(!partial.exists());
        std::fs::remove_dir_all(&updates.directory).unwrap();
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
    fn a_handoff_keeps_the_verified_file_staged_and_its_lease_outlives_a_discard() {
        let updates = fixture();
        let staged = ready(&updates);
        let path = prepared_path(&updates);
        drop(updates.prepared(&staged.id).unwrap());
        let lease = updates.prepared(&staged.id).unwrap();
        assert!(matches!(*updates.lock().unwrap(), Phase::Ready(_)));
        assert_eq!(updates.cancel(&staged.id).unwrap(), None);
        assert!(matches!(*updates.lock().unwrap(), Phase::Idle));
        assert!(path.exists());
        drop(lease);
        assert!(!path.exists());
        std::fs::remove_dir(&updates.directory).unwrap();
    }
    #[test]
    fn unknown_and_replaced_ids_cannot_cancel_or_hand_off_a_ready_package() {
        let updates = fixture();
        let first = ready(&updates);
        assert_eq!(updates.cancel("old-id").unwrap(), None);
        assert!(updates.prepared("old-id").is_err());
        assert!(
            updates
                .reserve(&uuid::Uuid::new_v4().to_string(), 2)
                .is_err()
        );
        updates.cancel(&first.id).unwrap();
        let next = ready(&updates);
        let next_path = prepared_path(&updates);
        assert_eq!(updates.cancel(&first.id).unwrap(), None);
        assert!(updates.prepared(&first.id).is_err());
        assert!(next_path.exists());
        assert_eq!(updates.prepared(&next.id).unwrap().file.path, next_path);
        updates.cancel(&next.id).unwrap();
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
    #[test]
    fn info_projects_only_the_current_stage() {
        let updates = fixture();
        let mut native = info();
        native["staged"] = json!({ "id": "forged", "versionCode": 1 });
        updates.snapshot(&mut native).unwrap();
        assert!(native.get("staged").is_none() && native.get("downloading").is_none());
        let id = uuid::Uuid::new_v4().to_string();
        let owner = updates.reserve(&id, 1).unwrap();
        updates.snapshot(&mut native).unwrap();
        assert_eq!(native["downloading"], json!({ "id": id }));
        drop(owner);
        let staged = ready(&updates);
        updates.snapshot(&mut native).unwrap();
        assert_eq!(
            native["staged"],
            json!({ "id": staged.id, "versionCode": staged.version_code })
        );
        assert!(native.get("downloading").is_none());
        updates.cancel(&staged.id).unwrap();
        std::fs::remove_dir(&updates.directory).unwrap();
    }
    #[test]
    fn an_evicted_package_fails_its_handoff_and_allows_a_new_download() {
        let updates = fixture();
        let staged = ready(&updates);
        std::fs::remove_file(prepared_path(&updates)).unwrap();
        assert_eq!(updates.prepared(&staged.id).err().unwrap(), MISSING_PACKAGE);
        assert!(matches!(*updates.lock().unwrap(), Phase::Idle));
        let mut native = info();
        updates.snapshot(&mut native).unwrap();
        assert!(native.get("staged").is_none());
        std::fs::remove_dir(&updates.directory).unwrap();
        let owner = updates
            .reserve(&uuid::Uuid::new_v4().to_string(), 2)
            .unwrap();
        assert!(updates.directory.is_dir());
        drop(owner);
        std::fs::remove_dir(&updates.directory).unwrap();
    }
    #[test]
    fn a_directory_cannot_become_a_prepared_package() {
        let updates = fixture();
        let staged = ready(&updates);
        let path = prepared_path(&updates);
        std::fs::remove_file(&path).unwrap();
        std::fs::create_dir(&path).unwrap();
        assert!(updates.prepared(&staged.id).is_err());
        assert!(matches!(*updates.lock().unwrap(), Phase::Idle));
        assert!(path.is_dir());
        std::fs::remove_dir(&path).unwrap();
        std::fs::remove_dir(&updates.directory).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_staging_symlink_never_follows_or_deletes_its_target() {
        let updates = fixture();
        let staged = ready(&updates);
        let path = prepared_path(&updates);
        let target = updates.directory.join("retained-data");
        std::fs::write(&target, b"retain").unwrap();
        std::fs::remove_file(&path).unwrap();
        std::os::unix::fs::symlink(&target, &path).unwrap();
        assert!(updates.prepared(&staged.id).is_err());
        assert!(matches!(*updates.lock().unwrap(), Phase::Idle));
        assert_eq!(std::fs::read(&target).unwrap(), b"retain");
        std::fs::remove_file(&target).unwrap();
        std::fs::remove_dir(&updates.directory).unwrap();
    }
}
