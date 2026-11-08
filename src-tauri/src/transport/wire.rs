use super::{
    NativeResponse, NativeStreamEvent,
    policy::{CheckedRequest, MAX_CHUNK, MAX_RESPONSE, http_request},
    session::Lease,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use http_body_util::{BodyExt, Full, Limited};
use hyper::{Response, body::Incoming, client::conn::http1};
use hyper_util::rt::TokioIo;
use std::{sync::Arc, time::Duration};
use tauri::ipc::Channel;
use tokio::{sync::mpsc, task::JoinHandle};
use tokio_rustls::TlsConnector;
use tokio_tungstenite::{
    Connector, client_async_tls_with_config,
    tungstenite::{
        client::IntoClientRequest,
        protocol::{Message, WebSocketConfig},
    },
};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(90);
const HTTP_TIMEOUT: Duration = Duration::from_secs(180);
const STREAM_IDLE: Duration = Duration::from_secs(180);

pub(super) struct ConnectionTask(JoinHandle<()>);
impl Drop for ConnectionTask {
    fn drop(&mut self) {
        self.0.abort();
    }
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
    let stream = lease.connect(&host).await?;
    lease.check()?;
    let name = rustls::pki_types::ServerName::try_from(host)
        .map_err(|_| "invalid private TLS hostname")?;
    let stream = TlsConnector::from(tls)
        .connect(name, stream)
        .await
        .map_err(|_| "private TLS verification failed")?;
    let request = http_request(checked)?;
    lease.check()?;
    let (response, driver) = send_http(stream, request).await?;
    if let Some(encoding) = response.headers().get(hyper::header::CONTENT_ENCODING) {
        if encoding.as_bytes() != b"identity" {
            return Err("upstream ignored private identity encoding".into());
        }
    }
    Ok((response, driver))
}

pub(super) async fn send_http<T>(
    stream: T,
    request: hyper::Request<Full<Bytes>>,
) -> Result<(Response<Incoming>, ConnectionTask), String>
where
    T: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let (mut sender, connection) = http1::Builder::new()
        .max_buf_size(64 * 1024)
        .handshake::<_, Full<Bytes>>(TokioIo::new(stream))
        .await
        .map_err(|_| "private HTTP handshake failed")?;
    let driver = ConnectionTask(tokio::spawn(async move {
        let _ = connection.await;
    }));
    let response = sender
        .send_request(request)
        .await
        .map_err(|_| "private HTTP request failed; outcome may be unknown")?;
    Ok((response, driver))
}

pub(super) async fn http(
    lease: Lease,
    checked: CheckedRequest,
    tls: Arc<rustls::ClientConfig>,
) -> Result<NativeResponse, String> {
    let response = tokio::select! {
        biased;
        _ = lease.cancel.cancelled() => return Err("private request cancelled; outcome may be unknown".into()),
        result = tokio::time::timeout(HTTP_TIMEOUT, async {
            let (response, _driver) = exchange(&lease, checked, tls).await?;
            let status = response.status().as_u16();
            let mut headers = Vec::new();
            for (name, value) in response.headers() {
                if name == hyper::header::SET_COOKIE { continue; }
                headers.push((name.to_string(), value.to_str().map_err(|_| "invalid private response header")?.to_owned()));
            }
            let body = Limited::new(response.into_body(), MAX_RESPONSE).collect().await.map_err(|_| "private response failed or exceeded size limit; outcome may be unknown")?.to_bytes();
            Ok::<_, String>(NativeResponse { generation: lease.generation, status, headers, body_base64: STANDARD.encode(body) })
        }) => result.map_err(|_| "private request timed out; outcome may be unknown")??,
    };
    lease.check()?;
    Ok(response)
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
        result = stream_inner(&lease, checked, tls, &channel) => result,
    };
    if let Err(error) = result {
        let _ = lease.emit(&channel, "error", None, Some(error), None);
    }
    let _ = lease.emit(&channel, "close", None, None, None);
}

async fn stream_inner(
    lease: &Lease,
    checked: CheckedRequest,
    tls: Arc<rustls::ClientConfig>,
    channel: &Channel<NativeStreamEvent>,
) -> Result<(), String> {
    let (response, _driver) = tokio::time::timeout(CONNECT_TIMEOUT, exchange(lease, checked, tls))
        .await
        .map_err(|_| "private stream connection timed out")??;
    if !response.status().is_success() {
        return Err("private stream HTTP status rejected".into());
    }
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
