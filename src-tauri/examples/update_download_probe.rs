use base64::{Engine, engine::general_purpose::STANDARD};
use sha2::{Digest, Sha256};
use shielded_native_lib::transport::{NativeMode, NativeRequest, PrivacyTransport, UpdateDownload};
use std::{path::PathBuf, time::Instant};
use tokio::io::AsyncReadExt;

async fn run() -> Result<(), String> {
    let root = std::env::args_os()
        .nth(1)
        .map(PathBuf::from)
        .ok_or("Pass a new disposable output directory")?;
    if root.exists() {
        return Err("The probe requires a new disposable output directory".into());
    }
    tokio::fs::create_dir_all(&root)
        .await
        .map_err(|_| "Could not create the probe directory")?;
    let transport = PrivacyTransport::new(root.join("tor"))?;
    let started = Instant::now();
    println!("{}", serde_json::json!({"phase":"starting-tor"}));
    let status = transport.start().await?;
    if status.phase != "ready" || status.mode != NativeMode::Tor {
        return Err(status.error.unwrap_or("Tor was not ready".into()));
    }
    println!(
        "{}",
        serde_json::json!({"phase":"tor-ready","bootstrapMs":started.elapsed().as_millis()})
    );
    let scope = transport.scope(status.generation, "release")?;
    let response = transport
        .http(NativeRequest {
            generation: status.generation,
            request_id: uuid::Uuid::new_v4().to_string(),
            scope: scope.id.clone(),
            url: "https://shielded.mutinynet.arkade.sh/api/native/releases".into(),
            method: "GET".into(),
            headers: vec![("Accept".into(), "application/json".into())],
            body_base64: None,
        })
        .await;
    let _ = transport.close_scope(status.generation, &scope.id);
    let response = response?;
    if response.status != 200 {
        return Err("Release metadata returned an unexpected status".into());
    }
    let body = STANDARD
        .decode(response.body_base64)
        .map_err(|_| "Invalid release metadata encoding")?;
    let metadata: serde_json::Value =
        serde_json::from_slice(&body).map_err(|_| "Invalid release metadata")?;
    let packages = metadata
        .get("packages")
        .and_then(|value| value.as_array())
        .ok_or("Missing release packages")?;
    let installable = |package: &&serde_json::Value| {
        package["platform"] == "android-arm64" && package["requiresSigning"] == false
    };
    let package = packages
        .iter()
        .filter(installable)
        .find(|package| package["profile"] == "release")
        .or_else(|| packages.iter().find(installable))
        .ok_or("No installable Android release")?;
    let asset = UpdateDownload {
        url: package["url"].as_str().ok_or("Missing package URL")?.into(),
        bytes: package["bytes"].as_u64().ok_or("Missing package length")?,
        sha256: package["sha256"]
            .as_str()
            .ok_or("Missing package checksum")?
            .into(),
    };
    println!(
        "{}",
        serde_json::json!({"phase":"metadata-ready","network":"tor","bytes":asset.bytes})
    );
    let path = root.join("update.part");
    let file = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .await
        .map_err(|_| "Could not create the probe package file")?;
    let downloading = Instant::now();
    transport.download_update(status.generation, uuid::Uuid::new_v4().to_string(), asset.clone(), file, |progress| {
        println!("{}", serde_json::json!({"phase":"downloading","received":progress.received,"total":progress.total}));
    }).await?;
    let mut file = tokio::fs::File::open(&path)
        .await
        .map_err(|_| "Could not reopen the probe package")?;
    let mut buffer = vec![0; 64 * 1024];
    let mut digest = Sha256::new();
    let mut bytes = 0u64;
    loop {
        let length = file
            .read(&mut buffer)
            .await
            .map_err(|_| "Could not read the probe package")?;
        if length == 0 {
            break;
        }
        bytes += length as u64;
        digest.update(&buffer[..length]);
    }
    let sha256: String = digest
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    if bytes != asset.bytes || sha256 != asset.sha256 {
        return Err("Independent package verification failed".into());
    }
    println!(
        "{}",
        serde_json::json!({"phase":"verified","network":"tor","bytes":bytes,"sha256":sha256,"downloadMs":downloading.elapsed().as_millis()})
    );
    transport.pause()?;
    Ok(())
}

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("{}", serde_json::json!({"phase":"error","error":error}));
        std::process::exit(1);
    }
}
