use tauri::{plugin::TauriPlugin, AppHandle, Runtime, WebviewWindow};
use zeroize::Zeroizing;

mod passkeys;
mod policy;

const UNAVAILABLE: &str = "Secure wallet storage unavailable";

#[cfg(mobile)]
use tauri::Manager;
#[cfg(mobile)]
struct Mobile<R: Runtime>(tauri::plugin::PluginHandle<R>);
#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_shielded_platform);

pub fn is_local_url(url: &tauri::Url) -> bool {
    policy::allowed_origin(
        url.scheme(),
        url.host_str(),
        url.port(),
        url.username(),
        url.password(),
    )
}

pub fn ensure_local<R: Runtime>(window: &WebviewWindow<R>) -> Result<(), String> {
    if window.label() == "main" && is_local_url(&window.url().map_err(|_| UNAVAILABLE)?) {
        Ok(())
    } else {
        Err("Native access is restricted to the bundled wallet".into())
    }
}

#[cfg(desktop)]
static VAULT_ACCESS: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(desktop)]
fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new("io.arkade.shielded.native.v1", "seed").map_err(|_| UNAVAILABLE.into())
}

#[cfg(desktop)]
fn read_seed() -> Result<Option<String>, String> {
    let _access = VAULT_ACCESS.lock().map_err(|_| UNAVAILABLE)?;
    match entry()?.get_secret() {
        Ok(value) => {
            let value = Zeroizing::new(value);
            let value = std::str::from_utf8(&value).map_err(|_| UNAVAILABLE)?;
            if !policy::valid_seed(value) {
                return Err(UNAVAILABLE.into());
            }
            Ok(Some(value.to_owned()))
        }
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err(UNAVAILABLE.into()),
    }
}

#[cfg(desktop)]
fn clear_seed() -> Result<(), String> {
    let _access = VAULT_ACCESS.lock().map_err(|_| UNAVAILABLE)?;
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err(UNAVAILABLE.into()),
    }
}

#[tauri::command]
async fn secret_get<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
) -> Result<Option<String>, String> {
    ensure_local(&window)?;
    #[cfg(desktop)]
    {
        let _ = app;
        tauri::async_runtime::spawn_blocking(read_seed)
            .await
            .map_err(|_| UNAVAILABLE.to_owned())?
    }
    #[cfg(mobile)]
    {
        let response: serde_json::Value = app
            .state::<Mobile<R>>()
            .0
            .run_mobile_plugin_async("secretGet", serde_json::json!({}))
            .await
            .map_err(|_| UNAVAILABLE)?;
        match response.get("value") {
            Some(serde_json::Value::Null) => Ok(None),
            Some(serde_json::Value::String(value)) if policy::valid_seed(value) => {
                Ok(Some(value.clone()))
            }
            _ => Err(UNAVAILABLE.into()),
        }
    }
}

#[tauri::command]
async fn secret_set<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    value: String,
) -> Result<(), String> {
    ensure_local(&window)?;
    let value = Zeroizing::new(value);
    if !policy::valid_seed(&value) {
        return Err("Invalid wallet seed".into());
    }
    #[cfg(desktop)]
    {
        let _ = app;
        tauri::async_runtime::spawn_blocking(move || {
            let _access = VAULT_ACCESS.lock().map_err(|_| UNAVAILABLE)?;
            entry()?
                .set_secret(value.as_bytes())
                .map_err(|_| UNAVAILABLE.into())
        })
        .await
        .map_err(|_| UNAVAILABLE.to_owned())?
    }
    #[cfg(mobile)]
    {
        let _: serde_json::Value = app
            .state::<Mobile<R>>()
            .0
            .run_mobile_plugin_async("secretSet", serde_json::json!({"value": &*value}))
            .await
            .map_err(|_| UNAVAILABLE)?;
        Ok(())
    }
}

#[tauri::command]
async fn secret_create<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    value: String,
) -> Result<(), String> {
    ensure_local(&window)?;
    let value = Zeroizing::new(value);
    if !policy::valid_seed(&value) {
        return Err("Invalid wallet seed".into());
    }
    #[cfg(desktop)]
    {
        let _ = app;
        tauri::async_runtime::spawn_blocking(move || {
            let _access = VAULT_ACCESS.lock().map_err(|_| UNAVAILABLE)?;
            let vault = entry()?;
            match vault.get_secret() {
                Ok(existing) => {
                    let existing = Zeroizing::new(existing);
                    if existing.as_slice() == value.as_bytes() {
                        Ok(())
                    } else {
                        Err("A different wallet already exists in secure storage".into())
                    }
                }
                Err(keyring::Error::NoEntry) => vault
                    .set_secret(value.as_bytes())
                    .map_err(|_| UNAVAILABLE.into()),
                Err(_) => Err(UNAVAILABLE.into()),
            }
        })
        .await
        .map_err(|_| UNAVAILABLE.to_owned())?
    }
    #[cfg(mobile)]
    {
        let _: serde_json::Value = app
            .state::<Mobile<R>>()
            .0
            .run_mobile_plugin_async("secretCreate", serde_json::json!({"value": &*value}))
            .await
            .map_err(|_| UNAVAILABLE)?;
        Ok(())
    }
}

#[tauri::command]
async fn secret_clear<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
) -> Result<(), String> {
    ensure_local(&window)?;
    #[cfg(desktop)]
    {
        let _ = app;
        tauri::async_runtime::spawn_blocking(clear_seed)
            .await
            .map_err(|_| UNAVAILABLE.to_owned())?
    }
    #[cfg(mobile)]
    {
        let _: serde_json::Value = app
            .state::<Mobile<R>>()
            .0
            .run_mobile_plugin_async("secretClear", serde_json::json!({}))
            .await
            .map_err(|_| UNAVAILABLE)?;
        Ok(())
    }
}

#[cfg(target_os = "android")]
async fn android_vault_request<R: Runtime>(
    app: &AppHandle<R>,
    command: &str,
    payload: serde_json::Value,
) -> Result<serde_json::Value, String> {
    app.state::<Mobile<R>>()
        .0
        .run_mobile_plugin_async(command, payload)
        .await
        .map_err(|error| match error.to_string() {
            code if matches!(code.as_str(), "cancelled" | "lock-gone" | "weak-biometric") => code,
            _ => UNAVAILABLE.into(),
        })
}

#[tauri::command]
async fn locked_secret_create<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    value: String,
) -> Result<(), String> {
    ensure_local(&window)?;
    let value = Zeroizing::new(value);
    if !policy::valid_entropy(&value) {
        return Err("Invalid wallet seed".into());
    }
    #[cfg(target_os = "android")]
    {
        android_vault_request(
            &app,
            "lockedSecretCreate",
            serde_json::json!({"value": &*value}),
        )
        .await
        .map(|_| ())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Err(UNAVAILABLE.into())
    }
}

#[tauri::command]
async fn locked_secret_get<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
) -> Result<Option<String>, String> {
    ensure_local(&window)?;
    #[cfg(target_os = "android")]
    {
        let response =
            android_vault_request(&app, "lockedSecretGet", serde_json::json!({})).await?;
        match response.get("value") {
            Some(serde_json::Value::Null) => Ok(None),
            Some(serde_json::Value::String(value)) if policy::valid_entropy(value) => {
                Ok(Some(value.clone()))
            }
            _ => Err(UNAVAILABLE.into()),
        }
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Err(UNAVAILABLE.into())
    }
}

#[tauri::command]
async fn locked_secret_clear<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
) -> Result<(), String> {
    ensure_local(&window)?;
    #[cfg(target_os = "android")]
    {
        android_vault_request(&app, "lockedSecretClear", serde_json::json!({}))
            .await
            .map(|_| ())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Ok(())
    }
}

#[tauri::command]
async fn vault_kind<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
) -> Result<&'static str, String> {
    #[cfg(target_os = "android")]
    {
        ensure_local(&window)?;
        let response = android_vault_request(&app, "vaultKind", serde_json::json!({})).await?;
        let kind = response.get("kind").and_then(serde_json::Value::as_str);
        ["none", "plain", "locked"]
            .into_iter()
            .find(|known| kind == Some(*known))
            .ok_or_else(|| UNAVAILABLE.into())
    }
    // Only Android has a locked vault so far, so elsewhere a stored wallet is the plain seed.
    #[cfg(not(target_os = "android"))]
    {
        ensure_local(&window)?;
        let seed = secret_get(app, window).await?.map(Zeroizing::new);
        Ok(if seed.is_some() { "plain" } else { "none" })
    }
}

#[tauri::command]
async fn device_lock_available<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
) -> Result<bool, String> {
    ensure_local(&window)?;
    #[cfg(target_os = "android")]
    {
        android_vault_request(&app, "deviceLockAvailable", serde_json::json!({}))
            .await?
            .get("available")
            .and_then(serde_json::Value::as_bool)
            .ok_or_else(|| UNAVAILABLE.into())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Ok(false)
    }
}

#[tauri::command]
async fn clipboard_text<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
) -> Result<Option<String>, String> {
    ensure_local(&window)?;
    #[cfg(target_os = "android")]
    {
        let response: serde_json::Value = app
            .state::<Mobile<R>>()
            .0
            .run_mobile_plugin_async("clipboardText", serde_json::json!({}))
            .await
            .map_err(|_| "The clipboard could not be read")?;
        Ok(response
            .get("text")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned))
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Err("The web view reads the clipboard on this platform".into())
    }
}

#[cfg(mobile)]
const PASSKEY_CANCELLED: &str = "Passkey cancelled";

#[tauri::command]
async fn passkey_support<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
) -> Result<serde_json::Value, String> {
    ensure_local(&window)?;
    #[cfg(mobile)]
    {
        app.state::<Mobile<R>>()
            .0
            .run_mobile_plugin_async(
                "passkeySupport",
                serde_json::json!({"configured":cfg!(apple_passkeys)}),
            )
            .await
            .map_err(|_| "Passkey unavailable".into())
    }
    #[cfg(desktop)]
    {
        let _ = app;
        #[cfg(target_os = "windows")]
        let available = passkeys::windows::available();
        #[cfg(target_os = "macos")]
        let available = cfg!(apple_passkeys) && passkeys::macos::available();
        #[cfg(target_os = "linux")]
        let available = passkeys::linux::available().await;
        let reason = if cfg!(target_os = "macos") && !cfg!(apple_passkeys) {
            "Passkeys need an Apple signing team and an associated domain in this build. You can use a recovery phrase."
        } else {
            "Passkeys need a supported system provider with PRF support. You can use a recovery phrase."
        };
        Ok(
            serde_json::json!({"available":available,"reason":if available {None} else {Some(reason)}}),
        )
    }
}

async fn passkey<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    command: &str,
    request: String,
) -> Result<String, String> {
    ensure_local(&window)?;
    let create = command == "passkeyCreate";
    let parsed = passkeys::parse(&request, create).map_err(String::from)?;
    #[cfg(mobile)]
    {
        let _ = parsed;
        #[cfg(target_os = "ios")]
        if !cfg!(apple_passkeys) {
            return Err("Passkey unavailable".into());
        }
        let response: serde_json::Value = app
            .state::<Mobile<R>>()
            .0
            .run_mobile_plugin_async(command, serde_json::json!({ "request": request }))
            .await
            .map_err(|error| {
                if error.to_string() == PASSKEY_CANCELLED {
                    PASSKEY_CANCELLED
                } else {
                    "Passkey unavailable"
                }
            })?;
        response
            .get("response")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| "Passkey unavailable".into())
    }
    #[cfg(target_os = "windows")]
    {
        let _ = app;
        let hwnd = window.hwnd().map_err(|_| "Passkey unavailable")?.0 as isize;
        tauri::async_runtime::spawn_blocking(move || passkeys::windows::run(hwnd, create, parsed))
            .await
            .map_err(|_| "Passkey unavailable")?
            .map_err(String::from)
    }
    #[cfg(target_os = "macos")]
    {
        if !cfg!(apple_passkeys) {
            return Err("Passkey unavailable".into());
        }
        passkeys::macos::run(app, window, create, parsed)
            .await
            .map_err(String::from)
    }
    #[cfg(target_os = "linux")]
    {
        // Preserve WebAuthn extensions for the trusted OS portal after enforcing our RP and input bounds.
        let _ = (app, parsed);
        passkeys::linux::run(create, request)
            .await
            .map_err(String::from)
    }
}

#[tauri::command]
async fn passkey_create<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    request: String,
) -> Result<String, String> {
    passkey(app, window, "passkeyCreate", request).await
}

#[tauri::command]
async fn passkey_get<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    request: String,
) -> Result<String, String> {
    passkey(app, window, "passkeyGet", request).await
}

async fn android_update_request<R: Runtime>(
    app: &AppHandle<R>,
    command: &str,
    metadata: serde_json::Value,
) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "android")]
    {
        app.state::<Mobile<R>>()
            .0
            .run_mobile_plugin_async(command, metadata)
            .await
            .map_err(|error| error.to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, command, metadata);
        Err("In-app Android updates are unavailable on this platform".into())
    }
}

pub async fn android_update_info<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<serde_json::Value, String> {
    android_update_request(app, "updateInfo", serde_json::json!({})).await
}

pub async fn android_verify_update<R: Runtime>(
    app: &AppHandle<R>,
    metadata: serde_json::Value,
) -> Result<(), String> {
    android_update_request(app, "updateVerify", metadata)
        .await
        .map(|_| ())
}

pub async fn android_open_update_installer<R: Runtime>(
    app: &AppHandle<R>,
    metadata: serde_json::Value,
) -> Result<(), String> {
    android_update_request(app, "updateOpenInstaller", metadata)
        .await
        .map(|_| ())
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new("shielded-platform")
        .invoke_handler(tauri::generate_handler![
            secret_get,
            secret_set,
            secret_create,
            secret_clear,
            locked_secret_create,
            locked_secret_get,
            locked_secret_clear,
            vault_kind,
            device_lock_available,
            clipboard_text,
            passkey_create,
            passkey_get,
            passkey_support
        ])
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            app.manage(Mobile::<R>(api.register_android_plugin(
                "io.arkade.shielded.platform",
                "ShieldedPlatformPlugin",
            )?));
            #[cfg(target_os = "ios")]
            app.manage(Mobile::<R>(
                api.register_ios_plugin(init_plugin_shielded_platform)?,
            ));
            #[cfg(desktop)]
            let _ = (app, api);
            Ok(())
        })
        .build()
}
