use super::{
    NativeMode, NativeRequest, PrivacyTransport, UpdateDownload,
    policy::{check_request, http_request},
    session::{Inner, Lease},
    update::{MAX_APK_BYTES, initial_url, redirect_url},
    wire::{download_with, send_http},
};
use arti_client::{BootstrapBehavior, TorClient, config::TorClientConfigBuilder};
use sha2::{Digest, Sha256};
use std::{
    collections::VecDeque,
    future::Future,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader, DuplexStream},
    sync::oneshot,
    task::JoinHandle,
};

const ASSET: &str = "https://github.com/arkade-os/shielded/releases/download/native-mutinynet-c4f30bb1be18-run98-attempt1/shielded-mutinynet-android-arm64-c4f30bb1be18-run98-attempt1.apk";
const CDN: &str = "https://release-assets.githubusercontent.com/github-production-release-asset/1398591288/e2d7640e-e4f8-4c70-ada3-e77e51cedb3b?sig=private-server-token";
const OK: &[u8] = b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok";

fn asset(body: &[u8]) -> UpdateDownload {
    UpdateDownload {
        url: ASSET.into(),
        bytes: body.len() as u64,
        sha256: Sha256::digest(body)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect(),
    }
}

struct Staging(PathBuf);
impl Staging {
    async fn create(&self) -> tokio::fs::File {
        tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&self.0)
            .await
            .unwrap()
    }
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!(
            "shielded-update-test-{}.part",
            uuid::Uuid::new_v4()
        )))
    }
}
impl Drop for Staging {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

async fn bounded<T>(work: impl Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(3), work)
        .await
        .expect("Update test stalled")
}

fn ready() -> Arc<Inner> {
    let inner = Arc::new(Inner::new(
        std::env::temp_dir().join(format!("shielded-update-tor-{}", uuid::Uuid::new_v4())),
    ));
    let config = TorClientConfigBuilder::from_directories(
        inner.data_dir.join("state"),
        inner.data_dir.join("cache"),
    )
    .build()
    .unwrap();
    let client = TorClient::builder()
        .config(config)
        .bootstrap_behavior(BootstrapBehavior::Manual)
        .create_unbootstrapped()
        .unwrap();
    {
        let mut session = inner.lock().unwrap();
        session.phase = "ready";
        session.generation = 1;
        session.client = Some(client);
    }
    inner
}

fn register(inner: &Arc<Inner>, id: &str) -> Lease {
    let scope = inner.scope(1, "update").unwrap();
    let request = NativeRequest {
        generation: 1,
        request_id: id.into(),
        scope: scope.id,
        url: ASSET.into(),
        method: "GET".into(),
        headers: Vec::new(),
        body_base64: None,
    };
    let checked = check_request(&request, false).unwrap();
    inner.register(&request, &checked, None).unwrap()
}

async fn headers(peer: &mut BufReader<DuplexStream>) -> Vec<u8> {
    let mut request = Vec::new();
    loop {
        assert_ne!(peer.read_until(b'\n', &mut request).await.unwrap(), 0);
        if request.ends_with(b"\r\n\r\n") {
            return request;
        }
    }
}

fn serve(response: Vec<u8>) -> (DuplexStream, JoinHandle<Vec<u8>>) {
    let (client, server) = tokio::io::duplex(8192);
    let task = tokio::spawn(async move {
        let mut peer = BufReader::new(server);
        let request = headers(&mut peer).await;
        let _ = peer.get_mut().write_all(&response).await;
        let _ = peer.get_mut().shutdown().await;
        assert_eq!(bounded(peer.read(&mut [0])).await.unwrap(), 0);
        request
    });
    (client, task)
}

#[test]
fn package_metadata_is_bounded_and_pinned_to_our_release_repository() {
    assert!(asset(b"ok").validate().is_ok());
    for value in [0, MAX_APK_BYTES + 1, u64::MAX] {
        let mut next = asset(b"ok");
        next.bytes = value;
        assert!(next.validate().is_err());
    }
    for value in ["x".repeat(64), "a".repeat(63), "A".repeat(64)] {
        let mut next = asset(b"ok");
        next.sha256 = value;
        assert!(next.validate().is_err());
    }
    for value in [
        ASSET.replace("https:", "http:"),
        ASSET.replace("github.com/", "github.com.evil.example/"),
        ASSET.replace("arkade-os/shielded/", "someone/shielded/"),
        ASSET.replace("native-mutinynet-", "mainnet-"),
        ASSET.replace(".apk", ".exe"),
        ASSET.replace("github.com/", "github.com:8443/"),
        ASSET.replace("github.com/", "user:password@github.com/"),
        ASSET.replace(".apk", "%2eapk"),
        format!("{ASSET}?token=renderer"),
        format!("{ASSET}#fragment"),
        CDN.into(),
    ] {
        assert!(initial_url(&value).is_err(), "{value}");
    }
}

#[test]
fn only_native_github_redirects_to_our_asset_repository_are_allowed() {
    assert!(redirect_url(CDN).is_ok());
    for value in [
        CDN.replace("https:", "http:"),
        CDN.replace("1398591288", "12345"),
        CDN.replace("release-assets.githubusercontent.com", "github.com"),
        CDN.replace(
            "release-assets.githubusercontent.com",
            "release-assets.githubusercontent.com.evil.example",
        ),
        CDN.replace("e2d7640e-e4f8-4c70-ada3-e77e51cedb3b", "../../another"),
        CDN.replace("/github-production-release-asset/", "/other/"),
        CDN.replace(".com/", ".com:8443/"),
        CDN.replace(".com/", ".com./"),
        format!("{CDN}#fragment"),
        ASSET.into(),
    ] {
        assert!(redirect_url(&value).is_err());
    }
}

#[tokio::test]
async fn direct_mode_can_check_download_and_publish_updates_until_revoked() {
    let inner = Arc::new(Inner::new(PathBuf::from("shielded-update-direct-unused")));
    let generation = inner.start(NativeMode::Direct).await.unwrap().generation;
    assert!(inner.scope(generation, "release").is_ok());
    assert!(inner.scope(generation, "update").is_ok());
    inner.finish_update(generation, || Ok(())).unwrap();
    inner.pause().unwrap();
    assert!(inner.finish_update(generation, || Ok(())).is_err());
    assert!(inner.scope(generation, "update").is_err());
}

#[tokio::test]
async fn pre_cancelled_operations_write_nothing_and_leave_no_scope() {
    let inner = ready();
    inner.cancel(1, "cancel-first").unwrap();
    let destination = Staging::new();
    let transport = PrivacyTransport {
        inner: inner.clone(),
    };
    assert!(
        transport
            .download_update(
                1,
                "cancel-first".into(),
                asset(b"ok"),
                destination.create().await,
                |_| {}
            )
            .await
            .is_err()
    );
    assert_eq!(std::fs::metadata(&destination.0).unwrap().len(), 0);
    assert!(inner.lock().unwrap().scopes.is_empty());
}

#[tokio::test]
async fn a_complete_verified_package_is_written_without_a_renderer_body_or_cached_connection() {
    let inner = ready();
    let lease = register(&inner, "complete");
    let destination = Staging::new();
    let (client, peer) = serve(OK.into());
    let mut client = Some(client);
    let progress = Mutex::new(Vec::new());
    bounded(download_with(
        &lease,
        &asset(b"ok"),
        destination.create().await,
        &|event| progress.lock().unwrap().push(event.received),
        |checked| {
            let stream = lease.test_stream(client.take().unwrap());
            async move { send_http(stream, http_request(checked)?).await }
        },
    ))
    .await
    .unwrap();
    assert_eq!(std::fs::read(&destination.0).unwrap(), b"ok");
    assert_eq!(*progress.lock().unwrap(), vec![0, 2]);
    assert!(lease.take_http("github.com").unwrap().is_none());
    let headers = String::from_utf8(bounded(peer).await.unwrap()).unwrap();
    assert!(headers.starts_with("GET /arkade-os/shielded/releases/download/"));
    assert!(
        headers
            .to_ascii_lowercase()
            .contains("accept-encoding: identity")
    );
    for forbidden in ["cookie:", "authorization:", "referer:", "origin:"] {
        assert!(!headers.to_ascii_lowercase().contains(forbidden));
    }
}

#[tokio::test]
async fn package_bytes_reach_the_private_file_before_the_response_finishes() {
    let inner = ready();
    let lease = register(&inner, "stream-file");
    let destination = Staging::new();
    let file = destination.create().await;
    let body = vec![b'a'; 256 * 1024];
    let expected = asset(&body);
    let (client, server) = tokio::io::duplex(8192);
    let (first_half, received_half) = oneshot::channel();
    let (continue_body, finish_body) = oneshot::channel();
    let peer = tokio::spawn(async move {
        let mut peer = BufReader::new(server);
        headers(&mut peer).await;
        peer.get_mut()
            .write_all(
                format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n", body.len()).as_bytes(),
            )
            .await
            .unwrap();
        peer.get_mut()
            .write_all(&body[..body.len() / 2])
            .await
            .unwrap();
        first_half.send(()).unwrap();
        finish_body.await.unwrap();
        peer.get_mut()
            .write_all(&body[body.len() / 2..])
            .await
            .unwrap();
        peer.get_mut().shutdown().await.unwrap();
        assert_eq!(bounded(peer.read(&mut [0])).await.unwrap(), 0);
    });
    let task = tokio::spawn(async move {
        let mut client = Some(client);
        download_with(&lease, &expected, file, &|_| {}, |checked| {
            let stream = lease.test_stream(client.take().unwrap());
            async move { send_http(stream, http_request(checked)?).await }
        })
        .await
    });
    bounded(received_half).await.unwrap();
    bounded(async {
        loop {
            if std::fs::metadata(&destination.0).unwrap().len() > 0 {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await;
    assert!(std::fs::metadata(&destination.0).unwrap().len() < 256 * 1024);
    continue_body.send(()).unwrap();
    bounded(task).await.unwrap().unwrap();
    bounded(peer).await.unwrap();
    assert_eq!(
        std::fs::read(&destination.0).unwrap(),
        vec![b'a'; 256 * 1024]
    );
}

#[tokio::test]
async fn incomplete_oversized_encoded_or_changed_packages_never_finish() {
    let cases: Vec<(Vec<u8>, UpdateDownload)> = vec![
        (
            b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nok".to_vec(),
            asset(b"ok"),
        ),
        (
            b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\no".to_vec(),
            asset(b"ok"),
        ),
        (
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1\r\no\r\n0\r\n\r\n".to_vec(),
            asset(b"ok"),
        ),
        (
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\noka\r\n0\r\n\r\n".to_vec(),
            asset(b"ok"),
        ),
        (
            b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Encoding: gzip\r\n\r\nok".to_vec(),
            asset(b"ok"),
        ),
        (
            b"HTTP/1.1 206 Partial Content\r\nContent-Length: 2\r\n\r\nok".to_vec(),
            asset(b"ok"),
        ),
        (OK.to_vec(), asset(b"no")),
    ];
    for (index, (response, expected)) in cases.into_iter().enumerate() {
        let inner = ready();
        let lease = register(&inner, &format!("bad-{index}"));
        let destination = Staging::new();
        let (client, peer) = serve(response);
        let mut client = Some(client);
        let progress = Mutex::new(Vec::new());
        assert!(
            bounded(download_with(
                &lease,
                &expected,
                destination.create().await,
                &|event| progress.lock().unwrap().push(event.received),
                |checked| {
                    let stream = lease.test_stream(client.take().unwrap());
                    async move { send_http(stream, http_request(checked)?).await }
                }
            ))
            .await
            .is_err(),
            "case {index}"
        );
        assert!(
            !progress.lock().unwrap().contains(&expected.bytes),
            "case {index}"
        );
        bounded(peer).await.unwrap();
    }
}

#[tokio::test]
async fn redirects_remain_in_one_fresh_operation_and_stop_at_the_approved_host_and_limit() {
    for (locations, success, connects) in [
        (vec![CDN], true, 2),
        (vec![CDN, CDN], true, 3),
        (vec![CDN, CDN, CDN], false, 3),
        (vec!["https://example.org/package.apk"], false, 1),
    ] {
        let inner = ready();
        let lease = register(&inner, "redirect");
        let destination = Staging::new();
        let mut servers = Vec::new();
        let mut clients = VecDeque::new();
        for index in 0..connects {
            let response = locations
                .get(index)
                .map(|location| {
                    format!(
                        "HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\n\r\n"
                    )
                    .into_bytes()
                })
                .unwrap_or_else(|| OK.to_vec());
            let (client, peer) = serve(response);
            clients.push_back(client);
            servers.push(peer);
        }
        let targets = Mutex::new(Vec::new());
        let result = bounded(download_with(
            &lease,
            &asset(b"ok"),
            destination.create().await,
            &|_| {},
            |checked| {
                targets
                    .lock()
                    .unwrap()
                    .push(checked.url.host_str().unwrap().to_owned());
                let stream = lease.test_stream(clients.pop_front().unwrap());
                async move { send_http(stream, http_request(checked)?).await }
            },
        ))
        .await;
        assert_eq!(result.is_ok(), success);
        let targets = targets.lock().unwrap();
        assert_eq!(targets.len(), connects);
        assert_eq!(targets[0], "github.com");
        assert!(
            targets[1..]
                .iter()
                .all(|host| host == "release-assets.githubusercontent.com")
        );
        for server in servers {
            bounded(server).await.unwrap();
        }
    }
}

#[tokio::test]
async fn cancellation_and_generation_retirement_close_the_physical_body_driver() {
    for pause in [false, true] {
        let inner = ready();
        let lease = register(&inner, "cancel-body");
        let destination = Staging::new();
        let file = destination.create().await;
        let (client, server) = tokio::io::duplex(4096);
        let (started, ready_body) = oneshot::channel();
        let peer = tokio::spawn(async move {
            let mut peer = BufReader::new(server);
            headers(&mut peer).await;
            peer.get_mut()
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\no")
                .await
                .unwrap();
            started.send(()).unwrap();
            assert_eq!(bounded(peer.read(&mut [0])).await.unwrap(), 0);
        });
        let task = tokio::spawn(async move {
            let mut client = Some(client);
            download_with(&lease, &asset(b"ok"), file, &|_| {}, |checked| {
                let stream = lease.test_stream(client.take().unwrap());
                async move { send_http(stream, http_request(checked)?).await }
            })
            .await
        });
        bounded(ready_body).await.unwrap();
        if pause {
            inner.pause().unwrap();
        } else {
            inner.cancel(1, "cancel-body").unwrap();
        }
        assert!(bounded(task).await.unwrap().is_err());
        bounded(peer).await.unwrap();
        assert_eq!(
            bounded(inner.start(NativeMode::Direct))
                .await
                .unwrap()
                .phase,
            "ready"
        );
    }
}

#[tokio::test(start_paused = true)]
async fn a_stalled_update_body_fails_at_the_native_idle_timeout() {
    let inner = ready();
    let lease = register(&inner, "stalled-body");
    let destination = Staging::new();
    let file = destination.create().await;
    let (client, server) = tokio::io::duplex(4096);
    let peer = tokio::spawn(async move {
        let mut peer = BufReader::new(server);
        headers(&mut peer).await;
        peer.get_mut()
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\no")
            .await
            .unwrap();
        let _ = peer.read(&mut [0]).await;
    });
    let started = tokio::time::Instant::now();
    let mut client = Some(client);
    let error = download_with(&lease, &asset(b"ok"), file, &|_| {}, |checked| {
        let stream = lease.test_stream(client.take().unwrap());
        async move { send_http(stream, http_request(checked)?).await }
    })
    .await
    .unwrap_err();
    assert!(error.contains("stopped responding"), "{error}");
    assert!(started.elapsed() >= Duration::from_secs(180));
    assert!(started.elapsed() < Duration::from_secs(30 * 60));
    peer.await.unwrap();
}

#[tokio::test]
async fn cancellation_at_final_progress_cannot_publish_a_ready_result() {
    let inner = ready();
    let lease = register(&inner, "cancel-final");
    let destination = Staging::new();
    let (client, peer) = serve(OK.into());
    let mut client = Some(client);
    let result = bounded(download_with(
        &lease,
        &asset(b"ok"),
        destination.create().await,
        &|event| {
            if event.received == event.total {
                inner.cancel(1, "cancel-final").unwrap();
            }
        },
        |checked| {
            let stream = lease.test_stream(client.take().unwrap());
            async move { send_http(stream, http_request(checked)?).await }
        },
    ))
    .await;
    assert!(result.is_err());
    bounded(peer).await.unwrap();
}

#[tokio::test]
async fn publication_fence_rejects_a_retired_generation_in_any_mode() {
    let inner = ready();
    let transport = PrivacyTransport {
        inner: inner.clone(),
    };
    assert_eq!(transport.finish_update(1, || Ok(7)).unwrap(), 7);
    inner.pause().unwrap();
    assert!(
        transport
            .finish_update(1, || -> Result<(), String> {
                panic!("retired publication ran")
            })
            .is_err()
    );
    let started = inner.start(NativeMode::Direct).await.unwrap();
    assert_eq!(transport.finish_update(started.generation, || Ok(8)).unwrap(), 8);
    assert!(
        transport
            .finish_update(1, || -> Result<(), String> {
                panic!("a Tor-era publication ran in direct mode")
            })
            .is_err()
    );
}

#[tokio::test]
async fn release_scopes_only_allow_the_pinned_metadata_endpoint() {
    let inner = ready();
    let scope = inner.scope(1, "release").unwrap();
    let mut request = NativeRequest {
        generation: 1,
        request_id: "release-info".into(),
        scope: scope.id,
        url: "https://shielded.mutinynet.arkade.sh/api/native/releases".into(),
        method: "GET".into(),
        headers: Vec::new(),
        body_base64: None,
    };
    let lease = inner
        .register(&request, &check_request(&request, false).unwrap(), None)
        .unwrap();
    lease.check().unwrap();
    drop(lease);
    for path in ["/api/rollup/status", "/api/native/releases?item=wallet"] {
        request.request_id = uuid::Uuid::new_v4().to_string();
        request.url = format!("https://shielded.mutinynet.arkade.sh{path}");
        assert!(
            inner
                .register(&request, &check_request(&request, false).unwrap(), None)
                .is_err()
        );
    }
}
