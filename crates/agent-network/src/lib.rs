// Source-adapted from OpenAI Codex rust-v0.145.0
// codex-rs/network-proxy/{attribution,config,connect_policy,network_policy,policy,proxy}.rs.
//! Source-native, execution-attributed network sandbox proxy.

use std::collections::{BTreeMap, HashMap};
use std::future::Future;
use std::io;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::pin::Pin;
use std::sync::{Arc, Mutex, Weak};

use base64::Engine as _;
use globset::{GlobBuilder, GlobSet, GlobSetBuilder};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream, lookup_host};
use tokio_util::sync::CancellationToken;
use url::Url;
use uuid::Uuid;

pub const PROXY_ACTIVE_ENV_KEY: &str = "CODEX_NETWORK_PROXY_ACTIVE";
pub const PROXY_ATTRIBUTION_TOKEN_ENV_KEY: &str = "CODEX_NETWORK_PROXY_ATTRIBUTION";
const MAX_HEADER_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")]
pub enum NetworkDomainPermission {
    None,
    Allow,
    Deny,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum NetworkMode {
    Limited,
    #[default]
    Full,
}

impl NetworkMode {
    pub fn allows_method(self, method: &str) -> bool {
        matches!(self, Self::Full) || matches!(method, "GET" | "HEAD" | "OPTIONS")
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct NetworkPolicy {
    pub enabled: bool,
    pub mode: NetworkMode,
    pub domains: BTreeMap<String, NetworkDomainPermission>,
    pub allow_local_binding: bool,
}

impl Default for NetworkPolicy {
    fn default() -> Self {
        Self {
            enabled: false,
            mode: NetworkMode::Full,
            domains: BTreeMap::new(),
            allow_local_binding: false,
        }
    }
}

impl NetworkPolicy {
    pub fn upsert(&mut self, host: &str, permission: NetworkDomainPermission) {
        let host = normalize_host(host);
        self.domains
            .retain(|pattern, _| normalize_pattern(pattern) != host);
        self.domains.insert(host, permission);
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NetworkDecisionSource {
    BaselinePolicy,
    ModeGuard,
    ProxyState,
    Decider,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NetworkProtocol {
    Http,
    HttpsConnect,
    Socks5Tcp,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NetworkApprovalRequest {
    pub thread_id: String,
    pub turn_id: String,
    pub item_id: String,
    pub command: String,
    pub protocol: NetworkProtocol,
    pub host: String,
    pub port: u16,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NetworkPolicyAmendment {
    pub host: String,
    pub action: NetworkDomainPermission,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NetworkApprovalDecision {
    AllowOnce,
    Apply(NetworkPolicyAmendment),
    Deny,
    Cancel,
}

pub type NetworkApprovalFuture =
    Pin<Box<dyn Future<Output = NetworkApprovalDecision> + Send + 'static>>;
pub type NetworkApprover =
    Arc<dyn Fn(NetworkApprovalRequest) -> NetworkApprovalFuture + Send + Sync>;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NetworkAuditEvent {
    pub thread_id: String,
    pub turn_id: String,
    pub item_id: String,
    pub protocol: NetworkProtocol,
    pub host: String,
    pub port: u16,
    pub decision: String,
    pub source: NetworkDecisionSource,
    pub reason: String,
}

#[derive(Clone)]
pub struct NetworkExecutionRequest {
    pub thread_id: String,
    pub turn_id: String,
    pub item_id: String,
    pub command: String,
    pub policy: NetworkPolicy,
    pub approver: Option<NetworkApprover>,
}

#[derive(Clone)]
pub struct NetworkRuntime {
    inner: Arc<RuntimeInner>,
}

struct RuntimeInner {
    contexts: Mutex<HashMap<String, ExecutionContext>>,
    persistent_rules: Mutex<BTreeMap<String, NetworkDomainPermission>>,
    audit: Mutex<Vec<NetworkAuditEvent>>,
    proxy: tokio::sync::OnceCell<ProxyState>,
    shutdown: CancellationToken,
}

struct ProxyState {
    http_addr: SocketAddr,
    socks_addr: SocketAddr,
}

#[derive(Clone)]
struct ExecutionContext {
    request: NetworkExecutionRequest,
    session_rules: Arc<Mutex<BTreeMap<String, NetworkDomainPermission>>>,
}

pub struct PreparedNetwork {
    token: String,
    runtime: Weak<RuntimeInner>,
    env: HashMap<String, Option<String>>,
    loopback_ports: Vec<u16>,
}

impl PreparedNetwork {
    pub fn env(&self) -> &HashMap<String, Option<String>> {
        &self.env
    }

    pub fn loopback_ports(&self) -> &[u16] {
        &self.loopback_ports
    }
}

impl Drop for PreparedNetwork {
    fn drop(&mut self) {
        if let Some(runtime) = self.runtime.upgrade()
            && let Ok(mut contexts) = runtime.contexts.lock()
        {
            contexts.remove(&self.token);
        }
    }
}

impl Default for NetworkRuntime {
    fn default() -> Self {
        Self::new()
    }
}

impl NetworkRuntime {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(RuntimeInner {
                contexts: Mutex::new(HashMap::new()),
                persistent_rules: Mutex::new(BTreeMap::new()),
                audit: Mutex::new(Vec::new()),
                proxy: tokio::sync::OnceCell::new(),
                shutdown: CancellationToken::new(),
            }),
        }
    }

    pub fn apply_persistent_amendment(&self, amendment: NetworkPolicyAmendment) {
        if let Ok(mut rules) = self.inner.persistent_rules.lock() {
            rules.insert(normalize_host(&amendment.host), amendment.action);
        }
    }

    pub fn replace_persistent_rules(
        &self,
        rules: impl IntoIterator<Item = NetworkPolicyAmendment>,
    ) {
        if let Ok(mut current) = self.inner.persistent_rules.lock() {
            current.clear();
            for rule in rules {
                current.insert(normalize_host(&rule.host), rule.action);
            }
        }
    }

    pub fn audit_events(&self) -> Vec<NetworkAuditEvent> {
        self.inner
            .audit
            .lock()
            .map(|events| events.clone())
            .unwrap_or_default()
    }

    pub async fn prepare_execution(
        &self,
        request: NetworkExecutionRequest,
    ) -> Result<PreparedNetwork, NetworkError> {
        if !request.policy.enabled {
            return Err(NetworkError::Disabled);
        }
        let proxy = self
            .inner
            .proxy
            .get_or_try_init(|| start_proxy(Arc::clone(&self.inner)))
            .await?;
        let token = Uuid::new_v4().simple().to_string();
        self.inner
            .contexts
            .lock()
            .map_err(|_| NetworkError::StatePoisoned)?
            .insert(
                token.clone(),
                ExecutionContext {
                    request,
                    session_rules: Arc::new(Mutex::new(BTreeMap::new())),
                },
            );
        let user = percent_encode_user(&token);
        let http = format!("http://{user}:x@{}", proxy.http_addr);
        let socks = format!("socks5h://{user}:x@{}", proxy.socks_addr);
        let mut env = HashMap::new();
        for key in ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"] {
            env.insert(key.into(), Some(http.clone()));
        }
        for key in ["ALL_PROXY", "all_proxy"] {
            env.insert(key.into(), Some(socks.clone()));
        }
        for key in ["NO_PROXY", "no_proxy"] {
            env.insert(key.into(), Some(String::new()));
        }
        env.insert(PROXY_ACTIVE_ENV_KEY.into(), Some("1".into()));
        env.insert(PROXY_ATTRIBUTION_TOKEN_ENV_KEY.into(), Some(token.clone()));
        Ok(PreparedNetwork {
            token,
            runtime: Arc::downgrade(&self.inner),
            env,
            loopback_ports: vec![proxy.http_addr.port(), proxy.socks_addr.port()],
        })
    }
}

impl Drop for RuntimeInner {
    fn drop(&mut self) {
        self.shutdown.cancel();
    }
}

#[derive(Debug, thiserror::Error)]
pub enum NetworkError {
    #[error("network policy is disabled")]
    Disabled,
    #[error("network proxy state lock poisoned")]
    StatePoisoned,
    #[error("network proxy I/O failed: {0}")]
    Io(#[from] io::Error),
}

async fn start_proxy(runtime: Arc<RuntimeInner>) -> Result<ProxyState, NetworkError> {
    let http = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await?;
    let socks = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await?;
    let http_addr = http.local_addr()?;
    let socks_addr = socks.local_addr()?;
    let shutdown = runtime.shutdown.clone();
    let http_runtime = Arc::clone(&runtime);
    tokio::spawn(async move { accept_loop(http, http_runtime, false, shutdown).await });
    let shutdown = runtime.shutdown.clone();
    tokio::spawn(async move { accept_loop(socks, runtime, true, shutdown).await });
    Ok(ProxyState {
        http_addr,
        socks_addr,
    })
}

async fn accept_loop(
    listener: TcpListener,
    runtime: Arc<RuntimeInner>,
    socks: bool,
    shutdown: CancellationToken,
) {
    loop {
        tokio::select! {
            _ = shutdown.cancelled() => break,
            accepted = listener.accept() => match accepted {
                Ok((stream, _)) => {
                    let runtime = Arc::clone(&runtime);
                    tokio::spawn(async move {
                        let _ = if socks { handle_socks(stream, runtime).await } else { handle_http(stream, runtime).await };
                    });
                }
                Err(_) => break,
            }
        }
    }
}

async fn handle_http(mut client: TcpStream, runtime: Arc<RuntimeInner>) -> io::Result<()> {
    let header = read_header(&mut client).await?;
    let text = String::from_utf8_lossy(&header);
    let mut lines = text.split("\r\n");
    let request_line = lines
        .next()
        .ok_or_else(|| invalid("missing HTTP request line"))?;
    let mut request_parts = request_line.split_whitespace();
    let method = request_parts
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    let target = request_parts.next().unwrap_or_default();
    let version = request_parts.next().unwrap_or("HTTP/1.1");
    let headers = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(name, value)| (name.trim().to_string(), value.trim().to_string()))
        .collect::<Vec<_>>();
    let token = proxy_basic_user(&headers).ok_or_else(|| denied("missing proxy attribution"))?;
    let (host, port, origin_target) = if method == "CONNECT" {
        let (host, port) = split_host_port(target, 443)?;
        (host, port, None)
    } else {
        let url = Url::parse(target).map_err(|_| invalid("HTTP proxy target must be absolute"))?;
        let host = url
            .host_str()
            .ok_or_else(|| invalid("target host is missing"))?
            .to_string();
        let port = url
            .port_or_known_default()
            .ok_or_else(|| invalid("target port is missing"))?;
        let mut path = url.path().to_string();
        if let Some(query) = url.query() {
            path.push('?');
            path.push_str(query);
        }
        (host, port, Some(path))
    };
    let protocol = if method == "CONNECT" {
        NetworkProtocol::HttpsConnect
    } else {
        NetworkProtocol::Http
    };
    if let Err(error) = authorize(&runtime, &token, protocol, &host, port, Some(&method)).await {
        let reason = error.to_string();
        let body = format!("Network access was blocked by policy: {reason}.");
        client
            .write_all(
                format!(
                    "HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nX-Proxy-Error: blocked-by-policy\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                )
                .as_bytes(),
            )
            .await?;
        return Ok(());
    }
    let mut upstream = connect_public(
        &host,
        port,
        context_policy(&runtime, &token)?
            .request
            .policy
            .allow_local_binding,
    )
    .await?;
    if method == "CONNECT" {
        client
            .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            .await?;
        let _ = tokio::io::copy_bidirectional(&mut client, &mut upstream).await?;
        return Ok(());
    }
    let mut outgoing = format!(
        "{method} {} {version}\r\n",
        origin_target.unwrap_or_else(|| "/".into())
    );
    for (name, value) in headers {
        if !name.eq_ignore_ascii_case("proxy-authorization")
            && !name.eq_ignore_ascii_case("proxy-connection")
        {
            outgoing.push_str(&name);
            outgoing.push_str(": ");
            outgoing.push_str(&value);
            outgoing.push_str("\r\n");
        }
    }
    outgoing.push_str("\r\n");
    upstream.write_all(outgoing.as_bytes()).await?;
    let _ = tokio::io::copy_bidirectional(&mut client, &mut upstream).await?;
    Ok(())
}

async fn handle_socks(mut client: TcpStream, runtime: Arc<RuntimeInner>) -> io::Result<()> {
    let version = client.read_u8().await?;
    if version != 5 {
        return Err(invalid("unsupported SOCKS version"));
    }
    let methods_len = client.read_u8().await? as usize;
    let mut methods = vec![0; methods_len];
    client.read_exact(&mut methods).await?;
    if !methods.contains(&2) {
        client.write_all(&[5, 0xff]).await?;
        return Err(denied("SOCKS attribution is required"));
    }
    client.write_all(&[5, 2]).await?;
    if client.read_u8().await? != 1 {
        return Err(invalid("invalid SOCKS auth version"));
    }
    let user_len = client.read_u8().await? as usize;
    let mut user = vec![0; user_len];
    client.read_exact(&mut user).await?;
    let pass_len = client.read_u8().await? as usize;
    let mut pass = vec![0; pass_len];
    client.read_exact(&mut pass).await?;
    let token = String::from_utf8(user).map_err(|_| invalid("invalid SOCKS token"))?;
    if !runtime
        .contexts
        .lock()
        .map_err(|_| denied("proxy state unavailable"))?
        .contains_key(&token)
    {
        client.write_all(&[1, 1]).await?;
        return Err(denied("unknown proxy attribution"));
    }
    client.write_all(&[1, 0]).await?;
    if client.read_u8().await? != 5 || client.read_u8().await? != 1 {
        return Err(denied("only SOCKS CONNECT is supported"));
    }
    let _reserved = client.read_u8().await?;
    let atyp = client.read_u8().await?;
    let host = match atyp {
        1 => {
            let mut b = [0; 4];
            client.read_exact(&mut b).await?;
            IpAddr::V4(b.into()).to_string()
        }
        3 => {
            let n = client.read_u8().await? as usize;
            let mut b = vec![0; n];
            client.read_exact(&mut b).await?;
            String::from_utf8(b).map_err(|_| invalid("invalid SOCKS hostname"))?
        }
        4 => {
            let mut b = [0; 16];
            client.read_exact(&mut b).await?;
            IpAddr::V6(b.into()).to_string()
        }
        _ => return Err(invalid("unsupported SOCKS address type")),
    };
    let port = client.read_u16().await?;
    if authorize(
        &runtime,
        &token,
        NetworkProtocol::Socks5Tcp,
        &host,
        port,
        None,
    )
    .await
    .is_err()
    {
        client.write_all(&[5, 2, 0, 1, 0, 0, 0, 0, 0, 0]).await?;
        return Ok(());
    }
    let allow_local = context_policy(&runtime, &token)?
        .request
        .policy
        .allow_local_binding;
    let mut upstream = connect_public(&host, port, allow_local).await?;
    client.write_all(&[5, 0, 0, 1, 127, 0, 0, 1, 0, 0]).await?;
    let _ = tokio::io::copy_bidirectional(&mut client, &mut upstream).await?;
    Ok(())
}

async fn authorize(
    runtime: &Arc<RuntimeInner>,
    token: &str,
    protocol: NetworkProtocol,
    host: &str,
    port: u16,
    method: Option<&str>,
) -> io::Result<()> {
    let context = context_policy(runtime, token)?;
    let host = normalize_host(host);
    let (decision, source, reason) = decide(runtime, &context, protocol, &host, method)?;
    let mut allowed = decision == Decision::Allow;
    if decision == Decision::Ask
        && let Some(approver) = &context.request.approver
    {
        let result = approver(NetworkApprovalRequest {
            thread_id: context.request.thread_id.clone(),
            turn_id: context.request.turn_id.clone(),
            item_id: context.request.item_id.clone(),
            command: context.request.command.clone(),
            protocol,
            host: host.clone(),
            port,
            reason: reason.clone(),
        })
        .await;
        match result {
            NetworkApprovalDecision::AllowOnce => allowed = true,
            NetworkApprovalDecision::Apply(amendment) => {
                let normalized = normalize_host(&amendment.host);
                if let Ok(mut rules) = context.session_rules.lock() {
                    rules.insert(normalized, amendment.action);
                }
                allowed = amendment.action == NetworkDomainPermission::Allow;
            }
            NetworkApprovalDecision::Cancel | NetworkApprovalDecision::Deny => {}
        }
    }
    if let Ok(mut audit) = runtime.audit.lock() {
        audit.push(NetworkAuditEvent {
            thread_id: context.request.thread_id,
            turn_id: context.request.turn_id,
            item_id: context.request.item_id,
            protocol,
            host: host.clone(),
            port,
            decision: if allowed {
                "allow"
            } else if decision == Decision::Ask {
                "ask"
            } else {
                "deny"
            }
            .into(),
            source,
            reason: reason.clone(),
        });
    }
    if allowed {
        Ok(())
    } else {
        Err(denied(&reason))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Decision {
    Allow,
    Deny,
    Ask,
}

fn decide(
    runtime: &RuntimeInner,
    context: &ExecutionContext,
    protocol: NetworkProtocol,
    host: &str,
    method: Option<&str>,
) -> io::Result<(Decision, NetworkDecisionSource, String)> {
    let policy = &context.request.policy;
    if !policy.enabled {
        return Ok((
            Decision::Deny,
            NetworkDecisionSource::ProxyState,
            "proxy_disabled".into(),
        ));
    }
    if policy.mode == NetworkMode::Limited
        && (protocol != NetworkProtocol::Http
            || !method.is_some_and(|method| policy.mode.allows_method(method)))
    {
        return Ok((
            Decision::Deny,
            NetworkDecisionSource::ModeGuard,
            "method_not_allowed".into(),
        ));
    }
    if let Ok(rules) = context.session_rules.lock()
        && let Some(permission) = matching_permission(&rules, host)?
    {
        return permission_decision(permission, NetworkDecisionSource::Decider);
    }
    if let Ok(rules) = runtime.persistent_rules.lock()
        && let Some(permission) = matching_permission(&rules, host)?
    {
        return permission_decision(permission, NetworkDecisionSource::Decider);
    }
    if let Some(permission) = matching_permission(&policy.domains, host)? {
        return permission_decision(permission, NetworkDecisionSource::BaselinePolicy);
    }
    let has_allowlist = policy
        .domains
        .values()
        .any(|p| *p == NetworkDomainPermission::Allow);
    if has_allowlist {
        Ok((
            Decision::Ask,
            NetworkDecisionSource::Decider,
            "not_allowed".into(),
        ))
    } else {
        Ok((
            Decision::Allow,
            NetworkDecisionSource::BaselinePolicy,
            "allow".into(),
        ))
    }
}

fn permission_decision(
    permission: NetworkDomainPermission,
    source: NetworkDecisionSource,
) -> io::Result<(Decision, NetworkDecisionSource, String)> {
    Ok(match permission {
        NetworkDomainPermission::Allow => (Decision::Allow, source, "allow".into()),
        NetworkDomainPermission::Deny => (Decision::Deny, source, "denied".into()),
        NetworkDomainPermission::None => (
            Decision::Ask,
            NetworkDecisionSource::Decider,
            "not_allowed".into(),
        ),
    })
}

fn context_policy(runtime: &RuntimeInner, token: &str) -> io::Result<ExecutionContext> {
    runtime
        .contexts
        .lock()
        .map_err(|_| denied("proxy state unavailable"))?
        .get(token)
        .cloned()
        .ok_or_else(|| denied("unknown proxy attribution"))
}

fn matching_permission(
    rules: &BTreeMap<String, NetworkDomainPermission>,
    host: &str,
) -> io::Result<Option<NetworkDomainPermission>> {
    let mut deny = false;
    let mut allow = false;
    let mut none = false;
    for (pattern, permission) in rules {
        let set = compile_pattern(pattern)?;
        if set.is_match(host) {
            match permission {
                NetworkDomainPermission::Deny => deny = true,
                NetworkDomainPermission::Allow => allow = true,
                NetworkDomainPermission::None => none = true,
            }
        }
    }
    Ok(if deny {
        Some(NetworkDomainPermission::Deny)
    } else if allow {
        Some(NetworkDomainPermission::Allow)
    } else if none {
        Some(NetworkDomainPermission::None)
    } else {
        None
    })
}

fn compile_pattern(pattern: &str) -> io::Result<GlobSet> {
    let pattern = normalize_pattern(pattern);
    if pattern == "*" {
        return globset(["*"]);
    }
    if let Some(domain) = pattern.strip_prefix("**.") {
        return globset([domain, &format!("?*.{domain}")]);
    }
    if let Some(domain) = pattern.strip_prefix("*.") {
        return globset([&format!("?*.{domain}")]);
    }
    globset([pattern.as_str()])
}

fn globset<const N: usize>(patterns: [&str; N]) -> io::Result<GlobSet> {
    let mut builder = GlobSetBuilder::new();
    for pattern in patterns {
        builder.add(
            GlobBuilder::new(pattern)
                .case_insensitive(true)
                .build()
                .map_err(invalid)?,
        );
    }
    builder.build().map_err(invalid)
}

pub fn normalize_host(host: &str) -> String {
    let host = host.trim();
    if host.starts_with('[')
        && let Some(end) = host.find(']')
    {
        return host[1..end].to_ascii_lowercase();
    }
    if host.bytes().filter(|b| *b == b':').count() == 1 {
        return host
            .split(':')
            .next()
            .unwrap_or_default()
            .trim_end_matches('.')
            .to_ascii_lowercase();
    }
    host.trim_end_matches('.').to_ascii_lowercase()
}

fn normalize_pattern(pattern: &str) -> String {
    let pattern = pattern.trim();
    if pattern == "*" {
        return "*".into();
    }
    for prefix in ["**.", "*."] {
        if let Some(domain) = pattern.strip_prefix(prefix) {
            return format!("{prefix}{}", normalize_host(domain));
        }
    }
    normalize_host(pattern)
}

async fn connect_public(host: &str, port: u16, allow_local: bool) -> io::Result<TcpStream> {
    let addrs = lookup_host((host, port)).await?.collect::<Vec<_>>();
    if addrs.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            "host did not resolve",
        ));
    }
    if !allow_local && addrs.iter().any(|addr| is_non_public_ip(addr.ip())) {
        return Err(denied("not_allowed_local"));
    }
    let mut last = None;
    for addr in addrs {
        match TcpStream::connect(addr).await {
            Ok(stream) => return Ok(stream),
            Err(error) => last = Some(error),
        }
    }
    Err(last.unwrap_or_else(|| io::Error::other("connection failed")))
}

pub fn is_non_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            ip.is_loopback()
                || ip.is_private()
                || ip.is_link_local()
                || ip.is_unspecified()
                || ip.is_multicast()
                || ip.is_broadcast()
                || cidr4(ip, [100, 64, 0, 0], 10)
                || cidr4(ip, [198, 18, 0, 0], 15)
                || cidr4(ip, [240, 0, 0, 0], 4)
        }
        IpAddr::V6(ip) => is_non_public_ipv6(ip),
    }
}
fn is_non_public_ipv6(ip: Ipv6Addr) -> bool {
    ip.to_ipv4()
        .is_some_and(|ip| is_non_public_ip(IpAddr::V4(ip)))
        || ip.is_loopback()
        || ip.is_unspecified()
        || ip.is_multicast()
        || ip.is_unique_local()
        || ip.is_unicast_link_local()
}
fn cidr4(ip: Ipv4Addr, base: [u8; 4], prefix: u8) -> bool {
    let mask = if prefix == 0 {
        0
    } else {
        u32::MAX << (32 - prefix)
    };
    (u32::from(ip) & mask) == (u32::from(Ipv4Addr::from(base)) & mask)
}

async fn read_header(stream: &mut TcpStream) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    let mut byte = [0; 1];
    while bytes.len() < MAX_HEADER_BYTES {
        if stream.read(&mut byte).await? == 0 {
            return Err(invalid("unexpected EOF"));
        }
        bytes.push(byte[0]);
        if bytes.ends_with(b"\r\n\r\n") {
            return Ok(bytes);
        }
    }
    Err(invalid("proxy header too large"))
}
fn proxy_basic_user(headers: &[(String, String)]) -> Option<String> {
    let value = headers
        .iter()
        .find(|(n, _)| n.eq_ignore_ascii_case("proxy-authorization"))?
        .1
        .strip_prefix("Basic ")?;
    let raw = base64::engine::general_purpose::STANDARD
        .decode(value)
        .ok()?;
    let text = String::from_utf8(raw).ok()?;
    Some(text.split(':').next()?.to_string())
}
fn split_host_port(value: &str, default: u16) -> io::Result<(String, u16)> {
    let url = Url::parse(&format!("http://{value}")).map_err(|_| invalid("invalid host:port"))?;
    Ok((
        url.host_str()
            .ok_or_else(|| invalid("missing host"))?
            .to_string(),
        url.port().unwrap_or(default),
    ))
}
fn percent_encode_user(value: &str) -> String {
    value
        .bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}
fn invalid(error: impl ToString) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, error.to_string())
}
fn denied(error: impl ToString) -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn domain_precedence_and_wildcards_match_codex() {
        let mut rules = BTreeMap::new();
        rules.insert("**.example.com".into(), NetworkDomainPermission::Allow);
        rules.insert("blocked.example.com".into(), NetworkDomainPermission::Deny);
        assert_eq!(
            matching_permission(&rules, "example.com").unwrap(),
            Some(NetworkDomainPermission::Allow)
        );
        assert_eq!(
            matching_permission(&rules, "api.example.com").unwrap(),
            Some(NetworkDomainPermission::Allow)
        );
        assert_eq!(
            matching_permission(&rules, "blocked.example.com").unwrap(),
            Some(NetworkDomainPermission::Deny)
        );
    }

    #[test]
    fn host_normalization_and_private_ranges_are_fail_closed() {
        assert_eq!(normalize_host("Example.COM.:443"), "example.com");
        assert!(is_non_public_ip("127.0.0.1".parse().unwrap()));
        assert!(is_non_public_ip("10.0.0.1".parse().unwrap()));
        assert!(!is_non_public_ip("8.8.8.8".parse().unwrap()));
    }

    #[tokio::test]
    async fn attributed_http_proxy_allows_exact_host_and_rejects_unknown_token() {
        let origin = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let origin_addr = origin.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut stream, _) = origin.accept().await.unwrap();
            let mut buf = [0; 1024];
            let _ = stream.read(&mut buf).await;
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok")
                .await
                .unwrap();
        });
        let runtime = NetworkRuntime::new();
        let prepared = runtime
            .prepare_execution(NetworkExecutionRequest {
                thread_id: "t".into(),
                turn_id: "u".into(),
                item_id: "i".into(),
                command: "curl".into(),
                policy: NetworkPolicy {
                    enabled: true,
                    allow_local_binding: true,
                    ..Default::default()
                },
                approver: None,
            })
            .await
            .unwrap();
        let proxy = prepared.env()["HTTP_PROXY"].as_ref().unwrap();
        let url = Url::parse(proxy).unwrap();
        let mut stream = TcpStream::connect((url.host_str().unwrap(), url.port().unwrap()))
            .await
            .unwrap();
        let auth =
            base64::engine::general_purpose::STANDARD.encode(format!("{}:x", url.username()));
        stream.write_all(format!("GET http://{}:{}/ HTTP/1.1\r\nHost: {}\r\nProxy-Authorization: Basic {}\r\n\r\n",origin_addr.ip(),origin_addr.port(),origin_addr,auth).as_bytes()).await.unwrap();
        let mut response = Vec::new();
        stream.read_to_end(&mut response).await.unwrap();
        assert!(String::from_utf8_lossy(&response).contains("ok"));

        let mut denied = TcpStream::connect((url.host_str().unwrap(), url.port().unwrap()))
            .await
            .unwrap();
        let bad_auth = base64::engine::general_purpose::STANDARD.encode("unknown:x");
        denied
            .write_all(
                format!(
                    "GET http://{origin_addr}/ HTTP/1.1\r\nHost: {origin_addr}\r\nProxy-Authorization: Basic {bad_auth}\r\n\r\n"
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        let mut response = Vec::new();
        denied.read_to_end(&mut response).await.unwrap();
        assert!(String::from_utf8_lossy(&response).contains("403 Forbidden"));
    }

    #[tokio::test]
    async fn approval_amendment_is_scoped_to_one_execution() {
        let runtime = NetworkRuntime::new();
        let approver: NetworkApprover = Arc::new(|request| {
            Box::pin(async move {
                NetworkApprovalDecision::Apply(NetworkPolicyAmendment {
                    host: request.host,
                    action: NetworkDomainPermission::Allow,
                })
            })
        });
        let request = NetworkExecutionRequest {
            thread_id: "t".into(),
            turn_id: "u".into(),
            item_id: "i".into(),
            command: "curl".into(),
            policy: NetworkPolicy {
                enabled: true,
                domains: BTreeMap::from([(
                    "allowed.example".into(),
                    NetworkDomainPermission::Allow,
                )]),
                ..Default::default()
            },
            approver: Some(approver),
        };
        let prepared = runtime.prepare_execution(request).await.unwrap();
        let context = context_policy(&runtime.inner, &prepared.token).unwrap();
        assert_eq!(
            decide(
                &runtime.inner,
                &context,
                NetworkProtocol::Http,
                "unknown.example",
                Some("GET")
            )
            .unwrap()
            .0,
            Decision::Ask
        );
    }
}
