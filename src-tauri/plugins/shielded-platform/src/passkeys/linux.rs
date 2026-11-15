use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};

use futures_util::StreamExt;
use zbus::{
    zvariant::{OwnedObjectPath, OwnedValue, Str},
    Connection, Proxy,
};

use super::PasskeyError;

const BUS: &str = "org.freedesktop.portal.Desktop";
const PATH: &str = "/org/freedesktop/portal/desktop";
const CREDENTIAL: &str = "org.freedesktop.portal.experimental.Credential";
const REQUEST: &str = "org.freedesktop.portal.Request";
const ORIGIN: &str = "https://shielded.mutinynet.arkade.sh";
static ACTIVE: AtomicBool = AtomicBool::new(false);
type Values = HashMap<String, OwnedValue>;

struct Ceremony;

impl Drop for Ceremony {
    fn drop(&mut self) {
        ACTIVE.store(false, Ordering::Release);
    }
}

struct PendingRequest {
    proxy: Option<Proxy<'static>>,
    ceremony: Arc<Ceremony>,
}

impl Drop for PendingRequest {
    fn drop(&mut self) {
        if let Some(proxy) = self.proxy.take() {
            let ceremony = self.ceremony.clone();
            tauri::async_runtime::spawn(async move {
                let _ =
                    tokio::time::timeout(Duration::from_secs(2), proxy.call_noreply("Close", &()))
                        .await;
                drop(ceremony);
            });
        }
    }
}

fn text(value: String) -> OwnedValue {
    OwnedValue::from(Str::from(value))
}

fn options(create: bool, request: String, token: String) -> Values {
    let public_key = if create {
        text(request)
    } else {
        OwnedValue::from(HashMap::from([("request_json".to_owned(), text(request))]))
    };
    HashMap::from([
        ("handle_token".to_owned(), text(token)),
        ("public_key".to_owned(), public_key),
    ])
}

fn request_path(sender: &str, token: &str) -> Result<OwnedObjectPath, PasskeyError> {
    let sender = sender
        .strip_prefix(':')
        .ok_or(PasskeyError::Unavailable)?
        .replace('.', "_");
    OwnedObjectPath::try_from(format!("{PATH}/request/{sender}/{token}"))
        .map_err(|_| PasskeyError::Unavailable)
}

fn response(create: bool, code: u32, mut values: Values) -> Result<String, PasskeyError> {
    match code {
        0 => {}
        1 => return Err(PasskeyError::Cancelled),
        _ => return Err(PasskeyError::Unavailable),
    }
    let kind = values.remove("type").and_then(|v| String::try_from(v).ok());
    if kind.as_deref() != Some("publicKey") {
        return Err(PasskeyError::Unavailable);
    }
    let field = if create {
        "registration_response_json"
    } else {
        "authentication_response_json"
    };
    let json = values
        .remove(field)
        .and_then(|v| String::try_from(v).ok())
        .filter(|v| v.len() <= 131_072)
        .ok_or(PasskeyError::Unavailable)?;
    let value: serde_json::Value =
        serde_json::from_str(&json).map_err(|_| PasskeyError::Unavailable)?;
    if value.get("type").and_then(|v| v.as_str()) != Some("public-key")
        || value.get("rawId").and_then(|v| v.as_str()).is_none()
    {
        return Err(PasskeyError::Unavailable);
    }
    Ok(json)
}

pub(crate) async fn available() -> bool {
    tokio::time::timeout(Duration::from_secs(2), async {
        let connection = Connection::session().await.ok()?;
        let portal = Proxy::new(&connection, BUS, PATH, CREDENTIAL).await.ok()?;
        portal.get_property::<u32>("version").await.ok()
    })
    .await
    .ok()
    .flatten()
    .is_some_and(|version| version >= 1)
}

pub(crate) async fn run(create: bool, request: String) -> Result<String, PasskeyError> {
    ACTIVE
        .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
        .map_err(|_| PasskeyError::Unavailable)?;
    let ceremony = Arc::new(Ceremony);
    tokio::time::timeout(Duration::from_secs(120), async {
        let connection = Connection::session()
            .await
            .map_err(|_| PasskeyError::Unavailable)?;
        let token = format!("shielded_{}", uuid::Uuid::new_v4().simple());
        let sender = connection.unique_name().ok_or(PasskeyError::Unavailable)?;
        let path = request_path(sender.as_str(), &token)?;
        let proxy = Proxy::new_owned(connection.clone(), BUS, path.clone(), REQUEST)
            .await
            .map_err(|_| PasskeyError::Unavailable)?;
        // Subscribe before invoking: a provider may answer before the method reply arrives.
        let mut replies = proxy
            .receive_signal("Response")
            .await
            .map_err(|_| PasskeyError::Unavailable)?;
        let mut pending = PendingRequest {
            proxy: Some(proxy),
            ceremony: ceremony.clone(),
        };
        let portal = Proxy::new(&connection, BUS, PATH, CREDENTIAL)
            .await
            .map_err(|_| PasskeyError::Unavailable)?;
        let arguments = options(create, request, token);
        let returned: OwnedObjectPath = if create {
            portal
                .call("CreateCredential", &("", ORIGIN, "publicKey", arguments))
                .await
        } else {
            portal.call("GetCredential", &("", ORIGIN, arguments)).await
        }
        .map_err(|_| PasskeyError::Unavailable)?;
        if returned != path {
            pending.proxy = Some(
                Proxy::new_owned(connection.clone(), BUS, returned, REQUEST)
                    .await
                    .map_err(|_| PasskeyError::Unavailable)?,
            );
            return Err(PasskeyError::Unavailable);
        }
        let message = replies.next().await.ok_or(PasskeyError::Unavailable)?;
        pending.proxy = None;
        let (code, values): (u32, Values) = message
            .body()
            .deserialize()
            .map_err(|_| PasskeyError::Unavailable)?;
        response(create, code, values)
    })
    .await
    .map_err(|_| PasskeyError::Unavailable)?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn portal_options_preserve_the_raw_webauthn_prf_request() {
        let request = r#"{"extensions":{"prf":{"eval":{"first":"RGVmYXVsdA"}}}}"#;
        let mut registration = options(true, request.into(), "opaque_token".into());
        assert_eq!(
            String::try_from(registration.remove("public_key").unwrap()).unwrap(),
            request
        );
        let mut assertion = options(false, request.into(), "opaque_token".into());
        let mut key: Values = Values::try_from(assertion.remove("public_key").unwrap()).unwrap();
        assert_eq!(
            String::try_from(key.remove("request_json").unwrap()).unwrap(),
            request
        );
        assert!(!assertion.contains_key("top_origin"));
    }

    #[test]
    fn response_preserves_prf_bytes_and_maps_cancellation() {
        let json = r#"{"type":"public-key","rawId":"AQ","clientExtensionResults":{"prf":{"results":{"first":"private_output"}}}}"#;
        let values = HashMap::from([
            ("type".into(), text("publicKey".into())),
            ("authentication_response_json".into(), text(json.into())),
        ]);
        assert_eq!(response(false, 0, values).unwrap(), json);
        assert!(matches!(
            response(false, 1, HashMap::new()),
            Err(PasskeyError::Cancelled)
        ));
        assert!(matches!(
            response(false, 2, HashMap::new()),
            Err(PasskeyError::Unavailable)
        ));
    }

    #[test]
    fn wrong_response_kind_missing_field_and_malformed_json_fail_closed() {
        for (kind, field, json) in [
            ("password", "authentication_response_json", "{}"),
            ("publicKey", "registration_response_json", "{}"),
            (
                "publicKey",
                "authentication_response_json",
                "private_output",
            ),
            (
                "publicKey",
                "authentication_response_json",
                r#"{"rawId":"AQ"}"#,
            ),
        ] {
            let values = HashMap::from([
                ("type".into(), text(kind.into())),
                (field.into(), text(json.into())),
            ]);
            assert!(matches!(
                response(false, 0, values),
                Err(PasskeyError::Unavailable)
            ));
        }
    }

    #[test]
    fn response_subscription_path_uses_the_same_sender_and_token() {
        assert_eq!(
            request_path(":1.432", "shielded_unpredictable")
                .unwrap()
                .as_str(),
            "/org/freedesktop/portal/desktop/request/1_432/shielded_unpredictable"
        );
        assert!(request_path("invalid", "token").is_err());
        assert!(request_path(":1.432", "invalid/path").is_err());
    }
}
