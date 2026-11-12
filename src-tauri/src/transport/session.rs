use super::{
    NativeHandle, NativeMode, NativeRequest, NativeResponse, NativeStatus, NativeStreamEvent,
    policy::CheckedRequest, wire::HttpConnection,
};
use arti_client::{BootstrapBehavior, DormantMode, TorClient, config::TorClientConfigBuilder};
use base64::{Engine, engine::general_purpose::STANDARD};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    future::Future,
    path::PathBuf,
    pin::Pin,
    sync::{Arc, Mutex, MutexGuard, Weak},
    task::{Context, Poll},
    time::{Duration, Instant},
};
use tauri::ipc::Channel;
use tokio::{
    io::{AsyncRead, AsyncWrite, ReadBuf},
    sync::{OwnedSemaphorePermit, Semaphore, mpsc, watch},
};
use tokio_util::{sync::CancellationToken, task::AbortOnDropHandle};
use tor_rtcompat::PreferredRuntime;

pub(super) type Client = Arc<TorClient<PreferredRuntime>>;
const MAX_SCOPES: usize = 1024;
const MAX_OPERATIONS: usize = 64;
const MAX_IDLE_HTTP: usize = 16;
const HTTP_IDLE_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_CANCELLED: usize = 4096;
const DRAIN_TIMEOUT: Duration = Duration::from_secs(10);
const WARM_PAUSE: Duration = Duration::from_secs(30);
const DIRECTORY_INITIAL_DELAY: Duration = Duration::from_secs(1);
const DIRECTORY_RETRY_ATTEMPTS: u32 = 8;
const DIRECTORY_PARALLELISM: u8 = 8;
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
    "update",
    "release",
];

#[derive(Clone)]
struct WarmPause {
    id: uuid::Uuid,
    generation: u64,
    deadline: Instant,
    client: Client,
}

pub(super) struct Session {
    pub phase: &'static str,
    native_foreground: bool,
    js_active: bool,
    warm: Option<WarmPause>,
    warm_from_generation: Option<u64>,
    pub generation: u64,
    pub mode: NativeMode,
    pub error: Option<String>,
    pub client: Option<Client>,
    pub bootstrap_cancel: Option<CancellationToken>,
    startup: Option<Arc<Startup>>,
    pub scopes: HashMap<String, Scope>,
    operations: HashMap<String, Operation>,
    cancelled: HashSet<String>,
    completed: HashSet<String>,
    completion_order: VecDeque<String>,
    subscriptions: HashMap<String, String>,
    resources: Vec<CancellationToken>,
}

fn configure_directory_downloads(config: &mut TorClientConfigBuilder) {
    config
        .download_schedule()
        .retry_consensus()
        .attempts(DIRECTORY_RETRY_ATTEMPTS)
        .initial_delay(DIRECTORY_INITIAL_DELAY)
        .parallelism(DIRECTORY_PARALLELISM);
    config
        .download_schedule()
        .retry_certs()
        .attempts(DIRECTORY_RETRY_ATTEMPTS)
        .initial_delay(DIRECTORY_INITIAL_DELAY)
        .parallelism(DIRECTORY_PARALLELISM);
    config
        .download_schedule()
        .retry_microdescs()
        .attempts(DIRECTORY_RETRY_ATTEMPTS)
        .initial_delay(DIRECTORY_INITIAL_DELAY)
        .parallelism(DIRECTORY_PARALLELISM);
}

type StartupResult = Result<NativeStatus, String>;

struct Startup {
    result: watch::Sender<Option<StartupResult>>,
}

impl Startup {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            result: watch::channel(None).0,
        })
    }

    fn waiter(&self, generation: u64, mode: NativeMode) -> StartWaiter {
        StartWaiter {
            generation,
            mode,
            result: self.result.subscribe(),
        }
    }

    fn finish(&self, result: StartupResult) {
        self.result.send_if_modified(|stored| {
            if stored.is_some() {
                return false;
            }
            *stored = Some(result);
            true
        });
    }
}

struct StartWaiter {
    generation: u64,
    mode: NativeMode,
    result: watch::Receiver<Option<StartupResult>>,
}

impl StartWaiter {
    async fn wait(mut self, inner: &Inner) -> StartupResult {
        loop {
            let result = { self.result.borrow_and_update().clone() };
            if let Some(result) = result {
                let session = inner.lock()?;
                if session.generation != self.generation || session.mode != self.mode {
                    return Err("private session changed".into());
                }
                return result;
            }
            self.result
                .changed()
                .await
                .map_err(|_| "private startup stopped; retry to reconnect".to_owned())?;
        }
    }
}

enum PreparedStart {
    Ready(NativeStatus),
    Pending {
        waiter: StartWaiter,
        work: Option<StartupWork>,
    },
}

struct StartupWork {
    inner: Arc<Inner>,
    generation: u64,
    mode: NativeMode,
    cancel: CancellationToken,
    existing: Option<Client>,
    retiring: Vec<CancellationToken>,
    completion: Arc<Startup>,
    drain_timeout: Duration,
    finished: bool,
    _retirement: Arc<Retirement>,
}

impl StartupWork {
    async fn run(self) {
        self.run_with_bootstrap(|inner, generation, cancel, existing| async move {
            inner.bootstrap(generation, &cancel, existing).await
        })
        .await;
    }

    async fn run_with_bootstrap<F, Fut>(mut self, bootstrap: F)
    where
        F: FnOnce(Arc<Inner>, u64, CancellationToken, Option<Client>) -> Fut,
        Fut: Future<Output = Result<(), String>>,
    {
        let cancel = self.cancel.clone();
        let result = tokio::select! {
            biased;
            _ = cancel.cancelled() => Err("private session paused".into()),
            result = async {
                self.inner.check_start(self.generation, self.mode, &self.completion)?;
                tokio::time::timeout(self.drain_timeout, async {
                    for resource in &self.retiring { resource.cancelled().await; }
                }).await.map_err(|_| "previous network requests are still closing; retry to reconnect".to_owned())?;
                self.inner.check_start(self.generation, self.mode, &self.completion)?;
                if self.mode == NativeMode::Tor {
                    bootstrap(self.inner.clone(), self.generation, self.cancel.clone(), self.existing.take()).await
                } else {
                    Ok(())
                }
            } => result,
        };
        self.inner
            .finish_start(self.generation, self.mode, &self.completion, result);
        self.finished = true;
    }
}

impl Drop for StartupWork {
    fn drop(&mut self) {
        if !self.finished {
            self.inner.finish_start(
                self.generation,
                self.mode,
                &self.completion,
                Err("private startup stopped; retry to reconnect".into()),
            );
        }
    }
}

#[derive(Clone)]
enum ConnectionContext {
    Tor(Client),
    Direct,
}

impl ConnectionContext {
    fn matches(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Tor(left), Self::Tor(right)) => Arc::ptr_eq(left, right),
            (Self::Direct, Self::Direct) => true,
            _ => false,
        }
    }

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
    http: Option<IdleHttp>,
}

struct IdleHttp {
    host: String,
    id: uuid::Uuid,
    since: Instant,
    connection: HttpConnection,
    _expiry: AbortOnDropHandle<()>,
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
                native_foreground: true,
                js_active: false,
                warm: None,
                warm_from_generation: None,
                generation: 0,
                mode: NativeMode::Tor,
                error: None,
                client: None,
                bootstrap_cancel: None,
                startup: None,
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

    pub fn finish_update<T>(
        &self,
        generation: u64,
        publish: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let session = self.lock()?;
        session.check(generation)?;
        publish()
    }

    pub fn pause(&self) -> Result<NativeStatus, String> {
        let mut session = self.lock()?;
        session.invalidate()?;
        session.phase = "paused";
        session.js_active = false;
        session.error = None;
        if let Some(client) = &session.client {
            client.set_dormant(DormantMode::Soft);
        }
        Ok(session.status())
    }

    pub fn suspend(self: &Arc<Self>, native: bool) -> Result<NativeStatus, String> {
        let mut session = self.lock()?;
        if native {
            session.native_foreground = false;
            // An app switch keeps the ready owner; revocation goes through pause() or suspend(false).
            if session.phase == "ready" {
                return Ok(session.status());
            }
        }
        let fresh = session.phase == "ready" && session.mode == NativeMode::Tor;
        let warm = if fresh {
            session.client.clone().map(|client| WarmPause {
                id: uuid::Uuid::new_v4(),
                generation: session.generation,
                deadline: Instant::now() + WARM_PAUSE,
                client,
            })
        } else if session.phase == "paused" {
            session
                .warm
                .clone()
                .filter(|warm| warm.deadline > Instant::now())
        } else {
            None
        };
        session.invalidate()?;
        session.phase = "paused";
        session.js_active = false;
        session.error = None;
        session.warm_from_generation = warm.as_ref().map(|warm| warm.generation);
        session.warm = warm.clone();
        if warm.is_none() {
            if let Some(client) = &session.client {
                client.set_dormant(DormantMode::Soft);
            }
        }
        let status = session.status();
        drop(session);
        if let Some(warm) = warm.filter(|_| fresh) {
            let weak = Arc::downgrade(self);
            let (id, deadline) = (warm.id, warm.deadline);
            let _ = tauri::async_runtime::spawn(async move {
                tokio::time::sleep_until(deadline.into()).await;
                if let Some(inner) = weak.upgrade() {
                    inner.expire_warm(id, Instant::now());
                }
            });
        }
        Ok(status)
    }

    fn expire_warm(&self, id: uuid::Uuid, now: Instant) {
        let Ok(mut session) = self.lock() else {
            return;
        };
        let matches = session.warm.as_ref().is_some_and(|warm| {
            warm.id == id
                && now >= warm.deadline
                && session
                    .client
                    .as_ref()
                    .is_some_and(|client| Arc::ptr_eq(client, &warm.client))
        }) && session.phase == "paused"
            && (!session.native_foreground || !session.js_active);
        if !matches {
            return;
        }
        if let Some(warm) = session.warm.take() {
            warm.client.set_dormant(DormantMode::Soft);
        }
        session.warm_from_generation = None;
    }

    pub fn resumed(&self) -> Result<NativeStatus, String> {
        let mut session = self.lock()?;
        session.native_foreground = true;
        Ok(session.status())
    }

    pub async fn start(self: &Arc<Self>, mode: NativeMode) -> Result<NativeStatus, String> {
        self.start_with_drain_timeout(mode, DRAIN_TIMEOUT).await
    }

    pub fn prewarm(self: &Arc<Self>) -> Result<NativeStatus, String> {
        match self.prepare_start(NativeMode::Tor, DRAIN_TIMEOUT, true)? {
            PreparedStart::Ready(status) => Ok(status),
            PreparedStart::Pending { work, .. } => {
                if let Some(work) = work {
                    let _ = tauri::async_runtime::spawn(work.run());
                }
                self.status()
            }
        }
    }

    async fn start_with_drain_timeout(
        self: &Arc<Self>,
        mode: NativeMode,
        drain_timeout: Duration,
    ) -> Result<NativeStatus, String> {
        match self.prepare_start(mode, drain_timeout, false)? {
            PreparedStart::Ready(status) => Ok(status),
            PreparedStart::Pending { waiter, work } => {
                if let Some(work) = work {
                    let _ = tokio::spawn(work.run());
                }
                waiter.wait(self).await
            }
        }
    }

    fn prepare_start(
        self: &Arc<Self>,
        mode: NativeMode,
        drain_timeout: Duration,
        initial_only: bool,
    ) -> Result<PreparedStart, String> {
        let mut session = self.lock()?;
        if !session.native_foreground {
            return Err("native activity is not in the foreground".into());
        }
        if initial_only
            && (session.generation != 0
                || session.phase != "locked"
                || session.mode != NativeMode::Tor)
        {
            return Ok(PreparedStart::Ready(session.status()));
        }
        if session.mode == mode {
            if session.phase == "ready" {
                return Ok(PreparedStart::Ready(session.status()));
            }
            if session.phase == "bootstrapping" {
                let completion = session
                    .startup
                    .as_ref()
                    .ok_or("private startup unavailable")?;
                return Ok(PreparedStart::Pending {
                    waiter: completion.waiter(session.generation, mode),
                    work: None,
                });
            }
        }
        let warm_from = session
            .warm
            .as_ref()
            .filter(|warm| {
                mode == NativeMode::Tor
                    && warm.deadline > Instant::now()
                    && session
                        .client
                        .as_ref()
                        .is_some_and(|client| Arc::ptr_eq(client, &warm.client))
            })
            .map(|warm| warm.generation);
        session.invalidate()?;
        session.js_active = true;
        session.warm_from_generation = warm_from;
        if session.mode != mode {
            if let Some(client) = session.client.take() {
                client.set_dormant(DormantMode::Soft);
                let stopped = client.wait_for_stop();
                let retirement = session.resource();
                let _ = tokio::spawn(async move {
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
        let completion = Startup::new();
        session.startup = Some(completion.clone());
        session
            .resources
            .retain(|resource| !resource.is_cancelled());
        let retiring = session.resources.clone();
        let retirement = session.resource();
        Ok(PreparedStart::Pending {
            waiter: completion.waiter(session.generation, mode),
            work: Some(StartupWork {
                inner: self.clone(),
                generation: session.generation,
                mode,
                cancel,
                existing: session.client.clone(),
                retiring,
                completion,
                drain_timeout,
                finished: false,
                _retirement: retirement,
            }),
        })
    }

    fn check_start(
        &self,
        generation: u64,
        mode: NativeMode,
        completion: &Arc<Startup>,
    ) -> Result<(), String> {
        if self.lock()?.start_matches(generation, mode, completion) {
            Ok(())
        } else {
            Err("private session changed".into())
        }
    }

    fn finish_start(
        &self,
        generation: u64,
        mode: NativeMode,
        completion: &Arc<Startup>,
        result: Result<(), String>,
    ) {
        let mut session = match self.lock() {
            Ok(session) => session,
            Err(error) => {
                completion.finish(Err(error));
                return;
            }
        };
        let result = if !session.start_matches(generation, mode, completion) {
            Err("private session changed".into())
        } else {
            session.bootstrap_cancel = None;
            match result {
                Ok(()) => session.phase = "ready",
                Err(error) => {
                    session.phase = "error";
                    session.warm_from_generation = None;
                    session.error = Some(error);
                    if let Some(client) = &session.client {
                        client.set_dormant(DormantMode::Soft);
                    }
                }
            }
            Ok(session.status())
        };
        completion.finish(result);
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
                let mut config = TorClientConfigBuilder::from_directories(
                    self.data_dir.join("state"),
                    self.data_dir.join("cache"),
                );
                configure_directory_downloads(&mut config);
                let config = config
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
                http: None,
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
            || session.resources.len() >= MAX_OPERATIONS + MAX_IDLE_HTTP
            || session.operations.contains_key(&request.request_id)
        {
            return Err("private request limit or duplicate identifier".into());
        }
        let scope = session
            .scopes
            .get_mut(&request.scope)
            .ok_or("unknown private scope")?;
        if ["update", "release"].contains(&scope.purpose.as_str()) {
            scope.context.tor()?;
        }
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

    fn expire_http(&self, generation: u64, scope: &str, id: uuid::Uuid) {
        if let Ok(mut session) = self.lock() {
            if session.generation == generation {
                if let Some(scope) = session.scopes.get_mut(scope) {
                    if scope.http.as_ref().is_some_and(|entry| entry.id == id) {
                        scope.http.take();
                    }
                }
            }
        }
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
            foreground: self.native_foreground,
            warm_from_generation: self.warm_from_generation,
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

    fn start_matches(&self, generation: u64, mode: NativeMode, completion: &Arc<Startup>) -> bool {
        self.generation == generation
            && self.native_foreground
            && self.mode == mode
            && self.phase == "bootstrapping"
            && self
                .startup
                .as_ref()
                .is_some_and(|current| Arc::ptr_eq(current, completion))
    }

    fn invalidate(&mut self) -> Result<(), String> {
        self.warm = None;
        self.warm_from_generation = None;
        self.generation = self
            .generation
            .checked_add(1)
            .ok_or("private session generation exhausted")?;
        if let Some(completion) = self.startup.take() {
            completion.finish(Err("private session changed".into()));
        }
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
    #[cfg(test)]
    pub fn test_stream<T>(&self, io: T) -> NativeStream
    where
        T: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    {
        NativeStream {
            io: Box::new(io),
            _retirement: self.retirement.clone(),
        }
    }

    pub fn take_http(&self, host: &str) -> Result<Option<HttpConnection>, String> {
        let inner = self.inner.upgrade().ok_or("private transport closed")?;
        let mut session = inner.lock()?;
        session.check(self.generation)?;
        if self.cancel.is_cancelled() {
            return Err("private request cancelled".into());
        }
        let scope = session
            .scopes
            .get_mut(&self.scope)
            .ok_or("private scope closed")?;
        if !scope.context.matches(&self.context) {
            return Ok(None);
        }
        Ok(scope
            .http
            .take()
            .filter(|entry| {
                entry.host == host
                    && entry.since.elapsed() < HTTP_IDLE_TIMEOUT
                    && !entry.connection.is_closed()
            })
            .map(|entry| entry.connection))
    }

    pub fn return_http(&self, host: String, connection: HttpConnection) -> Result<bool, String> {
        let inner = self.inner.upgrade().ok_or("private transport closed")?;
        let mut session = inner.lock()?;
        session.check(self.generation)?;
        if self.cancel.is_cancelled() {
            return Err("private request cancelled".into());
        }
        let scope = session
            .scopes
            .get(&self.scope)
            .ok_or("private scope closed")?;
        if !scope.context.matches(&self.context) || connection.is_closed() {
            return Ok(false);
        }
        if scope.http.is_none()
            && session
                .scopes
                .values()
                .filter(|scope| scope.http.is_some())
                .count()
                >= MAX_IDLE_HTTP
        {
            let oldest = session
                .scopes
                .iter()
                .filter_map(|(id, scope)| {
                    scope.http.as_ref().map(|entry| (id.clone(), entry.since))
                })
                .min_by_key(|(_, since)| *since)
                .map(|(id, _)| id);
            if let Some(oldest) = oldest {
                session.scopes.get_mut(&oldest).unwrap().http.take();
            }
        }
        let id = uuid::Uuid::new_v4();
        let since = Instant::now();
        let weak = Arc::downgrade(&inner);
        let scope = self.scope.clone();
        let generation = self.generation;
        let expiry = tokio::spawn(async move {
            tokio::time::sleep_until((since + HTTP_IDLE_TIMEOUT).into()).await;
            if let Some(inner) = weak.upgrade() {
                inner.expire_http(generation, &scope, id);
            }
        });
        session.scopes.get_mut(&self.scope).unwrap().http = Some(IdleHttp {
            host,
            id,
            since,
            connection,
            _expiry: AbortOnDropHandle::new(expiry),
        });
        Ok(true)
    }

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
            scope.http.take();
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

    async fn http_connection(lease: &Lease) -> (HttpConnection, tokio::io::DuplexStream) {
        let (client, server) = tokio::io::duplex(4096);
        let stream = NativeStream {
            io: Box::new(client),
            _retirement: lease.retirement.clone(),
        };
        (HttpConnection::new(stream).await.unwrap(), server)
    }

    async fn closed(mut peer: tokio::io::DuplexStream) {
        use tokio::io::AsyncReadExt;
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(2), peer.read(&mut [0]))
                .await
                .unwrap()
                .unwrap(),
            0
        );
    }

    #[tokio::test]
    async fn http_cache_checkout_is_exclusive_and_separates_scopes_and_hosts() {
        let inner = ready();
        let first = inner.scope(1, "indexer").unwrap();
        let second = inner.scope(1, "indexer").unwrap();
        let first = register(&inner, &request(1, first.id, "http-first")).unwrap();
        let second = register(&inner, &request(1, second.id, "http-second")).unwrap();
        let (connection, peer) = http_connection(&first).await;
        assert!(
            first
                .return_http("mutinynet.arkade.sh".into(), connection)
                .unwrap()
        );
        assert!(second.take_http("mutinynet.arkade.sh").unwrap().is_none());
        let connection = first.take_http("mutinynet.arkade.sh").unwrap().unwrap();
        assert!(first.take_http("mutinynet.arkade.sh").unwrap().is_none());
        assert!(
            first
                .return_http("mutinynet.arkade.sh".into(), connection)
                .unwrap()
        );
        assert!(first.take_http("other.example").unwrap().is_none());
        closed(peer).await;
    }

    #[tokio::test]
    async fn http_context_rotation_drops_idle_and_rejects_an_old_return() {
        let inner = ready();
        let handle = inner.scope(1, "indexer").unwrap();
        let lease = register(&inner, &request(1, handle.id.clone(), "http-rotate")).unwrap();
        let (connection, peer) = http_connection(&lease).await;
        lease
            .return_http("mutinynet.arkade.sh".into(), connection)
            .unwrap();
        lease.reconnect_client().unwrap();
        assert!(inner.lock().unwrap().scopes[&handle.id].http.is_none());
        closed(peer).await;
        let fresh = register(&inner, &request(1, handle.id.clone(), "http-current")).unwrap();
        let (connection, peer) = http_connection(&fresh).await;
        assert!(
            fresh
                .return_http("mutinynet.arkade.sh".into(), connection)
                .unwrap()
        );
        let id = inner.lock().unwrap().scopes[&handle.id]
            .http
            .as_ref()
            .unwrap()
            .id;
        let (old, old_peer) = http_connection(&lease).await;
        assert!(
            !lease
                .return_http("mutinynet.arkade.sh".into(), old)
                .unwrap()
        );
        assert_eq!(
            inner.lock().unwrap().scopes[&handle.id]
                .http
                .as_ref()
                .unwrap()
                .id,
            id
        );
        closed(old_peer).await;
        inner.close_scope(1, &handle.id).unwrap();
        closed(peer).await;
    }

    #[tokio::test]
    async fn http_expiry_cannot_remove_a_replacement_or_another_generation() {
        let inner = ready();
        let handle = inner.scope(1, "indexer").unwrap();
        let lease = register(&inner, &request(1, handle.id.clone(), "http-expiry")).unwrap();
        let (connection, peer) = http_connection(&lease).await;
        lease
            .return_http("mutinynet.arkade.sh".into(), connection)
            .unwrap();
        let old = inner.lock().unwrap().scopes[&handle.id]
            .http
            .as_ref()
            .unwrap()
            .id;
        let connection = lease.take_http("mutinynet.arkade.sh").unwrap().unwrap();
        lease
            .return_http("mutinynet.arkade.sh".into(), connection)
            .unwrap();
        let current = inner.lock().unwrap().scopes[&handle.id]
            .http
            .as_ref()
            .unwrap()
            .id;
        assert_ne!(old, current);
        inner.expire_http(1, &handle.id, old);
        inner.expire_http(2, &handle.id, current);
        assert_eq!(
            inner.lock().unwrap().scopes[&handle.id]
                .http
                .as_ref()
                .unwrap()
                .id,
            current
        );
        inner.expire_http(1, &handle.id, current);
        assert!(inner.lock().unwrap().scopes[&handle.id].http.is_none());
        closed(peer).await;
        assert_eq!(Arc::strong_count(&inner), 1);
    }

    #[tokio::test]
    async fn expired_http_connections_are_closed_instead_of_checked_out() {
        let inner = ready();
        let handle = inner.scope(1, "indexer").unwrap();
        let lease = register(&inner, &request(1, handle.id.clone(), "http-too-old")).unwrap();
        let (connection, peer) = http_connection(&lease).await;
        lease
            .return_http("mutinynet.arkade.sh".into(), connection)
            .unwrap();
        inner
            .lock()
            .unwrap()
            .scopes
            .get_mut(&handle.id)
            .unwrap()
            .http
            .as_mut()
            .unwrap()
            .since = Instant::now() - HTTP_IDLE_TIMEOUT;
        assert!(lease.take_http("mutinynet.arkade.sh").unwrap().is_none());
        closed(peer).await;
    }

    #[tokio::test]
    async fn checking_out_http_cancels_its_idle_expiry_task() {
        let inner = ready();
        let handle = inner.scope(1, "indexer").unwrap();
        let lease = register(&inner, &request(1, handle.id.clone(), "http-expiry-owner")).unwrap();
        let (connection, peer) = http_connection(&lease).await;
        lease
            .return_http("mutinynet.arkade.sh".into(), connection)
            .unwrap();
        let expiry = inner.lock().unwrap().scopes[&handle.id]
            .http
            .as_ref()
            .unwrap()
            ._expiry
            .abort_handle();
        let connection = lease.take_http("mutinynet.arkade.sh").unwrap().unwrap();
        tokio::time::timeout(Duration::from_secs(2), async {
            while !expiry.is_finished() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        drop(connection);
        closed(peer).await;
    }

    #[tokio::test]
    async fn idle_http_cache_evicts_oldest_without_cancelling_its_request() {
        let inner = ready();
        let mut leases = Vec::new();
        let mut peers = Vec::new();
        for index in 0..=MAX_IDLE_HTTP {
            let handle = inner.scope(1, "indexer").unwrap();
            let lease = register(
                &inner,
                &request(1, handle.id, &format!("http-bound-{index}")),
            )
            .unwrap();
            let (connection, peer) = http_connection(&lease).await;
            lease
                .return_http("mutinynet.arkade.sh".into(), connection)
                .unwrap();
            leases.push(lease);
            peers.push(peer);
        }
        assert_eq!(
            inner
                .lock()
                .unwrap()
                .scopes
                .values()
                .filter(|scope| scope.http.is_some())
                .count(),
            MAX_IDLE_HTTP
        );
        assert!(
            leases[0]
                .take_http("mutinynet.arkade.sh")
                .unwrap()
                .is_none()
        );
        assert!(leases.iter().all(|lease| lease.check().is_ok()));
        closed(peers.remove(0)).await;
        inner.pause().unwrap();
        for peer in peers {
            closed(peer).await;
        }
    }

    #[tokio::test]
    async fn idle_http_connections_preserve_the_full_active_operation_budget() {
        let inner = ready();
        let mut peers = Vec::new();
        for index in 0..MAX_IDLE_HTTP {
            let handle = inner.scope(1, "indexer").unwrap();
            let lease = register(
                &inner,
                &request(1, handle.id, &format!("http-idle-{index}")),
            )
            .unwrap();
            let (connection, peer) = http_connection(&lease).await;
            lease
                .return_http("mutinynet.arkade.sh".into(), connection)
                .unwrap();
            peers.push(peer);
        }
        let mut active = Vec::new();
        for index in 0..MAX_OPERATIONS {
            let handle = inner.scope(1, "indexer").unwrap();
            active.push(
                register(
                    &inner,
                    &request(1, handle.id, &format!("http-active-{index}")),
                )
                .unwrap(),
            );
        }
        let extra = inner.scope(1, "indexer").unwrap();
        assert!(register(&inner, &request(1, extra.id, "http-overflow")).is_err());
        assert_eq!(inner.lock().unwrap().operations.len(), MAX_OPERATIONS);
        drop(active);
        inner.pause().unwrap();
        for peer in peers {
            closed(peer).await;
        }
    }

    #[tokio::test]
    async fn cached_http_driver_retirement_is_drained_on_mode_change() {
        let inner = ready();
        let handle = inner.scope(1, "indexer").unwrap();
        let lease = register(&inner, &request(1, handle.id.clone(), "http-retirement")).unwrap();
        let (connection, peer) = http_connection(&lease).await;
        let retired = lease.retirement.clone();
        lease
            .return_http("mutinynet.arkade.sh".into(), connection)
            .unwrap();
        drop(lease);
        assert!(inner.lock().unwrap().operations.is_empty());
        let started = tokio::spawn({
            let inner = inner.clone();
            async move { inner.start(NativeMode::Direct).await }
        });
        wait_for_mode(&inner, NativeMode::Direct).await;
        assert!(inner.lock().unwrap().scopes.is_empty());
        assert!(!started.is_finished());
        closed(peer).await;
        drop(retired);
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

    #[test]
    fn directory_downloads_prefer_parallel_foreground_retries() {
        let mut config = TorClientConfigBuilder::from_directories("state", "cache");
        configure_directory_downloads(&mut config);
        let config = config.build().unwrap().dir_mgr_config().unwrap();
        for schedule in [
            config.schedule.retry_consensus(),
            config.schedule.retry_certs(),
            config.schedule.retry_microdescs(),
        ] {
            assert_eq!(schedule.n_attempts(), 8);
            assert_eq!(schedule.parallelism(), 8);
        }
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
    async fn startup_concurrent_callers_wait_for_the_same_pending_transition() {
        let inner = ready();
        let scope = inner.scope(1, "indexer").unwrap();
        let lease = register(&inner, &request(1, scope.id, "startup-retirement")).unwrap();
        let first = tokio::spawn({
            let inner = inner.clone();
            async move { inner.start(NativeMode::Direct).await }
        });
        wait_for_mode(&inner, NativeMode::Direct).await;
        let mut second = Box::pin(inner.start(NativeMode::Direct));
        assert!(matches!(
            futures_util::poll!(second.as_mut()),
            Poll::Pending
        ));
        drop(lease);
        let first = first.await.unwrap().unwrap();
        let second = second.await.unwrap();
        assert_eq!(first.phase, "ready");
        assert_eq!(second.phase, "ready");
        assert_eq!(first.generation, second.generation);
    }

    #[tokio::test]
    async fn startup_cancelled_waiter_does_not_strand_the_native_transition() {
        let inner = ready();
        let scope = inner.scope(1, "indexer").unwrap();
        let lease = register(&inner, &request(1, scope.id, "startup-cancelled-waiter")).unwrap();
        let first = tokio::spawn({
            let inner = inner.clone();
            async move { inner.start(NativeMode::Direct).await }
        });
        wait_for_mode(&inner, NativeMode::Direct).await;
        let generation = inner.status().unwrap().generation;
        first.abort();
        assert!(matches!(first.await, Err(error) if error.is_cancelled()));
        drop(lease);
        let recovered = inner.start(NativeMode::Direct).await.unwrap();
        assert_eq!(recovered.phase, "ready");
        assert_eq!(recovered.generation, generation);
    }

    fn startup_inner() -> Arc<Inner> {
        Arc::new(Inner::new(
            std::env::temp_dir().join(format!("shielded-startup-test-{}", uuid::Uuid::new_v4())),
        ))
    }

    fn reserve_startup(inner: &Arc<Inner>, initial_only: bool) -> (StartWaiter, StartupWork) {
        match inner
            .prepare_start(NativeMode::Tor, DRAIN_TIMEOUT, initial_only)
            .unwrap()
        {
            PreparedStart::Pending {
                waiter,
                work: Some(work),
            } => (waiter, work),
            _ => panic!("expected a new startup reservation"),
        }
    }

    #[tokio::test]
    async fn startup_reservation_is_single_flight_before_dispatch() {
        let inner = startup_inner();
        let (first, work) = reserve_startup(&inner, true);
        let second = match inner
            .prepare_start(NativeMode::Tor, DRAIN_TIMEOUT, false)
            .unwrap()
        {
            PreparedStart::Pending { waiter, work: None } => waiter,
            _ => panic!("expected to join the original startup"),
        };
        assert_eq!(inner.lock().unwrap().resources.len(), 1);
        assert!(matches!(
            inner.prepare_start(NativeMode::Tor, DRAIN_TIMEOUT, true).unwrap(),
            PreparedStart::Ready(status) if status.phase == "bootstrapping"
        ));
        work.run_with_bootstrap(|_, _, _, _| std::future::ready(Ok(())))
            .await;
        let first = first.wait(&inner).await.unwrap();
        let second = second.wait(&inner).await.unwrap();
        assert_eq!(first.phase, "ready");
        assert_eq!(first.generation, second.generation);
    }

    #[tokio::test]
    async fn startup_pause_before_dispatch_notifies_and_blocks_queued_work() {
        let inner = startup_inner();
        let (waiter, work) = reserve_startup(&inner, true);
        let paused = inner.pause().unwrap();
        let mut waiting = Box::pin(waiter.wait(&inner));
        assert!(matches!(
            futures_util::poll!(waiting.as_mut()),
            Poll::Ready(Err(_))
        ));
        let attempts = Arc::new(AtomicUsize::new(0));
        let count = attempts.clone();
        work.run_with_bootstrap(move |_, _, _, _| {
            count.fetch_add(1, Ordering::SeqCst);
            std::future::ready(Ok(()))
        })
        .await;
        assert_eq!(attempts.load(Ordering::SeqCst), 0);
        assert!(inner.lock().unwrap().client.is_none());
        assert_eq!(inner.status().unwrap().phase, "paused");
        assert_eq!(inner.status().unwrap().generation, paused.generation);
        assert!(!inner.data_dir.exists());
    }

    #[tokio::test]
    async fn startup_invalidation_completion_cannot_be_overwritten_by_late_success() {
        let inner = startup_inner();
        let (waiter, work) = reserve_startup(&inner, true);
        let completion = work.completion.clone();
        let mut stale = inner.status().unwrap();
        stale.phase = "ready".into();
        inner.pause().unwrap();
        completion.finish(Ok(stale));
        assert!(completion.result.borrow().as_ref().unwrap().is_err());
        drop(work);
        assert!(waiter.wait(&inner).await.is_err());
        assert_eq!(inner.status().unwrap().phase, "paused");
    }

    #[tokio::test]
    async fn startup_terminal_success_survives_no_receivers_and_worker_drop() {
        let inner = startup_inner();
        let (waiter, work) = reserve_startup(&inner, true);
        let completion = work.completion.clone();
        let generation = work.generation;
        drop(waiter);
        work.run_with_bootstrap(|_, _, _, _| std::future::ready(Ok(())))
            .await;
        assert_eq!(inner.status().unwrap().phase, "ready");
        let late = completion
            .waiter(generation, NativeMode::Tor)
            .wait(&inner)
            .await
            .unwrap();
        assert_eq!(late.phase, "ready");
        assert_eq!(late.generation, generation);
    }

    #[tokio::test]
    async fn startup_cached_ready_rechecks_generation_before_returning() {
        let inner = startup_inner();
        let (waiter, work) = reserve_startup(&inner, true);
        work.run_with_bootstrap(|_, _, _, _| std::future::ready(Ok(())))
            .await;
        inner.pause().unwrap();
        assert!(waiter.wait(&inner).await.is_err());
    }

    #[tokio::test]
    async fn startup_worker_drop_reports_failure_and_allows_retry() {
        let inner = startup_inner();
        let (waiter, work) = reserve_startup(&inner, true);
        let generation = work.generation;
        drop(work);
        let failed = waiter.wait(&inner).await.unwrap();
        assert_eq!(failed.phase, "error");
        assert!(failed.error.unwrap().contains("startup stopped"));
        let retried = inner.start(NativeMode::Direct).await.unwrap();
        assert_eq!(retried.phase, "ready");
        assert!(retried.generation > generation);
    }

    #[tokio::test]
    async fn startup_drain_precedes_bootstrap_work() {
        let inner = startup_inner();
        let retired = inner.lock().unwrap().resource();
        let (waiter, work) = reserve_startup(&inner, true);
        let attempts = Arc::new(AtomicUsize::new(0));
        let count = attempts.clone();
        let mut running = Box::pin(work.run_with_bootstrap(move |_, _, _, _| {
            count.fetch_add(1, Ordering::SeqCst);
            std::future::ready(Ok(()))
        }));
        assert!(matches!(
            futures_util::poll!(running.as_mut()),
            Poll::Pending
        ));
        assert_eq!(attempts.load(Ordering::SeqCst), 0);
        assert_eq!(inner.status().unwrap().phase, "bootstrapping");
        drop(retired);
        running.await;
        assert_eq!(attempts.load(Ordering::SeqCst), 1);
        assert_eq!(waiter.wait(&inner).await.unwrap().phase, "ready");
    }

    #[tokio::test]
    async fn startup_captured_success_cannot_revive_a_paused_session() {
        let inner = startup_inner();
        let (waiter, work) = reserve_startup(&inner, true);
        let paused = inner.clone();
        work.run_with_bootstrap(move |_, _, _, _| async move {
            paused.pause()?;
            Ok(())
        })
        .await;
        assert_eq!(inner.status().unwrap().phase, "paused");
        assert!(waiter.wait(&inner).await.is_err());
    }

    #[tokio::test]
    async fn startup_prewarm_does_not_reverse_pause_or_direct_choice() {
        let paused = startup_inner();
        let status = paused.pause().unwrap();
        let repeated = paused.prewarm().unwrap();
        assert_eq!(repeated.phase, "paused");
        assert_eq!(repeated.generation, status.generation);
        let direct = startup_inner();
        let status = direct.start(NativeMode::Direct).await.unwrap();
        let repeated = direct.prewarm().unwrap();
        assert_eq!(repeated.mode, NativeMode::Direct);
        assert_eq!(repeated.generation, status.generation);
        assert!(direct.lock().unwrap().client.is_none());
    }

    #[tokio::test]
    async fn startup_failed_bootstrap_notifies_and_retries_a_new_generation() {
        let inner = startup_inner();
        let (waiter, work) = reserve_startup(&inner, true);
        work.run_with_bootstrap(|_, _, _, _| std::future::ready(Err("unavailable".into())))
            .await;
        let failed = waiter.wait(&inner).await.unwrap();
        assert_eq!(failed.phase, "error");
        assert_eq!(failed.error.as_deref(), Some("unavailable"));
        let (waiter, work) = reserve_startup(&inner, false);
        work.run_with_bootstrap(|_, _, _, _| std::future::ready(Ok(())))
            .await;
        let ready = waiter.wait(&inner).await.unwrap();
        assert_eq!(ready.phase, "ready");
        assert!(ready.generation > failed.generation);
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

    #[tokio::test]
    async fn ordinary_background_keeps_the_ready_owner_and_its_existing_leases() {
        let inner = ready();
        let client = inner.lock().unwrap().client.clone().unwrap();
        let scope = inner.scope(1, "indexer").unwrap();
        let lease = register(&inner, &request(1, scope.id.clone(), "background")).unwrap();
        let background = inner.suspend(true).unwrap();
        assert_eq!(background.phase, "ready");
        assert_eq!(background.generation, 1);
        assert!(!background.foreground);
        assert!(!lease.cancel.is_cancelled());
        lease.check().unwrap();
        assert!(inner.lock().unwrap().warm.is_none());
        assert!(inner.start(NativeMode::Tor).await.is_err());
        inner.finish_update(1, || Ok(())).unwrap();
        assert!(Arc::ptr_eq(&client, inner.lock().unwrap().client.as_ref().unwrap()));
        inner.resumed().unwrap();
        assert_eq!(inner.status().unwrap().generation, 1);
        lease.check().unwrap();
        inner.pause().unwrap();
        assert!(lease.check().is_err());
        assert!(inner.finish_update(1, || Ok(())).is_err());
    }

    #[tokio::test]
    async fn warm_suspend_retires_every_old_capability_without_extending_the_deadline() {
        let inner = ready();
        let client = inner.lock().unwrap().client.clone().unwrap();
        let scope = inner.scope(1, "indexer").unwrap();
        let lease = register(&inner, &request(1, scope.id, "old")).unwrap();
        inner.suspend(true).unwrap();
        let paused = inner.suspend(false).unwrap();
        let first = inner.lock().unwrap().warm.clone().unwrap();
        assert_eq!(paused.phase, "paused");
        assert!(!paused.foreground);
        assert_eq!(paused.warm_from_generation, Some(1));
        assert!(lease.cancel.is_cancelled());
        assert!(lease.check().is_err());
        assert!(inner.lock().unwrap().scopes.is_empty());
        inner.suspend(false).unwrap();
        let session = inner.lock().unwrap();
        let second = session.warm.as_ref().unwrap();
        assert_eq!(first.id, second.id);
        assert_eq!(first.deadline, second.deadline);
        assert!(Arc::ptr_eq(&client, session.client.as_ref().unwrap()));
    }

    #[tokio::test]
    async fn native_resume_only_reports_visibility_and_cannot_start_an_inactive_activity() {
        let inner = ready();
        inner.suspend(true).unwrap();
        inner.suspend(false).unwrap();
        let paused = inner.status().unwrap();
        assert!(inner.start(NativeMode::Tor).await.is_err());
        let resumed = inner.resumed().unwrap();
        assert!(resumed.foreground);
        assert_eq!(resumed.phase, "paused");
        assert_eq!(resumed.generation, paused.generation);
        assert!(inner.scope(resumed.generation, "indexer").is_err());
    }

    #[tokio::test]
    async fn warm_resume_still_drains_then_bootstraps_a_fresh_owner() {
        let inner = ready();
        let scope = inner.scope(1, "indexer").unwrap();
        let old_request = request(1, scope.id, "proof-finished-late");
        let old = register(&inner, &old_request).unwrap();
        inner.suspend(true).unwrap();
        inner.suspend(false).unwrap();
        inner.resumed().unwrap();
        let PreparedStart::Pending {
            waiter,
            work: Some(work),
        } = inner
            .prepare_start(NativeMode::Tor, DRAIN_TIMEOUT, false)
            .unwrap()
        else {
            panic!("fresh start required");
        };
        let calls = Arc::new(AtomicUsize::new(0));
        let count = calls.clone();
        let mut running = Box::pin(work.run_with_bootstrap(move |_, _, _, existing| {
            assert!(existing.is_some());
            count.fetch_add(1, Ordering::SeqCst);
            std::future::ready(Ok(()))
        }));
        assert!(
            tokio::time::timeout(Duration::from_millis(10), &mut running)
                .await
                .is_err()
        );
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        drop(old);
        running.await;
        let status = waiter.wait(&inner).await.unwrap();
        assert_eq!(status.phase, "ready");
        assert!(status.generation > 1);
        assert_eq!(status.warm_from_generation, Some(1));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(register(&inner, &old_request).is_err());
    }

    #[tokio::test]
    async fn delayed_warm_expiry_cannot_dormant_a_resumed_or_newly_paused_client() {
        let inner = ready();
        inner.suspend(false).unwrap();
        let first = inner.lock().unwrap().warm.clone().unwrap();
        let PreparedStart::Pending {
            waiter,
            work: Some(work),
        } = inner
            .prepare_start(NativeMode::Tor, DRAIN_TIMEOUT, false)
            .unwrap()
        else {
            panic!("fresh start required");
        };
        work.run_with_bootstrap(|_, _, _, _| std::future::ready(Ok(())))
            .await;
        waiter.wait(&inner).await.unwrap();
        inner.expire_warm(first.id, first.deadline);
        assert_eq!(inner.status().unwrap().phase, "ready");
        inner.suspend(false).unwrap();
        let second = inner.lock().unwrap().warm.clone().unwrap();
        inner.expire_warm(first.id, second.deadline);
        assert_eq!(inner.lock().unwrap().warm.as_ref().unwrap().id, second.id);
        inner.expire_warm(second.id, second.deadline);
        assert!(inner.lock().unwrap().warm.is_none());
        assert_eq!(inner.status().unwrap().warm_from_generation, None);
    }

    #[tokio::test]
    async fn hard_pause_and_interrupted_startup_cannot_retain_warmth() {
        let inner = ready();
        inner.suspend(false).unwrap();
        inner.pause().unwrap();
        assert!(inner.lock().unwrap().warm.is_none());
        assert_eq!(inner.status().unwrap().warm_from_generation, None);
        let PreparedStart::Pending {
            work: Some(work), ..
        } = inner
            .prepare_start(NativeMode::Tor, DRAIN_TIMEOUT, false)
            .unwrap()
        else {
            panic!("fresh start required");
        };
        inner.suspend(true).unwrap();
        work.run_with_bootstrap(|_, _, _, _| std::future::ready(Ok(())))
            .await;
        assert_eq!(inner.status().unwrap().phase, "paused");
        assert!(inner.lock().unwrap().warm.is_none());
    }
    #[tokio::test]
    async fn warm_pause_can_schedule_warm_expiry_from_an_unentered_ui_thread() {
        let inner = ready();
        inner.suspend(true).unwrap();
        let status = std::thread::spawn(move || inner.suspend(false))
            .join()
            .unwrap()
            .unwrap();
        assert_eq!(status.phase, "paused");
        assert!(!status.foreground);
        assert_eq!(status.warm_from_generation, Some(1));
    }
}
