fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "native_status",
            "native_start",
            "native_pause",
            "native_scope",
            "native_scope_close",
            "native_http",
            "native_stream",
            "native_stream_ack",
            "native_socket",
            "native_socket_send",
            "native_cancel",
        ]),
    ))
    .expect("failed to build native host manifest");
}
