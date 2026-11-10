use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

pub mod transport;

pub(crate) fn ensure_local(window: &tauri::WebviewWindow) -> Result<(), String> {
    tauri_plugin_shielded_platform::ensure_local(window)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _, _| {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
    }));
    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shielded_platform::init())
        .invoke_handler(tauri::generate_handler![
            transport::native_status,
            transport::native_start,
            transport::native_pause,
            transport::native_scope,
            transport::native_scope_close,
            transport::native_http,
            transport::native_stream,
            transport::native_stream_ack,
            transport::native_socket,
            transport::native_socket_send,
            transport::native_cancel
        ])
        .setup(|app| {
            let transport = transport::PrivacyTransport::new(app.path().app_data_dir()?.join("tor"))
                .map_err(std::io::Error::other)?;
            app.manage(transport.clone());
            transport.prewarm().map_err(std::io::Error::other)?;
            let marker = "(() => { const l = location; const local = !l.port && !l.username && !l.password && ((l.protocol === 'tauri:' && l.hostname === 'localhost') || (['http:', 'https:'].includes(l.protocol) && l.hostname === 'tauri.localhost')); if (window !== window.top || !local) return; Object.defineProperty(window, '__SHIELDED_NATIVE__', {value: Object.freeze({version: 1, poolOrigin: 'https://shielded.mutinynet.arkade.sh'}), writable: false, configurable: false}); })();";
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Shielded")
                .inner_size(440.0, 850.0)
                .min_inner_size(360.0, 640.0)
                .initialization_script(marker)
                .on_navigation(|url| tauri_plugin_shielded_platform::is_local_url(url))
                .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
                .build()?;
            Ok(())
        })
        .on_window_event(|window, event| {
            let pause = matches!(event, tauri::WindowEvent::Destroyed);
            #[cfg(mobile)]
            let pause = pause || matches!(event, tauri::WindowEvent::Suspended);
            if pause {
                if let Some(transport) = window.app_handle().try_state::<transport::PrivacyTransport>() {
                    let _ = transport.pause();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("Unable to start Shielded native host");
}
