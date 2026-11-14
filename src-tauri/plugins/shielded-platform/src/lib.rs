use tauri::{plugin::TauriPlugin, AppHandle, Runtime, WebviewWindow};
use zeroize::Zeroizing;

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

#[cfg(target_os = "android")]
const PASSKEY_CANCELLED: &str = "Passkey cancelled";

async fn passkey<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    command: &str,
    request: String,
) -> Result<String, String> {
    ensure_local(&window)?;
    #[cfg(target_os = "android")]
    {
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
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, command, request);
        Err("Passkeys are available in the Android app only".into())
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

pub async fn android_update_permission<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    android_update_request(app, "updatePermission", serde_json::json!({}))
        .await
        .map(|_| ())
}

pub async fn android_verify_update<R: Runtime>(
    app: &AppHandle<R>,
    metadata: serde_json::Value,
) -> Result<(), String> {
    android_update_request(app, "updateVerify", metadata)
        .await
        .map(|_| ())
}

pub async fn android_install_update<R: Runtime>(
    app: &AppHandle<R>,
    metadata: serde_json::Value,
) -> Result<serde_json::Value, String> {
    android_update_request(app, "updateInstall", metadata).await
}

pub async fn android_confirm_update<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<serde_json::Value, String> {
    android_update_request(app, "updateConfirm", serde_json::json!({})).await
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new("shielded-platform")
        .invoke_handler(tauri::generate_handler![
            secret_get,
            secret_set,
            secret_clear,
            clipboard_text,
            passkey_create,
            passkey_get
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
