fn main() {
    tauri_plugin::Builder::new(&["secret_get", "secret_set"])
        .android_path("android")
        .ios_path("ios")
        .build();
}
