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
    "The saved update is unavailable. Download it again before installing.";

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
        .map_err(|_| "Could not stage the verified update")?;
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

#[derive(Clone)]
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
        attempt: String,
        calling: bool,
    },
    Failed {
        info: StagedUpdate,
        error: String,
    },
}

#[derive(Debug)]
enum BeginInstallError {
    Invalid(String),
    Failed(String),
}

struct InfoQueryTicket(Phase);
impl InfoQueryTicket {
    fn check(&self, current: &Phase) -> Result<(), String> {
        let unchanged = match (&self.0, current) {
            (Phase::Idle, Phase::Idle) => true,
            (
                Phase::Downloading {
                    id: old_id,
                    generation: old_generation,
                    cancelled: old_cancelled,
                },
                Phase::Downloading {
                    id,
                    generation,
                    cancelled,
                },
            ) => old_id == id && old_generation == generation && old_cancelled == cancelled,
            (Phase::Ready(old), Phase::Ready(prepared)) => old.same_file(prepared),
            (
                Phase::Installing {
                    prepared: old,
                    attempt: old_attempt,
                    calling: old_calling,
                },
                Phase::Installing {
                    prepared,
                    attempt,
                    calling,
                },
            ) => old.same_file(prepared) && old_attempt == attempt && old_calling == calling,
            (
                Phase::Failed {
                    info: old,
                    error: old_error,
                },
                Phase::Failed { info, error },
            ) => old.id == info.id && old.version_code == info.version_code && old_error == error,
            _ => false,
        };
        if unchanged {
            Ok(())
        } else {
            Err("Android update state changed. Check its status again.".into())
        }
    }
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
        if !matches!(*state, Phase::Idle | Phase::Failed { .. }) {
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

    fn info_ticket(&self) -> Result<InfoQueryTicket, String> {
        Ok(InfoQueryTicket(self.lock()?.clone()))
    }

    #[cfg(test)]
    fn snapshot(&self, info: &mut Value) -> Result<(), String> {
        self.snapshot_for(info, &self.info_ticket()?)
    }

    fn snapshot_for(&self, info: &mut Value, ticket: &InfoQueryTicket) -> Result<(), String> {
        let version = info["versionCode"].as_u64();
        let status = info["installStatus"].as_str().unwrap_or("").to_owned();
        let checked = {
            let state = self.lock()?;
            ticket.check(&state)?;
            match &*state {
                Phase::Ready(prepared) => Some(prepared.clone()),
                Phase::Installing {
                    prepared,
                    calling: false,
                    ..
                } if matches!(status.as_str(), "idle" | "failed") => Some(prepared.clone()),
                _ => None,
            }
        };
        let completed = |target| version.is_some_and(|version| version >= target);
        let available = checked
            .as_ref()
            .is_some_and(|prepared| completed(prepared.info.version_code) || prepared.available());
        let fields = info.as_object_mut().ok_or(UNAVAILABLE)?;
        fields.remove("staged");
        fields.remove("downloading");
        let mut state = self.lock()?;
        ticket.check(&state)?;
        let transition = match &*state {
            Phase::Ready(prepared)
            | Phase::Installing {
                prepared,
                calling: false,
                ..
            } if completed(prepared.info.version_code) => Some(Phase::Idle),
            Phase::Failed { info, .. } if completed(info.version_code) => Some(Phase::Idle),
            Phase::Ready(prepared) if !available => Some(Phase::Failed {
                info: prepared.info.clone(),
                error: MISSING_PACKAGE.into(),
            }),
            Phase::Installing {
                prepared,
                calling: false,
                ..
            } if matches!(status.as_str(), "idle" | "failed") => Some(if available {
                Phase::Ready(prepared.clone())
            } else {
                Phase::Failed {
                    info: prepared.info.clone(),
                    error: MISSING_PACKAGE.into(),
                }
            }),
            _ => None,
        };
        if let Some(next) = transition {
            if matches!(next, Phase::Idle) {
                info["installStatus"] = json!("installed");
                info["installError"] = Value::Null;
            }
            *state = next;
        }
        match &*state {
            Phase::Downloading { id, .. } => info["downloading"] = json!({ "id": id }),
            Phase::Ready(prepared) | Phase::Installing { prepared, .. } => {
                info["staged"] = serde_json::to_value(&prepared.info).map_err(|_| UNAVAILABLE)?;
                info["staged"]["ready"] = json!(matches!(*state, Phase::Ready(_)));
                if matches!(*state, Phase::Installing { calling: true, .. }) {
                    info["installStatus"] = json!("installing");
                    info["installError"] = Value::Null;
                }
            }
            Phase::Failed { error, .. } => {
                info["installStatus"] = json!("failed");
                info["installError"] = json!(error);
            }
            Phase::Idle => {}
        }
        Ok(())
    }

    async fn query_info(
        &self,
        query: impl std::future::Future<Output = Result<Value, String>>,
    ) -> Result<Value, String> {
        let ticket = self.info_ticket()?;
        let mut info = query.await?;
        self.snapshot_for(&mut info, &ticket)?;
        Ok(info)
    }

    fn begin_install(&self, id: &str) -> Result<InstallOwner, BeginInstallError> {
        let prepared = {
            let state = self.lock().map_err(BeginInstallError::Invalid)?;
            match &*state {
                Phase::Ready(prepared) if prepared.info.id == id => prepared.clone(),
                Phase::Failed { info, error } if info.id == id => {
                    return Err(BeginInstallError::Failed(error.clone()));
                }
                _ => {
                    return Err(BeginInstallError::Invalid(
                        "The verified update is not ready to install or has been replaced".into(),
                    ));
                }
            }
        };
        let available = prepared.available();
        let mut state = self.lock().map_err(BeginInstallError::Invalid)?;
        if !matches!(&*state, Phase::Ready(current) if current.same_file(&prepared)) {
            return Err(BeginInstallError::Invalid(
                "This update has been replaced or is already running".into(),
            ));
        }
        if !available {
            *state = Phase::Failed {
                info: prepared.info.clone(),
                error: MISSING_PACKAGE.into(),
            };
            return Err(BeginInstallError::Failed(MISSING_PACKAGE.into()));
        }
        let attempt = uuid::Uuid::new_v4().to_string();
        *state = Phase::Installing {
            prepared: prepared.clone(),
            attempt: attempt.clone(),
            calling: true,
        };
        Ok(InstallOwner {
            updates: self.clone(),
            prepared,
            attempt,
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
                let previous = std::mem::replace(&mut *state, Phase::Idle);
                drop(state);
                drop(previous);
                Ok(None)
            }
            Phase::Failed { info, .. } if info.id == id => {
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
    attempt: String,
}
impl InstallOwner {
    fn finish(&self, result: &Result<Value, String>) -> Result<(), String> {
        let known_failure = result.as_ref().is_ok_and(|value| {
            matches!(
                value["installStatus"].as_str(),
                Some("failed" | "permission-required")
            )
        });
        let available = known_failure && self.prepared.available();
        let mut state = self.updates.lock()?;
        if !matches!(&*state, Phase::Installing { prepared, attempt, .. } if prepared.same_file(&self.prepared) && attempt == &self.attempt)
        {
            return Err(UNAVAILABLE.into());
        }
        if known_failure {
            *state = if available {
                Phase::Ready(self.prepared.clone())
            } else {
                Phase::Failed {
                    info: self.prepared.info.clone(),
                    error: MISSING_PACKAGE.into(),
                }
            };
        }
        Ok(())
    }
}
impl Drop for InstallOwner {
    fn drop(&mut self) {
        if let Ok(mut state) = self.updates.lock() {
            if let Phase::Installing {
                prepared,
                attempt,
                calling,
            } = &mut *state
            {
                if prepared.same_file(&self.prepared) && attempt == &self.attempt {
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
    updates
        .query_info(tauri_plugin_shielded_platform::android_update_info(&app))
        .await
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
    let owner = match updates.begin_install(&id) {
        Ok(owner) => owner,
        Err(BeginInstallError::Failed(error)) => {
            return Ok(json!({ "installStatus": "failed", "installError": error }));
        }
        Err(BeginInstallError::Invalid(error)) => return Err(error),
    };
    let request = &owner.prepared.request;
    let result = match check_candidate(request, &info) {
        Ok(()) => tauri_plugin_shielded_platform::android_install_update(&app, json!({ "path": owner.prepared.file.path, "sha256": request.sha256, "bytes": request.bytes, "versionCode": request.version_code })).await,
        Err(error) => Ok(json!({ "installStatus": "failed", "installError": error })),
    };
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
        ready_with_id(updates, &uuid::Uuid::new_v4().to_string())
    }
    fn ready_with_id(updates: &AndroidUpdates, id: &str) -> StagedUpdate {
        let mut owner = updates.reserve(id, 1).unwrap();
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
        installed["versionCode"] = json!(prepared.version_code);
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

    fn prepared_path(updates: &AndroidUpdates) -> PathBuf {
        let state = updates.lock().unwrap();
        match &*state {
            Phase::Ready(prepared) | Phase::Installing { prepared, .. } => {
                prepared.file.path.clone()
            }
            _ => panic!("No prepared file"),
        }
    }

    #[test]
    fn an_old_installed_marker_preserves_the_newer_install_and_its_file() {
        let updates = fixture();
        let prepared = ready(&updates);
        let path = prepared_path(&updates);
        drop(updates.begin_install(&prepared.id).unwrap());
        let mut old_completion = info();
        old_completion["installStatus"] = json!("installed");
        updates.snapshot(&mut old_completion).unwrap();
        assert!(path.exists());
        assert!(matches!(
            *updates.lock().unwrap(),
            Phase::Installing { calling: false, .. }
        ));
        assert_eq!(old_completion["staged"]["id"], prepared.id);
        assert!(updates.begin_install(&prepared.id).is_err());
        let mut completed = info();
        completed["versionCode"] = json!(prepared.version_code);
        completed["installStatus"] = json!("installed");
        updates.snapshot(&mut completed).unwrap();
        assert!(!path.exists());
        assert!(completed.get("staged").is_none());
        std::fs::remove_dir(&updates.directory).unwrap();
    }

    #[test]
    fn a_known_precommit_failure_restores_only_an_available_package_for_explicit_retry() {
        let updates = fixture();
        let prepared = ready(&updates);
        let owner = updates.begin_install(&prepared.id).unwrap();
        owner.finish(&Ok(json!({"installStatus":"failed","installError":"Could not save the installer record"}))).unwrap();
        assert!(matches!(*updates.lock().unwrap(), Phase::Ready(_)));
        drop(owner);
        let mut native = info();
        updates.snapshot(&mut native).unwrap();
        assert_eq!(native["staged"]["id"], prepared.id);
        assert!(updates.begin_install(&prepared.id).is_ok());
    }

    #[test]
    fn an_evicted_ready_package_reports_authoritative_failure_and_allows_a_new_download() {
        let updates = fixture();
        let prepared = ready(&updates);
        std::fs::remove_file(prepared_path(&updates)).unwrap();
        for _ in 0..2 {
            let mut native = info();
            updates.snapshot(&mut native).unwrap();
            assert_eq!(native["installStatus"], "failed");
            assert!(
                native["installError"]
                    .as_str()
                    .unwrap()
                    .contains("Download")
            );
            assert!(native.get("staged").is_none());
        }
        assert!(
            updates
                .reserve(&uuid::Uuid::new_v4().to_string(), 2)
                .is_ok()
        );
        assert_eq!(updates.cancel(&prepared.id).unwrap(), None);
    }

    #[test]
    fn a_package_evicted_between_preflight_and_begin_install_is_a_known_failure() {
        let updates = fixture();
        let prepared = ready(&updates);
        let mut native = info();
        updates.snapshot(&mut native).unwrap();
        assert!(native.get("staged").is_some());
        std::fs::remove_file(prepared_path(&updates)).unwrap();
        let attempt = updates.begin_install(&prepared.id);
        assert!(matches!(attempt, Err(BeginInstallError::Failed(_))));
        let mut native = info();
        updates.snapshot(&mut native).unwrap();
        assert_eq!(native["installStatus"], "failed");
        assert!(native.get("staged").is_none());
    }

    #[test]
    fn native_failure_recovery_cannot_restore_an_evicted_package_to_ready() {
        let updates = fixture();
        let prepared = ready(&updates);
        drop(updates.begin_install(&prepared.id).unwrap());
        std::fs::remove_file(prepared_path(&updates)).unwrap();
        let mut failed = info();
        failed["installStatus"] = json!("failed");
        failed["installError"] = json!("The installer failed");
        updates.snapshot(&mut failed).unwrap();
        assert_eq!(failed["installStatus"], "failed");
        assert!(failed.get("staged").is_none());
        let mut native = info();
        updates.snapshot(&mut native).unwrap();
        assert_eq!(native["installStatus"], "failed");
        assert!(native.get("staged").is_none());
    }

    #[test]
    fn known_failure_and_permission_replies_do_not_restore_a_missing_file() {
        for status in ["failed", "permission-required"] {
            let updates = fixture();
            let prepared = ready(&updates);
            let owner = updates.begin_install(&prepared.id).unwrap();
            std::fs::remove_file(prepared_path(&updates)).unwrap();
            owner.finish(&Ok(json!({"installStatus":status}))).unwrap();
            drop(owner);
            let mut native = info();
            updates.snapshot(&mut native).unwrap();
            assert_eq!(native["installStatus"], "failed");
            assert!(native.get("staged").is_none());
        }
    }

    #[test]
    fn an_active_install_retains_ownership_until_call_and_os_session_settle() {
        let updates = fixture();
        let prepared = ready(&updates);
        let owner = updates.begin_install(&prepared.id).unwrap();
        std::fs::remove_file(prepared_path(&updates)).unwrap();
        let mut failed = info();
        failed["installStatus"] = json!("failed");
        updates.snapshot(&mut failed).unwrap();
        assert_eq!(failed["staged"]["id"], prepared.id);
        assert!(matches!(
            *updates.lock().unwrap(),
            Phase::Installing { calling: true, .. }
        ));
        drop(owner);
        for status in ["installing", "confirmation-required", "installed"] {
            let mut pending = info();
            pending["installStatus"] = json!(status);
            updates.snapshot(&mut pending).unwrap();
            assert_eq!(pending["staged"]["id"], prepared.id);
            assert!(matches!(
                *updates.lock().unwrap(),
                Phase::Installing { calling: false, .. }
            ));
            assert!(updates.cancel(&prepared.id).is_err());
        }
        let mut complete = info();
        complete["installStatus"] = json!("installed");
        complete["versionCode"] = json!(prepared.version_code);
        updates.snapshot(&mut complete).unwrap();
        assert!(matches!(*updates.lock().unwrap(), Phase::Idle));
        assert!(complete.get("staged").is_none());
    }

    #[test]
    fn an_old_install_owner_cannot_finish_or_drop_the_replacement_attempt() {
        let updates = fixture();
        let prepared = ready(&updates);
        let owner = updates.begin_install(&prepared.id).unwrap();
        owner
            .finish(&Ok(json!({"installStatus":"permission-required"})))
            .unwrap();
        let replacement = updates.begin_install(&prepared.id).unwrap();
        assert!(
            owner
                .finish(&Ok(json!({"installStatus":"failed"})))
                .is_err()
        );
        drop(owner);
        assert!(matches!(
            *updates.lock().unwrap(),
            Phase::Installing { calling: true, .. }
        ));
        let mut stale = info();
        stale["installStatus"] = json!("idle");
        updates.snapshot(&mut stale).unwrap();
        assert!(matches!(
            *updates.lock().unwrap(),
            Phase::Installing { calling: true, .. }
        ));
        assert!(updates.begin_install(&prepared.id).is_err());
        drop(replacement);
    }

    #[test]
    fn an_old_id_or_owner_cannot_clear_a_newly_prepared_package() {
        let updates = fixture();
        let first = ready(&updates);
        let old_owner = updates.begin_install(&first.id).unwrap();
        old_owner
            .finish(&Ok(json!({"installStatus":"permission-required"})))
            .unwrap();
        updates.cancel(&first.id).unwrap();
        let next = ready(&updates);
        let next_path = prepared_path(&updates);
        assert_eq!(updates.cancel(&first.id).unwrap(), None);
        assert!(updates.begin_install(&first.id).is_err());
        assert!(
            old_owner
                .finish(&Ok(json!({"installStatus":"failed"})))
                .is_err()
        );
        drop(old_owner);
        let mut native = info();
        updates.snapshot(&mut native).unwrap();
        assert_eq!(native["staged"]["id"], next.id);
        assert!(next_path.exists());
    }

    #[test]
    fn only_an_available_ready_package_advertises_an_explicit_install_retry() {
        let updates = fixture();
        let prepared = ready(&updates);
        assert!(
            serde_json::to_value(&prepared)
                .unwrap()
                .get("ready")
                .is_none()
        );
        let mut native = info();
        updates.snapshot(&mut native).unwrap();
        assert_eq!(native["staged"]["ready"], true);
        assert_eq!(native["staged"].as_object().unwrap().len(), 3);
        let owner = updates.begin_install(&prepared.id).unwrap();
        let mut native = info();
        updates.snapshot(&mut native).unwrap();
        assert_eq!(native["installStatus"], "installing");
        assert_eq!(native["staged"]["ready"], false);
        drop(owner);
        for status in ["installed", "installing", "confirmation-required"] {
            let mut pending = info();
            pending["installStatus"] = json!(status);
            updates.snapshot(&mut pending).unwrap();
            assert_eq!(pending["staged"]["ready"], false);
        }
        let mut failed = info();
        failed["installStatus"] = json!("failed");
        updates.snapshot(&mut failed).unwrap();
        assert_eq!(failed["staged"]["ready"], true);
        std::fs::remove_file(prepared_path(&updates)).unwrap();
        let mut missing = info();
        updates.snapshot(&mut missing).unwrap();
        assert_eq!(missing["installStatus"], "failed");
        assert!(missing.get("staged").is_none());
        std::fs::remove_dir(&updates.directory).unwrap();
    }

    #[test]
    fn actual_completion_wins_over_eviction_and_clears_a_known_cache_failure() {
        for previously_failed in [false, true] {
            let updates = fixture();
            let prepared = ready(&updates);
            std::fs::remove_file(prepared_path(&updates)).unwrap();
            if previously_failed {
                let mut native = info();
                updates.snapshot(&mut native).unwrap();
                assert_eq!(native["installStatus"], "failed");
            }
            let mut completed = info();
            completed["versionCode"] = json!(prepared.version_code);
            completed["installStatus"] = json!(if previously_failed {
                "failed"
            } else {
                "installed"
            });
            updates.snapshot(&mut completed).unwrap();
            assert_eq!(completed["installStatus"], "installed");
            assert!(completed.get("staged").is_none());
            assert!(matches!(*updates.lock().unwrap(), Phase::Idle));
            assert!(
                updates
                    .reserve(&uuid::Uuid::new_v4().to_string(), 2)
                    .is_ok()
            );
        }
    }

    #[test]
    fn a_directory_cannot_become_a_retryable_prepared_package() {
        let updates = fixture();
        ready(&updates);
        let path = prepared_path(&updates);
        std::fs::remove_file(&path).unwrap();
        std::fs::create_dir(&path).unwrap();
        let mut native = info();
        updates.snapshot(&mut native).unwrap();
        assert_eq!(native["installStatus"], "failed");
        assert!(native.get("staged").is_none());
        assert!(path.is_dir());
        std::fs::remove_dir(&path).unwrap();
        std::fs::remove_dir(&updates.directory).unwrap();
    }

    #[test]
    fn an_evicted_cache_directory_is_recreated_for_an_explicit_download() {
        let updates = fixture();
        ready(&updates);
        std::fs::remove_file(prepared_path(&updates)).unwrap();
        std::fs::remove_dir(&updates.directory).unwrap();
        let mut native = info();
        updates.snapshot(&mut native).unwrap();
        assert_eq!(native["installStatus"], "failed");
        let owner = updates
            .reserve(&uuid::Uuid::new_v4().to_string(), 2)
            .unwrap();
        assert!(updates.directory.is_dir());
        drop(owner);
        std::fs::remove_dir(&updates.directory).unwrap();
    }

    #[tokio::test]
    async fn an_info_query_started_before_an_install_cannot_unlock_it_later() {
        let updates = fixture();
        let prepared = ready(&updates);
        let query_updates = updates.clone();
        let (started, entered) = tokio::sync::oneshot::channel();
        let (send, receive) = tokio::sync::oneshot::channel();
        let query = tokio::spawn(async move {
            query_updates
                .query_info(async {
                    started.send(()).unwrap();
                    receive.await.unwrap()
                })
                .await
        });
        entered.await.unwrap();
        let owner = updates.begin_install(&prepared.id).unwrap();
        owner
            .finish(&Ok(json!({"installStatus":"installing"})))
            .unwrap();
        drop(owner);
        send.send(Ok(info())).unwrap();
        assert!(query.await.unwrap().is_err());
        assert!(matches!(
            *updates.lock().unwrap(),
            Phase::Installing { calling: false, .. }
        ));
        assert!(updates.begin_install(&prepared.id).is_err());
    }

    #[tokio::test]
    async fn an_info_query_with_an_old_calling_ticket_cannot_reconcile_a_settled_call() {
        let updates = fixture();
        let prepared = ready(&updates);
        let owner = updates.begin_install(&prepared.id).unwrap();
        let query_updates = updates.clone();
        let (started, entered) = tokio::sync::oneshot::channel();
        let (send, receive) = tokio::sync::oneshot::channel();
        let query = tokio::spawn(async move {
            query_updates
                .query_info(async {
                    started.send(()).unwrap();
                    receive.await.unwrap()
                })
                .await
        });
        entered.await.unwrap();
        drop(owner);
        let mut stale = info();
        stale["installStatus"] = json!("failed");
        send.send(Ok(stale)).unwrap();
        assert!(query.await.unwrap().is_err());
        assert!(matches!(
            *updates.lock().unwrap(),
            Phase::Installing { calling: false, .. }
        ));
    }

    #[tokio::test]
    async fn an_old_info_query_cannot_match_a_reused_public_id_with_a_new_file() {
        let updates = fixture();
        let prepared = ready(&updates);
        let old_path = prepared_path(&updates);
        let query_updates = updates.clone();
        let (started, entered) = tokio::sync::oneshot::channel();
        let (send, receive) = tokio::sync::oneshot::channel();
        let query = tokio::spawn(async move {
            query_updates
                .query_info(async {
                    started.send(()).unwrap();
                    receive.await.unwrap()
                })
                .await
        });
        entered.await.unwrap();
        updates.cancel(&prepared.id).unwrap();
        ready_with_id(&updates, &prepared.id);
        let replacement_path = prepared_path(&updates);
        assert_ne!(old_path, replacement_path);
        send.send(Ok(info())).unwrap();
        assert!(query.await.unwrap().is_err());
        assert!(replacement_path.exists());
        assert!(!old_path.exists());
        assert!(matches!(*updates.lock().unwrap(), Phase::Ready(_)));
    }

    #[cfg(unix)]
    #[test]
    fn a_staging_symlink_never_follows_or_deletes_its_target() {
        let updates = fixture();
        ready(&updates);
        let path = prepared_path(&updates);
        let target = updates.directory.join("retained-data");
        std::fs::write(&target, b"retain").unwrap();
        std::fs::remove_file(&path).unwrap();
        std::os::unix::fs::symlink(&target, &path).unwrap();
        let mut native = info();
        updates.snapshot(&mut native).unwrap();
        assert_eq!(native["installStatus"], "failed");
        assert!(native.get("staged").is_none());
        assert_eq!(std::fs::read(&target).unwrap(), b"retain");
        std::fs::remove_file(&target).unwrap();
        std::fs::remove_dir(&updates.directory).unwrap();
    }
}
