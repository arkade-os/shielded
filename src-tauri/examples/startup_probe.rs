use serde_json::json;
use shielded_native_lib::transport::{NativeMode, NativeStatus, PrivacyTransport};
use std::{
    fs,
    io::{Error, ErrorKind, Write},
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU8, Ordering},
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

struct Probe {
    launched: Instant,
    setup: Instant,
    prewarm_invoked: Option<Instant>,
    early: bool,
    started: AtomicBool,
    exit: Arc<AtomicU8>,
}

const UNFINISHED: u8 = u8::MAX;

fn emit(value: serde_json::Value) {
    println!("{value}");
    let _ = std::io::stdout().flush();
}

#[tauri::command]
async fn native_start(
    window: WebviewWindow,
    app: AppHandle,
    transport: State<'_, PrivacyTransport>,
    probe: State<'_, Probe>,
    mode: Option<NativeMode>,
) -> Result<NativeStatus, String> {
    tauri_plugin_shielded_platform::ensure_local(&window)?;
    if mode.unwrap_or_default() != NativeMode::Tor {
        return Err("The startup probe only supports Tor".into());
    }
    if probe.started.swap(true, Ordering::SeqCst) {
        return Err("The startup probe already recorded its first request".into());
    }
    let requested = Instant::now();
    let status_at_call = transport.status()?;
    let invoked = Instant::now();
    let result = transport.start().await;
    let ready = result.as_ref().is_ok_and(|status| status.phase == "ready");
    let exit = if ready { 0 } else { 1 };
    if probe
        .exit
        .compare_exchange(UNFINISHED, exit, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
    {
        emit(json!({
            "event": "native_startup",
            "early": probe.early,
            "ready": ready,
            "embedded_native_assets": true,
            "exit_code": exit,
            "frontend_ipc_at_ms": requested.duration_since(probe.launched).as_millis(),
            "setup_at_ms": probe.setup.duration_since(probe.launched).as_millis(),
            "initial_tor_api": if probe.early { "prewarm" } else { "start" },
            "tor_api_invoked_at_ms": probe.prewarm_invoked.unwrap_or(invoked).duration_since(probe.launched).as_millis(),
            "tor_api_invoked_after_setup_ms": probe.prewarm_invoked.unwrap_or(invoked).duration_since(probe.setup).as_millis(),
            "tor_wait_ms": requested.elapsed().as_millis(),
            "launch_to_ready_ms": probe.launched.elapsed().as_millis(),
            "phase_at_call": status_at_call.phase,
            "progress_at_call": status_at_call.progress,
            "phase": result.as_ref().map(|status| status.phase.as_str()).unwrap_or("error"),
            "debug_assertions": cfg!(debug_assertions),
        }));
        app.exit(i32::from(exit));
    }
    result
}

fn options() -> Result<(PathBuf, bool), Error> {
    let mut early = false;
    let mut directory = None;
    for argument in std::env::args_os().skip(1) {
        if argument == "--early" && !early {
            early = true;
        } else if directory.is_none() && PathBuf::from(&argument).is_absolute() {
            directory = Some(PathBuf::from(argument));
        } else {
            return Err(Error::new(
                ErrorKind::InvalidInput,
                "Expected an absolute probe directory and optional --early",
            ));
        }
    }
    let directory = directory.ok_or_else(|| {
        Error::new(
            ErrorKind::InvalidInput,
            "Pass an absolute disposable probe directory",
        )
    })?;
    if fs::symlink_metadata(&directory).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err(Error::new(
            ErrorKind::InvalidInput,
            "The probe directory cannot be a link",
        ));
    }
    fs::create_dir_all(&directory)?;
    let marker = directory.join(".shielded-startup-probe");
    if marker.exists() {
        if fs::read_to_string(marker)? != "shielded-startup-probe-v1\n" {
            return Err(Error::new(
                ErrorKind::InvalidInput,
                "Unrecognized probe directory marker",
            ));
        }
    } else {
        if fs::read_dir(&directory)?.next().is_some() {
            return Err(Error::new(
                ErrorKind::InvalidInput,
                "An unmarked probe directory must be empty",
            ));
        }
        fs::write(marker, "shielded-startup-probe-v1\n")?;
    }
    Ok((directory.canonicalize()?, early))
}

fn embedded_native_assets(
    context: &tauri::Context<tauri::Wry>,
) -> Result<(), Box<dyn std::error::Error>> {
    if context.config().build.dev_url.is_some() {
        return Err("The startup probe requires bundled assets, not devUrl".into());
    }
    let assets = context.assets();
    let html = assets
        .get(&"index.html".into())
        .ok_or("No embedded frontend index")?;
    let html = std::str::from_utf8(&html)?;
    let entry = html
        .split("<script")
        .skip(1)
        .find_map(|script| {
            script
                .split('>')
                .next()
                .and_then(|tag| tag.split("src=\"").nth(1))
                .and_then(|source| source.split('"').next())
        })
        .ok_or("No embedded frontend entry")?;
    let script = assets
        .get(&entry.trim_start_matches('/').into())
        .ok_or("No embedded frontend entry bytes")?;
    if !std::str::from_utf8(&script)?.contains("NativeWallet-") {
        return Err("Build the native frontend before compiling the startup probe".into());
    }
    Ok(())
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    if !cfg!(target_os = "windows") {
        return Err("The isolated WebView2 startup probe runs on Windows".into());
    }
    let launched = Instant::now();
    let (directory, early) = options()?;
    let exit = Arc::new(AtomicU8::new(UNFINISHED));
    let setup_exit = exit.clone();
    let mut context = tauri::generate_context!();
    embedded_native_assets(&context)?;
    context.config_mut().identifier = "io.arkade.shielded.startup-probe".into();
    let app = tauri::Builder::default()
        // Deliberately omit the vault plugin; this process cannot open a wallet.
        .invoke_handler(tauri::generate_handler![
            shielded_native_lib::transport::native_status,
            shielded_native_lib::transport::native_pause,
            native_start,
        ])
        .setup(move |app| {
            let setup = Instant::now();
            let transport = PrivacyTransport::new(directory.join("tor")).map_err(Error::other)?;
            app.manage(transport.clone());
            let prewarm_invoked = early.then(Instant::now);
            if early {
                transport.prewarm().map_err(Error::other)?;
            }
            app.manage(Probe { launched, setup, prewarm_invoked, early, started: AtomicBool::new(false), exit: setup_exit.clone() });
            let marker = "(() => { const l = location; const local = !l.port && !l.username && !l.password && ((l.protocol === 'tauri:' && l.hostname === 'localhost') || (['http:', 'https:'].includes(l.protocol) && l.hostname === 'tauri.localhost')); if (window !== window.top || !local) return; Object.defineProperty(window, '__SHIELDED_NATIVE__', {value: Object.freeze({version: 1, poolOrigin: 'https://shielded.mutinynet.arkade.sh'}), writable: false, configurable: false}); })();";
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Shielded startup timing probe — no wallet")
                .inner_size(440.0, 850.0)
                .data_directory(directory.join("webview"))
                .initialization_script(marker)
                .on_navigation(tauri_plugin_shielded_platform::is_local_url)
                .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
                .build()?;
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_secs(210)).await;
                if setup_exit.compare_exchange(UNFINISHED, 2, Ordering::SeqCst, Ordering::SeqCst).is_ok() {
                    emit(json!({"event": "native_startup_timeout", "early": early, "ready": false, "exit_code": 2, "launch_to_ready_ms": launched.elapsed().as_millis()}));
                    handle.exit(2);
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            let pause = matches!(event, tauri::WindowEvent::Destroyed);
            #[cfg(mobile)]
            let pause = pause || matches!(event, tauri::WindowEvent::Suspended);
            if pause {
                let _ = window.state::<PrivacyTransport>().pause();
            }
        })
        .build(context)?;
    let runtime_exit = app.run_return(|_, _| {});
    let recorded_exit = exit.load(Ordering::SeqCst);
    let effective_exit = if runtime_exit != 0 {
        runtime_exit
    } else if recorded_exit == 0 {
        0
    } else if recorded_exit == UNFINISHED {
        1
    } else {
        i32::from(recorded_exit)
    };
    emit(
        json!({"event": "native_startup_exit", "early": early, "runtime_exit_code": runtime_exit, "recorded_exit_code": recorded_exit, "exit_code": effective_exit, "ready": recorded_exit == 0 && effective_exit == 0}),
    );
    std::process::exit(effective_exit);
}
