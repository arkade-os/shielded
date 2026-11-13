use super::{
    NativeMode, NativeRequest, NativeResponse,
    policy::{CheckedRequest, MAX_RESPONSE, check_request},
    session::{Inner, Lease},
    wire::{HttpConnection, http_with},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use std::{
    future::Future,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader, DuplexStream},
    sync::oneshot,
    task::JoinHandle,
};

const HOST: &str = "receive.example";
const OK: &[u8] = b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok";

async fn bounded<T>(work: impl Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(2), work)
        .await
        .expect("HTTP test stalled")
}

async fn ready() -> Arc<Inner> {
    let inner = Arc::new(Inner::new(
        std::env::temp_dir().join(format!("shielded-http-test-{}", uuid::Uuid::new_v4())),
    ));
    assert_eq!(
        inner.start(NativeMode::Direct).await.unwrap().phase,
        "ready"
    );
    inner
}

fn register(
    inner: &Arc<Inner>,
    scope: &str,
    id: &str,
    method: &str,
    body: &[u8],
) -> (Lease, CheckedRequest) {
    let request = NativeRequest {
        generation: 1,
        request_id: id.into(),
        scope: scope.into(),
        url: format!("https://{HOST}/receive"),
        method: method.into(),
        headers: Vec::new(),
        body_base64: (!body.is_empty()).then(|| STANDARD.encode(body)),
    };
    let checked = check_request(&request, false).unwrap();
    let lease = inner.register(&request, &checked, None).unwrap();
    (lease, checked)
}

async fn perform(
    inner: &Arc<Inner>,
    scope: &str,
    id: &str,
    method: &str,
    body: &[u8],
    client: Option<DuplexStream>,
    connects: &AtomicUsize,
) -> Result<NativeResponse, String> {
    let (lease, checked) = register(inner, scope, id, method, body);
    bounded(http_with(&lease, checked, || async move {
        connects.fetch_add(1, Ordering::SeqCst);
        HttpConnection::new(client.ok_or("unexpected fresh HTTP connection")?).await
    }))
    .await
}

async fn headers(peer: &mut BufReader<DuplexStream>) -> Vec<u8> {
    let mut request = Vec::new();
    loop {
        let length = peer.read_until(b'\n', &mut request).await.unwrap();
        assert_ne!(length, 0, "peer closed before a request");
        if request.ends_with(b"\r\n\r\n") {
            return request;
        }
    }
}

async fn closed(peer: &mut BufReader<DuplexStream>) {
    let mut byte = [0];
    assert_eq!(bounded(peer.read(&mut byte)).await.unwrap(), 0);
}

fn serve(responses: Vec<Vec<u8>>) -> (DuplexStream, JoinHandle<Vec<Vec<u8>>>) {
    let (client, server) = tokio::io::duplex(8192);
    let task = tokio::spawn(async move {
        let mut peer = BufReader::new(server);
        let mut requests = Vec::new();
        for response in responses {
            requests.push(headers(&mut peer).await);
            peer.get_mut().write_all(&response).await.unwrap();
        }
        closed(&mut peer).await;
        requests
    });
    (client, task)
}

fn no_cached(inner: &Arc<Inner>, scope: &str, id: &str) {
    let (lease, _) = register(inner, scope, id, "GET", &[]);
    assert!(lease.take_http(HOST).unwrap().is_none());
}

#[tokio::test]
async fn complete_responses_reuse_one_connection_within_the_scope() {
    let inner = ready().await;
    let scope = inner.scope(1, "lnurl").unwrap();
    let connects = AtomicUsize::new(0);
    let (client, peer) = serve(vec![OK.to_vec(), OK.to_vec(), OK.to_vec()]);
    for (index, client) in [Some(client), None, None].into_iter().enumerate() {
        let response = perform(
            &inner,
            &scope.id,
            &format!("read-{index}"),
            "GET",
            &[],
            client,
            &connects,
        )
        .await
        .unwrap();
        assert_eq!(STANDARD.decode(response.body_base64).unwrap(), b"ok");
    }
    assert_eq!(connects.load(Ordering::SeqCst), 1);
    inner.close_scope(1, &scope.id).unwrap();
    let requests = bounded(peer).await.unwrap();
    assert_eq!(requests.len(), 3);
    assert!(
        requests
            .iter()
            .all(|request| request.starts_with(b"GET /receive HTTP/1.1"))
    );
}

#[tokio::test]
async fn unrelated_scopes_never_take_another_scopes_connection() {
    let inner = ready().await;
    let first = inner.scope(1, "lnurl").unwrap();
    let second = inner.scope(1, "lnurl").unwrap();
    let connects = AtomicUsize::new(0);
    let (one, first_peer) = serve(vec![OK.to_vec(), OK.to_vec()]);
    let (two, second_peer) = serve(vec![OK.to_vec()]);
    perform(&inner, &first.id, "first", "GET", &[], Some(one), &connects)
        .await
        .unwrap();
    perform(
        &inner,
        &second.id,
        "second",
        "GET",
        &[],
        Some(two),
        &connects,
    )
    .await
    .unwrap();
    perform(
        &inner,
        &first.id,
        "first-again",
        "GET",
        &[],
        None,
        &connects,
    )
    .await
    .unwrap();
    assert_eq!(connects.load(Ordering::SeqCst), 2);
    inner.pause().unwrap();
    assert_eq!(bounded(first_peer).await.unwrap().len(), 2);
    assert_eq!(bounded(second_peer).await.unwrap().len(), 1);
}

#[tokio::test]
async fn an_origin_mismatch_cannot_receive_the_cached_connection() {
    let inner = ready().await;
    let scope = inner.scope(1, "lnurl").unwrap();
    let connects = AtomicUsize::new(0);
    let (client, peer) = serve(vec![OK.to_vec()]);
    perform(
        &inner,
        &scope.id,
        "first",
        "GET",
        &[],
        Some(client),
        &connects,
    )
    .await
    .unwrap();
    let (lease, _) = register(&inner, &scope.id, "wrong-origin", "GET", &[]);
    assert!(lease.take_http("another.example").unwrap().is_none());
    assert_eq!(bounded(peer).await.unwrap().len(), 1);
}

#[tokio::test]
async fn server_close_and_http_10_responses_are_not_cached() {
    for response in [
        b"HTTP/1.1 200 OK\r\nConnection: keep-alive, CLOSE\r\nContent-Length: 2\r\n\r\nok".to_vec(),
        b"HTTP/1.0 200 OK\r\nContent-Length: 2\r\n\r\nok".to_vec(),
    ] {
        let inner = ready().await;
        let scope = inner.scope(1, "lnurl").unwrap();
        let connects = AtomicUsize::new(0);
        let (client, peer) = serve(vec![response]);
        assert_eq!(
            perform(
                &inner,
                &scope.id,
                "read",
                "GET",
                &[],
                Some(client),
                &connects
            )
            .await
            .unwrap()
            .status,
            200
        );
        no_cached(&inner, &scope.id, "inspect");
        assert_eq!(bounded(peer).await.unwrap().len(), 1);
    }
}

#[tokio::test]
async fn a_closed_idle_socket_is_replaced_before_a_new_request() {
    let inner = ready().await;
    let scope = inner.scope(1, "lnurl").unwrap();
    let connects = AtomicUsize::new(0);
    let (client, server) = tokio::io::duplex(8192);
    let (close, close_now) = oneshot::channel();
    let peer = tokio::spawn(async move {
        let mut peer = BufReader::new(server);
        assert!(headers(&mut peer).await.starts_with(b"GET /receive"));
        peer.get_mut().write_all(OK).await.unwrap();
        close_now.await.unwrap();
    });
    perform(
        &inner,
        &scope.id,
        "first",
        "GET",
        &[],
        Some(client),
        &connects,
    )
    .await
    .unwrap();
    close.send(()).unwrap();
    bounded(peer).await.unwrap();
    let (lease, _) = register(&inner, &scope.id, "wait-closed", "GET", &[]);
    bounded(async {
        loop {
            let Some(connection) = lease.take_http(HOST).unwrap() else {
                break;
            };
            lease.return_http(HOST.into(), connection).unwrap();
            tokio::task::yield_now().await;
        }
    })
    .await;
    drop(lease);
    let (client, peer) = serve(vec![OK.to_vec()]);
    perform(
        &inner,
        &scope.id,
        "replacement",
        "GET",
        &[],
        Some(client),
        &connects,
    )
    .await
    .unwrap();
    assert_eq!(connects.load(Ordering::SeqCst), 2);
    inner.close_scope(1, &scope.id).unwrap();
    assert_eq!(bounded(peer).await.unwrap().len(), 1);
}

#[tokio::test]
async fn a_post_is_not_replayed_after_an_uncertain_response() {
    for reused in [false, true] {
        let inner = ready().await;
        let scope = inner.scope(1, "lnurl").unwrap();
        let connects = AtomicUsize::new(0);
        let (client, server) = tokio::io::duplex(8192);
        let peer = tokio::spawn(async move {
            let mut peer = BufReader::new(server);
            if reused {
                assert!(headers(&mut peer).await.starts_with(b"GET /receive"));
                peer.get_mut().write_all(OK).await.unwrap();
            }
            let request = headers(&mut peer).await;
            assert!(request.starts_with(b"POST /receive HTTP/1.1"));
            let mut body = [0; 4];
            peer.read_exact(&mut body).await.unwrap();
            assert_eq!(&body, b"once");
        });
        let client = if reused {
            perform(
                &inner,
                &scope.id,
                "warm",
                "GET",
                &[],
                Some(client),
                &connects,
            )
            .await
            .unwrap();
            None
        } else {
            Some(client)
        };
        let error = perform(
            &inner, &scope.id, "post", "POST", b"once", client, &connects,
        )
        .await
        .err()
        .unwrap();
        assert!(error.contains("outcome may be unknown"), "{error}");
        assert_eq!(connects.load(Ordering::SeqCst), 1);
        bounded(peer).await.unwrap();
        no_cached(&inner, &scope.id, "inspect");
    }
}

#[tokio::test]
async fn a_truncated_body_does_not_return_its_connection_to_the_cache() {
    let inner = ready().await;
    let scope = inner.scope(1, "lnurl").unwrap();
    let connects = AtomicUsize::new(0);
    let (client, server) = tokio::io::duplex(8192);
    let peer = tokio::spawn(async move {
        let mut peer = BufReader::new(server);
        headers(&mut peer).await;
        peer.get_mut()
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nx")
            .await
            .unwrap();
    });
    let error = perform(
        &inner,
        &scope.id,
        "truncated",
        "GET",
        &[],
        Some(client),
        &connects,
    )
    .await
    .err()
    .unwrap();
    assert!(error.contains("private response failed"), "{error}");
    bounded(peer).await.unwrap();
    no_cached(&inner, &scope.id, "inspect");
}

#[tokio::test]
async fn an_unsupported_encoding_is_rejected_without_caching() {
    let inner = ready().await;
    let scope = inner.scope(1, "lnurl").unwrap();
    let connects = AtomicUsize::new(0);
    let (client, peer) = serve(vec![
        b"HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: 2\r\n\r\nxz".to_vec(),
    ]);
    let error = perform(
        &inner,
        &scope.id,
        "encoded",
        "GET",
        &[],
        Some(client),
        &connects,
    )
    .await
    .err()
    .unwrap();
    assert!(error.contains("identity encoding"), "{error}");
    no_cached(&inner, &scope.id, "inspect");
    assert_eq!(bounded(peer).await.unwrap().len(), 1);
}

#[tokio::test]
async fn a_refusal_carries_its_reason_phrase() {
    let inner = ready().await;
    let scope = inner.scope(1, "lnurl").unwrap();
    let connects = AtomicUsize::new(0);
    let (client, peer) = serve(vec![
        b"HTTP/1.1 429 Too Many Requests\r\nRetry-After: 30\r\nContent-Length: 0\r\n\r\n".to_vec(),
    ]);
    let response = perform(
        &inner,
        &scope.id,
        "limited",
        "GET",
        &[],
        Some(client),
        &connects,
    )
    .await
    .unwrap();
    assert_eq!(response.status, 429);
    assert_eq!(response.status_text, "Too Many Requests");
    inner.close_scope(1, &scope.id).unwrap();
    assert_eq!(bounded(peer).await.unwrap().len(), 1);
}

#[tokio::test]
async fn an_encoded_refusal_surfaces_its_status_without_its_body() {
    let inner = ready().await;
    let scope = inner.scope(1, "lnurl").unwrap();
    let connects = AtomicUsize::new(0);
    let (client, peer) = serve(vec![
        b"HTTP/1.1 429 Too Many Requests\r\nContent-Encoding: gzip\r\nRetry-After: 20\r\nContent-Length: 2\r\n\r\nxz".to_vec(),
    ]);
    let response = perform(
        &inner,
        &scope.id,
        "encoded-refusal",
        "GET",
        &[],
        Some(client),
        &connects,
    )
    .await
    .unwrap();
    assert_eq!(response.status, 429);
    assert_eq!(response.status_text, "Too Many Requests");
    assert!(response.body_base64.is_empty());
    assert!(
        response
            .headers
            .iter()
            .any(|(name, value)| name == "retry-after" && value == "20")
    );
    assert!(
        !response
            .headers
            .iter()
            .any(|(name, _)| name == "content-encoding" || name == "content-length")
    );
    no_cached(&inner, &scope.id, "inspect");
    assert_eq!(bounded(peer).await.unwrap().len(), 1);
}

#[tokio::test]
async fn a_refusal_whose_body_cannot_be_read_still_surfaces_its_status() {
    for oversized in [false, true] {
        let inner = ready().await;
        let scope = inner.scope(1, "lnurl").unwrap();
        let (client, server) = tokio::io::duplex(64 * 1024);
        // The oversized peer holds its socket open, so only the undrained-body rule can keep
        // that connection out of the cache.
        let (release, released) = oneshot::channel();
        let peer = tokio::spawn(async move {
            let mut peer = BufReader::new(server);
            headers(&mut peer).await;
            let length = if oversized { MAX_RESPONSE + 1 } else { 10 };
            peer.get_mut()
                .write_all(
                    format!(
                        "HTTP/1.1 429 Too Many Requests\r\nRetry-After: 15\r\nContent-Length: {length}\r\n\r\n"
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
            if !oversized {
                peer.get_mut().write_all(b"x").await.unwrap();
                return;
            }
            let chunk = [0; 64 * 1024];
            for _ in 0..MAX_RESPONSE / chunk.len() {
                if peer.get_mut().write_all(&chunk).await.is_err() {
                    break;
                }
            }
            let _ = peer.get_mut().write_all(b"x").await;
            let _ = released.await;
        });
        let (lease, checked) = register(&inner, &scope.id, "unreadable-refusal", "GET", &[]);
        let response = tokio::time::timeout(
            Duration::from_secs(8),
            http_with(&lease, checked, || HttpConnection::new(client)),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(response.status, 429, "oversized {oversized}");
        assert_eq!(response.status_text, "Too Many Requests");
        assert!(response.body_base64.is_empty());
        assert!(
            response
                .headers
                .iter()
                .any(|(name, value)| name == "retry-after" && value == "15")
        );
        assert!(
            !response
                .headers
                .iter()
                .any(|(name, _)| name == "content-length")
        );
        no_cached(&inner, &scope.id, "inspect");
        let _ = release.send(());
        drop(lease);
        bounded(peer).await.unwrap();
    }
}

#[tokio::test]
async fn an_oversized_body_is_rejected_without_caching() {
    let inner = ready().await;
    let scope = inner.scope(1, "lnurl").unwrap();
    let (client, server) = tokio::io::duplex(64 * 1024);
    let peer = tokio::spawn(async move {
        let mut peer = BufReader::new(server);
        headers(&mut peer).await;
        let head = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n",
            MAX_RESPONSE + 1
        );
        peer.get_mut().write_all(head.as_bytes()).await.unwrap();
        let chunk = [0; 64 * 1024];
        for _ in 0..MAX_RESPONSE / chunk.len() {
            if peer.get_mut().write_all(&chunk).await.is_err() {
                return;
            }
        }
        let _ = peer.get_mut().write_all(b"x").await;
    });
    let (lease, checked) = register(&inner, &scope.id, "oversized", "GET", &[]);
    let error = tokio::time::timeout(
        Duration::from_secs(8),
        http_with(&lease, checked, || HttpConnection::new(client)),
    )
    .await
    .unwrap()
    .err()
    .unwrap();
    assert!(
        error.contains("private response failed or exceeded size limit"),
        "{error}"
    );
    drop(lease);
    bounded(peer).await.unwrap();
    no_cached(&inner, &scope.id, "inspect");
}

#[tokio::test]
async fn cancellation_before_dispatch_opens_no_connection_and_sends_no_bytes() {
    let inner = ready().await;
    let scope = inner.scope(1, "lnurl").unwrap();
    let (lease, checked) = register(&inner, &scope.id, "cancelled", "POST", b"once");
    let connects = AtomicUsize::new(0);
    let (client, server) = tokio::io::duplex(8192);
    inner.cancel(1, "cancelled").unwrap();
    let error = bounded(http_with(&lease, checked, || async {
        connects.fetch_add(1, Ordering::SeqCst);
        HttpConnection::new(client).await
    }))
    .await
    .err()
    .unwrap();
    assert!(error.contains("cancelled"), "{error}");
    assert_eq!(connects.load(Ordering::SeqCst), 0);
    closed(&mut BufReader::new(server)).await;
}

#[tokio::test]
async fn cancellation_after_headers_drops_the_connection_and_never_caches_it() {
    let inner = ready().await;
    let scope = inner.scope(1, "lnurl").unwrap();
    let (lease, checked) = register(&inner, &scope.id, "cancel-body", "GET", &[]);
    let (client, server) = tokio::io::duplex(8192);
    let (sent, received) = oneshot::channel();
    let peer = tokio::spawn(async move {
        let mut peer = BufReader::new(server);
        headers(&mut peer).await;
        peer.get_mut()
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nx")
            .await
            .unwrap();
        sent.send(()).unwrap();
        closed(&mut peer).await;
    });
    let work = http_with(&lease, checked, || HttpConnection::new(client));
    tokio::pin!(work);
    tokio::select! {
        result = &mut work => panic!("body completed before cancellation: {}", result.is_ok()),
        _ = received => {},
    }
    no_cached(&inner, &scope.id, "inspect-pending");
    inner.cancel(1, "cancel-body").unwrap();
    let error = bounded(work).await.err().unwrap();
    assert!(error.contains("cancelled"), "{error}");
    no_cached(&inner, &scope.id, "inspect-cancelled");
    bounded(peer).await.unwrap();
}

#[tokio::test]
async fn scope_close_and_generation_retirement_cannot_cache_a_late_body() {
    for pause in [false, true] {
        let inner = ready().await;
        let scope = inner.scope(1, "lnurl").unwrap();
        let (lease, checked) = register(&inner, &scope.id, "late-body", "GET", &[]);
        let (client, server) = tokio::io::duplex(8192);
        let (sent, received) = oneshot::channel();
        let (finish, finish_body) = oneshot::channel();
        let peer = tokio::spawn(async move {
            let mut peer = BufReader::new(server);
            headers(&mut peer).await;
            peer.get_mut()
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nx")
                .await
                .unwrap();
            sent.send(()).unwrap();
            finish_body.await.unwrap();
            let _ = peer.get_mut().write_all(b"y").await;
            closed(&mut peer).await;
        });
        let work = http_with(&lease, checked, || HttpConnection::new(client));
        tokio::pin!(work);
        tokio::select! {
            result = &mut work => panic!("body completed before retirement: {}", result.is_ok()),
            _ = received => {},
        }
        if pause {
            inner.pause().unwrap();
        } else {
            inner.close_scope(1, &scope.id).unwrap();
        }
        finish.send(()).unwrap();
        assert!(bounded(work).await.is_err());
        assert!(lease.take_http(HOST).is_err());
        bounded(peer).await.unwrap();
    }
}
