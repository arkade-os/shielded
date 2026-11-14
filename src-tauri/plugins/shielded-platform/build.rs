fn main() {
    tauri_plugin::Builder::new(&[
        "secret_get",
        "secret_set",
        "secret_clear",
        "clipboard_text",
        "passkey_create",
        "passkey_get",
    ])
    .android_path("android")
    .ios_path("ios")
    .build();
}
