use super::{
    NativeHandle, NativeMode, NativeRequest, NativeResponse, NativeStatus, NativeStreamEvent,
    policy::CheckedRequest,
};
use arti_client::{BootstrapBehavior, DormantMode, TorClient, config::TorClientConfigBuilder};
use base64::{Engine, engine::general_purpose::STANDARD};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    path::PathBuf,
    pin::Pin,
    sync::{Arc, Mutex, MutexGuard, Weak},
    task::{Context, Poll},
    time::Duration,
};
use tauri::ipc::Channel;
use tokio::{
    io::{AsyncRead, AsyncWrite, ReadBuf},
    sync::{OwnedSemaphorePermit, Semaphore, mpsc},
};
use tokio_util::sync::CancellationToken;
use tor_rtcompat::PreferredRuntime;

pub(super) type Client = Arc<TorClient<PreferredRuntime>>;
const MAX_SCOPES: usize = 1024;
const MAX_OPERATIONS: usize = 64;
const MAX_CANCELLED: usize = 4096;
const DRAIN_TIMEOUT: Duration = Duration::from_secs(10);
const PURPOSES: &[&str] = &[
    "public",
    "pool-sync",
    "pool-operation",
    "indexer",
    "ark",
    "esplora",
    "swap",
    "lnurl",
    "assets",
    "discovery",
];

pub(super) struct Session {
    pub phase: &'static str,
    pub generation: u64,
    pub mode: NativeMode,
    pub error: Option<String>,
    pub client: Option<Client>,
    pub bootstrap_cancel: Option<CancellationToken>,
    pub scopes: HashMap<String, Scope>,
    operations: HashMap<String, Operation>,
    cancelled: HashSet<String>,
    completed: HashSet<String>,
    completion_order: VecDeque<String>,
    subscriptions: HashMap<String, String>,
    resources: Vec<CancellationToken>,
}

#[derive(Clone)]
enum ConnectionContext {
    Tor(Client),
    Direct,
}

impl ConnectionContext {
    fn tor(&self) -> Result<&Client, String> {
        match self {
            Self::Tor(client) => Ok(client),
            Self::Direct => Err("Tor is unavailable in direct mode".into()),
        }
    }
}

pub(super) struct Retirement(CancellationToken);
impl Drop for Retirement {
    fn drop(&mut self) {
        self.0.cancel();
    }
}

trait NativeIo: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> NativeIo for T {}

pub(super) struct NativeStream {
    io: Box<dyn NativeIo>,
    _retirement: Arc<Retirement>,
}

impl AsyncRead for NativeStream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.io).poll_read(context, buffer)
    }
}

impl AsyncWrite for NativeStream {
    fn poll_write(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        Pin::new(&mut self.io).poll_write(context, buffer)
    }
    fn poll_flush(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
    ) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.io).poll_flush(context)
    }
    fn poll_shutdown(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
    ) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.io).poll_shutdown(context)
    }
}

struct Operation {
    scope: String,
    cancel: CancellationToken,
    socket: Option<mpsc::Sender<String>>,
    delivery: Arc<Delivery>,
}

#[derive(Default)]
struct DeliveryState {
    next: u64,
    pending: Option<(u64, OwnedSemaphorePermit)>,
}

struct Delivery {
    slot: Arc<Semaphore>,
    state: Mutex<DeliveryState>,
}

impl Default for Delivery {
    fn default() -> Self {
        Self {
            slot: Arc::new(Semaphore::new(1)),
            state: Mutex::new(DeliveryState::default()),
        }
    }
}

pub(super) struct Scope {
    context: ConnectionContext,
    purpose: String,
    binding: Option<String>,
    subscription: Option<String>,
}

pub(super) struct Inner {
    pub data_dir: PathBuf,
    pub session: Mutex<Session>,
    pub tls: Arc<rustls::ClientConfig>,
}

pub(super) struct Lease {
    pub inner: Weak<Inner>,
    pub id: String,
    pub scope: String,
    pub generation: u64,
    context: ConnectionContext,
    pub cancel: CancellationToken,
    delivery: Arc<Delivery>,
    retirement: Arc<Retirement>,
}

impl Inner {
    pub fn new(data_dir: PathBuf) -> Self {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let roots =
            rustls::RootCertStore::from_iter(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        let mut tls = rustls::ClientConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .expect("default TLS protocol versions")
        .with_root_certificates(roots)
        .with_no_client_auth();
        tls.resumption = rustls::client::Resumption::disabled();
        Self {
            data_dir,
            tls: Arc::new(tls),
            session: Mutex::new(Session {
                phase: "locked",
                generation: 0,
                mode: NativeMode::Tor,
                error: None,
                client: None,
                bootstrap_cancel: None,
                scopes: HashMap::new(),
                operations: HashMap::new(),
                cancelled: HashSet::new(),
                completed: HashSet::new(),
                completion_order: VecDeque::new(),
                subscriptions: HashMap::new(),
                resources: Vec::new(),
            }),
        }
    }

    pub fn lock(&self) -> Result<MutexGuard<'_, Session>, String> {
        self.session
            .lock()
            .map_err(|_| "private transport state unavailable".into())
    }

    pub fn status(&self) -> Result<NativeStatus, String> {
        Ok(self.lock()?.status())
    }

    pub fn pause(&self) -> Result<NativeStatus, String> {
        let mut session = self.lock()?;
        session.invalidate()?;
        session.phase = "paused";
        session.error = None;
        if let Some(client) = &session.client {
            client.set_dormant(DormantMode::Soft);
        }
        Ok(session.status())
    }

    pub async fn start(self: &Arc<Self>, mode: NativeMode) -> Result<NativeStatus, String> {
        self.start_with_drain_timeout(mode, DRAIN_TIMEOUT).await
    }

    async fn start_with_drain_timeout(
        self: &Arc<Self>,
        mode: NativeMode,
        drain_timeout: Duration,
    ) -> Result<NativeStatus, String> {
        let (generation, cancel, existing, retiring, _retirement) = {
            let mut session = self.lock()?;
            if session.mode == mode && matches!(session.phase, "ready" | "bootstrapping") {
                return Ok(session.status());
            }
            session.invalidate()?;
            if session.mode != mode {
                if let Some(client) = session.client.take() {
                    client.set_dormant(DormantMode::Soft);
                    let stopped = client.wait_for_stop();
                    let retirement = session.resource();
                    tokio::spawn(async move {
                        stopped.await;
                        drop(retirement);
                    });
                }
            }
            session.mode = mode;
            session.phase = "bootstrapping";
            session.error = None;
            let cancel = CancellationToken::new();
            session.bootstrap_cancel = Some(cancel.clone());
            session
                .resources
                .retain(|resource| !resource.is_cancelled());
            let retiring = session.resources.clone();
            let retirement = session.resource();
            (
                session.generation,
                cancel,
                session.client.clone(),
                retiring,
                retirement,
            )
        };
        let result = tokio::select! {
            biased;
            _ = cancel.cancelled() => Err("private session paused".into()),
            result = async {
                tokio::time::timeout(drain_timeout, async {
                    for resource in retiring { resource.cancelled().await; }
                }).await.map_err(|_| "previous network requests are still closing; retry to reconnect".to_owned())?;
                if mode == NativeMode::Tor {
                    self.bootstrap(generation, &cancel, existing).await
                } else {
                    Ok(())
                }
            } => result,
        };
        let mut session = self.lock()?;
        if generation != session.generation || session.phase != "bootstrapping" {
            return Err("private session changed".into());
        }
        session.bootstrap_cancel = None;
        match result {
            Ok(()) => session.phase = "ready",
            Err(error) => {
                session.phase = "error";
                session.error = Some(error);
                if let Some(client) = &session.client {
                    client.set_dormant(DormantMode::Soft);
                }
            }
        }
        Ok(session.status())
    }

    async fn bootstrap(
        &self,
        generation: u64,
        cancel: &CancellationToken,
        existing: Option<Client>,
    ) -> Result<(), String> {
        let client = match existing {
            Some(client) => client,
            None => {
                let config = TorClientConfigBuilder::from_directories(
                    self.data_dir.join("state"),
                    self.data_dir.join("cache"),
                )
                .build()
                .map_err(|_| "Tor storage configuration failed")?;
                TorClient::builder()
                    .config(config)
                    .bootstrap_behavior(BootstrapBehavior::Manual)
                    .create_unbootstrapped()
                    .map_err(|_| "Tor initialization failed")?
            }
        };
        {
            let mut session = self.lock()?;
            if generation != session.generation || cancel.is_cancelled() {
                client.set_dormant(DormantMode::Soft);
                return Err("private session changed".into());
            }
            session.client = Some(client.clone());
            client.set_dormant(DormantMode::Normal);
        }
        tokio::select! {
            biased;
            _ = cancel.cancelled() => Err("private session paused".into()),
            result = tokio::time::timeout(Duration::from_secs(180), client.bootstrap()) => {
                match result {
                    Ok(Ok(())) => Ok(()),
                    Ok(Err(_)) => Err("Tor bootstrap failed; retry to reconnect".into()),
                    Err(_) => Err("Tor bootstrap timed out; retry to reconnect".into()),
                }
            }
        }
    }

    pub fn scope(&self, generation: u64, purpose: &str) -> Result<NativeHandle, String> {
        if !PURPOSES.contains(&purpose) {
            return Err("unknown private scope purpose".into());
        }
        let mut session = self.lock()?;
        session.check(generation)?;
        if session.scopes.len() >= MAX_SCOPES {
            return Err("too many private scopes".into());
        }
        let context = match session.mode {
            NativeMode::Tor => ConnectionContext::Tor(
                session
                    .client
                    .as_ref()
                    .ok_or("Tor client unavailable")?
                    .isolated_client(),
            ),
            NativeMode::Direct => ConnectionContext::Direct,
        };
        let id = uuid::Uuid::new_v4().to_string();
        session.scopes.insert(
            id.clone(),
            Scope {
                context,
                purpose: purpose.into(),
                binding: None,
                subscription: None,
            },
        );
        Ok(NativeHandle { id, generation })
    }

    pub fn close_scope(&self, generation: u64, id: &str) -> Result<(), String> {
        let mut session = self.lock()?;
        session.check(generation)?;
        session.scopes.remove(id);
        for operation in session.operations.values().filter(|op| op.scope == id) {
            operation.cancel.cancel();
        }
        Ok(())
    }

    pub fn register(
        self: &Arc<Self>,
        request: &NativeRequest,
        checked: &CheckedRequest,
        socket: Option<mpsc::Sender<String>>,
    ) -> Result<Lease, String> {
        if request.request_id.is_empty()
            || request.request_id.len() > 128
            || !request
                .request_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_:".contains(&b))
        {
            return Err("invalid private request identifier".into());
        }
        let mut session = self.lock()?;
        session.check(request.generation)?;
        session
            .resources
            .retain(|resource| !resource.is_cancelled());
        if session.cancelled.remove(&request.request_id) {
            session.complete(&request.request_id);
            return Err("private request cancelled".into());
        }
        if session.completed.contains(&request.request_id) {
            return Err("private request identifier already completed".into());
        }
        if session.operations.len() >= MAX_OPERATIONS
            || session.resources.len() >= MAX_OPERATIONS
            || session.operations.contains_key(&request.request_id)
        {
            return Err("private request limit or duplicate identifier".into());
        }
        let scope = session
            .scopes
            .get_mut(&request.scope)
            .ok_or("unknown private scope")?;
        let binding =
            super::routes::binding(&scope.purpose, checked, scope.subscription.as_deref())?;
        if binding == "subscription" {
            if scope.binding.is_none() {
                return Err("private subscription is not bound to an item".into());
            }
        } else {
            if scope
                .binding
                .as_ref()
                .is_some_and(|existing| existing != &binding)
            {
                return Err("private scope cannot be reused for another item".into());
            }
            scope.binding = Some(binding);
        }
        let context = scope.context.clone();
        let cancel = CancellationToken::new();
        let delivery = Arc::new(Delivery::default());
        let retirement = session.resource();
        session.operations.insert(
            request.request_id.clone(),
            Operation {
                scope: request.scope.clone(),
                cancel: cancel.clone(),
                socket,
                delivery: delivery.clone(),
            },
        );
        Ok(Lease {
            inner: Arc::downgrade(self),
            id: request.request_id.clone(),
            scope: request.scope.clone(),
            generation: request.generation,
            context,
            cancel,
            delivery,
            retirement,
        })
    }

    pub fn cancel(&self, generation: u64, id: &str) -> Result<(), String> {
        if id.is_empty() || id.len() > 128 {
            return Err("invalid private request identifier".into());
        }
        let mut session = self.lock()?;
        session.check(generation)?;
        if let Some(operation) = session.operations.get(id) {
            operation.cancel.cancel();
            return Ok(());
        }
        if session.completed.contains(id) {
            return Ok(());
        }
        if session.cancelled.len() >= MAX_CANCELLED && !session.cancelled.contains(id) {
            session.invalidate()?;
            session.phase = "error";
            session.error = Some("private cancellation limit; reconnect required".into());
            if let Some(client) = &session.client {
                client.set_dormant(DormantMode::Soft);
            }
            return Err("private cancellation limit; reconnect required".into());
        }
        session.cancelled.insert(id.to_owned());
        Ok(())
    }

    pub fn subscription_response(
        &self,
        request: &NativeRequest,
        response: &NativeResponse,
    ) -> Result<(), String> {
        if response.status < 200 || response.status >= 300 {
            return Ok(());
        }
        let url =
            url::Url::parse(&request.url).map_err(|_| "invalid subscription response route")?;
        if request.method != "POST" || url.host_str() != Some("mutinynet.arkade.sh") {
            return Ok(());
        }
        if ![
            "/v1/indexer/script/subscribe",
            "/v1/indexer/script/unsubscribe",
        ]
        .contains(&url.path())
        {
            return Ok(());
        }
        let mut session = self.lock()?;
        session.check(request.generation)?;
        if url.path().ends_with("/unsubscribe") {
            let bytes = STANDARD
                .decode(
                    request
                        .body_base64
                        .as_deref()
                        .ok_or("missing private unsubscribe body")?,
                )
                .map_err(|_| "invalid private unsubscribe encoding")?;
            let value: serde_json::Value =
                serde_json::from_slice(&bytes).map_err(|_| "invalid private unsubscribe body")?;
            let id = value
                .get("subscriptionId")
                .and_then(serde_json::Value::as_str)
                .ok_or("missing private subscription identifier")?;
            let scope = session
                .scopes
                .get_mut(&request.scope)
                .ok_or("private subscription scope closed")?;
            if scope.subscription.as_deref() == Some(id) {
                scope.subscription = None;
            }
            return Ok(());
        }
        if response.body_base64.len() > 64 * 1024 {
            return Err("private subscription response too large".into());
        }
        let bytes = STANDARD
            .decode(&response.body_base64)
            .map_err(|_| "invalid private subscription response encoding")?;
        let value: serde_json::Value =
            serde_json::from_slice(&bytes).map_err(|_| "invalid private subscription response")?;
        let id = value
            .get("subscriptionId")
            .and_then(|value| value.as_str())
            .filter(|id| {
                !id.is_empty()
                    && id.len() <= 256
                    && id
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
            })
            .ok_or("invalid private subscription identifier")?;
        let binding = session
            .scopes
            .get(&request.scope)
            .ok_or("private subscription scope closed")?
            .binding
            .clone()
            .ok_or("private subscription item missing")?;
        if session
            .subscriptions
            .get(id)
            .is_some_and(|known| known != &binding)
        {
            return Err("indexer reused a subscription identifier for another private item".into());
        }
        if session.subscriptions.len() >= MAX_CANCELLED && !session.subscriptions.contains_key(id) {
            return Err("private subscription history limit; reconnect required".into());
        }
        session.subscriptions.insert(id.into(), binding);
        session
            .scopes
            .get_mut(&request.scope)
            .ok_or("private subscription scope closed")?
            .subscription = Some(id.into());
        Ok(())
    }

    pub fn socket_send(&self, generation: u64, id: &str, data: String) -> Result<(), String> {
        if data.len() > super::policy::MAX_CHUNK {
            return Err("private socket message too large".into());
        }
        let session = self.lock()?;
        session.check(generation)?;
        let operation = session.operations.get(id).ok_or("private socket closed")?;
        if operation.cancel.is_cancelled() {
            return Err("private socket cancelled".into());
        }
        operation
            .socket
            .as_ref()
            .ok_or("request is not a socket")?
            .try_send(data)
            .map_err(|_| "private socket send queue full or closed".into())
    }

    pub fn stream_ack(&self, generation: u64, id: &str, sequence: u64) -> Result<(), String> {
        let session = self.lock()?;
        session.check(generation)?;
        let Some(operation) = session.operations.get(id) else {
            return if session.completed.contains(id) {
                Ok(())
            } else {
                Err("private stream closed".into())
            };
        };
        let mut delivery = operation
            .delivery
            .state
            .lock()
            .map_err(|_| "private delivery unavailable")?;
        if delivery
            .pending
            .as_ref()
            .is_some_and(|(pending, _)| *pending == sequence)
        {
            delivery.pending.take();
            Ok(())
        } else {
            Err("private stream acknowledgement mismatch".into())
        }
    }
}

impl Session {
    fn complete(&mut self, id: &str) {
        self.cancelled.remove(id);
        if self.completed.insert(id.into()) {
            self.completion_order.push_back(id.into());
        }
        while self.completion_order.len() > MAX_CANCELLED {
            if let Some(id) = self.completion_order.pop_front() {
                self.completed.remove(&id);
            }
        }
    }
    fn status(&self) -> NativeStatus {
        NativeStatus {
            phase: self.phase.into(),
            generation: self.generation,
            mode: self.mode,
            error: self.error.clone(),
            progress: if self.mode == NativeMode::Tor && self.phase == "bootstrapping" {
                self.client
                    .as_ref()
                    .map(|client| format!("{:.0}%", client.bootstrap_status().as_frac() * 100.0))
            } else {
                None
            },
        }
    }

    fn check(&self, generation: u64) -> Result<(), String> {
        if self.generation != generation || self.phase != "ready" {
            return Err("private transport is not ready for this session".into());
        }
        Ok(())
    }

    fn invalidate(&mut self) -> Result<(), String> {
        self.generation = self
            .generation
            .checked_add(1)
            .ok_or("private session generation exhausted")?;
        if let Some(cancel) = self.bootstrap_cancel.take() {
            cancel.cancel();
        }
        for (_, operation) in self.operations.drain() {
            operation.cancel.cancel();
        }
        self.scopes.clear();
        self.cancelled.clear();
        self.completed.clear();
        self.completion_order.clear();
        self.subscriptions.clear();
        Ok(())
    }

    fn resource(&mut self) -> Arc<Retirement> {
        let completion = CancellationToken::new();
        self.resources.push(completion.clone());
        Arc::new(Retirement(completion))
    }
}

impl Lease {
    pub async fn connect(&self, host: &str) -> Result<NativeStream, String> {
        self.check()?;
        let io: Box<dyn NativeIo> = match &self.context {
            ConnectionContext::Tor(_) => Box::new(
                self.connect_with_recovery(
                    |client| async move { client.connect((host, 443)).await },
                )
                .await?,
            ),
            ConnectionContext::Direct => {
                Box::new(super::direct::connect(host, &self.cancel, self.retirement.clone()).await?)
            }
        };
        self.check()?;
        Ok(NativeStream {
            io,
            _retirement: self.retirement.clone(),
        })
    }

    pub async fn connect_with_recovery<T, E, F, Fut>(&self, mut connect: F) -> Result<T, String>
    where
        F: FnMut(Client) -> Fut,
        Fut: std::future::Future<Output = Result<T, E>>,
    {
        self.check()?;
        let connected = match connect(self.context.tor()?.clone()).await {
            Ok(connected) => connected,
            Err(_) => {
                let client = self.reconnect_client()?;
                self.check()?;
                connect(client).await.map_err(|_| "Tor connection failed")?
            }
        };
        self.check()?;
        Ok(connected)
    }

    fn reconnect_client(&self) -> Result<Client, String> {
        let inner = self.inner.upgrade().ok_or("private transport closed")?;
        let mut session = inner.lock()?;
        session.check(self.generation)?;
        if self.cancel.is_cancelled()
            || !session
                .operations
                .get(&self.id)
                .is_some_and(|operation| operation.scope == self.scope)
        {
            return Err("private request cancelled".into());
        }
        let scope = session
            .scopes
            .get_mut(&self.scope)
            .ok_or("private scope closed")?;
        if Arc::ptr_eq(scope.context.tor()?, self.context.tor()?) {
            scope.context = ConnectionContext::Tor(scope.context.tor()?.isolated_client());
        }
        Ok(scope.context.tor()?.clone())
    }

    pub async fn emit_data(
        &self,
        channel: &Channel<NativeStreamEvent>,
        data: String,
    ) -> Result<(), String> {
        if data.len() > super::policy::MAX_CHUNK.div_ceil(3) * 4 {
            return Err("private delivery chunk too large".into());
        }
        let permit = tokio::select! {
            biased;
            _ = self.cancel.cancelled() => return Err("private request cancelled".into()),
            slot = self.delivery.slot.clone().acquire_owned() => slot.map_err(|_| "private delivery closed")?,
        };
        self.check()?;
        let sequence = {
            let mut state = self
                .delivery
                .state
                .lock()
                .map_err(|_| "private delivery unavailable")?;
            state.next = state
                .next
                .checked_add(1)
                .ok_or("private stream sequence exhausted")?;
            let sequence = state.next;
            state.pending = Some((sequence, permit));
            sequence
        };
        self.emit_event(channel, "data", Some(data), None, None, Some(sequence))
    }
    pub fn check(&self) -> Result<(), String> {
        let inner = self.inner.upgrade().ok_or("private transport closed")?;
        let session = inner.lock()?;
        session.check(self.generation)?;
        if self.cancel.is_cancelled() || !session.scopes.contains_key(&self.scope) {
            return Err("private request cancelled".into());
        }
        Ok(())
    }

    pub fn emit(
        &self,
        channel: &Channel<NativeStreamEvent>,
        kind: &str,
        data: Option<String>,
        error: Option<String>,
        status: Option<u16>,
    ) -> Result<(), String> {
        self.emit_event(channel, kind, data, error, status, None)
    }

    fn emit_event(
        &self,
        channel: &Channel<NativeStreamEvent>,
        kind: &str,
        data: Option<String>,
        error: Option<String>,
        status: Option<u16>,
        sequence: Option<u64>,
    ) -> Result<(), String> {
        let inner = self.inner.upgrade().ok_or("private transport closed")?;
        let session = inner.lock()?;
        session.check(self.generation)?;
        if self.cancel.is_cancelled() || !session.scopes.contains_key(&self.scope) {
            return Err("private request cancelled".into());
        }
        channel
            .send(NativeStreamEvent {
                id: self.id.clone(),
                generation: self.generation,
                kind: kind.into(),
                data,
                error,
                status,
                sequence,
            })
            .map_err(|_| "private channel closed".into())
    }
}

impl Drop for Lease {
    fn drop(&mut self) {
        self.cancel.cancel();
        if let Some(inner) = self.inner.upgrade() {
            if let Ok(mut session) = inner.session.lock() {
                if session.generation == self.generation {
                    session.operations.remove(&self.id);
                    session.complete(&self.id);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn request(generation: u64, scope: String, id: &str) -> NativeRequest {
        NativeRequest {
            generation,
            scope,
            request_id: id.into(),
            url: "https://mutinynet.arkade.sh/v1/indexer/vtxos?scripts=aa".into(),
            method: "GET".into(),
            headers: Vec::new(),
            body_base64: None,
        }
    }

    fn register(inner: &Arc<Inner>, request: &NativeRequest) -> Result<Lease, String> {
        let checked = super::super::policy::check_request(request, false)?;
        inner.register(request, &checked, None)
    }

    fn ready() -> Arc<Inner> {
        let inner = Arc::new(Inner::new(
            std::env::temp_dir().join(format!("shielded-native-test-{}", uuid::Uuid::new_v4())),
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

    async fn wait_for_mode(inner: &Inner, mode: NativeMode) {
        tokio::time::timeout(Duration::from_secs(2), async {
            while inner.status().unwrap().mode != mode {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn direct_start_is_explicit_idempotent_and_never_creates_a_tor_client() {
        let inner = Arc::new(Inner::new(
            std::env::temp_dir().join("shielded-direct-unused"),
        ));
        assert_eq!(inner.status().unwrap().mode, NativeMode::Tor);
        let started = inner.start(NativeMode::Direct).await.unwrap();
        assert_eq!(started.phase, "ready");
        assert_eq!(started.mode, NativeMode::Direct);
        assert!(inner.lock().unwrap().client.is_none());
        assert_eq!(
            inner.start(NativeMode::Direct).await.unwrap().generation,
            started.generation
        );
        let scope = inner.scope(started.generation, "indexer").unwrap();
        let lease = register(
            &inner,
            &request(started.generation, scope.id.clone(), "direct"),
        )
        .unwrap();
        let mut attempts = 0;
        assert!(
            lease
                .connect_with_recovery(|_| {
                    attempts += 1;
                    std::future::ready(Ok::<_, ()>(()))
                })
                .await
                .is_err()
        );
        assert_eq!(attempts, 0);
        let mut other = request(started.generation, scope.id, "another-item");
        other.url = "https://mutinynet.arkade.sh/v1/indexer/vtxos?scripts=bb".into();
        assert!(register(&inner, &other).is_err());
        assert!(serde_json::from_str::<NativeMode>("\"auto\"").is_err());
        assert_eq!(
            serde_json::to_string(&NativeMode::Direct).unwrap(),
            "\"direct\""
        );
    }

    #[tokio::test]
    async fn tor_initialization_failure_retains_tor_mode_without_direct_fallback() {
        let inner = Arc::new(Inner::new(PathBuf::from("\0")));
        let status = inner.start(NativeMode::Tor).await.unwrap();
        assert_eq!(status.phase, "error");
        assert_eq!(status.mode, NativeMode::Tor);
        assert!(status.error.is_some());
        assert!(inner.lock().unwrap().client.is_none());
        assert!(inner.scope(status.generation, "public").is_err());
    }

    #[tokio::test]
    async fn mode_switch_waits_for_old_lease_and_detached_resource_completion() {
        let inner = ready();
        let scope = inner.scope(1, "indexer").unwrap();
        let lease = register(&inner, &request(1, scope.id, "old-transport")).unwrap();
        let detached = lease.retirement.clone();
        let started = tokio::spawn({
            let inner = inner.clone();
            async move { inner.start(NativeMode::Direct).await }
        });
        wait_for_mode(&inner, NativeMode::Direct).await;
        assert!(lease.cancel.is_cancelled());
        assert!(lease.check().is_err());
        assert_eq!(inner.status().unwrap().phase, "bootstrapping");
        assert!(!started.is_finished());
        drop(lease);
        tokio::task::yield_now().await;
        assert!(!started.is_finished());
        drop(detached);
        let status = tokio::time::timeout(Duration::from_secs(2), started)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(status.phase, "ready");
        assert_eq!(status.mode, NativeMode::Direct);
        assert!(status.generation > 1);
        assert!(inner.lock().unwrap().client.is_none());
        assert!(inner.scope(1, "indexer").is_err());
    }

    #[tokio::test]
    async fn unfinished_retirement_leaves_the_selected_mode_in_error_until_retry() {
        let inner = ready();
        let scope = inner.scope(1, "indexer").unwrap();
        let lease = register(&inner, &request(1, scope.id, "slow-retirement")).unwrap();
        let failed = inner
            .start_with_drain_timeout(NativeMode::Direct, Duration::from_millis(1))
            .await
            .unwrap();
        assert_eq!(failed.phase, "error");
        assert_eq!(failed.mode, NativeMode::Direct);
        assert!(failed.error.unwrap().contains("still closing"));
        assert!(inner.scope(failed.generation, "public").is_err());
        drop(lease);
        let retried = inner.start(NativeMode::Direct).await.unwrap();
        assert_eq!(retried.phase, "ready");
        assert_eq!(retried.mode, NativeMode::Direct);
    }

    #[tokio::test]
    async fn pause_during_mode_retirement_cannot_publish_the_delayed_ready_result() {
        let inner = ready();
        let scope = inner.scope(1, "indexer").unwrap();
        let lease = register(&inner, &request(1, scope.id, "pause-during-switch")).unwrap();
        let started = tokio::spawn({
            let inner = inner.clone();
            async move { inner.start(NativeMode::Direct).await }
        });
        wait_for_mode(&inner, NativeMode::Direct).await;
        let paused = inner.pause().unwrap();
        drop(lease);
        assert!(
            tokio::time::timeout(Duration::from_secs(2), started)
                .await
                .unwrap()
                .unwrap()
                .is_err()
        );
        let status = inner.status().unwrap();
        assert_eq!(status.phase, "paused");
        assert_eq!(status.mode, NativeMode::Direct);
        assert_eq!(status.generation, paused.generation);
    }

    #[tokio::test]
    async fn cancelled_bootstrap_must_finish_before_direct_becomes_ready() {
        let inner = ready();
        let bootstrap_cancel = CancellationToken::new();
        let bootstrap = {
            let mut session = inner.lock().unwrap();
            session.phase = "bootstrapping";
            session.bootstrap_cancel = Some(bootstrap_cancel.clone());
            session.resource()
        };
        let started = tokio::spawn({
            let inner = inner.clone();
            async move { inner.start(NativeMode::Direct).await }
        });
        wait_for_mode(&inner, NativeMode::Direct).await;
        assert!(bootstrap_cancel.is_cancelled());
        assert!(!started.is_finished());
        drop(bootstrap);
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(2), started)
                .await
                .unwrap()
                .unwrap()
                .unwrap()
                .phase,
            "ready"
        );
    }

    #[tokio::test]
    async fn tor_client_shutdown_blocks_direct_even_without_an_active_operation() {
        let inner = ready();
        let held = inner.lock().unwrap().client.clone().unwrap();
        let started = tokio::spawn({
            let inner = inner.clone();
            async move { inner.start(NativeMode::Direct).await }
        });
        wait_for_mode(&inner, NativeMode::Direct).await;
        assert!(!started.is_finished());
        assert!(inner.lock().unwrap().client.is_none());
        drop(held);
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(2), started)
                .await
                .unwrap()
                .unwrap()
                .unwrap()
                .phase,
            "ready"
        );
    }

    #[tokio::test]
    async fn mode_switch_drains_the_http_driver_after_its_lease_has_finished() {
        use bytes::Bytes;
        use http_body_util::Full;
        use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

        let inner = ready();
        let scope = inner.scope(1, "indexer").unwrap();
        let lease = register(&inner, &request(1, scope.id, "old-http-driver")).unwrap();
        let (client, server) = tokio::io::duplex(4096);
        let stream = NativeStream {
            io: Box::new(client),
            _retirement: lease.retirement.clone(),
        };
        let peer = tokio::spawn(async move {
            let mut server = BufReader::new(server);
            let mut request = Vec::new();
            while !request.ends_with(b"\r\n\r\n") {
                server.read_until(b'\n', &mut request).await.unwrap();
            }
            server
                .get_mut()
                .write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1\r\na\r\n")
                .await
                .unwrap();
            let mut byte = [0];
            server.read(&mut byte).await.unwrap()
        });
        let request = hyper::Request::builder()
            .uri("/status")
            .body(Full::new(Bytes::new()))
            .unwrap();
        let (response, driver) = super::super::wire::send_http(stream, request)
            .await
            .unwrap();
        drop(lease);
        assert!(inner.lock().unwrap().operations.is_empty());
        let started = tokio::spawn({
            let inner = inner.clone();
            async move { inner.start(NativeMode::Direct).await }
        });
        wait_for_mode(&inner, NativeMode::Direct).await;
        assert!(!started.is_finished());
        drop(response);
        drop(driver);
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(2), started)
                .await
                .unwrap()
                .unwrap()
                .unwrap()
                .phase,
            "ready"
        );
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(2), peer)
                .await
                .unwrap()
                .unwrap(),
            0
        );
    }

    #[tokio::test]
    async fn unrelated_scopes_get_separate_handles_and_unknown_scopes_fail() {
        let inner = ready();
        let first = inner.scope(1, "indexer").unwrap();
        let second = inner.scope(1, "indexer").unwrap();
        assert_ne!(first.id, second.id);
        let session = inner.lock().unwrap();
        assert!(!Arc::ptr_eq(
            session
                .scopes
                .get(&first.id)
                .unwrap()
                .context
                .tor()
                .unwrap(),
            session
                .scopes
                .get(&second.id)
                .unwrap()
                .context
                .tor()
                .unwrap()
        ));
        drop(session);
        assert!(register(&inner, &request(1, "forged".into(), "unknown")).is_err());
        assert!(inner.scope(1, "anything").is_err());
    }

    #[tokio::test]
    async fn cancellation_before_open_prevents_registration() {
        let inner = ready();
        let scope = inner.scope(1, "indexer").unwrap();
        inner.cancel(1, "early").unwrap();
        assert!(register(&inner, &request(1, scope.id.clone(), "early")).is_err());
        assert!(inner.lock().unwrap().operations.is_empty());
        assert!(inner.lock().unwrap().cancelled.is_empty());
        assert!(register(&inner, &request(1, scope.id, "early")).is_err());
    }

    #[tokio::test]
    async fn pause_cancels_inflight_work_and_fences_queued_delivery() {
        let inner = ready();
        let scope = inner.scope(1, "indexer").unwrap();
        let lease = register(&inner, &request(1, scope.id, "pending")).unwrap();
        let messages = Arc::new(AtomicUsize::new(0));
        let count = messages.clone();
        let channel = Channel::new(move |_| {
            count.fetch_add(1, Ordering::SeqCst);
            Ok(())
        });
        lease.emit(&channel, "open", None, None, Some(200)).unwrap();
        let paused = inner.pause().unwrap();
        assert_eq!(paused.phase, "paused");
        assert_eq!(paused.generation, 2);
        assert!(lease.cancel.is_cancelled());
        assert!(
            lease
                .emit(&channel, "data", Some("late".into()), None, None)
                .is_err()
        );
        assert_eq!(messages.load(Ordering::SeqCst), 1);
        assert!(inner.scope(1, "ark").is_err());
        assert!(inner.lock().unwrap().scopes.is_empty());
    }

    #[tokio::test]
    async fn scope_close_cancels_only_its_operations() {
        let inner = ready();
        let first = inner.scope(1, "indexer").unwrap();
        let second = inner.scope(1, "indexer").unwrap();
        let first_lease = register(&inner, &request(1, first.id.clone(), "one")).unwrap();
        let second_lease = register(&inner, &request(1, second.id, "two")).unwrap();
        inner.close_scope(1, &first.id).unwrap();
        assert!(first_lease.cancel.is_cancelled());
        assert!(first_lease.check().is_err());
        assert!(!second_lease.cancel.is_cancelled());
        second_lease.check().unwrap();
    }

    #[tokio::test]
    async fn cancellation_overflow_invalidates_instead_of_forgetting() {
        let inner = ready();
        {
            let mut session = inner.lock().unwrap();
            session.cancelled = (0..MAX_CANCELLED).map(|n| format!("cancel-{n}")).collect();
        }
        assert!(inner.cancel(1, "overtaking-open").is_err());
        let session = inner.lock().unwrap();
        assert_eq!(session.phase, "error");
        assert_eq!(session.generation, 2);
    }

    #[tokio::test]
    async fn completed_cancellations_retire_without_cancelling_unrelated_work() {
        let inner = ready();
        let scope = inner.scope(1, "indexer").unwrap();
        let unrelated = register(&inner, &request(1, scope.id.clone(), "still-running")).unwrap();
        for n in 0..MAX_CANCELLED + 2 {
            let id = format!("cancel-{n}");
            let lease = register(&inner, &request(1, scope.id.clone(), &id)).unwrap();
            inner.cancel(1, &id).unwrap();
            assert!(lease.check().is_err());
            drop(lease);
            inner.cancel(1, &id).unwrap();
        }
        unrelated.check().unwrap();
        let session = inner.lock().unwrap();
        assert_eq!(session.phase, "ready");
        assert!(session.cancelled.is_empty());
        assert_eq!(session.completed.len(), MAX_CANCELLED);
    }

    #[tokio::test]
    async fn unsubscribe_completion_preserves_a_newer_subscription() {
        let inner = ready();
        let scope = inner.scope(1, "indexer").unwrap();
        inner
            .lock()
            .unwrap()
            .scopes
            .get_mut(&scope.id)
            .unwrap()
            .subscription = Some("newer".into());
        let mut unsubscribe = request(1, scope.id.clone(), "unsubscribe-old");
        unsubscribe.method = "POST".into();
        unsubscribe.url = "https://mutinynet.arkade.sh/v1/indexer/script/unsubscribe".into();
        unsubscribe.body_base64 = Some(STANDARD.encode(r#"{"subscriptionId":"older"}"#));
        let response = NativeResponse {
            generation: 1,
            status: 200,
            headers: vec![],
            body_base64: String::new(),
        };
        inner
            .subscription_response(&unsubscribe, &response)
            .unwrap();
        assert_eq!(
            inner
                .lock()
                .unwrap()
                .scopes
                .get(&scope.id)
                .unwrap()
                .subscription
                .as_deref(),
            Some("newer")
        );
        unsubscribe.body_base64 = Some(STANDARD.encode(r#"{"subscriptionId":"newer"}"#));
        inner
            .subscription_response(&unsubscribe, &response)
            .unwrap();
        assert!(
            inner
                .lock()
                .unwrap()
                .scopes
                .get(&scope.id)
                .unwrap()
                .subscription
                .is_none()
        );
    }

    #[tokio::test]
    async fn stream_delivery_waits_for_matching_ack_and_exceeds_old_lifetime_budget() {
        let inner = ready();
        let scope = inner.scope(1, "indexer").unwrap();
        let lease = register(&inner, &request(1, scope.id, "stream")).unwrap();
        let received = Arc::new(AtomicUsize::new(0));
        let count = received.clone();
        let channel = Channel::new(move |_| {
            count.fetch_add(1, Ordering::SeqCst);
            Ok(())
        });
        let chunk = STANDARD.encode(vec![0; super::super::policy::MAX_CHUNK]);
        lease.emit_data(&channel, chunk.clone()).await.unwrap();
        let next = lease.emit_data(&channel, chunk.clone());
        tokio::pin!(next);
        assert!(
            tokio::time::timeout(Duration::from_millis(10), &mut next)
                .await
                .is_err()
        );
        assert_eq!(received.load(Ordering::SeqCst), 1);
        assert!(inner.stream_ack(1, "stream", 2).is_err());
        inner.stream_ack(1, "stream", 1).unwrap();
        next.await.unwrap();
        inner.stream_ack(1, "stream", 2).unwrap();
        for sequence in 3..=144 {
            lease.emit_data(&channel, chunk.clone()).await.unwrap();
            inner.stream_ack(1, "stream", sequence).unwrap();
        }
        assert_eq!(received.load(Ordering::SeqCst), 144);
        lease.emit_data(&channel, chunk.clone()).await.unwrap();
        let blocked = lease.emit_data(&channel, chunk);
        inner.pause().unwrap();
        assert!(
            tokio::time::timeout(Duration::from_secs(1), blocked)
                .await
                .unwrap()
                .is_err()
        );
        assert!(inner.stream_ack(1, "stream", 145).is_err());
    }

    #[tokio::test]
    async fn scope_item_binding_rejects_a_second_script() {
        let inner = ready();
        let scope = inner.scope(1, "indexer").unwrap();
        let first = request(1, scope.id.clone(), "one");
        drop(register(&inner, &first).unwrap());
        let mut second = request(1, scope.id, "two");
        second.url = second.url.replace("scripts=aa", "scripts=bb");
        assert!(register(&inner, &second).is_err());
    }

    #[tokio::test]
    async fn adversarial_subscription_id_collision_preserves_first_binding() {
        let inner = ready();
        let mut scopes = Vec::new();
        let response = NativeResponse {
            generation: 1,
            status: 200,
            headers: vec![],
            body_base64: STANDARD.encode(r#"{"subscriptionId":"same-server-id"}"#),
        };
        for (index, script) in ["aa", "bb"].iter().enumerate() {
            let scope = inner.scope(1, "indexer").unwrap();
            let mut request = request(1, scope.id.clone(), &format!("sub-{index}"));
            request.url = "https://mutinynet.arkade.sh/v1/indexer/script/subscribe".into();
            request.method = "POST".into();
            request.body_base64 = Some(STANDARD.encode(format!(r#"{{"scripts":["{script}"]}}"#)));
            drop(register(&inner, &request).unwrap());
            let result = inner.subscription_response(&request, &response);
            assert_eq!(result.is_ok(), index == 0);
            scopes.push(scope);
        }
        let session = inner.lock().unwrap();
        assert_eq!(
            session
                .subscriptions
                .get("same-server-id")
                .map(String::as_str),
            Some("scripts|aa")
        );
        assert_eq!(
            session
                .scopes
                .get(&scopes[0].id)
                .unwrap()
                .subscription
                .as_deref(),
            Some("same-server-id")
        );
        assert_eq!(
            session.scopes.get(&scopes[1].id).unwrap().subscription,
            None
        );
    }

    #[tokio::test]
    async fn failed_connect_rotates_only_its_scope_before_one_uncertain_post() {
        use bytes::Bytes;
        use http_body_util::Full;
        use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};

        let inner = ready();
        let scope = inner.scope(1, "indexer").unwrap();
        let unrelated = inner.scope(1, "indexer").unwrap();
        let lease = register(&inner, &request(1, scope.id.clone(), "recover")).unwrap();
        let other = register(&inner, &request(1, unrelated.id.clone(), "other")).unwrap();
        let original = lease.context.tor().unwrap().clone();
        let unrelated_client = other.context.tor().unwrap().clone();
        inner
            .lock()
            .unwrap()
            .scopes
            .get_mut(&scope.id)
            .unwrap()
            .subscription = Some("server-id".into());
        let (client, server) = tokio::io::duplex(4096);
        let mut client = Some(client);
        let mut attempts = Vec::new();
        let stream = lease
            .connect_with_recovery(|client_context| {
                attempts.push(client_context);
                std::future::ready(if attempts.len() == 1 {
                    Err(())
                } else {
                    Ok(client.take().unwrap())
                })
            })
            .await
            .unwrap();
        assert_eq!(attempts.len(), 2);
        assert!(Arc::ptr_eq(&attempts[0], &original));
        assert!(!Arc::ptr_eq(&attempts[1], &original));
        {
            let session = inner.lock().unwrap();
            let recovered = session.scopes.get(&scope.id).unwrap();
            assert!(Arc::ptr_eq(recovered.context.tor().unwrap(), &attempts[1]));
            assert_eq!(recovered.binding.as_deref(), Some("scripts|aa"));
            assert_eq!(recovered.subscription.as_deref(), Some("server-id"));
            assert!(Arc::ptr_eq(
                session
                    .scopes
                    .get(&unrelated.id)
                    .unwrap()
                    .context
                    .tor()
                    .unwrap(),
                &unrelated_client
            ));
        }
        other.check().unwrap();
        let peer = tokio::spawn(async move {
            let mut peer = BufReader::new(server);
            let mut headers = Vec::new();
            while !headers.ends_with(b"\r\n\r\n") {
                peer.read_until(b'\n', &mut headers).await.unwrap();
            }
            assert!(headers.starts_with(b"POST /spend HTTP/1.1"));
            let mut body = [0; 4];
            peer.read_exact(&mut body).await.unwrap();
            assert_eq!(&body, b"once");
        });
        let request = hyper::Request::builder()
            .method("POST")
            .uri("/spend")
            .header("host", "example.org")
            .body(Full::new(Bytes::from_static(b"once")))
            .unwrap();
        let result = super::super::wire::send_http(stream, request).await;
        assert!(matches!(result, Err(error) if error.contains("outcome may be unknown")));
        peer.await.unwrap();
        assert_eq!(attempts.len(), 2);
    }

    #[tokio::test]
    async fn two_failed_connections_exhaust_recovery_without_an_open_stream() {
        let inner = ready();
        let scope = inner.scope(1, "indexer").unwrap();
        let lease = register(&inner, &request(1, scope.id, "bounded")).unwrap();
        let mut attempts = 0;
        let result = lease
            .connect_with_recovery(|_| {
                attempts += 1;
                std::future::ready(Err::<(), _>(()))
            })
            .await;
        assert_eq!(attempts, 2);
        assert_eq!(result, Err("Tor connection failed".into()));
    }

    #[tokio::test]
    async fn retired_or_closed_scope_cannot_recover_a_failed_connection() {
        for retire in ["pause", "scope", "cancel"] {
            let inner = ready();
            let scope = inner.scope(1, "indexer").unwrap();
            let lease = register(&inner, &request(1, scope.id.clone(), "retire")).unwrap();
            let mut attempts = 0;
            let result = lease
                .connect_with_recovery(|_| {
                    attempts += 1;
                    match retire {
                        "pause" => {
                            inner.pause().unwrap();
                        }
                        "scope" => {
                            inner.close_scope(1, &scope.id).unwrap();
                        }
                        _ => {
                            inner.cancel(1, "retire").unwrap();
                        }
                    }
                    std::future::ready(Err::<(), _>(()))
                })
                .await;
            assert!(result.is_err());
            assert_eq!(attempts, 1);
        }
    }

    #[tokio::test]
    async fn a_recovered_connection_arriving_after_pause_is_not_delivered() {
        let inner = ready();
        let scope = inner.scope(1, "indexer").unwrap();
        let lease = register(&inner, &request(1, scope.id, "late-connect")).unwrap();
        let mut attempts = 0;
        let result = lease
            .connect_with_recovery(|_| {
                attempts += 1;
                let result = if attempts == 1 {
                    Err(())
                } else {
                    inner.pause().unwrap();
                    Ok(())
                };
                std::future::ready(result)
            })
            .await;
        assert!(result.is_err());
        assert_eq!(attempts, 2);
    }

    #[tokio::test]
    async fn an_older_failed_lease_uses_the_current_replacement_without_overwriting_it() {
        let inner = ready();
        let scope = inner.scope(1, "indexer").unwrap();
        let first = register(&inner, &request(1, scope.id.clone(), "first-recovery")).unwrap();
        let older = register(&inner, &request(1, scope.id.clone(), "older-lease")).unwrap();
        let mut attempts = 0;
        first
            .connect_with_recovery(|_| {
                attempts += 1;
                std::future::ready(if attempts == 1 { Err(()) } else { Ok(()) })
            })
            .await
            .unwrap();
        let replacement = inner
            .lock()
            .unwrap()
            .scopes
            .get(&scope.id)
            .unwrap()
            .context
            .tor()
            .unwrap()
            .clone();
        let mut contexts = Vec::new();
        older
            .connect_with_recovery(|client| {
                contexts.push(client);
                std::future::ready(if contexts.len() == 1 { Err(()) } else { Ok(()) })
            })
            .await
            .unwrap();
        assert!(Arc::ptr_eq(&contexts[1], &replacement));
        assert!(Arc::ptr_eq(
            inner
                .lock()
                .unwrap()
                .scopes
                .get(&scope.id)
                .unwrap()
                .context
                .tor()
                .unwrap(),
            &replacement
        ));
    }
}
