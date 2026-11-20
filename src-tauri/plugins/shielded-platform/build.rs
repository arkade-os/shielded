fn main() {
    println!("cargo:rerun-if-env-changed=SHIELDED_APPLE_PASSKEYS");
    println!("cargo:rustc-check-cfg=cfg(apple_passkeys)");
    if std::env::var("SHIELDED_APPLE_PASSKEYS").as_deref() == Ok("1") {
        println!("cargo:rustc-cfg=apple_passkeys");
    }
    tauri_plugin::Builder::new(&[
        "secret_get",
        "secret_set",
        "secret_create",
        "secret_clear",
        "locked_secret_create",
        "locked_secret_get",
        "locked_secret_clear",
        "vault_kind",
        "device_lock_available",
        "clipboard_text",
        "passkey_create",
        "passkey_get",
        "passkey_support",
    ])
    .android_path("android")
    .ios_path("ios")
    .build();
}
