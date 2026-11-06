use super::{
    NativeHandle, NativeRequest, NativeResponse, NativeStatus, NativeStreamEvent,
    policy::CheckedRequest,
};
use arti_client::{BootstrapBehavior, DormantMode, TorClient, config::TorClientConfigBuilder};
use base64::{Engine, engine::general_purpose::STANDARD};
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{Arc, Mutex, MutexGuard, Weak},
    time::Duration,
};
use tauri::ipc::Channel;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use tor_rtcompat::PreferredRuntime;

pub(super) type Client = Arc<TorClient<PreferredRuntime>>;
const MAX_SCOPES: usize = 1024;
const MAX_OPERATIONS: usize = 64;
const MAX_CANCELLED: usize = 4096;
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
    pub error: Option<String>,
    pub client: Option<Client>,
    pub bootstrap_cancel: Option<CancellationToken>,
    pub scopes: HashMap<String, Scope>,
    operations: HashMap<String, Operation>,
    cancelled: HashSet<String>,
    subscriptions: HashMap<String, String>,
}

struct Operation {
    scope: String,
    cancel: CancellationToken,
    socket: Option<mpsc::Sender<String>>,
}

pub(super) struct Scope {
    pub client: Client,
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
    pub client: Client,
    pub cancel: CancellationToken,
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
                error: None,
                client: None,
                bootstrap_cancel: None,
                scopes: HashMap::new(),
                operations: HashMap::new(),
                cancelled: HashSet::new(),
                subscriptions: HashMap::new(),
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

    pub async fn start(self: &Arc<Self>) -> Result<NativeStatus, String> {
        let (generation, cancel, existing) = {
            let mut session = self.lock()?;
            if matches!(session.phase, "ready" | "bootstrapping") {
                return Ok(session.status());
            }
            session.invalidate()?;
            session.phase = "bootstrapping";
            session.error = None;
            let cancel = CancellationToken::new();
            session.bootstrap_cancel = Some(cancel.clone());
            (session.generation, cancel, session.client.clone())
        };
        let result = self.bootstrap(generation, &cancel, existing).await;
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
        let client = session
            .client
            .as_ref()
            .ok_or("Tor client unavailable")?
            .isolated_client();
        let id = uuid::Uuid::new_v4().to_string();
        session.scopes.insert(
            id.clone(),
            Scope {
                client,
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
        if session.cancelled.contains(&request.request_id) {
            return Err("private request cancelled".into());
        }
        if session.operations.len() >= MAX_OPERATIONS
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
        let client = scope.client.clone();
        let cancel = CancellationToken::new();
        session.operations.insert(
            request.request_id.clone(),
            Operation {
                scope: request.scope.clone(),
                cancel: cancel.clone(),
                socket,
            },
        );
        Ok(Lease {
            inner: Arc::downgrade(self),
            id: request.request_id.clone(),
            scope: request.scope.clone(),
            generation: request.generation,
            client,
            cancel,
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
            session
                .scopes
                .get_mut(&request.scope)
                .ok_or("private subscription scope closed")?
                .subscription = None;
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
}

impl Session {
    fn status(&self) -> NativeStatus {
        NativeStatus {
            phase: self.phase.into(),
            generation: self.generation,
            error: self.error.clone(),
            progress: if self.phase == "bootstrapping" {
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
        self.subscriptions.clear();
        Ok(())
    }
}

impl Lease {
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

    #[tokio::test]
    async fn unrelated_scopes_get_separate_handles_and_unknown_scopes_fail() {
        let inner = ready();
        let first = inner.scope(1, "indexer").unwrap();
        let second = inner.scope(1, "indexer").unwrap();
        assert_ne!(first.id, second.id);
        let session = inner.lock().unwrap();
        assert!(!Arc::ptr_eq(
            &session.scopes.get(&first.id).unwrap().client,
            &session.scopes.get(&second.id).unwrap().client
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
        assert!(register(&inner, &request(1, scope.id, "early")).is_err());
        assert!(inner.lock().unwrap().operations.is_empty());
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
}
