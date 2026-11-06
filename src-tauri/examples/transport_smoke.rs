use base64::{Engine, engine::general_purpose::STANDARD};
use shielded_native_lib::transport::{NativeRequest, PrivacyTransport};
use std::time::Duration;

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

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let data = std::env::temp_dir().join("shielded-native-tor-smoke");
    let transport = PrivacyTransport::new(data)?;
    let boot = transport.start().await?;
    if boot.phase != "ready" {
        return Err(format!(
            "Tor bootstrap phase: {}; {}",
            boot.phase,
            boot.error.unwrap_or_default()
        )
        .into());
    }
    println!("Tor bootstrap ready, generation {}", boot.generation);
    let first = transport.scope(boot.generation, "public")?;
    let second = transport.scope(boot.generation, "public")?;
    assert_ne!(first.id, second.id);
    let pool = "https://shielded.mutinynet.arkade.sh/api/rollup/status";
    for (id, scope) in [("pool-one", &first.id), ("pool-two", &second.id)] {
        let response = transport
            .http(request(boot.generation, scope, id, pool))
            .await?;
        assert_eq!(response.status, 200);
        let body = STANDARD.decode(response.body_base64)?;
        let status: serde_json::Value = serde_json::from_slice(&body)?;
        println!(
            "Isolated pool read {id}: HTTP {}, {} bytes, phase {}",
            response.status,
            body.len(),
            status["phase"].as_str().unwrap_or("unknown")
        );
    }
    let check = transport.scope(boot.generation, "discovery")?;
    let response = transport
        .http(request(
            boot.generation,
            &check.id,
            "tor-check",
            "https://check.torproject.org/api/ip",
        ))
        .await?;
    assert_eq!(response.status, 200);
    let check: serde_json::Value = serde_json::from_slice(&STANDARD.decode(response.body_base64)?)?;
    assert_eq!(check["IsTor"], true);
    println!("Tor Project independently reports IsTor=true");
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
    Ok(())
}
