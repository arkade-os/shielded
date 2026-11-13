use super::{
    NativeRequest, NativeResponse, NativeStreamEvent, UpdateDownload, UpdateProgress,
    policy::{CheckedRequest, MAX_CHUNK, MAX_RESPONSE, http_request},
    session::Lease,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use bytes::Bytes;
use futures_util::{SinkExt, StreamExt, future::BoxFuture};
use http_body_util::{BodyExt, Full, Limited};
use hyper::{Response, body::Incoming, client::conn::http1};
use hyper_util::rt::TokioIo;
use sha2::{Digest, Sha256};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use tauri::ipc::Channel;
use tokio::{
    io::{AsyncSeekExt, AsyncWriteExt},
    sync::mpsc,
    task::JoinHandle,
};
use tokio_rustls::TlsConnector;
use tokio_tungstenite::{
    Connector, client_async_tls_with_config,
    tungstenite::{
        client::IntoClientRequest,
        protocol::{Message, WebSocketConfig},
    },
};
use url::Url;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(90);
const HTTP_TIMEOUT: Duration = Duration::from_secs(180);
const STREAM_IDLE: Duration = Duration::from_secs(180);
const UPDATE_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const UPDATE_PROGRESS_INTERVAL: Duration = Duration::from_millis(250);
/// A refusal body is a small error page or the pool's admission JSON, sent with its headers.
/// A sixth of the 30s idle window that governs the connection it arrives on: several Tor round
/// trips of headroom, without letting a body that never lands hold back the status.
const REFUSAL_BODY_TIMEOUT: Duration = Duration::from_secs(5);

pub(super) struct ConnectionTask(JoinHandle<()>);
impl Drop for ConnectionTask {
    fn drop(&mut self) {
        self.0.abort();
    }
}

pub(super) struct HttpConnection {
    sender: http1::SendRequest<Full<Bytes>>,
    driver: ConnectionTask,
}

impl HttpConnection {
    pub async fn new<T>(stream: T) -> Result<Self, String>
    where
        T: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
    {
        let (sender, connection) = http1::Builder::new()
            .max_buf_size(64 * 1024)
            .handshake::<_, Full<Bytes>>(TokioIo::new(stream))
            .await
            .map_err(|_| "private HTTP handshake failed")?;
        let driver = ConnectionTask(tokio::spawn(async move {
            let _ = connection.await;
        }));
        Ok(Self { sender, driver })
    }

    pub async fn ready(&mut self) -> Result<(), String> {
        self.sender
            .ready()
            .await
            .map_err(|_| "private HTTP connection closed before request".into())
    }

    pub fn is_closed(&self) -> bool {
        self.sender.is_closed() || self.driver.0.is_finished()
    }

    async fn send(
        &mut self,
        request: hyper::Request<Full<Bytes>>,
    ) -> Result<Response<Incoming>, String> {
        self.sender
            .send_request(request)
            .await
            .map_err(|_| "private HTTP request failed; outcome may be unknown".into())
    }
}

async fn connect_http(
    lease: &Lease,
    host: &str,
    tls: Arc<rustls::ClientConfig>,
) -> Result<HttpConnection, String> {
    let stream = lease.connect(host).await?;
    lease.check()?;
    let name = rustls::pki_types::ServerName::try_from(host.to_owned())
        .map_err(|_| "invalid private TLS hostname")?;
    let stream = TlsConnector::from(tls)
        .connect(name, stream)
        .await
        .map_err(|_| "private TLS verification failed")?;
    HttpConnection::new(stream).await
}

fn encoded(response: &Response<Incoming>) -> bool {
    response
        .headers()
        .get(hyper::header::CONTENT_ENCODING)
        .is_some_and(|encoding| encoding.as_bytes() != b"identity")
}

fn check_encoding(response: &Response<Incoming>) -> Result<(), String> {
    if encoded(response) {
        return Err("upstream ignored private identity encoding".into());
    }
    Ok(())
}

fn retry_after(response: &Response<Incoming>) -> Option<String> {
    response
        .headers()
        .get(hyper::header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned)
}

async fn exchange(
    lease: &Lease,
    checked: CheckedRequest,
    tls: Arc<rustls::ClientConfig>,
) -> Result<(Response<Incoming>, ConnectionTask), String> {
    lease.check()?;
    let host = checked
        .url
        .host_str()
        .ok_or("missing private HTTP host")?
        .to_owned();
    let mut connection = connect_http(lease, &host, tls).await?;
    connection.ready().await?;
    let request = http_request(checked)?;
    lease.check()?;
    let response = connection.send(request).await?;
    Ok((response, connection.driver))
}

#[cfg(test)]
pub(super) async fn send_http<T>(
    stream: T,
    request: hyper::Request<Full<Bytes>>,
) -> Result<(Response<Incoming>, ConnectionTask), String>
where
    T: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let mut connection = HttpConnection::new(stream).await?;
    connection.ready().await?;
    let response = connection.send(request).await?;
    Ok((response, connection.driver))
}

pub(super) fn http(
    lease: Lease,
    checked: CheckedRequest,
    tls: Arc<rustls::ClientConfig>,
) -> BoxFuture<'static, Result<NativeResponse, String>> {
    Box::pin(async move {
        let host = checked
            .url
            .host_str()
            .ok_or("missing private HTTP host")?
            .to_owned();
        http_with(&lease, checked, || connect_http(&lease, &host, tls)).await
    })
}

pub(super) async fn http_with<F, Fut>(
    lease: &Lease,
    checked: CheckedRequest,
    connect: F,
) -> Result<NativeResponse, String>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<HttpConnection, String>>,
{
    let host = checked
        .url
        .host_str()
        .ok_or("missing private HTTP host")?
        .to_owned();
    let response = tokio::select! {
        biased;
        _ = lease.cancel.cancelled() => return Err("private request cancelled; outcome may be unknown".into()),
        result = tokio::time::timeout(HTTP_TIMEOUT, async {
            let mut cached = lease.take_http(&host)?;
            if let Some(connection) = cached.as_mut() {
                if connection.ready().await.is_err() { cached = None; }
            }
            let mut connection = match cached {
                Some(connection) => connection,
                None => connect().await?,
            };
            connection.ready().await?;
            let request = http_request(checked)?;
            lease.check()?;
            let response = connection.send(request).await?;
            // A refusal is often a CDN error page the host compressed anyway; its status is the
            // part the caller needs, so keep it rather than failing on a body nobody reads.
            let undecodable = encoded(&response);
            if undecodable && response.status().is_success() { return Err("upstream ignored private identity encoding".into()); }
            let refused = matches!(response.status().as_u16(), 403 | 429);
            let reusable = !undecodable
                && response.version() == hyper::Version::HTTP_11
                && !response.headers().get_all(hyper::header::CONNECTION).iter().any(|value| value.as_bytes().split(|byte| *byte == b',').any(|token| token.trim_ascii().eq_ignore_ascii_case(b"close")));
            let status = response.status().as_u16();
            let status_text = response.status().canonical_reason().unwrap_or_default().to_owned();
            let mut headers = Vec::new();
            for (name, value) in response.headers() {
                if name == hyper::header::SET_COOKIE { continue; }
                if undecodable && (name == hyper::header::CONTENT_ENCODING || name == hyper::header::CONTENT_LENGTH) { continue; }
                headers.push((name.to_string(), value.to_str().map_err(|_| "invalid private response header")?.to_owned()));
            }
            // Replace the exit on the headers, not after a body that may never finish.
            if refused { let _ = lease.retire_circuit(); }
            let mut dropped = undecodable;
            let body = if undecodable { Bytes::new() } else {
                let read = Limited::new(response.into_body(), MAX_RESPONSE).collect();
                let collected = if refused {
                    tokio::time::timeout(REFUSAL_BODY_TIMEOUT, read).await.ok().and_then(|result| result.ok())
                } else {
                    Some(read.await.map_err(|_| "private response failed or exceeded size limit; outcome may be unknown")?)
                };
                match collected { Some(collected) => collected.to_bytes(), None => { dropped = true; Bytes::new() } }
            };
            if dropped { headers.retain(|(name, _)| name != hyper::header::CONTENT_LENGTH.as_str()); }
            lease.check()?;
            if reusable && !dropped { lease.return_http(host, connection)?; }
            Ok::<_, String>(NativeResponse { generation: lease.generation, status, status_text, headers, body_base64: STANDARD.encode(body) })
        }) => result.map_err(|_| "private request timed out; outcome may be unknown")??,
    };
    lease.check()?;
    Ok(response)
}

pub(super) fn download<'a, P>(
    lease: &'a Lease,
    asset: &'a UpdateDownload,
    sources: &'a [Url],
    file: &'a mut tokio::fs::File,
    tls: Arc<rustls::ClientConfig>,
    progress: &'a P,
) -> BoxFuture<'a, Result<(), String>>
where
    P: Fn(UpdateProgress) + Sync,
{
    Box::pin(download_with(
        lease,
        asset,
        sources,
        file,
        progress,
        move |checked| exchange(lease, checked, tls.clone()),
    ))
}

pub(super) async fn download_with<F, Fut, P>(
    lease: &Lease,
    asset: &UpdateDownload,
    sources: &[Url],
    file: &mut tokio::fs::File,
    progress: &P,
    mut exchange: F,
) -> Result<(), String>
where
    F: FnMut(CheckedRequest) -> Fut,
    Fut: std::future::Future<Output = Result<(Response<Incoming>, ConnectionTask), String>>,
    P: Fn(UpdateProgress) + Sync,
{
    lease.check()?;
    let work = async {
        let mut failure = "Update download has no approved source".to_owned();
        for source in sources {
            match attempt(lease, asset, source, file, progress, &mut exchange).await {
                Ok(()) => return Ok(()),
                // Cancellation and generation retirement are final; only a bad source falls back.
                Err(error) if lease.check().is_err() => return Err(error),
                Err(error) => failure = error,
            }
            file.set_len(0)
                .await
                .map_err(|_| "Could not reset the private update file")?;
            file.seek(std::io::SeekFrom::Start(0))
                .await
                .map_err(|_| "Could not reset the private update file")?;
        }
        Err(failure)
    };
    let result = tokio::select! {
        biased;
        _ = lease.cancel.cancelled() => Err("Update download cancelled; retry when Tor is connected".into()),
        result = tokio::time::timeout(UPDATE_TIMEOUT, work) => {
            result.unwrap_or_else(|_| Err("Update download timed out; retry the download".into()))
        }
    };
    if result.is_err() {
        let _ = file.flush().await;
    }
    result
}

async fn attempt<F, Fut, P>(
    lease: &Lease,
    asset: &UpdateDownload,
    source: &Url,
    file: &mut tokio::fs::File,
    progress: &P,
    exchange: &mut F,
) -> Result<(), String>
where
    F: FnMut(CheckedRequest) -> Fut,
    Fut: std::future::Future<Output = Result<(Response<Incoming>, ConnectionTask), String>>,
    P: Fn(UpdateProgress) + Sync,
{
    let mut url = asset.start(source)?;
    lease.check()?;
    progress(UpdateProgress {
        received: 0,
        total: asset.bytes,
    });
    for redirects in 0..=2 {
        let checked = super::policy::check_request(
            &NativeRequest {
                generation: lease.generation,
                request_id: lease.id.clone(),
                scope: lease.scope.clone(),
                url: url.as_str().into(),
                method: "GET".into(),
                headers: vec![("Accept".into(), "application/octet-stream".into())],
                body_base64: None,
            },
            false,
        )?;
        lease.check()?;
        let (response, driver) = tokio::time::timeout(CONNECT_TIMEOUT, exchange(checked))
            .await
            .map_err(|_| "Update connection timed out; retry the download")??;
        lease.check()?;
        check_encoding(&response)?;
        if matches!(response.status().as_u16(), 301 | 302 | 303 | 307 | 308) {
            if redirects == 2 {
                return Err("Update redirect limit exceeded".into());
            }
            let location = response
                .headers()
                .get(hyper::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or("Update redirect is missing its destination")?;
            url = super::update::redirect_url(location)?;
            drop(response);
            drop(driver);
            continue;
        }
        if response.status() != hyper::StatusCode::OK {
            return Err("Update server did not return the requested package".into());
        }
        if let Some(length) = response.headers().get(hyper::header::CONTENT_LENGTH) {
            let length = length
                .to_str()
                .ok()
                .and_then(|value| value.parse::<u64>().ok())
                .ok_or("Update package length is invalid")?;
            if length != asset.bytes {
                return Err("Update package length does not match the release".into());
            }
        }
        let mut body = response.into_body();
        let mut received = 0u64;
        let mut digest = Sha256::new();
        let mut last_progress = Instant::now();
        while let Some(frame) = tokio::time::timeout(STREAM_IDLE, body.frame())
            .await
            .map_err(|_| "Update download stopped responding; retry the download")?
        {
            let frame = frame.map_err(|_| "Update download was interrupted; retry the download")?;
            if let Ok(bytes) = frame.into_data() {
                for chunk in bytes.chunks(MAX_CHUNK) {
                    lease.check()?;
                    received = received
                        .checked_add(chunk.len() as u64)
                        .filter(|received| *received <= asset.bytes)
                        .ok_or("Update package exceeded its advertised size")?;
                    file.write_all(chunk)
                        .await
                        .map_err(|_| "Could not write the private update file")?;
                    digest.update(chunk);
                    lease.check()?;
                    if received < asset.bytes && last_progress.elapsed() >= UPDATE_PROGRESS_INTERVAL
                    {
                        progress(UpdateProgress {
                            received,
                            total: asset.bytes,
                        });
                        last_progress = Instant::now();
                    }
                }
            }
        }
        if received != asset.bytes {
            return Err("Update package was incomplete; retry the download".into());
        }
        let actual: String = digest
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        if actual != asset.sha256 {
            return Err("Update package checksum does not match the release".into());
        }
        file.flush()
            .await
            .map_err(|_| "Could not finish the private update file")?;
        file.sync_all()
            .await
            .map_err(|_| "Could not save the private update file")?;
        lease.check()?;
        progress(UpdateProgress {
            received,
            total: asset.bytes,
        });
        drop(driver);
        lease.check()?;
        return Ok(());
    }
    Err("Update redirect limit exceeded".into())
}

pub(super) async fn stream(
    lease: Lease,
    checked: CheckedRequest,
    tls: Arc<rustls::ClientConfig>,
    channel: Channel<NativeStreamEvent>,
) {
    let result = tokio::select! {
        biased;
        _ = lease.cancel.cancelled() => return,
        result = stream_with(&lease, &channel, || exchange(&lease, checked, tls)) => result,
    };
    if let Err(error) = result {
        let _ = lease.emit(&channel, "error", None, Some(error), None);
    }
    let _ = lease.emit(&channel, "close", None, None, None);
}

pub(super) async fn stream_with<F, Fut>(
    lease: &Lease,
    channel: &Channel<NativeStreamEvent>,
    exchange: F,
) -> Result<(), String>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<(Response<Incoming>, ConnectionTask), String>>,
{
    let (response, _driver) = tokio::time::timeout(CONNECT_TIMEOUT, exchange())
        .await
        .map_err(|_| "private stream connection timed out")??;
    let status = response.status();
    if !status.is_success() {
        if matches!(status.as_u16(), 403 | 429) {
            let _ = lease.retire_circuit();
        }
        lease.emit_refused(channel, status.as_u16(), retry_after(&response))?;
        return Err("private stream HTTP status rejected".into());
    }
    check_encoding(&response)?;
    let content_type = response
        .headers()
        .get(hyper::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if !content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .eq_ignore_ascii_case("text/event-stream")
    {
        return Err("private stream content type rejected".into());
    }
    lease.emit(
        channel,
        "open",
        None,
        None,
        Some(response.status().as_u16()),
    )?;
    let mut body = response.into_body();
    while let Some(frame) = tokio::time::timeout(STREAM_IDLE, body.frame())
        .await
        .map_err(|_| "private stream idle timeout")?
    {
        let frame = frame.map_err(|_| "private stream interrupted")?;
        if let Ok(bytes) = frame.into_data() {
            for chunk in bytes.chunks(MAX_CHUNK) {
                tokio::time::timeout(
                    STREAM_IDLE,
                    lease.emit_data(channel, STANDARD.encode(chunk)),
                )
                .await
                .map_err(|_| "private stream consumer timed out")??;
            }
        }
    }
    Ok(())
}

pub(super) async fn socket(
    lease: Lease,
    checked: CheckedRequest,
    tls: Arc<rustls::ClientConfig>,
    channel: Channel<NativeStreamEvent>,
    mut outgoing: mpsc::Receiver<String>,
) {
    let result = tokio::select! {
        biased;
        _ = lease.cancel.cancelled() => return,
        result = socket_inner(&lease, checked, tls, &channel, &mut outgoing) => result,
    };
    if let Err(error) = result {
        let _ = lease.emit(&channel, "error", None, Some(error), None);
    }
    let _ = lease.emit(&channel, "close", None, None, None);
}

async fn socket_inner(
    lease: &Lease,
    checked: CheckedRequest,
    tls: Arc<rustls::ClientConfig>,
    channel: &Channel<NativeStreamEvent>,
    outgoing: &mut mpsc::Receiver<String>,
) -> Result<(), String> {
    let mut socket = tokio::time::timeout(CONNECT_TIMEOUT, async {
        lease.check()?;
        let host = checked
            .url
            .host_str()
            .ok_or("missing private socket host")?;
        let stream = lease.connect(host).await?;
        let mut request = checked
            .url
            .as_str()
            .into_client_request()
            .map_err(|_| "invalid private socket request")?;
        for (name, value) in checked.headers {
            request.headers_mut().insert(name, value);
        }
        let config = WebSocketConfig::default()
            .write_buffer_size(0)
            .max_write_buffer_size(MAX_CHUNK * 2)
            .max_message_size(Some(MAX_CHUNK))
            .max_frame_size(Some(MAX_CHUNK));
        lease.check()?;
        let (socket, _) = client_async_tls_with_config(
            request,
            stream,
            Some(config),
            Some(Connector::Rustls(tls)),
        )
        .await
        .map_err(|_| "private socket TLS or handshake failed")?;
        Ok::<_, String>(socket)
    })
    .await
    .map_err(|_| "private socket connection timed out")??;
    lease.emit(channel, "open", None, None, Some(101))?;
    loop {
        tokio::select! {
            biased;
            _ = lease.cancel.cancelled() => return Ok(()),
            event = async {
                tokio::select! {
                    message = outgoing.recv() => SocketEvent::Outgoing(message),
                    message = tokio::time::timeout(STREAM_IDLE, socket.next()) => SocketEvent::Incoming(message),
                }
            } => match event {
            SocketEvent::Outgoing(message) => {
                let Some(message) = message else { return Ok(()); };
                lease.check()?;
                tokio::time::timeout(CONNECT_TIMEOUT, socket.send(Message::Text(message.into())))
                    .await.map_err(|_| "private socket send timed out")?.map_err(|_| "private socket send failed; outcome may be unknown")?;
            }
            SocketEvent::Incoming(message) => {
                match message.map_err(|_| "private socket idle timeout")? {
                    None | Some(Ok(Message::Close(_))) => return Ok(()),
                    Some(Ok(Message::Text(message))) => {
                        tokio::time::timeout(STREAM_IDLE, lease.emit_data(channel, message.to_string()))
                            .await.map_err(|_| "private socket consumer timed out")??;
                    }
                    Some(Ok(Message::Binary(_))) => return Err("private socket binary messages are unsupported".into()),
                    Some(Ok(Message::Ping(_))) => {
                        tokio::time::timeout(CONNECT_TIMEOUT, socket.flush()).await.map_err(|_| "private socket pong timed out")?.map_err(|_| "private socket pong failed")?;
                    }
                    Some(Ok(_)) => {},
                    Some(Err(_)) => return Err("private socket interrupted".into()),
                }
            }
            }
        }
    }
}

enum SocketEvent {
    Outgoing(Option<String>),
    Incoming(
        Result<
            Option<Result<Message, tokio_tungstenite::tungstenite::Error>>,
            tokio::time::error::Elapsed,
        >,
    ),
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

    async fn headers(server: &mut BufReader<tokio::io::DuplexStream>) -> Vec<u8> {
        let mut request = Vec::new();
        loop {
            let length = server.read_until(b'\n', &mut request).await.unwrap();
            if length == 0 || request.ends_with(b"\r\n\r\n") {
                return request;
            }
        }
    }

    fn get() -> hyper::Request<Full<Bytes>> {
        hyper::Request::builder()
            .uri("/status")
            .header("host", "example.org")
            .body(Full::new(Bytes::new()))
            .unwrap()
    }

    #[tokio::test]
    async fn redirect_is_returned_without_following_another_target() {
        let (client, server) = tokio::io::duplex(4096);
        let server = tokio::spawn(async move {
            let mut server = BufReader::new(server);
            let request = headers(&mut server).await;
            assert!(request.starts_with(b"GET /status HTTP/1.1"));
            server.get_mut().write_all(b"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1/\r\nContent-Length: 0\r\n\r\n").await.unwrap();
        });
        let (response, _driver) = send_http(client, get()).await.unwrap();
        assert_eq!(response.status().as_u16(), 302);
        server.await.unwrap();
    }

    #[tokio::test]
    async fn uncertain_post_is_written_once_then_errors() {
        let (client, server) = tokio::io::duplex(4096);
        let server = tokio::spawn(async move {
            let mut server = BufReader::new(server);
            let request = headers(&mut server).await;
            assert!(request.starts_with(b"POST /spend HTTP/1.1"));
            let mut body = [0; 4];
            server.read_exact(&mut body).await.unwrap();
            assert_eq!(&body, b"once");
        });
        let request = hyper::Request::builder()
            .method("POST")
            .uri("/spend")
            .header("host", "example.org")
            .body(Full::new(Bytes::from_static(b"once")))
            .unwrap();
        let error = match send_http(client, request).await {
            Err(error) => error,
            Ok(_) => panic!("unexpected response"),
        };
        assert!(error.contains("outcome may be unknown"));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn dropping_response_driver_closes_pending_stream() {
        let (client, server) = tokio::io::duplex(4096);
        let server = tokio::spawn(async move {
            let mut server = BufReader::new(server);
            headers(&mut server).await;
            server
                .get_mut()
                .write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1\r\na\r\n")
                .await
                .unwrap();
            let mut data = [0; 1];
            assert_eq!(
                tokio::time::timeout(Duration::from_secs(2), server.read(&mut data))
                    .await
                    .unwrap()
                    .unwrap(),
                0
            );
        });
        let (response, driver) = send_http(client, get()).await.unwrap();
        drop(response);
        drop(driver);
        server.await.unwrap();
    }
}
