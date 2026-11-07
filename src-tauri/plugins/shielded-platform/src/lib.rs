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

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new("shielded-platform")
        .invoke_handler(tauri::generate_handler![secret_get, secret_set])
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
