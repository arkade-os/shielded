use crate::transport::{PrivacyTransport, UpdateDownload, UpdateProgress};
use base64::{Engine, engine::general_purpose::STANDARD};
use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, MutexGuard,
        atomic::{AtomicBool, Ordering},
    },
};
use tauri::{AppHandle, Manager, State, WebviewWindow, ipc::Channel};

const UNAVAILABLE: &str = "Desktop updater unavailable";
const UNSUPPORTED: &str =
    "This installation cannot update itself. Download the new version from the downloads page.";
const CHANGED: &str = "The saved update is missing or changed. Download it again.";
const STAGING: &str = ".shielded-update-";

/// Release platform, installable asset suffix and staged file extension.
type Host = (&'static str, &'static str, &'static str);
#[cfg(target_os = "windows")]
const HOST: Option<Host> = Some(("windows-x86_64", "-setup.exe", "exe"));
#[cfg(target_os = "linux")]
const HOST: Option<Host> = Some(("linux-x86_64", ".AppImage", "AppImage"));
#[cfg(target_os = "macos")]
const HOST: Option<Host> = Some(("macos-universal", ".app.zip", "zip"));
#[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
const HOST: Option<Host> = None;

/// Tauri's NSIS installer: passive, update mode, relaunch the app after success.
#[cfg(any(target_os = "windows", test))]
const INSTALLER_ARGUMENTS: [&str; 3] = ["/P", "/UPDATE", "/R"];

/// The run number and commit CI compiles in, the same values as the renderer's build identity.
fn installed() -> Result<(u64, &'static str), String> {
    release_identity(option_env!("GITHUB_RUN_NUMBER"), option_env!("GITHUB_SHA"))
}

fn release_identity(
    build: Option<&str>,
    commit: Option<&'static str>,
) -> Result<(u64, &'static str), String> {
    build
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|build| *build > 0)
        .zip(commit.filter(|commit| is_commit(commit)))
        .ok_or_else(|| {
            "This build has no release identity. Download updates from the downloads page.".into()
        })
}

fn is_commit(value: &str) -> bool {
    value.len() == 40
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesktopUpdate {
    url: String,
    bytes: u64,
    sha256: String,
    commit: String,
    build_number: u64,
    signature: String,
}

impl DesktopUpdate {
    fn download(&self) -> UpdateDownload {
        UpdateDownload {
            url: self.url.clone(),
            bytes: self.bytes,
            sha256: self.sha256.clone(),
        }
    }
}

fn release_key() -> Result<VerifyingKey, String> {
    let pinned: serde_json::Value =
        serde_json::from_str(include_str!("../update-signing.json")).map_err(|_| UNAVAILABLE)?;
    let hex = pinned["publicKey"].as_str().unwrap_or_default();
    let mut key = [0u8; 32];
    for (index, byte) in key.iter_mut().enumerate() {
        *byte = hex
            .get(index * 2..index * 2 + 2)
            .and_then(|pair| u8::from_str_radix(pair, 16).ok())
            .ok_or(UNAVAILABLE)?;
    }
    VerifyingKey::from_bytes(&key).map_err(|_| UNAVAILABLE.into())
}

fn message(platform: &str, file: &str, update: &DesktopUpdate) -> String {
    format!(
        "shielded-native-update-v1\nchannel=native-mutinynet\nnetwork=mutinynet\nplatform={platform}\nfile={file}\nbytes={}\nsha256={}\ncommit={}\nbuildNumber={}",
        update.bytes, update.sha256, update.commit, update.build_number
    )
}

/// Accepts only a newer installer for this host's platform, signed by the release key.
fn check(
    update: &DesktopUpdate,
    platform: &str,
    suffix: &str,
    installed: (u64, &str),
    key: &VerifyingKey,
) -> Result<(), String> {
    let file = update.download().file()?;
    if !file.starts_with(&format!("shielded-mutinynet-{platform}-")) || !file.ends_with(suffix) {
        return Err("This update package is for a different platform".into());
    }
    if !is_commit(&update.commit) {
        return Err("The update identity is invalid".into());
    }
    if update.build_number <= installed.0 || update.commit == installed.1 {
        return Err("This version of Shielded is already installed".into());
    }
    let signature = STANDARD
        .decode(&update.signature)
        .ok()
        .and_then(|bytes| <[u8; 64]>::try_from(bytes).ok())
        .ok_or("The update signature is invalid")?;
    key.verify_strict(
        message(platform, &file, update).as_bytes(),
        &Signature::from_bytes(&signature),
    )
    .map_err(|_| "The update signature is invalid".into())
}

struct StagedFile {
    path: PathBuf,
    owned: AtomicBool,
}
impl Drop for StagedFile {
    fn drop(&mut self) {
        if self.owned.load(Ordering::Acquire) {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

async fn stage_verified(partial: &StagedFile, extension: &str) -> Result<Arc<StagedFile>, String> {
    let path = partial.path.with_extension(extension);
    tokio::fs::rename(&partial.path, &path)
        .await
        .map_err(|error| format!("Could not stage the verified update: {error}"))?;
    partial.owned.store(false, Ordering::Release);
    Ok(Arc::new(StagedFile {
        path,
        owned: AtomicBool::new(true),
    }))
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StagedDesktopUpdate {
    id: String,
    build_number: u64,
}

#[derive(Clone)]
struct Prepared {
    info: StagedDesktopUpdate,
    file: Arc<StagedFile>,
    update: DesktopUpdate,
}

enum Phase {
    Idle,
    Downloading {
        id: String,
        generation: u64,
        cancelled: bool,
    },
    Ready(Prepared),
    Installing(Prepared),
}

#[derive(Clone)]
pub struct DesktopUpdates {
    directory: PathBuf,
    state: Arc<Mutex<Phase>>,
}

fn staged_id(name: &str) -> Option<&str> {
    name.split_once('.')
        .filter(|(_, extension)| ["part", "exe", "AppImage", "zip"].contains(extension))
        .map(|(id, _)| id)
}

fn staging_id(name: &str) -> Option<&str> {
    name.strip_prefix(STAGING)
}

/// Best effort: an installer still running after the relaunch goes on a later start.
fn remove_leftovers(directory: &Path, id: fn(&str) -> Option<&str>) {
    for entry in std::fs::read_dir(directory).into_iter().flatten().flatten() {
        let name = entry.file_name();
        if !name
            .to_str()
            .and_then(id)
            .is_some_and(|id| uuid::Uuid::parse_str(id).is_ok())
        {
            continue;
        }
        let _ = match entry.file_type() {
            Ok(kind) if kind.is_dir() => std::fs::remove_dir_all(entry.path()),
            Ok(kind) if kind.is_file() => std::fs::remove_file(entry.path()),
            _ => Ok(()),
        };
    }
}

impl DesktopUpdates {
    pub fn new(app: &AppHandle) -> tauri::Result<Self> {
        if let Some(parent) = target(app).ok().flatten().as_deref().and_then(Path::parent) {
            remove_leftovers(parent, staging_id);
        }
        Ok(Self::at(
            app.path().app_cache_dir()?.join("shielded-desktop-updates"),
        ))
    }

    fn at(directory: PathBuf) -> Self {
        remove_leftovers(&directory, staged_id);
        Self {
            directory,
            state: Arc::new(Mutex::new(Phase::Idle)),
        }
    }

    fn lock(&self) -> Result<MutexGuard<'_, Phase>, String> {
        self.state.lock().map_err(|_| UNAVAILABLE.into())
    }

    fn reserve(&self, id: &str, generation: u64) -> Result<DownloadOwner, String> {
        if uuid::Uuid::parse_str(id).is_err() {
            return Err("Invalid update identifier".into());
        }
        std::fs::create_dir_all(&self.directory).map_err(|_| UNAVAILABLE)?;
        if std::fs::symlink_metadata(&self.directory)
            .map_err(|_| UNAVAILABLE)?
            .file_type()
            .is_symlink()
        {
            return Err(UNAVAILABLE.into());
        }
        let mut state = self.lock()?;
        if !matches!(*state, Phase::Idle) {
            return Err("A desktop update is already downloading or saved".into());
        }
        *state = Phase::Downloading {
            id: id.into(),
            generation,
            cancelled: false,
        };
        Ok(DownloadOwner {
            updates: self.clone(),
            id: id.into(),
            partial: Arc::new(StagedFile {
                path: self.directory.join(format!("{}.part", uuid::Uuid::new_v4())),
                owned: AtomicBool::new(false),
            }),
            finished: false,
        })
    }

    fn snapshot(&self) -> Result<(Option<StagedDesktopUpdate>, Option<String>), String> {
        Ok(match &*self.lock()? {
            Phase::Idle => (None, None),
            Phase::Downloading { id, .. } => (None, Some(id.clone())),
            Phase::Ready(prepared) | Phase::Installing(prepared) => {
                (Some(prepared.info.clone()), None)
            }
        })
    }

    fn begin_install(&self, id: &str) -> Result<Prepared, String> {
        let mut state = self.lock()?;
        let prepared = match &*state {
            Phase::Ready(prepared) if prepared.info.id == id => prepared.clone(),
            _ => return Err("This update is not ready to install or has been replaced".into()),
        };
        *state = Phase::Installing(prepared.clone());
        Ok(prepared)
    }

    fn end_install(&self, prepared: &Prepared, keep: bool) {
        if let Ok(mut state) = self.lock() {
            if matches!(&*state, Phase::Installing(current) if Arc::ptr_eq(&current.file, &prepared.file))
            {
                *state = if keep {
                    Phase::Ready(prepared.clone())
                } else {
                    Phase::Idle
                };
            }
        }
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
            Phase::Installing(prepared) if prepared.info.id == id => {
                Err("This update is being installed".into())
            }
            _ => Ok(None),
        }
    }
}

struct DownloadOwner {
    updates: DesktopUpdates,
    id: String,
    partial: Arc<StagedFile>,
    finished: bool,
}
impl DownloadOwner {
    fn publish(
        &mut self,
        update: DesktopUpdate,
        file: Arc<StagedFile>,
    ) -> Result<StagedDesktopUpdate, String> {
        let mut state = self.updates.lock()?;
        if !matches!(&*state, Phase::Downloading { id, cancelled: false, .. } if id == &self.id) {
            return Err("Update download cancelled".into());
        }
        let info = StagedDesktopUpdate {
            id: self.id.clone(),
            build_number: update.build_number,
        };
        *state = Phase::Ready(Prepared {
            info: info.clone(),
            file,
            update,
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

/// Streams the saved update into `sink`, refusing it unless it still has the signed length and SHA-256.
fn copy_checked(source: impl Read, mut sink: impl Write, update: &DesktopUpdate) -> Result<(), String> {
    let mut source = source.take(update.bytes.saturating_add(1));
    let (mut digest, mut buffer, mut length) = (Sha256::new(), vec![0; 1 << 20], 0u64);
    loop {
        let read = source.read(&mut buffer).map_err(|_| CHANGED)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
        sink.write_all(&buffer[..read])
            .map_err(|_| "Could not write the update")?;
        length += read as u64;
    }
    let sha256: String = digest
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    if length != update.bytes || sha256 != update.sha256 {
        return Err(CHANGED.into());
    }
    Ok(())
}

fn verify(staged: &Path, update: &DesktopUpdate) -> Result<(), String> {
    let file = std::fs::File::open(staged).map_err(|_| CHANGED)?;
    copy_checked(file, std::io::sink(), update)
}

fn writable(directory: &Path) -> Result<(), String> {
    let probe = directory.join(format!("{STAGING}{}", uuid::Uuid::new_v4()));
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&probe)
        .map_err(|_| UNSUPPORTED)?;
    let _ = std::fs::remove_file(&probe);
    Ok(())
}

#[cfg(any(target_os = "linux", test))]
fn appimage(value: Option<&std::ffi::OsStr>) -> Result<PathBuf, String> {
    let path = PathBuf::from(value.ok_or(UNSUPPORTED)?);
    if !path.is_absolute() || !std::fs::symlink_metadata(&path).is_ok_and(|item| item.is_file()) {
        return Err(UNSUPPORTED.into());
    }
    Ok(path)
}

#[cfg(any(target_os = "linux", test))]
fn write_executable(staged: &Path, path: &Path, update: &DesktopUpdate) -> Result<(), String> {
    let mut copy = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|_| UNSUPPORTED)?;
    let source = std::fs::File::open(staged).map_err(|_| CHANGED)?;
    copy_checked(source, &mut copy, update)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        copy.set_permissions(std::fs::Permissions::from_mode(0o755))
            .map_err(|_| "Could not mark the update executable")?;
    }
    copy.sync_all()
        .map_err(|_| "Could not save the update".into())
}

/// Swaps the AppImage by rename, so the running image keeps its open inode.
#[cfg(any(target_os = "linux", test))]
fn replace_file(staged: &Path, target: &Path, update: &DesktopUpdate) -> Result<(), String> {
    let temporary = target.with_file_name(format!("{STAGING}{}", uuid::Uuid::new_v4()));
    let result = write_executable(staged, &temporary, update).and_then(|()| {
        std::fs::rename(&temporary, target)
            .map_err(|error| format!("Could not replace the AppImage: {error}"))
    });
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

#[cfg(any(target_os = "macos", test))]
fn bundle_root(binary: &Path) -> Result<PathBuf, String> {
    let bundle = binary
        .parent()
        .filter(|directory| directory.ends_with("MacOS"))
        .and_then(Path::parent)
        .filter(|directory| directory.ends_with("Contents"))
        .and_then(Path::parent)
        .filter(|bundle| bundle.extension().is_some_and(|extension| extension == "app"))
        .ok_or(UNSUPPORTED)?;
    // Gatekeeper runs a quarantined app from a random read-only copy; replacing it updates nothing.
    if bundle.components().any(|part| part.as_os_str() == "AppTranslocation") {
        return Err("Move Shielded to the Applications folder and reopen it to update in place.".into());
    }
    Ok(bundle.to_path_buf())
}

#[cfg(target_os = "macos")]
fn exchange(from: &Path, to: &Path) -> std::io::Result<()> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    let (from, to) = (
        CString::new(from.as_os_str().as_bytes())?,
        CString::new(to.as_os_str().as_bytes())?,
    );
    // SAFETY: both pointers are NUL-terminated paths that outlive the call.
    match unsafe { libc::renamex_np(from.as_ptr(), to.as_ptr(), libc::RENAME_SWAP) } {
        0 => Ok(()),
        _ => Err(std::io::Error::last_os_error()),
    }
}

/// One atomic exchange, so the installed path always holds a complete app and a failure
/// changes nothing; on success the staging folder holds the previous version.
#[cfg(target_os = "macos")]
fn swap_bundle(bundle: &Path, staging: &Path) -> Result<(), String> {
    let update = staging.join("Shielded.app");
    if !std::fs::symlink_metadata(&update).is_ok_and(|item| item.is_dir()) {
        return Err("The update archive does not contain Shielded.app".into());
    }
    exchange(&update, bundle).map_err(|error| {
        format!("Could not replace Shielded in place ({error}); it is unchanged. Try again, or install the update from the downloads page.")
    })
}

/// What install replaces in place; Windows hands that to the NSIS installer.
#[cfg(target_os = "windows")]
fn target(_app: &AppHandle) -> Result<Option<PathBuf>, String> {
    Ok(None)
}

#[cfg(target_os = "linux")]
fn target(app: &AppHandle) -> Result<Option<PathBuf>, String> {
    appimage(app.env().appimage.as_deref()).map(Some)
}

#[cfg(target_os = "macos")]
fn target(app: &AppHandle) -> Result<Option<PathBuf>, String> {
    let binary = tauri::process::current_binary(&app.env()).map_err(|_| UNAVAILABLE)?;
    bundle_root(&binary).map(Some)
}

#[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
fn target(_app: &AppHandle) -> Result<Option<PathBuf>, String> {
    Err(UNAVAILABLE.into())
}

/// Hashes through a handle that shares reading only, so the verified installer cannot be
/// rewritten, renamed or deleted until its process exists and Windows protects the image.
#[cfg(target_os = "windows")]
fn lock_installer(staged: &Path, update: &DesktopUpdate) -> Result<std::fs::File, String> {
    use std::os::windows::fs::OpenOptionsExt;
    const FILE_SHARE_READ: u32 = 1;
    let installer = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ)
        .open(staged)
        .map_err(|_| CHANGED)?;
    copy_checked(&installer, std::io::sink(), update)?;
    Ok(installer)
}

/// Returns whether Tauri should relaunch the app; the NSIS installer relaunches it itself.
#[cfg(target_os = "windows")]
fn install(staged: &Path, _target: Option<&Path>, update: &DesktopUpdate) -> Result<bool, String> {
    let _installer = lock_installer(staged, update)?;
    std::process::Command::new(staged)
        .args(INSTALLER_ARGUMENTS)
        .spawn()
        .map_err(|error| format!("Could not start the installer: {error}"))?;
    Ok(false)
}

#[cfg(target_os = "linux")]
fn install(staged: &Path, target: Option<&Path>, update: &DesktopUpdate) -> Result<bool, String> {
    replace_file(staged, target.ok_or(UNSUPPORTED)?, update)?;
    Ok(true)
}

#[cfg(target_os = "macos")]
fn install(staged: &Path, target: Option<&Path>, _update: &DesktopUpdate) -> Result<bool, String> {
    let bundle = target.ok_or(UNSUPPORTED)?;
    let staging = bundle.with_file_name(format!("{STAGING}{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&staging).map_err(|_| UNSUPPORTED)?;
    let unpacked = std::process::Command::new("/usr/bin/ditto")
        .args(["-x", "-k"])
        .arg(staged)
        .arg(&staging)
        .status()
        .is_ok_and(|status| status.success());
    let result = if unpacked {
        swap_bundle(bundle, &staging)
    } else {
        Err("Could not unpack the update".into())
    };
    // A failed exchange moved nothing, so staging holds only the unpacked update.
    if result.is_err() {
        let _ = std::fs::remove_dir_all(&staging);
    }
    result.map(|()| true)
}

#[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
fn install(_staged: &Path, _target: Option<&Path>, _update: &DesktopUpdate) -> Result<bool, String> {
    Err(UNAVAILABLE.into())
}

/// This host's platform and what it replaces, or why it cannot update itself in place.
fn host(app: &AppHandle) -> Result<(Host, Option<PathBuf>), String> {
    let host = HOST.ok_or(UNAVAILABLE)?;
    installed()?;
    let target = target(app)?;
    if let Some(parent) = target.as_deref().and_then(Path::parent) {
        writable(parent)?;
    }
    Ok((host, target))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopUpdateInfo {
    platform: Option<&'static str>,
    build_number: u64,
    commit: &'static str,
    unsupported: Option<String>,
    staged: Option<StagedDesktopUpdate>,
    downloading: Option<String>,
}

#[tauri::command]
pub async fn native_desktop_update_info(
    app: AppHandle,
    window: WebviewWindow,
    updates: State<'_, DesktopUpdates>,
) -> Result<DesktopUpdateInfo, String> {
    crate::ensure_local(&window)?;
    let (build_number, commit) = installed().unwrap_or((0, ""));
    let (staged, downloading) = updates.snapshot()?;
    Ok(DesktopUpdateInfo {
        platform: HOST.map(|(platform, ..)| platform),
        build_number,
        commit,
        unsupported: host(&app).err(),
        staged,
        downloading,
    })
}

#[tauri::command]
pub async fn native_desktop_update_download(
    app: AppHandle,
    window: WebviewWindow,
    updates: State<'_, DesktopUpdates>,
    transport: State<'_, PrivacyTransport>,
    generation: u64,
    request_id: String,
    update: DesktopUpdate,
    on_progress: Channel<UpdateProgress>,
) -> Result<StagedDesktopUpdate, String> {
    crate::ensure_local(&window)?;
    let ((platform, suffix, extension), _) = host(&app)?;
    check(&update, platform, suffix, installed()?, &release_key()?)?;
    let mut owner = updates.reserve(&request_id, generation)?;
    let file = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&owner.partial.path)
        .await
        .map_err(|_| "Could not create the private update file")?;
    owner.partial.owned.store(true, Ordering::Release);
    transport
        .download_update(
            generation,
            request_id,
            update.download(),
            file,
            move |progress| {
                let _ = on_progress.send(progress);
            },
        )
        .await?;
    let staged = stage_verified(&owner.partial, extension).await?;
    transport.finish_update(generation, || owner.publish(update, staged))
}

#[tauri::command]
pub fn native_desktop_update_cancel(
    window: WebviewWindow,
    updates: State<'_, DesktopUpdates>,
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

/// Runs only a staged file that still verifies, then exits or relaunches; the reply may never arrive.
#[tauri::command]
pub async fn native_desktop_update_install(
    app: AppHandle,
    window: WebviewWindow,
    updates: State<'_, DesktopUpdates>,
    id: String,
) -> Result<(), String> {
    crate::ensure_local(&window)?;
    let (_, target) = host(&app)?;
    let prepared = updates.begin_install(&id)?;
    let (staged, update) = (prepared.file.path.clone(), prepared.update.clone());
    let applied = tokio::task::spawn_blocking(move || {
        verify(&staged, &update)?;
        install(&staged, target.as_deref(), &update)
    })
    .await
    .unwrap_or_else(|_| Err(UNAVAILABLE.into()));
    match applied {
        Ok(true) => app.request_restart(),
        Ok(false) => app.exit(0),
        Err(error) => {
            updates.end_install(&prepared, error != CHANGED);
            return Err(error);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    const RELEASE: &str = "https://github.com/arkade-os/shielded/releases/download/native-mutinynet-7a90ca067003-run44073476179-attempt1/";
    const WINDOWS: &str = "shielded-mutinynet-windows-x86_64-7a90ca067003-run44073476179-attempt1-mutinynet-release-Shielded_0.1.0_x64-setup.exe";
    const COMMIT: &str = "7a90ca067003650a87163c1ffc0f6203c72e6722";
    const OLDER: (u64, &str) = (274, "1111111111111111111111111111111111111111");
    // tests/native-publication.test.ts signs the same message with the seed [7; 32].
    const VECTOR: &str = "mwS7OvlAyVyjn55vYhrvkVl0DxNjLk7VrRVzvOhk9P1uOxjlGv7p9y7PcTvYmthkOM4b4QbaVoU6tlv29IlFBQ==";

    fn windows() -> DesktopUpdate {
        DesktopUpdate {
            url: format!("{RELEASE}{WINDOWS}"),
            bytes: 226_613_350,
            sha256: "59967f6469a778999c465f1e4f8d8bdda009612f8a2f37e9f3fa7c68b2a9d9e4".into(),
            commit: COMMIT.into(),
            build_number: 275,
            signature: VECTOR.into(),
        }
    }

    fn test_key() -> SigningKey {
        SigningKey::from_bytes(&[7; 32])
    }

    fn signed(update: DesktopUpdate, platform: &str) -> DesktopUpdate {
        let file = update.download().file().unwrap();
        let signature = test_key().sign(message(platform, &file, &update).as_bytes());
        DesktopUpdate {
            signature: STANDARD.encode(signature.to_bytes()),
            ..update
        }
    }

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|byte| format!("{byte:02x}")).collect()
    }

    fn local(content: &[u8]) -> DesktopUpdate {
        DesktopUpdate {
            bytes: content.len() as u64,
            sha256: hex(&Sha256::digest(content)),
            ..windows()
        }
    }

    struct Scratch(PathBuf);
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn scratch() -> Scratch {
        let path = std::env::temp_dir().join(format!("shielded-desktop-update-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&path).unwrap();
        Scratch(path)
    }

    fn names(directory: &Path) -> Vec<String> {
        let mut names: Vec<_> = std::fs::read_dir(directory)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        names.sort();
        names
    }

    fn ready(updates: &DesktopUpdates, id: &str) -> PathBuf {
        let mut owner = updates.reserve(id, 1).unwrap();
        let path = updates.directory.join(format!("{}.exe", uuid::Uuid::new_v4()));
        std::fs::write(&path, b"verified").unwrap();
        let file = Arc::new(StagedFile {
            path: path.clone(),
            owned: AtomicBool::new(true),
        });
        owner.publish(windows(), file).unwrap();
        path
    }

    #[test]
    fn the_typescript_publisher_vector_verifies_and_dalek_signs_it_identically() {
        let update = windows();
        assert_eq!(
            message("windows-x86_64", WINDOWS, &update),
            "shielded-native-update-v1\nchannel=native-mutinynet\nnetwork=mutinynet\nplatform=windows-x86_64\nfile=shielded-mutinynet-windows-x86_64-7a90ca067003-run44073476179-attempt1-mutinynet-release-Shielded_0.1.0_x64-setup.exe\nbytes=226613350\nsha256=59967f6469a778999c465f1e4f8d8bdda009612f8a2f37e9f3fa7c68b2a9d9e4\ncommit=7a90ca067003650a87163c1ffc0f6203c72e6722\nbuildNumber=275"
        );
        assert_eq!(
            hex(&test_key().verifying_key().to_bytes()),
            "ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c"
        );
        assert!(check(&update, "windows-x86_64", "-setup.exe", OLDER, &test_key().verifying_key()).is_ok());
        assert_eq!(signed(windows(), "windows-x86_64").signature, VECTOR);
    }

    #[test]
    fn the_pinned_release_key_is_the_one_ci_signs_with_and_refuses_the_test_key() {
        let key = release_key().unwrap();
        assert_eq!(
            hex(&key.to_bytes()),
            "19eb5afdb10d63cb8a6c58780e2b8ab955d57a8630da379554beb0e5870b2ab6"
        );
        assert!(check(&windows(), "windows-x86_64", "-setup.exe", OLDER, &key).is_err());
    }

    #[test]
    fn a_changed_field_or_signature_fails_verification() {
        let key = test_key().verifying_key();
        let mut flipped = STANDARD.decode(VECTOR).unwrap();
        flipped[10] ^= 1;
        for change in 0..7 {
            let mut update = windows();
            match change {
                0 => update.bytes -= 1,
                1 => update.sha256 = "0".repeat(64),
                2 => update.commit = "b".repeat(40),
                3 => update.build_number = 276,
                4 => update.url = update.url.replace("Shielded_0.1.0", "Shielded_0.1.1"),
                5 => update.signature = STANDARD.encode(&flipped),
                _ => update.signature = STANDARD.encode([0u8; 63]),
            }
            assert!(check(&update, "windows-x86_64", "-setup.exe", OLDER, &key).is_err(), "{change}");
        }
    }

    #[test]
    fn only_a_newer_installer_for_this_platform_is_accepted() {
        let key = test_key().verifying_key();
        assert!(check(&windows(), "linux-x86_64", ".AppImage", OLDER, &key).is_err());
        assert!(check(&windows(), "macos-universal", ".app.zip", OLDER, &key).is_err());
        let linux = signed(
            DesktopUpdate {
                url: format!("{RELEASE}shielded-mutinynet-linux-x86_64-7a90ca067003-run44073476179-attempt1-mutinynet-release-Shielded_0.1.0_amd64.AppImage"),
                ..windows()
            },
            "linux-x86_64",
        );
        assert!(check(&linux, "linux-x86_64", ".AppImage", OLDER, &key).is_ok());
        assert!(check(&linux, "windows-x86_64", "-setup.exe", OLDER, &key).is_err());
        let deb = DesktopUpdate {
            url: linux.url.replace(".AppImage", ".deb"),
            ..linux.clone()
        };
        assert!(check(&deb, "linux-x86_64", ".AppImage", OLDER, &key).is_err());
        for installed in [(275, OLDER.1), (276, OLDER.1), (274, COMMIT)] {
            assert!(check(&windows(), "windows-x86_64", "-setup.exe", installed, &key).is_err());
        }
    }

    #[test]
    fn the_windows_installer_runs_passively_in_update_mode_and_relaunches() {
        assert_eq!(INSTALLER_ARGUMENTS, ["/P", "/UPDATE", "/R"]);
    }

    #[test]
    fn a_saved_update_must_still_match_its_signed_length_and_hash() {
        let directory = scratch();
        let path = directory.0.join("saved.exe");
        std::fs::write(&path, b"installer").unwrap();
        assert!(verify(&path, &local(b"installer")).is_ok());
        for content in [&b"installeR"[..], b"installe", b"installer!"] {
            std::fs::write(&path, content).unwrap();
            assert_eq!(verify(&path, &local(b"installer")).unwrap_err(), CHANGED);
        }
        std::fs::remove_file(&path).unwrap();
        assert!(verify(&path, &local(b"installer")).is_err());
    }

    #[test]
    fn only_an_absolute_regular_appimage_can_be_replaced() {
        let directory = scratch();
        let image = directory.0.join("Shielded.AppImage");
        std::fs::write(&image, b"old").unwrap();
        assert_eq!(appimage(Some(image.as_os_str())).unwrap(), image);
        for value in [
            None,
            Some(std::ffi::OsStr::new("Shielded.AppImage")),
            Some(directory.0.as_os_str()),
            Some(std::ffi::OsStr::new("/nonexistent/Shielded.AppImage")),
        ] {
            assert_eq!(appimage(value).unwrap_err(), UNSUPPORTED);
        }
        #[cfg(unix)]
        {
            let link = directory.0.join("link.AppImage");
            std::os::unix::fs::symlink(&image, &link).unwrap();
            assert!(appimage(Some(link.as_os_str())).is_err());
        }
    }

    #[test]
    fn an_appimage_is_replaced_only_by_verified_bytes_and_leaves_no_temporary_file() {
        let directory = scratch();
        let (staged, image) = (directory.0.join("staged"), directory.0.join("Shielded.AppImage"));
        std::fs::write(&staged, b"new image").unwrap();
        std::fs::write(&image, b"old image").unwrap();
        assert!(replace_file(&staged, &image, &local(b"other image")).is_err());
        assert_eq!(std::fs::read(&image).unwrap(), b"old image");
        replace_file(&staged, &image, &local(b"new image")).unwrap();
        assert_eq!(std::fs::read(&image).unwrap(), b"new image");
        assert_eq!(names(&directory.0), ["Shielded.AppImage", "staged"]);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&image).unwrap().permissions().mode() & 0o777, 0o755);
        }
    }

    #[test]
    fn the_running_bundle_is_found_from_its_executable_unless_gatekeeper_translocated_it() {
        for bundle in ["/Applications/Shielded.app", "/Users/me/Downloads/Shielded.app"] {
            let binary = format!("{bundle}/Contents/MacOS/shielded-native");
            assert_eq!(bundle_root(Path::new(&binary)), Ok(PathBuf::from(bundle)));
        }
        for binary in [
            "/usr/local/bin/shielded-native",
            "/Applications/Shielded.app/Contents/shielded-native",
            "/Applications/Shielded/Contents/MacOS/shielded-native",
        ] {
            assert_eq!(bundle_root(Path::new(binary)).unwrap_err(), UNSUPPORTED, "{binary}");
        }
        let translocated = "/private/var/folders/x1/abc123/T/AppTranslocation/1C9C2F7E-0D4E-4F5B-9B0A-2E4D2C7A1B11/d/Shielded.app/Contents/MacOS/shielded-native";
        assert!(bundle_root(Path::new(translocated)).unwrap_err().contains("Applications folder"));
    }

    #[cfg(windows)]
    #[test]
    fn a_locked_installer_still_starts_but_cannot_be_rewritten_renamed_or_deleted() {
        let directory = scratch();
        let staged = directory.0.join("installer.exe");
        let system = PathBuf::from(std::env::var_os("SystemRoot").unwrap()).join("System32");
        std::fs::copy(system.join("hostname.exe"), &staged).unwrap();
        let update = local(&std::fs::read(&staged).unwrap());
        let writer = std::fs::OpenOptions::new().write(true).open(&staged).unwrap();
        assert_eq!(lock_installer(&staged, &update).unwrap_err(), CHANGED);
        drop(writer);
        let installer = lock_installer(&staged, &update).unwrap();
        assert!(std::fs::File::open(&staged).is_ok());
        assert!(lock_installer(&staged, &update).is_ok());
        assert!(std::fs::OpenOptions::new().write(true).open(&staged).is_err());
        assert!(std::fs::rename(&staged, directory.0.join("swapped.exe")).is_err());
        assert!(std::fs::remove_file(&staged).is_err());
        assert!(std::process::Command::new(&staged).output().unwrap().status.success());
        drop(installer);
        assert_eq!(lock_installer(&staged, &local(b"another installer")).unwrap_err(), CHANGED);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_bundle_swap_exchanges_atomically_and_changes_nothing_when_it_cannot() {
        let directory = scratch();
        let bundle = directory.0.join("Shielded.app");
        let staging = directory.0.join(format!("{STAGING}{}", uuid::Uuid::new_v4()));
        let version = |app: &Path| std::fs::read(app.join("Contents/version")).unwrap();
        std::fs::create_dir_all(bundle.join("Contents")).unwrap();
        std::fs::write(bundle.join("Contents/version"), b"old").unwrap();
        std::fs::create_dir_all(staging.join("Other.app")).unwrap();
        assert!(swap_bundle(&bundle, &staging).is_err());
        assert!(exchange(&staging.join("Shielded.app"), &bundle).is_err());
        assert_eq!(version(&bundle), b"old");
        std::fs::create_dir_all(staging.join("Shielded.app/Contents")).unwrap();
        std::fs::write(staging.join("Shielded.app/Contents/version"), b"new").unwrap();
        swap_bundle(&bundle, &staging).unwrap();
        assert_eq!(version(&bundle), b"new");
        assert_eq!(version(&staging.join("Shielded.app")), b"old");
    }

    #[test]
    fn only_a_build_with_a_run_number_and_a_full_commit_can_update_itself() {
        let full = "7a90ca067003650a87163c1ffc0f6203c72e6722";
        assert_eq!(release_identity(Some("274"), Some(full)), Ok((274, full)));
        for (build, commit) in [
            (Some("274"), None),
            (Some("274"), Some("")),
            (Some("274"), Some("7a90ca0")),
            (Some("274"), Some("7A90CA067003650A87163C1FFC0F6203C72E6722")),
            (None, Some(full)),
            (Some("0"), Some(full)),
            (Some("x"), Some(full)),
        ] {
            assert!(release_identity(build, commit).is_err(), "{build:?} {commit:?}");
        }
    }

    #[test]
    fn startup_removes_only_our_staged_files_and_install_leftovers() {
        let directory = scratch();
        let id = uuid::Uuid::new_v4();
        for name in [
            format!("{id}.part"),
            format!("{id}.exe"),
            format!("{id}.AppImage"),
            format!("{id}.zip"),
            format!("{id}.json"),
            "wallet.exe".into(),
            format!("{STAGING}{}", uuid::Uuid::new_v4()),
            format!("{STAGING}wallet"),
        ] {
            std::fs::write(directory.0.join(name), b"").unwrap();
        }
        std::fs::create_dir_all(directory.0.join(format!("{STAGING}{id}/Shielded.app"))).unwrap();
        DesktopUpdates::at(directory.0.clone());
        remove_leftovers(&directory.0, staging_id);
        assert_eq!(
            names(&directory.0),
            [format!("{STAGING}wallet"), format!("{id}.json"), "wallet.exe".into()]
        );
    }

    #[test]
    fn one_download_at_a_time_and_a_cancelled_download_cannot_publish() {
        let directory = scratch();
        let updates = DesktopUpdates::at(directory.0.clone());
        let id = uuid::Uuid::new_v4().to_string();
        let mut owner = updates.reserve(&id, 1).unwrap();
        assert!(updates.reserve(&uuid::Uuid::new_v4().to_string(), 1).is_err());
        assert_eq!(updates.cancel(&id).unwrap(), Some(1));
        let path = directory.0.join(format!("{}.exe", uuid::Uuid::new_v4()));
        std::fs::write(&path, b"verified").unwrap();
        let file = Arc::new(StagedFile {
            path: path.clone(),
            owned: AtomicBool::new(true),
        });
        assert!(owner.publish(windows(), file).is_err());
        assert!(!path.exists());
        drop(owner);
        assert!(updates.reserve(&uuid::Uuid::new_v4().to_string(), 2).is_ok());
    }

    #[test]
    fn install_claims_the_ready_update_once_then_keeps_or_discards_it_on_failure() {
        let directory = scratch();
        let updates = DesktopUpdates::at(directory.0.clone());
        let id = uuid::Uuid::new_v4().to_string();
        let path = ready(&updates, &id);
        assert!(updates.begin_install(&uuid::Uuid::new_v4().to_string()).is_err());
        let prepared = updates.begin_install(&id).unwrap();
        assert!(updates.begin_install(&id).is_err());
        assert!(updates.cancel(&id).is_err());
        updates.end_install(&prepared, true);
        drop(prepared);
        assert!(path.exists());
        let prepared = updates.begin_install(&id).unwrap();
        updates.end_install(&prepared, false);
        drop(prepared);
        assert!(!path.exists());
        assert!(matches!(updates.snapshot().unwrap(), (None, None)));
    }

    #[test]
    fn discarding_a_ready_update_removes_its_file() {
        let directory = scratch();
        let updates = DesktopUpdates::at(directory.0.clone());
        let id = uuid::Uuid::new_v4().to_string();
        let path = ready(&updates, &id);
        assert_eq!(updates.cancel(&uuid::Uuid::new_v4().to_string()).unwrap(), None);
        assert!(path.exists());
        assert_eq!(updates.cancel(&id).unwrap(), None);
        assert!(!path.exists());
    }
}
