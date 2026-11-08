use base64::{Engine, engine::general_purpose::STANDARD};
use shielded_native_lib::transport::{NativeRequest, PrivacyTransport};
use std::{
    path::PathBuf,
    time::{Duration, Instant},
};

fn request(generation: u64, scope: &str, id: &str, url: &str) -> NativeRequest {
    NativeRequest {
        generation,
        request_id: id.into(),
        scope: scope.into(),
        url: url.into(),
        method: "GET".into(),
        headers: Vec::new(),
        body_base64: None,
    }
}

async fn verify_tor(
    transport: &PrivacyTransport,
    generation: u64,
    id: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let scope = transport.scope(generation, "discovery")?;
    let response = transport
        .http(request(
            generation,
            &scope.id,
            id,
            "https://check.torproject.org/api/ip",
        ))
        .await?;
    assert_eq!(response.status, 200);
    let check: serde_json::Value = serde_json::from_slice(&STANDARD.decode(response.body_base64)?)?;
    assert_eq!(check["IsTor"], true);
    println!("Tor Project independently reports IsTor=true ({id})");
    Ok(())
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let data = std::env::args_os()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("shielded-native-tor-smoke"));
    let transport = PrivacyTransport::new(data)?;
    let started = Instant::now();
    let boot = transport.start().await?;
    if boot.phase != "ready" {
        return Err(format!(
            "Tor bootstrap phase: {}; {}",
            boot.phase,
            boot.error.unwrap_or_default()
        )
        .into());
    }
    println!(
        "Tor bootstrap ready in {} ms, generation {}",
        started.elapsed().as_millis(),
        boot.generation
    );
    let first = transport.scope(boot.generation, "public")?;
    let second = transport.scope(boot.generation, "public")?;
    assert_ne!(first.id, second.id);
    let pool = "https://shielded.mutinynet.arkade.sh/api/rollup/status";
    for (id, scope) in [("pool-one", &first.id), ("pool-two", &second.id)] {
        let started = Instant::now();
        let response = transport
            .http(request(boot.generation, scope, id, pool))
            .await?;
        assert_eq!(response.status, 200);
        let body = STANDARD.decode(response.body_base64)?;
        let status: serde_json::Value = serde_json::from_slice(&body)?;
        println!(
            "Pool read on scope {id}: {} ms, HTTP {}, {} bytes, phase {}",
            started.elapsed().as_millis(),
            response.status,
            body.len(),
            status["phase"].as_str().unwrap_or("unknown")
        );
    }
    verify_tor(&transport, boot.generation, "tor-check").await?;
    transport.cancel(boot.generation, "before-open")?;
    assert!(
        transport
            .http(request(boot.generation, &first.id, "before-open", pool))
            .await
            .is_err()
    );
    let pending = {
        let transport = transport.clone();
        let request = request(boot.generation, &second.id, "pause-inflight", pool);
        tokio::spawn(async move { transport.http(request).await })
    };
    tokio::time::sleep(Duration::from_millis(20)).await;
    let resumed_at = Instant::now();
    let paused = transport.pause()?;
    assert_eq!(paused.phase, "paused");
    assert!(paused.generation > boot.generation);
    assert!(pending.await?.is_err());
    assert!(transport.scope(boot.generation, "public").is_err());
    assert!(
        transport
            .http(request(boot.generation, &first.id, "stale", pool))
            .await
            .is_err()
    );
    println!("Before-open cancellation, inflight pause and stale-generation dispatch rejected");
    let resumed = transport.start().await?;
    if resumed.phase != "ready" {
        return Err(format!(
            "Tor resume phase: {}; {}",
            resumed.phase,
            resumed.error.unwrap_or_default()
        )
        .into());
    }
    assert!(resumed.generation > paused.generation);
    println!(
        "Tor pause/resume ready in {} ms, generation {}",
        resumed_at.elapsed().as_millis(),
        resumed.generation
    );
    let scope = transport.scope(resumed.generation, "public")?;
    let started = Instant::now();
    let response = transport
        .http(request(resumed.generation, &scope.id, "pool-resumed", pool))
        .await?;
    assert_eq!(response.status, 200);
    let status: serde_json::Value =
        serde_json::from_slice(&STANDARD.decode(response.body_base64)?)?;
    println!(
        "Pool read after resume: {} ms, HTTP {}, phase {}",
        started.elapsed().as_millis(),
        response.status,
        status["phase"].as_str().unwrap_or("unknown")
    );
    verify_tor(&transport, resumed.generation, "tor-check-resumed").await?;
    Ok(())
}
