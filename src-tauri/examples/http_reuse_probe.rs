use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::json;
use shielded_native_lib::transport::{NativeRequest, PrivacyTransport};
use std::{path::PathBuf, time::Instant};

fn request(generation: u64, scope: &str, id: String, url: &str) -> NativeRequest {
    NativeRequest {
        generation,
        request_id: id,
        scope: scope.into(),
        url: url.into(),
        method: "GET".into(),
        headers: Vec::new(),
        body_base64: None,
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let data = PathBuf::from(
        std::env::args_os()
            .nth(1)
            .ok_or("Pass a disposable Tor directory")?,
    );
    if !data.is_absolute() {
        return Err("The disposable Tor directory must be absolute".into());
    }
    let transport = PrivacyTransport::new(data)?;
    let started = Instant::now();
    let status = transport.start().await?;
    if status.phase != "ready" {
        return Err(status.error.unwrap_or(status.phase).into());
    }
    println!(
        "{}",
        json!({"event":"bootstrap", "elapsed_ms":started.elapsed().as_millis()})
    );
    for item in 0..2 {
        let scope = transport.scope(status.generation, "public")?;
        for sample in 0..4 {
            let started = Instant::now();
            let response = transport
                .http(request(
                    status.generation,
                    &scope.id,
                    format!("probe-{item}-{sample}"),
                    "https://shielded.mutinynet.arkade.sh/api/rollup/status",
                ))
                .await;
            let elapsed = started.elapsed().as_millis();
            let response = match response {
                Ok(response) => response,
                Err(error) => {
                    println!(
                        "{}",
                        json!({"event":"request_error", "item":item, "sample":sample, "elapsed_ms":elapsed, "error":error})
                    );
                    return Err(error.into());
                }
            };
            if response.status != 200 {
                return Err(format!("Pool status returned HTTP {}", response.status).into());
            }
            let body: serde_json::Value =
                serde_json::from_slice(&STANDARD.decode(response.body_base64)?)?;
            if body["phase"] != "ready" {
                return Err("The public pool is not ready".into());
            }
            println!(
                "{}",
                json!({"event":"request", "item":item, "sample":sample, "elapsed_ms":elapsed, "status":response.status})
            );
        }
        transport.close_scope(status.generation, &scope.id)?;
    }
    let scope = transport.scope(status.generation, "discovery")?;
    let response = transport
        .http(request(
            status.generation,
            &scope.id,
            "tor-check".into(),
            "https://check.torproject.org/api/ip",
        ))
        .await?;
    let body: serde_json::Value = serde_json::from_slice(&STANDARD.decode(response.body_base64)?)?;
    if response.status != 200 || body["IsTor"] != true {
        return Err("Independent Tor check failed".into());
    }
    transport.close_scope(status.generation, &scope.id)?;
    let paused = transport.pause()?;
    assert_eq!(paused.phase, "paused");
    assert!(transport.scope(status.generation, "public").is_err());
    println!(
        "{}",
        json!({"event":"complete", "tor_verified":true, "retired_generation_rejected":true})
    );
    Ok(())
}
