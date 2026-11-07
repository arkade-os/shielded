use super::NativeRequest;
use base64::{Engine, engine::general_purpose::STANDARD};
use bytes::Bytes;
use http_body_util::Full;
use hyper::{
    Method, Request,
    header::{HeaderName, HeaderValue},
};
use url::Url;

pub const MAX_REQUEST: usize = 4 * 1024 * 1024;
pub const MAX_RESPONSE: usize = 64 * 1024 * 1024;
pub const MAX_CHUNK: usize = 64 * 1024;

pub struct CheckedRequest {
    pub url: Url,
    pub method: Method,
    pub headers: Vec<(HeaderName, HeaderValue)>,
    pub body: Vec<u8>,
}

pub fn check_request(request: &NativeRequest, socket: bool) -> Result<CheckedRequest, String> {
    if request.url.len() > 8192 {
        return Err("private URL too long".into());
    }
    let url = Url::parse(&request.url).map_err(|_| "invalid private URL")?;
    if url.scheme() != if socket { "wss" } else { "https" }
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || url.port_or_known_default() != Some(443)
    {
        return Err("private requests require public TLS targets on port 443".into());
    }
    let host = match url.host() {
        Some(url::Host::Domain(host)) => host.trim_end_matches('.'),
        _ => return Err("private requests require a DNS hostname".into()),
    };
    if url.host_str().is_some_and(|host| host.ends_with('.'))
        || !host.contains('.')
        || host == "localhost"
        || [".localhost", ".local", ".internal", ".onion"]
            .iter()
            .any(|suffix| host.ends_with(suffix))
    {
        return Err("local or unsupported private target".into());
    }
    let method =
        Method::from_bytes(request.method.as_bytes()).map_err(|_| "invalid private HTTP method")?;
    if ![
        Method::GET,
        Method::HEAD,
        Method::POST,
        Method::PUT,
        Method::PATCH,
        Method::DELETE,
        Method::OPTIONS,
    ]
    .contains(&method)
        || (socket && method != Method::GET)
    {
        return Err("unsupported private HTTP method".into());
    }
    let body = match &request.body_base64 {
        Some(encoded) => {
            if encoded.len() > MAX_REQUEST.div_ceil(3) * 4 {
                return Err("private request body too large".into());
            }
            let bytes = STANDARD
                .decode(encoded)
                .map_err(|_| "invalid private request base64")?;
            if bytes.len() > MAX_REQUEST {
                return Err("private request body too large".into());
            }
            bytes
        }
        None => Vec::new(),
    };
    if !body.is_empty() && (socket || method == Method::GET || method == Method::HEAD) {
        return Err("private request method cannot carry a body".into());
    }
    if request.headers.len() > 128
        || request
            .headers
            .iter()
            .map(|(name, value)| name.len().saturating_add(value.len()))
            .sum::<usize>()
            > 64 * 1024
    {
        return Err("private request headers too large".into());
    }
    let mut headers = Vec::new();
    for (name, value) in &request.headers {
        let name =
            HeaderName::from_bytes(name.as_bytes()).map_err(|_| "invalid private header name")?;
        if ["x-build-version", "x-sdk-version"].contains(&name.as_str()) {
            continue;
        }
        if [
            "cookie",
            "host",
            "referer",
            "origin",
            "connection",
            "content-length",
            "transfer-encoding",
            "accept-encoding",
            "upgrade",
            "te",
            "trailer",
            "user-agent",
            "forwarded",
        ]
        .contains(&name.as_str())
            || name.as_str().starts_with("proxy-")
            || name.as_str().starts_with("sec-websocket-")
            || name.as_str().starts_with("x-forwarded-")
        {
            return Err("renderer cannot set private connection or identity headers".into());
        }
        headers.push((
            name,
            HeaderValue::from_str(value).map_err(|_| "invalid private header value")?,
        ));
    }
    headers.push((
        hyper::header::USER_AGENT,
        HeaderValue::from_static("ShieldedNative/1"),
    ));
    if !socket {
        headers.push((
            hyper::header::HOST,
            HeaderValue::from_str(url.host_str().ok_or("missing private host")?)
                .map_err(|_| "invalid private host")?,
        ));
        headers.push((
            hyper::header::ACCEPT_ENCODING,
            HeaderValue::from_static("identity"),
        ));
        headers.push((hyper::header::CONNECTION, HeaderValue::from_static("close")));
    }
    Ok(CheckedRequest {
        url,
        method,
        headers,
        body,
    })
}

pub fn http_request(checked: CheckedRequest) -> Result<Request<Full<Bytes>>, String> {
    let path = match checked.url.query() {
        Some(query) => format!("{}?{query}", checked.url.path()),
        None => checked.url.path().to_owned(),
    };
    let mut request = Request::builder().method(checked.method).uri(path);
    for (name, value) in checked.headers {
        request = request.header(name, value);
    }
    request
        .body(Full::new(Bytes::from(checked.body)))
        .map_err(|_| "invalid HTTP request".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(url: &str) -> NativeRequest {
        NativeRequest {
            generation: 1,
            request_id: "test-request".into(),
            scope: "scope".into(),
            url: url.into(),
            method: "GET".into(),
            headers: vec![],
            body_base64: None,
        }
    }

    #[test]
    fn public_tls_target_passes_without_local_dns() {
        let checked = check_request(&request("https://example.org/path?q=1"), false).unwrap();
        assert_eq!(checked.url.host_str(), Some("example.org"));
        assert_eq!(http_request(checked).unwrap().uri(), "/path?q=1");
    }

    #[test]
    fn sdk_build_fingerprints_are_stripped_without_rejecting_requests() {
        let mut value = request("https://mutinynet.arkade.sh/v1/info");
        value.headers = vec![
            ("X-Build-Version".into(), "build-identifier".into()),
            ("X-SDK-VERSION".into(), "0.5.3".into()),
            ("Accept".into(), "application/json".into()),
        ];
        let checked = check_request(&value, false).unwrap();
        assert!(
            checked
                .headers
                .iter()
                .all(|(name, _)| !["x-build-version", "x-sdk-version"].contains(&name.as_str()))
        );
        assert!(
            checked
                .headers
                .iter()
                .any(|(name, value)| name == "accept" && value == "application/json")
        );
    }

    #[test]
    fn local_targets_credentials_and_plaintext_are_rejected() {
        for url in [
            "http://example.org",
            "file:///etc/passwd",
            "https://127.0.0.1",
            "https://[::1]",
            "https://localhost",
            "https://app.local",
            "https://user:secret@example.org",
            "https://example.org:8443",
            "https://example.org/#private",
        ] {
            assert!(check_request(&request(url), false).is_err(), "{url}");
        }
    }

    #[test]
    fn connection_identifiers_and_oversized_payloads_are_rejected() {
        for name in [
            "Cookie",
            "Host",
            "Referer",
            "Origin",
            "Connection",
            "Proxy-Authorization",
            "Content-Length",
            "Transfer-Encoding",
            "Accept-Encoding",
        ] {
            let mut value = request("https://example.org");
            value.headers.push((name.into(), "x".into()));
            assert!(check_request(&value, false).is_err(), "{name}");
        }
        let mut value = request("https://example.org");
        value.body_base64 = Some(STANDARD.encode(vec![0; MAX_REQUEST + 1]));
        assert!(check_request(&value, false).is_err());
    }

    #[test]
    fn malformed_base64_and_unsupported_methods_fail_before_dispatch() {
        let mut value = request("https://example.org");
        value.body_base64 = Some("%%%".into());
        assert!(check_request(&value, false).is_err());
        value.body_base64 = None;
        value.method = "CONNECT".into();
        assert!(check_request(&value, false).is_err());
    }

    #[test]
    fn sockets_require_wss_get_without_body() {
        assert!(check_request(&request("wss://relay.example.org/"), true).is_ok());
        assert!(check_request(&request("https://relay.example.org/"), true).is_err());
        let mut value = request("wss://relay.example.org/");
        value.method = "POST".into();
        assert!(check_request(&value, true).is_err());
    }
}
