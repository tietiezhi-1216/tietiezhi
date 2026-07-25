//! Source-native Codex Remote Control state and authorization.
//!
//! The pinned Codex App Server delegates its remote transport to an OpenAI
//! service. This crate keeps the same App Server lifecycle while using a
//! transport-neutral, locally owned authorization store. A desktop transport
//! (Tietiezhi Device Fabric) may claim pairings and forward requests, but it
//! cannot bypass per-client and per-Thread grants.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use thiserror::Error;
use uuid::Uuid;

const STORE_VERSION: u32 = 1;
const PAIRING_TTL_SECS: i64 = 600;
const MAX_COMPLETED_REQUESTS: usize = 512;

#[derive(Debug, Error)]
pub enum RemoteError {
    #[error("{0}")]
    Invalid(String),
    #[error("{0}")]
    Unauthorized(String),
    #[error("{0}")]
    Conflict(String),
    #[error("remote control state error: {0}")]
    State(String),
    #[error("remote control I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("remote control JSON error: {0}")]
    Json(#[from] serde_json::Error),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteClient {
    pub client_id: String,
    pub display_name: Option<String>,
    pub device_type: Option<String>,
    pub platform: Option<String>,
    pub os_version: Option<String>,
    pub device_model: Option<String>,
    pub app_version: Option<String>,
    pub last_seen_at: Option<i64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteClientMetadata {
    pub display_name: Option<String>,
    pub device_type: Option<String>,
    pub platform: Option<String>,
    pub os_version: Option<String>,
    pub device_model: Option<String>,
    pub app_version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Pairing {
    pairing_code: String,
    manual_pairing_code: Option<String>,
    expires_at: i64,
    claimed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CompletedRemoteRequest {
    client_id: String,
    thread_id: String,
    response: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct RemoteState {
    version: u32,
    enabled: bool,
    installation_id: String,
    environment_id: String,
    clients: BTreeMap<String, RemoteClient>,
    pairings: BTreeMap<String, Pairing>,
    thread_grants: BTreeMap<String, BTreeSet<String>>,
    completed_requests: BTreeMap<String, CompletedRemoteRequest>,
    completed_order: VecDeque<String>,
}

impl Default for RemoteState {
    fn default() -> Self {
        Self {
            version: STORE_VERSION,
            enabled: false,
            installation_id: Uuid::new_v4().to_string(),
            environment_id: Uuid::new_v4().to_string(),
            clients: BTreeMap::new(),
            pairings: BTreeMap::new(),
            thread_grants: BTreeMap::new(),
            completed_requests: BTreeMap::new(),
            completed_order: VecDeque::new(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemoteStatus {
    Disabled,
    Connecting,
    Connected,
    Errored,
}

impl RemoteStatus {
    pub fn wire(self) -> &'static str {
        match self {
            Self::Disabled => "disabled",
            Self::Connecting => "connecting",
            Self::Connected => "connected",
            Self::Errored => "errored",
        }
    }
}

#[derive(Debug, Clone, Default)]
struct RuntimeFlags {
    ephemeral_enabled: bool,
    transport_connected: bool,
    transport_error: Option<String>,
    pending_requests: BTreeSet<String>,
}

#[derive(Clone)]
pub struct RemoteControlRuntime {
    path: Arc<PathBuf>,
    state: Arc<Mutex<RemoteState>>,
    flags: Arc<Mutex<RuntimeFlags>>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum RemoteRequestAdmission {
    Execute,
    Cached(Value),
}

impl RemoteControlRuntime {
    pub fn open(root: impl AsRef<Path>) -> Result<Self, RemoteError> {
        let root = root.as_ref();
        fs::create_dir_all(root)?;
        let path = root.join("remote-control.json");
        let mut state = if path.exists() {
            serde_json::from_slice::<RemoteState>(&fs::read(&path)?)?
        } else {
            RemoteState::default()
        };
        if state.installation_id.is_empty() {
            state.installation_id = Uuid::new_v4().to_string();
        }
        if state.environment_id.is_empty() {
            state.environment_id = Uuid::new_v4().to_string();
        }
        state.version = STORE_VERSION;
        prune_pairings(&mut state);
        atomic_write(&path, &serde_json::to_vec_pretty(&state)?)?;
        Ok(Self {
            path: Arc::new(path),
            state: Arc::new(Mutex::new(state)),
            flags: Arc::new(Mutex::new(RuntimeFlags::default())),
        })
    }

    pub fn status(&self) -> Result<Value, RemoteError> {
        let state = self.lock_state()?;
        let flags = self.lock_flags()?;
        Ok(status_value(&state, &flags))
    }

    pub fn status_notification(&self) -> Result<Value, RemoteError> {
        Ok(json!({
            "method":"remoteControl/status/changed",
            "params":self.status()?
        }))
    }

    pub fn set_transport_state(
        &self,
        connected: bool,
        error: Option<String>,
    ) -> Result<Value, RemoteError> {
        let mut flags = self.lock_flags()?;
        flags.transport_connected = connected;
        flags.transport_error = error;
        drop(flags);
        self.status_notification()
    }

    pub fn enable(&self) -> Result<Value, RemoteError> {
        self.mutate(|state| state.enabled = true)?;
        self.status()
    }

    pub fn enable_ephemeral(&self) -> Result<Value, RemoteError> {
        self.lock_flags()?.ephemeral_enabled = true;
        self.status()
    }

    pub fn disable(&self) -> Result<Value, RemoteError> {
        self.mutate(|state| {
            state.enabled = false;
            state.pairings.clear();
        })?;
        self.status()
    }

    pub fn disable_ephemeral(&self) -> Result<Value, RemoteError> {
        self.lock_flags()?.ephemeral_enabled = false;
        self.status()
    }

    pub fn start_pairing(&self, manual_code: bool) -> Result<Value, RemoteError> {
        let mut state = self.lock_state()?;
        self.ensure_runtime_enabled(&state)?;
        prune_pairings(&mut state);
        let pairing_code = Uuid::new_v4().to_string();
        let manual_pairing_code = manual_code.then(|| manual_code_for(&pairing_code));
        let expires_at = now_secs().saturating_add(PAIRING_TTL_SECS);
        state.pairings.insert(
            pairing_code.clone(),
            Pairing {
                pairing_code: pairing_code.clone(),
                manual_pairing_code: manual_pairing_code.clone(),
                expires_at,
                claimed: false,
            },
        );
        self.persist_locked(&state)?;
        Ok(json!({
            "pairingCode":pairing_code,
            "manualPairingCode":manual_pairing_code,
            "environmentId":state.environment_id,
            "expiresAt":expires_at
        }))
    }

    pub fn pairing_status(
        &self,
        pairing_code: Option<&str>,
        manual_pairing_code: Option<&str>,
    ) -> Result<Value, RemoteError> {
        if pairing_code.is_some() == manual_pairing_code.is_some() {
            return Err(RemoteError::Invalid(
                "pairing status requires exactly one pairing code".into(),
            ));
        }
        let mut state = self.lock_state()?;
        prune_pairings(&mut state);
        let pairing = find_pairing(&state, pairing_code, manual_pairing_code)
            .ok_or_else(|| RemoteError::Invalid("pairing code is unknown or expired".into()))?;
        let claimed = pairing.claimed;
        self.persist_locked(&state)?;
        Ok(json!({"claimed":claimed}))
    }

    /// Claiming is a transport-side operation. It deliberately is not exposed
    /// as an App Server client request, matching Codex's service-owned claim.
    pub fn claim_pairing(
        &self,
        pairing_code: Option<&str>,
        manual_pairing_code: Option<&str>,
        client_id: &str,
        metadata: RemoteClientMetadata,
    ) -> Result<RemoteClient, RemoteError> {
        validate_identifier("clientId", client_id)?;
        if pairing_code.is_some() == manual_pairing_code.is_some() {
            return Err(RemoteError::Invalid(
                "claim requires exactly one pairing code".into(),
            ));
        }
        let mut state = self.lock_state()?;
        self.ensure_runtime_enabled(&state)?;
        prune_pairings(&mut state);
        let pairing_key =
            find_pairing_key(&state, pairing_code, manual_pairing_code).ok_or_else(|| {
                RemoteError::Unauthorized("pairing code is unknown or expired".into())
            })?;
        let pairing = state
            .pairings
            .get_mut(&pairing_key)
            .ok_or_else(|| RemoteError::State("pairing disappeared".into()))?;
        if pairing.claimed {
            return Err(RemoteError::Conflict(
                "pairing code was already claimed".into(),
            ));
        }
        pairing.claimed = true;
        let client = RemoteClient {
            client_id: client_id.to_owned(),
            display_name: metadata.display_name,
            device_type: metadata.device_type,
            platform: metadata.platform,
            os_version: metadata.os_version,
            device_model: metadata.device_model,
            app_version: metadata.app_version,
            last_seen_at: Some(now_secs()),
        };
        state.clients.insert(client_id.to_owned(), client.clone());
        self.persist_locked(&state)?;
        Ok(client)
    }

    pub fn list_clients(
        &self,
        environment_id: &str,
        cursor: Option<&str>,
        limit: Option<u32>,
        descending: bool,
    ) -> Result<Value, RemoteError> {
        let state = self.lock_state()?;
        ensure_environment(&state, environment_id)?;
        let mut clients = state.clients.values().cloned().collect::<Vec<_>>();
        clients.sort_by(|left, right| left.client_id.cmp(&right.client_id));
        if descending {
            clients.reverse();
        }
        if let Some(cursor) = cursor {
            let position = clients
                .iter()
                .position(|client| client.client_id == cursor)
                .ok_or_else(|| RemoteError::Invalid("invalid clients cursor".into()))?;
            clients = clients.into_iter().skip(position + 1).collect();
        }
        let limit = limit.unwrap_or(50).clamp(1, 100) as usize;
        let has_more = clients.len() > limit;
        clients.truncate(limit);
        let next_cursor = has_more
            .then(|| clients.last().map(|client| client.client_id.clone()))
            .flatten();
        Ok(json!({"data":clients,"nextCursor":next_cursor}))
    }

    pub fn revoke_client(
        &self,
        environment_id: &str,
        client_id: &str,
    ) -> Result<Value, RemoteError> {
        self.mutate(|state| {
            ensure_environment(state, environment_id)?;
            if state.clients.remove(client_id).is_none() {
                return Err(RemoteError::Invalid("remote client was not found".into()));
            }
            state.thread_grants.remove(client_id);
            state
                .completed_requests
                .retain(|_, completed| completed.client_id != client_id);
            state
                .completed_order
                .retain(|id| state.completed_requests.contains_key(id));
            Ok(())
        })??;
        Ok(json!({}))
    }

    pub fn grant_thread(&self, client_id: &str, thread_id: &str) -> Result<(), RemoteError> {
        validate_identifier("threadId", thread_id)?;
        {
            let state = self.lock_state()?;
            self.ensure_runtime_enabled(&state)?;
        }
        self.mutate(|state| {
            ensure_client(state, client_id)?;
            state
                .thread_grants
                .entry(client_id.to_owned())
                .or_default()
                .insert(thread_id.to_owned());
            Ok(())
        })?
    }

    pub fn revoke_thread(&self, client_id: &str, thread_id: &str) -> Result<(), RemoteError> {
        self.mutate(|state| {
            ensure_client(state, client_id)?;
            if let Some(grants) = state.thread_grants.get_mut(client_id) {
                grants.remove(thread_id);
            }
            Ok(())
        })?
    }

    pub fn thread_grants(&self, client_id: &str) -> Result<Vec<String>, RemoteError> {
        let state = self.lock_state()?;
        ensure_client(&state, client_id)?;
        Ok(state
            .thread_grants
            .get(client_id)
            .into_iter()
            .flatten()
            .cloned()
            .collect())
    }

    pub fn admit_request(
        &self,
        client_id: &str,
        thread_id: &str,
        request_id: &str,
    ) -> Result<RemoteRequestAdmission, RemoteError> {
        validate_identifier("requestId", request_id)?;
        let mut state = self.lock_state()?;
        self.ensure_runtime_enabled(&state)?;
        ensure_client(&state, client_id)?;
        ensure_grant(&state, client_id, thread_id)?;
        if let Some(completed) = state.completed_requests.get(request_id) {
            if completed.client_id != client_id || completed.thread_id != thread_id {
                return Err(RemoteError::Conflict(
                    "requestId belongs to a different remote scope".into(),
                ));
            }
            return Ok(RemoteRequestAdmission::Cached(completed.response.clone()));
        }
        if let Some(client) = state.clients.get_mut(client_id) {
            client.last_seen_at = Some(now_secs());
        }
        self.persist_locked(&state)?;
        drop(state);
        let mut flags = self.lock_flags()?;
        if !flags.pending_requests.insert(request_id.to_owned()) {
            return Err(RemoteError::Conflict(
                "remote request is already in progress".into(),
            ));
        }
        Ok(RemoteRequestAdmission::Execute)
    }

    pub fn complete_request(
        &self,
        client_id: &str,
        thread_id: &str,
        request_id: &str,
        response: Value,
    ) -> Result<(), RemoteError> {
        self.lock_flags()?.pending_requests.remove(request_id);
        self.mutate(|state| {
            state.completed_requests.insert(
                request_id.to_owned(),
                CompletedRemoteRequest {
                    client_id: client_id.to_owned(),
                    thread_id: thread_id.to_owned(),
                    response,
                },
            );
            state.completed_order.retain(|id| id != request_id);
            state.completed_order.push_back(request_id.to_owned());
            while state.completed_order.len() > MAX_COMPLETED_REQUESTS {
                if let Some(oldest) = state.completed_order.pop_front() {
                    state.completed_requests.remove(&oldest);
                }
            }
        })
    }

    pub fn fail_request(&self, request_id: &str) -> Result<(), RemoteError> {
        self.lock_flags()?.pending_requests.remove(request_id);
        Ok(())
    }

    pub fn authorize_thread(&self, client_id: &str, thread_id: &str) -> Result<(), RemoteError> {
        let state = self.lock_state()?;
        self.ensure_runtime_enabled(&state)?;
        ensure_client(&state, client_id)?;
        ensure_grant(&state, client_id, thread_id)
    }

    fn mutate<T>(&self, mutate: impl FnOnce(&mut RemoteState) -> T) -> Result<T, RemoteError> {
        let mut state = self.lock_state()?;
        let output = mutate(&mut state);
        self.persist_locked(&state)?;
        Ok(output)
    }

    fn persist_locked(&self, state: &RemoteState) -> Result<(), RemoteError> {
        atomic_write(&self.path, &serde_json::to_vec_pretty(state)?)?;
        Ok(())
    }

    fn ensure_runtime_enabled(&self, state: &RemoteState) -> Result<(), RemoteError> {
        if state.enabled || self.lock_flags()?.ephemeral_enabled {
            Ok(())
        } else {
            Err(RemoteError::Unauthorized(
                "remote control is disabled".into(),
            ))
        }
    }

    fn lock_state(&self) -> Result<std::sync::MutexGuard<'_, RemoteState>, RemoteError> {
        self.state
            .lock()
            .map_err(|_| RemoteError::State("state lock poisoned".into()))
    }

    fn lock_flags(&self) -> Result<std::sync::MutexGuard<'_, RuntimeFlags>, RemoteError> {
        self.flags
            .lock()
            .map_err(|_| RemoteError::State("runtime lock poisoned".into()))
    }
}

fn status_value(state: &RemoteState, flags: &RuntimeFlags) -> Value {
    let effective_enabled = state.enabled || flags.ephemeral_enabled;
    let status = if !effective_enabled {
        RemoteStatus::Disabled
    } else if flags.transport_error.is_some() {
        RemoteStatus::Errored
    } else if flags.transport_connected {
        RemoteStatus::Connected
    } else {
        RemoteStatus::Connecting
    };
    json!({
        "status":status.wire(),
        "serverName":"Tietiezhi Device Fabric",
        "installationId":state.installation_id,
        "environmentId":effective_enabled.then(|| state.environment_id.clone())
    })
}

fn ensure_environment(state: &RemoteState, environment_id: &str) -> Result<(), RemoteError> {
    if state.environment_id == environment_id {
        Ok(())
    } else {
        Err(RemoteError::Unauthorized(
            "remote environment is not authorized".into(),
        ))
    }
}

fn ensure_client(state: &RemoteState, client_id: &str) -> Result<(), RemoteError> {
    if state.clients.contains_key(client_id) {
        Ok(())
    } else {
        Err(RemoteError::Unauthorized(
            "remote client is not paired or was revoked".into(),
        ))
    }
}

fn ensure_grant(state: &RemoteState, client_id: &str, thread_id: &str) -> Result<(), RemoteError> {
    if state
        .thread_grants
        .get(client_id)
        .is_some_and(|threads| threads.contains(thread_id))
    {
        Ok(())
    } else {
        Err(RemoteError::Unauthorized(
            "remote client is not authorized for this Thread".into(),
        ))
    }
}

fn validate_identifier(name: &str, value: &str) -> Result<(), RemoteError> {
    if value.trim().is_empty() || value.len() > 256 {
        return Err(RemoteError::Invalid(format!("{name} is invalid")));
    }
    Ok(())
}

fn find_pairing<'a>(
    state: &'a RemoteState,
    pairing_code: Option<&str>,
    manual_pairing_code: Option<&str>,
) -> Option<&'a Pairing> {
    let key = find_pairing_key(state, pairing_code, manual_pairing_code)?;
    state.pairings.get(&key)
}

fn find_pairing_key(
    state: &RemoteState,
    pairing_code: Option<&str>,
    manual_pairing_code: Option<&str>,
) -> Option<String> {
    if let Some(code) = pairing_code {
        return state.pairings.contains_key(code).then(|| code.to_owned());
    }
    let manual = manual_pairing_code?;
    state
        .pairings
        .iter()
        .find(|(_, pairing)| pairing.manual_pairing_code.as_deref() == Some(manual))
        .map(|(key, _)| key.clone())
}

fn prune_pairings(state: &mut RemoteState) {
    let now = now_secs();
    state.pairings.retain(|_, pairing| pairing.expires_at > now);
}

fn manual_code_for(pairing_code: &str) -> String {
    let hash = Sha256::digest(pairing_code.as_bytes());
    let number = u32::from_be_bytes([hash[0], hash[1], hash[2], hash[3]]) % 100_000_000;
    format!("{number:08}")
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        .min(i64::MAX as u64) as i64
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), std::io::Error> {
    let parent = path
        .parent()
        .ok_or_else(|| std::io::Error::other("remote state has no parent"))?;
    fs::create_dir_all(parent)?;
    let temporary = parent.join(format!(".remote-control-{}.tmp", Uuid::new_v4()));
    fs::write(&temporary, bytes)?;
    fs::rename(temporary, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn runtime() -> (tempfile::TempDir, RemoteControlRuntime) {
        let temp = tempfile::tempdir().unwrap();
        let runtime = RemoteControlRuntime::open(temp.path()).unwrap();
        (temp, runtime)
    }

    fn pair(runtime: &RemoteControlRuntime, client_id: &str) -> String {
        runtime.enable().unwrap();
        let pairing = runtime.start_pairing(true).unwrap();
        let code = pairing["pairingCode"].as_str().unwrap().to_owned();
        runtime
            .claim_pairing(
                Some(&code),
                None,
                client_id,
                RemoteClientMetadata {
                    display_name: Some("Phone".into()),
                    platform: Some("ios".into()),
                    ..Default::default()
                },
            )
            .unwrap();
        code
    }

    #[test]
    fn pairing_claim_and_revocation_are_durable() {
        let (temp, runtime) = runtime();
        pair(&runtime, "phone-1");
        let environment = runtime.status().unwrap()["environmentId"]
            .as_str()
            .unwrap()
            .to_owned();
        assert_eq!(
            runtime
                .list_clients(&environment, None, None, false)
                .unwrap()["data"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        drop(runtime);
        let reopened = RemoteControlRuntime::open(temp.path()).unwrap();
        reopened.revoke_client(&environment, "phone-1").unwrap();
        assert!(reopened.authorize_thread("phone-1", "thread").is_err());
    }

    #[test]
    fn thread_grants_are_exact() {
        let (_temp, runtime) = runtime();
        pair(&runtime, "phone-1");
        runtime.grant_thread("phone-1", "thread-a").unwrap();
        assert!(runtime.authorize_thread("phone-1", "thread-a").is_ok());
        assert!(runtime.authorize_thread("phone-1", "thread-b").is_err());
        runtime.revoke_thread("phone-1", "thread-a").unwrap();
        assert!(runtime.authorize_thread("phone-1", "thread-a").is_err());
    }

    #[test]
    fn completed_request_is_idempotent_and_scope_bound() {
        let (_temp, runtime) = runtime();
        pair(&runtime, "phone-1");
        runtime.grant_thread("phone-1", "thread-a").unwrap();
        assert_eq!(
            runtime
                .admit_request("phone-1", "thread-a", "request-1")
                .unwrap(),
            RemoteRequestAdmission::Execute
        );
        runtime
            .complete_request("phone-1", "thread-a", "request-1", json!({"ok":true}))
            .unwrap();
        assert_eq!(
            runtime
                .admit_request("phone-1", "thread-a", "request-1")
                .unwrap(),
            RemoteRequestAdmission::Cached(json!({"ok":true}))
        );
        assert!(runtime
            .admit_request("phone-1", "thread-b", "request-1")
            .is_err());
    }

    #[test]
    fn duplicate_inflight_request_is_rejected() {
        let (_temp, runtime) = runtime();
        pair(&runtime, "phone-1");
        runtime.grant_thread("phone-1", "thread-a").unwrap();
        runtime
            .admit_request("phone-1", "thread-a", "request-1")
            .unwrap();
        assert!(matches!(
            runtime.admit_request("phone-1", "thread-a", "request-1"),
            Err(RemoteError::Conflict(_))
        ));
        runtime.fail_request("request-1").unwrap();
        assert_eq!(
            runtime
                .admit_request("phone-1", "thread-a", "request-1")
                .unwrap(),
            RemoteRequestAdmission::Execute
        );
    }

    #[test]
    fn status_notification_matches_app_server_v2_shape() {
        let (_temp, runtime) = runtime();
        let notification = runtime.status_notification().unwrap();
        assert_eq!(notification["method"], "remoteControl/status/changed");
        serde_json::from_value::<tietiezhi_agent_protocol::ServerNotification>(notification)
            .expect("remote status should match the pinned V2 union");
        assert_eq!(runtime.status().unwrap()["status"], "disabled");
        runtime.enable().unwrap();
        assert_eq!(runtime.status().unwrap()["status"], "connecting");
        runtime.set_transport_state(true, None).unwrap();
        assert_eq!(runtime.status().unwrap()["status"], "connected");
    }
}
