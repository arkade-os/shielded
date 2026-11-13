mod direct;
mod policy;
mod routes;
mod session;
mod update;
mod wire;

pub use update::{UpdateDownload, UpdateProgress};

#[cfg(test)]
mod http_tests;

#[cfg(test)]
mod update_tests;

use serde::{Deserialize, Serialize};
use std::{path::PathBuf, sync::Arc};
use tauri::{State, WebviewWindow, ipc::Channel};

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum NativeMode {
    #[default]
    Tor,
    Direct,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeStatus {
    pub phase: String,
    pub generation: u64,
    pub mode: NativeMode,
    pub foreground: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warm_from_generation: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeRequest {
    pub generation: u64,
    pub request_id: String,
    pub scope: String,
    pub url: String,
    pub method: String,
    #[serde(default)]
    pub headers: Vec<(String, String)>,
    pub body_base64: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeHandle {
    pub id: String,
    pub generation: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeResponse {
    pub generation: u64,
    pub status: u16,
    pub status_text: String,
    pub headers: Vec<(String, String)>,
    pub body_base64: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeStreamEvent {
    pub id: String,
    pub generation: u64,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sequence: Option<u64>,
}

#[derive(Clone)]
pub struct PrivacyTransport {
    inner: Arc<session::Inner>,
}

impl PrivacyTransport {
    pub fn new(data_dir: PathBuf) -> Result<Self, String> {
        Ok(Self {
            inner: Arc::new(session::Inner::new(data_dir)),
        })
    }
    pub fn pause(&self) -> Result<NativeStatus, String> {
        self.inner.pause()
    }
    pub fn suspend(&self, native: bool) -> Result<NativeStatus, String> {
        self.inner.suspend(native)
    }
    pub fn resumed(&self) -> Result<NativeStatus, String> {
        self.inner.resumed()
    }
    pub fn status(&self) -> Result<NativeStatus, String> {
        self.inner.status()
    }
    pub fn prewarm(&self) -> Result<NativeStatus, String> {
        self.inner.prewarm()
    }
    pub async fn start(&self) -> Result<NativeStatus, String> {
        self.start_mode(NativeMode::Tor).await
    }
    pub async fn start_mode(&self, mode: NativeMode) -> Result<NativeStatus, String> {
        self.inner.start(mode).await
    }
    pub fn scope(&self, generation: u64, purpose: &str) -> Result<NativeHandle, String> {
        self.inner.scope(generation, purpose)
    }
    pub fn cancel(&self, generation: u64, id: &str) -> Result<(), String> {
        self.inner.cancel(generation, id)
    }
    pub fn close_scope(&self, generation: u64, id: &str) -> Result<(), String> {
        self.inner.close_scope(generation, id)
    }
    pub async fn http(&self, request: NativeRequest) -> Result<NativeResponse, String> {
        let checked = policy::check_request(&request, false)?;
        let lease = self.inner.register(&request, &checked, None)?;
        let response = wire::http(lease, checked, self.inner.tls.clone()).await?;
        self.inner.subscription_response(&request, &response)?;
        Ok(response)
    }
}

#[tauri::command]
pub fn native_status(
    window: WebviewWindow,
    state: State<'_, PrivacyTransport>,
) -> Result<NativeStatus, String> {
    crate::ensure_local(&window)?;
    state.status()
}

#[tauri::command]
pub async fn native_start(
    window: WebviewWindow,
    state: State<'_, PrivacyTransport>,
    mode: Option<NativeMode>,
) -> Result<NativeStatus, String> {
    crate::ensure_local(&window)?;
    state.start_mode(mode.unwrap_or_default()).await
}

#[tauri::command]
pub fn native_pause(
    window: WebviewWindow,
    state: State<'_, PrivacyTransport>,
    warm: Option<bool>,
) -> Result<NativeStatus, String> {
    crate::ensure_local(&window)?;
    if warm.unwrap_or(false) {
        state.suspend(false)
    } else {
        state.pause()
    }
}

#[tauri::command]
pub fn native_scope(
    window: WebviewWindow,
    state: State<'_, PrivacyTransport>,
    generation: u64,
    purpose: String,
) -> Result<NativeHandle, String> {
    crate::ensure_local(&window)?;
    state.scope(generation, &purpose)
}

#[tauri::command]
pub fn native_scope_close(
    window: WebviewWindow,
    state: State<'_, PrivacyTransport>,
    generation: u64,
    id: String,
) -> Result<(), String> {
    crate::ensure_local(&window)?;
    state.close_scope(generation, &id)
}

#[tauri::command]
pub async fn native_http(
    window: WebviewWindow,
    state: State<'_, PrivacyTransport>,
    request: NativeRequest,
) -> Result<NativeResponse, String> {
    crate::ensure_local(&window)?;
    state.http(request).await
}

#[tauri::command]
pub fn native_stream(
    window: WebviewWindow,
    state: State<'_, PrivacyTransport>,
    request: NativeRequest,
    channel: Channel<NativeStreamEvent>,
) -> Result<NativeHandle, String> {
    crate::ensure_local(&window)?;
    let checked = policy::check_request(&request, false)?;
    if checked.method != hyper::Method::GET {
        return Err("private event streams require GET".into());
    }
    let lease = state.inner.register(&request, &checked, None)?;
    let handle = NativeHandle {
        id: lease.id.clone(),
        generation: lease.generation,
    };
    tauri::async_runtime::spawn(wire::stream(
        lease,
        checked,
        state.inner.tls.clone(),
        channel,
    ));
    Ok(handle)
}

#[tauri::command]
pub fn native_socket(
    window: WebviewWindow,
    state: State<'_, PrivacyTransport>,
    request: NativeRequest,
    channel: Channel<NativeStreamEvent>,
) -> Result<NativeHandle, String> {
    crate::ensure_local(&window)?;
    let checked = policy::check_request(&request, true)?;
    let (sender, receiver) = tokio::sync::mpsc::channel(8);
    let lease = state.inner.register(&request, &checked, Some(sender))?;
    let handle = NativeHandle {
        id: lease.id.clone(),
        generation: lease.generation,
    };
    tauri::async_runtime::spawn(wire::socket(
        lease,
        checked,
        state.inner.tls.clone(),
        channel,
        receiver,
    ));
    Ok(handle)
}

#[tauri::command]
pub fn native_socket_send(
    window: WebviewWindow,
    state: State<'_, PrivacyTransport>,
    generation: u64,
    id: String,
    data: String,
) -> Result<(), String> {
    crate::ensure_local(&window)?;
    state.inner.socket_send(generation, &id, data)
}

#[tauri::command]
pub fn native_stream_ack(
    window: WebviewWindow,
    state: State<'_, PrivacyTransport>,
    generation: u64,
    id: String,
    sequence: u64,
) -> Result<(), String> {
    crate::ensure_local(&window)?;
    state.inner.stream_ack(generation, &id, sequence)
}

#[tauri::command]
pub fn native_cancel(
    window: WebviewWindow,
    state: State<'_, PrivacyTransport>,
    generation: u64,
    id: String,
) -> Result<(), String> {
    crate::ensure_local(&window)?;
    state.cancel(generation, &id)
}
