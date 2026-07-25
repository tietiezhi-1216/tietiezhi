//! Codex-compatible operational telemetry, diagnostics, and feedback support.
//!
//! This is a source-level implementation aligned with OpenAI Codex
//! `rust-v0.145.0`; it never invokes or embeds the upstream executable.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use regex_lite::Regex;
use reqwest::multipart::{Form, Part};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use thiserror::Error;
use tokio::sync::oneshot;
use uuid::Uuid;

const DEFAULT_MAX_LOG_BYTES: usize = 4 * 1024 * 1024;
const MAX_FEEDBACK_FILE_BYTES: u64 = 8 * 1024 * 1024;
const MAX_FEEDBACK_FILES: usize = 16;
const FEEDBACK_UPLOAD_TIMEOUT: Duration = Duration::from_secs(10);
const REDACTED: &str = "[REDACTED]";

#[derive(Debug, Error)]
pub enum ObservabilityError {
    #[error("{0}")]
    Invalid(String),
    #[error("I/O error: {0}")]
    Io(#[from] io::Error),
    #[error("HTTP error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("observability state lock poisoned")]
    Lock,
}

#[derive(Debug, Clone)]
pub struct ObservabilityConfig {
    pub root: PathBuf,
    pub service_name: String,
    pub service_version: String,
    pub environment: String,
    pub feedback_endpoint: Option<String>,
    pub otlp_endpoint: Option<String>,
    pub otlp_headers: BTreeMap<String, String>,
    pub max_log_bytes: usize,
}

impl ObservabilityConfig {
    pub fn local(root: PathBuf, service_version: impl Into<String>) -> Self {
        Self {
            root,
            service_name: "tietiezhi-agent-runtime".into(),
            service_version: service_version.into(),
            environment: if cfg!(debug_assertions) {
                "development".into()
            } else {
                "production".into()
            },
            feedback_endpoint: std::env::var("TIETIEZHI_FEEDBACK_ENDPOINT")
                .ok()
                .filter(|value| !value.trim().is_empty()),
            otlp_endpoint: std::env::var("TIETIEZHI_OTLP_ENDPOINT")
                .ok()
                .filter(|value| !value.trim().is_empty()),
            otlp_headers: BTreeMap::new(),
            max_log_bytes: DEFAULT_MAX_LOG_BYTES,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StructuredEvent {
    pub timestamp_ms: i64,
    pub level: String,
    pub target: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(default)]
    pub fields: BTreeMap<String, Value>,
}

impl StructuredEvent {
    pub fn new(level: &str, target: &str, name: &str) -> Self {
        Self {
            timestamp_ms: now_ms(),
            level: level.into(),
            target: target.into(),
            name: name.into(),
            thread_id: None,
            turn_id: None,
            fields: BTreeMap::new(),
        }
    }

    pub fn with_thread(mut self, thread_id: Option<&str>, turn_id: Option<&str>) -> Self {
        self.thread_id = thread_id.map(str::to_owned);
        self.turn_id = turn_id.map(str::to_owned);
        self
    }

    pub fn with_field(mut self, key: impl Into<String>, value: impl Into<Value>) -> Self {
        self.fields.insert(key.into(), value.into());
        self
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MetricsSnapshot {
    pub counters: BTreeMap<String, u64>,
    pub histograms: BTreeMap<String, HistogramSnapshot>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HistogramSnapshot {
    pub count: u64,
    pub sum: u64,
    pub min: u64,
    pub max: u64,
}

impl HistogramSnapshot {
    fn record(&mut self, value: u64) {
        self.count = self.count.saturating_add(1);
        self.sum = self.sum.saturating_add(value);
        if self.count == 1 {
            self.min = value;
            self.max = value;
        } else {
            self.min = self.min.min(value);
            self.max = self.max.max(value);
        }
    }
}

#[derive(Clone)]
pub struct Observability {
    inner: Arc<ObservabilityInner>,
}

struct ObservabilityInner {
    config: ObservabilityConfig,
    logs: Mutex<ByteRing>,
    metrics: Mutex<MetricsSnapshot>,
    started_at: Instant,
    client: reqwest::Client,
}

impl Observability {
    pub fn open(config: ObservabilityConfig) -> Result<Self, ObservabilityError> {
        if config.service_name.trim().is_empty() {
            return Err(ObservabilityError::Invalid(
                "service name must not be empty".into(),
            ));
        }
        fs::create_dir_all(config.root.join("feedback-outbox"))?;
        let client = reqwest::Client::builder()
            .timeout(FEEDBACK_UPLOAD_TIMEOUT)
            .build()?;
        let max_log_bytes = config.max_log_bytes.max(1024);
        Ok(Self {
            inner: Arc::new(ObservabilityInner {
                config,
                logs: Mutex::new(ByteRing::new(max_log_bytes)),
                metrics: Mutex::new(MetricsSnapshot::default()),
                started_at: Instant::now(),
                client,
            }),
        })
    }

    pub fn record(&self, mut event: StructuredEvent) -> Result<(), ObservabilityError> {
        event.level = normalize_level(&event.level);
        event.target = sanitize_scalar(&event.target);
        event.name = sanitize_scalar(&event.name);
        event.thread_id = event.thread_id.map(|value| sanitize_scalar(&value));
        event.turn_id = event.turn_id.map(|value| sanitize_scalar(&value));
        let mut fields = Value::Object(event.fields.into_iter().collect::<Map<String, Value>>());
        redact_value(None, &mut fields);
        event.fields = fields
            .as_object()
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .collect();
        let mut encoded = serde_json::to_vec(&event)
            .map_err(|error| ObservabilityError::Invalid(error.to_string()))?;
        encoded.push(b'\n');
        self.inner
            .logs
            .lock()
            .map_err(|_| ObservabilityError::Lock)?
            .push(&encoded);
        let metric_suffix = event
            .name
            .chars()
            .map(|character| {
                if character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-') {
                    character
                } else {
                    '_'
                }
            })
            .collect::<String>();
        self.counter(&format!("events.{metric_suffix}"), 1)?;
        Ok(())
    }

    pub fn counter(&self, name: &str, value: u64) -> Result<(), ObservabilityError> {
        let name = metric_name(name)?;
        let mut metrics = self
            .inner
            .metrics
            .lock()
            .map_err(|_| ObservabilityError::Lock)?;
        let counter = metrics.counters.entry(name).or_default();
        *counter = counter.saturating_add(value);
        Ok(())
    }

    pub fn histogram(&self, name: &str, value: u64) -> Result<(), ObservabilityError> {
        let name = metric_name(name)?;
        self.inner
            .metrics
            .lock()
            .map_err(|_| ObservabilityError::Lock)?
            .histograms
            .entry(name)
            .or_default()
            .record(value);
        Ok(())
    }

    pub fn snapshot_logs(&self) -> Result<Vec<u8>, ObservabilityError> {
        Ok(self
            .inner
            .logs
            .lock()
            .map_err(|_| ObservabilityError::Lock)?
            .snapshot())
    }

    pub fn snapshot_metrics(&self) -> Result<MetricsSnapshot, ObservabilityError> {
        self.inner
            .metrics
            .lock()
            .map_err(|_| ObservabilityError::Lock)
            .map(|metrics| metrics.clone())
    }

    pub async fn export_otlp(&self) -> Result<bool, ObservabilityError> {
        let Some(endpoint) = self.inner.config.otlp_endpoint.as_deref() else {
            return Ok(false);
        };
        validate_http_endpoint(endpoint)?;
        let logs = self.snapshot_logs()?;
        let metrics = self.snapshot_metrics()?;
        let resource = json!({
            "attributes":[
                {"key":"service.name","value":{"stringValue":self.inner.config.service_name}},
                {"key":"service.version","value":{"stringValue":self.inner.config.service_version}},
                {"key":"deployment.environment.name","value":{"stringValue":self.inner.config.environment}}
            ]
        });
        let log_records = String::from_utf8_lossy(&logs)
            .lines()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .map(|event| {
                json!({
                    "timeUnixNano":event.get("timestampMs").and_then(Value::as_i64).unwrap_or_default().saturating_mul(1_000_000).to_string(),
                    "severityText":event.get("level").cloned().unwrap_or_else(|| json!("INFO")),
                    "body":{"stringValue":serde_json::to_string(&event).unwrap_or_default()}
                })
            })
            .collect::<Vec<_>>();
        let mut metric_points = Vec::new();
        for (name, value) in metrics.counters {
            metric_points.push(json!({
                "name":name,
                "sum":{"aggregationTemporality":2,"isMonotonic":true,"dataPoints":[{"asInt":value.to_string()}]}
            }));
        }
        for (name, value) in metrics.histograms {
            metric_points.push(json!({
                "name":name,
                "histogram":{"aggregationTemporality":2,"dataPoints":[{
                    "count":value.count.to_string(),
                    "sum":value.sum,
                    "min":value.min,
                    "max":value.max
                }]}
            }));
        }
        self.post_otlp(
            &format!("{}/v1/logs", endpoint.trim_end_matches('/')),
            json!({"resourceLogs":[{"resource":resource.clone(),"scopeLogs":[{"scope":{"name":"tietiezhi-agent-runtime"},"logRecords":log_records}]}]}),
        )
        .await?;
        self.post_otlp(
            &format!("{}/v1/metrics", endpoint.trim_end_matches('/')),
            json!({"resourceMetrics":[{"resource":resource,"scopeMetrics":[{"scope":{"name":"tietiezhi-agent-runtime"},"metrics":metric_points}]}]}),
        )
        .await?;
        Ok(true)
    }

    async fn post_otlp(&self, endpoint: &str, body: Value) -> Result<(), ObservabilityError> {
        let mut request = self.inner.client.post(endpoint).json(&body);
        for (key, value) in &self.inner.config.otlp_headers {
            request = request.header(key, value);
        }
        request.send().await?.error_for_status()?;
        Ok(())
    }

    pub fn doctor(&self, input: DoctorInput) -> DoctorReport {
        let generated_at_ms = now_ms();
        let mut checks = Vec::new();
        checks.push(path_check(
            "runtime.root",
            "runtime",
            &input.runtime_root,
            true,
        ));
        checks.push(path_check("tasks.root", "storage", &input.tasks_root, true));
        checks.push(file_check("state.database", "storage", &input.state_db));
        checks.push(directory_space_check(&input.runtime_root));
        checks.push(endpoint_check(
            "provider.endpoint",
            input.provider_endpoint.as_deref(),
        ));
        checks.push(sandbox_check(input.sandbox_readiness));
        checks.push(DoctorCheck {
            id: "runtime.uptime".into(),
            category: "runtime".into(),
            status: CheckStatus::Ok,
            summary: "Agent Runtime is active.".into(),
            details: vec![format!(
                "uptimeMs={}",
                self.inner.started_at.elapsed().as_millis()
            )],
            issues: Vec::new(),
            remediation: None,
            duration_ms: 0,
        });
        let overall_status = checks
            .iter()
            .map(|check| check.status)
            .max()
            .unwrap_or(CheckStatus::Ok);
        DoctorReport {
            schema_version: 1,
            generated_at_ms,
            overall_status,
            service_version: self.inner.config.service_version.clone(),
            checks,
        }
    }

    pub async fn upload_feedback(
        &self,
        params: FeedbackUpload,
        doctor: DoctorReport,
    ) -> Result<FeedbackReceipt, ObservabilityError> {
        if params.classification.trim().is_empty() {
            return Err(ObservabilityError::Invalid(
                "feedback classification must not be empty".into(),
            ));
        }
        if params.extra_log_files.len() > MAX_FEEDBACK_FILES {
            return Err(ObservabilityError::Invalid(format!(
                "feedback accepts at most {MAX_FEEDBACK_FILES} extra files"
            )));
        }
        let thread_id = params
            .thread_id
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| format!("no-active-thread-{}", Uuid::now_v7()));
        let feedback_id = Uuid::now_v7().to_string();
        let outbox = self
            .inner
            .config
            .root
            .join("feedback-outbox")
            .join(&feedback_id);
        fs::create_dir_all(&outbox)?;
        let logs = params
            .include_logs
            .then(|| self.snapshot_logs())
            .transpose()?;
        let mut attachments = Vec::new();
        if let Some(logs) = logs.as_ref() {
            let path = outbox.join("agent-runtime.log");
            atomic_write(&path, logs)?;
            attachments.push(path);
        }
        let doctor_bytes = serde_json::to_vec_pretty(&doctor)
            .map_err(|error| ObservabilityError::Invalid(error.to_string()))?;
        let doctor_path = outbox.join("doctor-report.json");
        atomic_write(&doctor_path, &doctor_bytes)?;
        attachments.push(doctor_path);
        for source in &params.extra_log_files {
            let metadata = fs::metadata(source)?;
            if !metadata.is_file() {
                return Err(ObservabilityError::Invalid(format!(
                    "feedback attachment is not a file: {}",
                    source.display()
                )));
            }
            if metadata.len() > MAX_FEEDBACK_FILE_BYTES {
                return Err(ObservabilityError::Invalid(format!(
                    "feedback attachment exceeds {MAX_FEEDBACK_FILE_BYTES} bytes: {}",
                    source.display()
                )));
            }
            let name = source
                .file_name()
                .and_then(|value| value.to_str())
                .map(sanitize_filename)
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| "attachment.log".into());
            let target = unique_attachment_path(&outbox, &name);
            atomic_write(&target, &fs::read(source)?)?;
            attachments.push(target);
        }
        let manifest = FeedbackManifest {
            schema_version: 1,
            feedback_id: feedback_id.clone(),
            thread_id: thread_id.clone(),
            classification: sanitize_scalar(&params.classification),
            reason: params.reason.map(|value| sanitize_scalar(&value)),
            tags: params
                .tags
                .into_iter()
                .map(|(key, value)| {
                    let safe_value = if sensitive_key(&key) {
                        REDACTED.into()
                    } else {
                        sanitize_scalar(&value)
                    };
                    (sanitize_scalar(&key), safe_value)
                })
                .collect(),
            created_at_ms: now_ms(),
            attachment_sha256: attachments
                .iter()
                .map(|path| {
                    fs::read(path).map(|bytes| {
                        (
                            path.file_name()
                                .and_then(|value| value.to_str())
                                .unwrap_or("attachment")
                                .to_owned(),
                            hex_sha256(&bytes),
                        )
                    })
                })
                .collect::<Result<_, _>>()?,
        };
        let manifest_bytes = serde_json::to_vec_pretty(&manifest)
            .map_err(|error| ObservabilityError::Invalid(error.to_string()))?;
        let manifest_path = outbox.join("manifest.json");
        atomic_write(&manifest_path, &manifest_bytes)?;
        let uploaded = if let Some(endpoint) = self.inner.config.feedback_endpoint.as_deref() {
            validate_http_endpoint(endpoint)?;
            let mut form = Form::new().text(
                "manifest",
                serde_json::to_string(&manifest)
                    .map_err(|error| ObservabilityError::Invalid(error.to_string()))?,
            );
            for path in &attachments {
                let bytes = fs::read(path)?;
                let filename = path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .unwrap_or("attachment")
                    .to_owned();
                form = form.part("attachments", Part::bytes(bytes).file_name(filename));
            }
            self.inner
                .client
                .post(endpoint)
                .multipart(form)
                .send()
                .await?
                .error_for_status()?;
            atomic_write(&outbox.join("uploaded"), b"ok\n")?;
            true
        } else {
            false
        };
        self.counter("feedback.uploaded", u64::from(uploaded))?;
        self.counter("feedback.queued", u64::from(!uploaded))?;
        Ok(FeedbackReceipt {
            thread_id,
            feedback_id,
            outbox,
            uploaded,
        })
    }
}

#[derive(Debug, Clone)]
pub struct DoctorInput {
    pub runtime_root: PathBuf,
    pub tasks_root: PathBuf,
    pub state_db: PathBuf,
    pub provider_endpoint: Option<String>,
    pub sandbox_readiness: Option<Value>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum CheckStatus {
    Ok,
    Warning,
    Fail,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DoctorReport {
    pub schema_version: u32,
    pub generated_at_ms: i64,
    pub overall_status: CheckStatus,
    pub service_version: String,
    pub checks: Vec<DoctorCheck>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DoctorCheck {
    pub id: String,
    pub category: String,
    pub status: CheckStatus,
    pub summary: String,
    pub details: Vec<String>,
    pub issues: Vec<DoctorIssue>,
    pub remediation: Option<String>,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DoctorIssue {
    pub severity: CheckStatus,
    pub cause: String,
    pub measured: Option<String>,
    pub expected: Option<String>,
    pub remedy: Option<String>,
    pub fields: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct FeedbackUpload {
    pub classification: String,
    pub reason: Option<String>,
    pub thread_id: Option<String>,
    pub include_logs: bool,
    pub extra_log_files: Vec<PathBuf>,
    pub tags: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct FeedbackManifest {
    schema_version: u32,
    feedback_id: String,
    thread_id: String,
    classification: String,
    reason: Option<String>,
    tags: BTreeMap<String, String>,
    created_at_ms: i64,
    attachment_sha256: BTreeMap<String, String>,
}

#[derive(Debug, Clone)]
pub struct FeedbackReceipt {
    pub thread_id: String,
    pub feedback_id: String,
    pub outbox: PathBuf,
    pub uploaded: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutedServerRequest {
    pub recipients: Vec<String>,
    pub id: Value,
    pub method: String,
    pub params: Value,
}

impl RoutedServerRequest {
    pub fn wire_message(&self) -> Value {
        json!({"id":self.id,"method":self.method,"params":self.params})
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutedResolvedNotification {
    pub recipients: Vec<String>,
    pub method: String,
    pub params: Value,
}

impl RoutedResolvedNotification {
    pub fn wire_message(&self) -> Value {
        json!({"method":self.method,"params":self.params})
    }
}

#[derive(Clone, Default)]
pub struct ServerRequestTracker {
    inner: Arc<Mutex<HashMap<String, PendingServerRequest>>>,
}

#[derive(Debug, Clone)]
struct PendingServerRequest {
    thread_id: String,
    recipients: Vec<String>,
}

impl ServerRequestTracker {
    pub fn register(
        &self,
        request_id: &Value,
        thread_id: &str,
        recipients: Vec<String>,
    ) -> Result<(), ObservabilityError> {
        if thread_id.trim().is_empty() {
            return Err(ObservabilityError::Invalid(
                "server request thread id must not be empty".into(),
            ));
        }
        self.inner
            .lock()
            .map_err(|_| ObservabilityError::Lock)?
            .insert(
                request_id_key(request_id),
                PendingServerRequest {
                    thread_id: thread_id.into(),
                    recipients,
                },
            );
        Ok(())
    }

    pub fn resolve(
        &self,
        response: &Value,
    ) -> Result<Option<RoutedResolvedNotification>, ObservabilityError> {
        serde_json::from_value::<tietiezhi_agent_protocol::JSONRPCResponse>(response.clone())
            .map_err(|error| ObservabilityError::Invalid(error.to_string()))?;
        let id = response
            .get("id")
            .ok_or_else(|| ObservabilityError::Invalid("response id is required".into()))?;
        let Some(pending) = self
            .inner
            .lock()
            .map_err(|_| ObservabilityError::Lock)?
            .remove(&request_id_key(id))
        else {
            return Ok(None);
        };
        let notification = RoutedResolvedNotification {
            recipients: pending.recipients,
            method: "serverRequest/resolved".into(),
            params: json!({"threadId":pending.thread_id,"requestId":id}),
        };
        serde_json::from_value::<tietiezhi_agent_protocol::ServerNotification>(
            notification.wire_message(),
        )
        .map_err(|error| ObservabilityError::Invalid(error.to_string()))?;
        Ok(Some(notification))
    }

    pub fn cancel_thread(&self, thread_id: &str) -> Result<usize, ObservabilityError> {
        let mut pending = self.inner.lock().map_err(|_| ObservabilityError::Lock)?;
        let before = pending.len();
        pending.retain(|_, request| request.thread_id != thread_id);
        Ok(before - pending.len())
    }

    pub fn cancel(&self, request_id: &Value) -> Result<bool, ObservabilityError> {
        Ok(self
            .inner
            .lock()
            .map_err(|_| ObservabilityError::Lock)?
            .remove(&request_id_key(request_id))
            .is_some())
    }
}

#[derive(Clone, Default)]
pub struct AttestationBroker {
    tracker: ServerRequestTracker,
    next_id: Arc<std::sync::atomic::AtomicU64>,
    pending: PendingAttestations,
}

type PendingAttestations = Arc<Mutex<HashMap<String, oneshot::Sender<Result<String, String>>>>>;

pub struct PendingAttestation {
    pub request: RoutedServerRequest,
    pub receiver: oneshot::Receiver<Result<String, String>>,
}

impl AttestationBroker {
    pub fn tracker(&self) -> ServerRequestTracker {
        self.tracker.clone()
    }

    pub fn begin(
        &self,
        recipients: Vec<String>,
        thread_id: &str,
    ) -> Result<PendingAttestation, ObservabilityError> {
        let id = format!(
            "attestation-{}",
            self.next_id
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
                + 1
        );
        let request = RoutedServerRequest {
            recipients: recipients.clone(),
            id: json!(id),
            method: "attestation/generate".into(),
            params: json!({}),
        };
        serde_json::from_value::<tietiezhi_agent_protocol::ServerRequest>(request.wire_message())
            .map_err(|error| ObservabilityError::Invalid(error.to_string()))?;
        self.tracker.register(&request.id, thread_id, recipients)?;
        let (sender, receiver) = oneshot::channel();
        self.pending
            .lock()
            .map_err(|_| ObservabilityError::Lock)?
            .insert(id, sender);
        Ok(PendingAttestation { request, receiver })
    }

    pub fn resolve(&self, response: &Value) -> Result<bool, ObservabilityError> {
        serde_json::from_value::<tietiezhi_agent_protocol::JSONRPCResponse>(response.clone())
            .map_err(|error| ObservabilityError::Invalid(error.to_string()))?;
        let id = response
            .get("id")
            .ok_or_else(|| ObservabilityError::Invalid("response id is required".into()))?;
        let Some(sender) = self
            .pending
            .lock()
            .map_err(|_| ObservabilityError::Lock)?
            .remove(&request_id_key(id))
        else {
            return Ok(false);
        };
        let token = response
            .pointer("/result/token")
            .and_then(Value::as_str)
            .filter(|token| !token.trim().is_empty())
            .map(str::to_owned)
            .ok_or_else(|| {
                ObservabilityError::Invalid(
                    response
                        .pointer("/error/message")
                        .and_then(Value::as_str)
                        .unwrap_or("attestation response token is required")
                        .into(),
                )
            });
        let _ = sender.send(token.map_err(|error| error.to_string()));
        Ok(true)
    }

    pub fn cancel(&self, request_id: &Value) -> Result<bool, ObservabilityError> {
        let removed = self
            .pending
            .lock()
            .map_err(|_| ObservabilityError::Lock)?
            .remove(&request_id_key(request_id))
            .is_some();
        let _ = self.tracker.cancel(request_id)?;
        Ok(removed)
    }
}

struct ByteRing {
    max: usize,
    bytes: VecDeque<u8>,
}

impl ByteRing {
    fn new(max: usize) -> Self {
        Self {
            max,
            bytes: VecDeque::with_capacity(max),
        }
    }

    fn push(&mut self, data: &[u8]) {
        if data.len() >= self.max {
            self.bytes.clear();
            self.bytes
                .extend(data[data.len().saturating_sub(self.max)..].iter().copied());
            return;
        }
        while self.bytes.len().saturating_add(data.len()) > self.max {
            self.bytes.pop_front();
        }
        self.bytes.extend(data.iter().copied());
    }

    fn snapshot(&self) -> Vec<u8> {
        self.bytes.iter().copied().collect()
    }
}

fn normalize_level(value: &str) -> String {
    match value.to_ascii_uppercase().as_str() {
        "TRACE" => "TRACE",
        "DEBUG" => "DEBUG",
        "WARN" | "WARNING" => "WARN",
        "ERROR" => "ERROR",
        _ => "INFO",
    }
    .into()
}

fn metric_name(value: &str) -> Result<String, ObservabilityError> {
    let value = value.trim();
    if value.is_empty()
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return Err(ObservabilityError::Invalid(format!(
            "invalid metric name: {value}"
        )));
    }
    Ok(value.into())
}

fn redact_value(key: Option<&str>, value: &mut Value) {
    if key.is_some_and(sensitive_key) {
        *value = Value::String(REDACTED.into());
        return;
    }
    match value {
        Value::Object(object) => {
            for (key, value) in object {
                redact_value(Some(key), value);
            }
        }
        Value::Array(array) => {
            for value in array {
                redact_value(key, value);
            }
        }
        Value::String(text) => *text = sanitize_scalar(text),
        _ => {}
    }
}

fn sensitive_key(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    [
        "authorization",
        "api_key",
        "apikey",
        "access_token",
        "refresh_token",
        "password",
        "secret",
        "cookie",
        "private_key",
        "client_secret",
    ]
    .iter()
    .any(|needle| key.contains(needle))
}

fn sanitize_scalar(value: &str) -> String {
    let mut output = value.to_owned();
    for pattern in [
        r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]+",
        r"\bsk-[A-Za-z0-9_-]{12,}",
        r"\b[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b",
        r"(?i)(password|secret|token|api[_-]?key)=([^&\s]+)",
    ] {
        if let Ok(regex) = Regex::new(pattern) {
            output = regex
                .replace_all(&output, |captures: &regex_lite::Captures<'_>| {
                    captures
                        .get(1)
                        .map(|prefix| format!("{}={REDACTED}", prefix.as_str()))
                        .unwrap_or_else(|| REDACTED.into())
                })
                .into_owned();
        }
    }
    output
}

fn path_check(id: &str, category: &str, path: &Path, require_write: bool) -> DoctorCheck {
    let start = Instant::now();
    let mut status = CheckStatus::Ok;
    let mut summary = format!("{} is available.", path.display());
    let mut issues = Vec::new();
    if let Err(error) = fs::create_dir_all(path) {
        status = CheckStatus::Fail;
        summary = format!("{} is unavailable.", path.display());
        issues.push(DoctorIssue {
            severity: status,
            cause: error.to_string(),
            measured: None,
            expected: Some("directory can be created and opened".into()),
            remedy: Some("Repair the application data directory permissions.".into()),
            fields: vec!["path".into()],
        });
    } else if require_write {
        let probe = path.join(format!(".doctor-{}", Uuid::now_v7()));
        if let Err(error) = fs::write(&probe, b"probe").and_then(|_| fs::remove_file(&probe)) {
            status = CheckStatus::Fail;
            summary = format!("{} is not writable.", path.display());
            issues.push(DoctorIssue {
                severity: status,
                cause: error.to_string(),
                measured: None,
                expected: Some("write and delete succeeds".into()),
                remedy: Some("Grant the current user write access.".into()),
                fields: vec!["path".into()],
            });
        }
    }
    DoctorCheck {
        id: id.into(),
        category: category.into(),
        status,
        summary,
        details: vec![format!("path={}", path.display())],
        issues,
        remediation: None,
        duration_ms: start.elapsed().as_millis() as u64,
    }
}

fn file_check(id: &str, category: &str, path: &Path) -> DoctorCheck {
    let start = Instant::now();
    let (status, summary, issues) = match fs::metadata(path) {
        Ok(metadata) if metadata.is_file() => (
            CheckStatus::Ok,
            "State database is present.".into(),
            Vec::new(),
        ),
        Ok(_) => (
            CheckStatus::Fail,
            "State database path is not a file.".into(),
            vec![DoctorIssue {
                severity: CheckStatus::Fail,
                cause: "unexpected file type".into(),
                measured: Some(path.display().to_string()),
                expected: Some("regular SQLite file".into()),
                remedy: Some("Move the conflicting path and restart the runtime.".into()),
                fields: vec!["path".into()],
            }],
        ),
        Err(error) if error.kind() == io::ErrorKind::NotFound => (
            CheckStatus::Warning,
            "State database has not been created yet.".into(),
            Vec::new(),
        ),
        Err(error) => (
            CheckStatus::Fail,
            "State database cannot be inspected.".into(),
            vec![DoctorIssue {
                severity: CheckStatus::Fail,
                cause: error.to_string(),
                measured: None,
                expected: Some("metadata is readable".into()),
                remedy: Some("Repair storage permissions.".into()),
                fields: vec!["path".into()],
            }],
        ),
    };
    DoctorCheck {
        id: id.into(),
        category: category.into(),
        status,
        summary,
        details: vec![format!("path={}", path.display())],
        issues,
        remediation: None,
        duration_ms: start.elapsed().as_millis() as u64,
    }
}

fn directory_space_check(path: &Path) -> DoctorCheck {
    let start = Instant::now();
    let (status, summary, details, issues) = match fs2::available_space(path) {
        Ok(bytes) if bytes < 64 * 1024 * 1024 => (
            CheckStatus::Warning,
            "Runtime storage is low.".into(),
            vec![format!("availableBytes={bytes}")],
            vec![DoctorIssue {
                severity: CheckStatus::Warning,
                cause: "less than 64 MiB is available".into(),
                measured: Some(bytes.to_string()),
                expected: Some("at least 67108864 bytes".into()),
                remedy: Some("Free disk space before starting a long task.".into()),
                fields: vec!["availableBytes".into()],
            }],
        ),
        Ok(bytes) => (
            CheckStatus::Ok,
            "Runtime storage has sufficient free space.".into(),
            vec![format!("availableBytes={bytes}")],
            Vec::new(),
        ),
        Err(error) => (
            CheckStatus::Warning,
            "Runtime storage capacity could not be measured.".into(),
            vec![format!("error={}", sanitize_scalar(&error.to_string()))],
            Vec::new(),
        ),
    };
    DoctorCheck {
        id: "storage.freeSpace".into(),
        category: "storage".into(),
        status,
        summary,
        details,
        issues,
        remediation: None,
        duration_ms: start.elapsed().as_millis() as u64,
    }
}

fn endpoint_check(id: &str, endpoint: Option<&str>) -> DoctorCheck {
    let start = Instant::now();
    let (status, summary, issues) = match endpoint {
        None => (
            CheckStatus::Warning,
            "No Responses provider endpoint is configured.".into(),
            Vec::new(),
        ),
        Some(endpoint) => match validate_http_endpoint(endpoint) {
            Ok(()) => (
                CheckStatus::Ok,
                "Responses provider endpoint is valid.".into(),
                Vec::new(),
            ),
            Err(error) => (
                CheckStatus::Fail,
                "Responses provider endpoint is invalid.".into(),
                vec![DoctorIssue {
                    severity: CheckStatus::Fail,
                    cause: error.to_string(),
                    measured: Some("<invalid endpoint>".into()),
                    expected: Some("http:// or https:// endpoint".into()),
                    remedy: Some("Correct the active model provider base URL.".into()),
                    fields: vec!["providerEndpoint".into()],
                }],
            ),
        },
    };
    DoctorCheck {
        id: id.into(),
        category: "network".into(),
        status,
        summary,
        details: Vec::new(),
        issues,
        remediation: None,
        duration_ms: start.elapsed().as_millis() as u64,
    }
}

fn sandbox_check(readiness: Option<Value>) -> DoctorCheck {
    let start = Instant::now();
    let ready = readiness
        .as_ref()
        .and_then(|value| value.get("readiness"))
        .and_then(Value::as_str)
        .is_some_and(|value| value == "ready");
    let status = if cfg!(target_os = "windows") && !ready {
        CheckStatus::Warning
    } else {
        CheckStatus::Ok
    };
    DoctorCheck {
        id: "sandbox.readiness".into(),
        category: "sandbox".into(),
        status,
        summary: if status == CheckStatus::Ok {
            "Sandbox runtime is ready.".into()
        } else {
            "Windows sandbox setup is incomplete.".into()
        },
        details: readiness
            .map(|value| vec![serde_json::to_string(&value).unwrap_or_default()])
            .unwrap_or_default(),
        issues: Vec::new(),
        remediation: (status != CheckStatus::Ok)
            .then(|| "Run windowsSandbox/setupStart with administrator consent.".into()),
        duration_ms: start.elapsed().as_millis() as u64,
    }
}

fn validate_http_endpoint(endpoint: &str) -> Result<(), ObservabilityError> {
    if !(endpoint.starts_with("http://") || endpoint.starts_with("https://")) {
        return Err(ObservabilityError::Invalid(
            "endpoint must use http:// or https://".into(),
        ));
    }
    let host = endpoint
        .split_once("://")
        .map(|(_, rest)| rest.split(['/', '?', '#']).next().unwrap_or_default())
        .unwrap_or_default();
    if host.is_empty() || host.contains('@') {
        return Err(ObservabilityError::Invalid(
            "endpoint host is missing or contains credentials".into(),
        ));
    }
    Ok(())
}

fn unique_attachment_path(root: &Path, filename: &str) -> PathBuf {
    let direct = root.join(filename);
    if !direct.exists() {
        return direct;
    }
    let stem = Path::new(filename)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("attachment");
    let extension = Path::new(filename)
        .extension()
        .and_then(|value| value.to_str());
    for index in 2..=MAX_FEEDBACK_FILES + 1 {
        let candidate = match extension {
            Some(extension) => root.join(format!("{stem}-{index}.{extension}")),
            None => root.join(format!("{stem}-{index}")),
        };
        if !candidate.exists() {
            return candidate;
        }
    }
    root.join(format!("attachment-{}", Uuid::now_v7()))
}

fn sanitize_filename(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .take(120)
        .collect()
}

fn atomic_write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "path has no parent"))?;
    fs::create_dir_all(parent)?;
    let temp = parent.join(format!(".tmp-{}", Uuid::now_v7()));
    fs::write(&temp, bytes)?;
    if let Ok(file) = fs::OpenOptions::new().read(true).open(&temp) {
        let _ = file.sync_all();
    }
    match fs::rename(&temp, path) {
        Ok(()) => Ok(()),
        Err(_error) if path.exists() => {
            fs::remove_file(path)?;
            fs::rename(temp, path)
        }
        Err(error) => Err(error),
    }
}

fn hex_sha256(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn request_id_key(value: &Value) -> String {
    value
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| value.to_string())
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(i64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    fn runtime(root: &Path) -> Observability {
        Observability::open(ObservabilityConfig::local(root.into(), "test")).unwrap()
    }

    #[test]
    fn structured_logs_are_bounded_and_redact_secrets() {
        let temp = tempfile::tempdir().unwrap();
        let mut config = ObservabilityConfig::local(temp.path().into(), "test");
        config.max_log_bytes = 2048;
        let runtime = Observability::open(config).unwrap();
        for _ in 0..40 {
            runtime
                .record(
                    StructuredEvent::new("info", "runtime", "request")
                        .with_field("authorization", "Bearer not-safe")
                        .with_field("message", "api_key=also-not-safe"),
                )
                .unwrap();
        }
        let logs = String::from_utf8(runtime.snapshot_logs().unwrap()).unwrap();
        assert!(logs.len() <= 2048);
        assert!(!logs.contains("not-safe"));
        assert!(logs.contains(REDACTED));
    }

    #[test]
    fn metrics_and_doctor_are_structured() {
        let temp = tempfile::tempdir().unwrap();
        let runtime = runtime(temp.path());
        runtime.counter("turn.started", 2).unwrap();
        runtime.histogram("request.latency_ms", 10).unwrap();
        runtime.histogram("request.latency_ms", 30).unwrap();
        let snapshot = runtime.snapshot_metrics().unwrap();
        assert_eq!(snapshot.counters["turn.started"], 2);
        assert_eq!(snapshot.histograms["request.latency_ms"].sum, 40);
        let report = runtime.doctor(DoctorInput {
            runtime_root: temp.path().join("runtime"),
            tasks_root: temp.path().join("tasks"),
            state_db: temp.path().join("runtime/state.sqlite"),
            provider_endpoint: Some("https://gateway.example.invalid/v1".into()),
            sandbox_readiness: Some(json!({"readiness":"ready"})),
        });
        assert_eq!(report.schema_version, 1);
        assert!(
            report
                .checks
                .iter()
                .any(|check| check.id == "storage.freeSpace")
        );
    }

    #[tokio::test]
    async fn feedback_is_atomic_and_uploads_multipart_when_configured() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let requests = Arc::new(AtomicUsize::new(0));
        let requests_server = requests.clone();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = vec![0_u8; 32 * 1024];
            let size = stream.read(&mut request).await.unwrap();
            let request = String::from_utf8_lossy(&request[..size]);
            assert!(request.contains("multipart/form-data"));
            requests_server.fetch_add(1, Ordering::Relaxed);
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}")
                .await
                .unwrap();
        });
        let temp = tempfile::tempdir().unwrap();
        let mut config = ObservabilityConfig::local(temp.path().into(), "test");
        config.feedback_endpoint = Some(format!("http://{address}/feedback"));
        let runtime = Observability::open(config).unwrap();
        runtime
            .record(StructuredEvent::new("info", "test", "feedback"))
            .unwrap();
        let attachment = temp.path().join("extra.log");
        fs::write(&attachment, "safe").unwrap();
        let doctor = runtime.doctor(DoctorInput {
            runtime_root: temp.path().join("runtime"),
            tasks_root: temp.path().join("tasks"),
            state_db: temp.path().join("runtime/state.sqlite"),
            provider_endpoint: None,
            sandbox_readiness: None,
        });
        let receipt = runtime
            .upload_feedback(
                FeedbackUpload {
                    classification: "bug".into(),
                    reason: Some("broken".into()),
                    thread_id: Some("019-test".into()),
                    include_logs: true,
                    extra_log_files: vec![attachment],
                    tags: BTreeMap::new(),
                },
                doctor,
            )
            .await
            .unwrap();
        assert!(receipt.uploaded);
        assert!(receipt.outbox.join("manifest.json").is_file());
        assert!(receipt.outbox.join("uploaded").is_file());
        assert_eq!(requests.load(Ordering::Relaxed), 1);
    }

    #[tokio::test]
    async fn attestation_and_resolved_notification_round_trip() {
        let broker = AttestationBroker::default();
        let pending = broker.begin(vec!["desktop".into()], "thread-1").unwrap();
        assert_eq!(pending.request.method, "attestation/generate");
        let response = json!({"id":pending.request.id,"result":{"token":"opaque"}});
        let resolved = broker.tracker().resolve(&response).unwrap().unwrap();
        assert_eq!(resolved.method, "serverRequest/resolved");
        assert_eq!(resolved.params["threadId"], "thread-1");
        assert!(broker.resolve(&response).unwrap());
        assert_eq!(pending.receiver.await.unwrap().unwrap(), "opaque");
    }

    #[test]
    fn server_request_tracker_cancels_exact_thread() {
        let tracker = ServerRequestTracker::default();
        tracker
            .register(&json!(1), "thread-a", vec!["desktop".into()])
            .unwrap();
        tracker
            .register(&json!(2), "thread-b", vec!["desktop".into()])
            .unwrap();
        assert_eq!(tracker.cancel_thread("thread-a").unwrap(), 1);
        assert!(
            tracker
                .resolve(&json!({"id":1,"result":{}}))
                .unwrap()
                .is_none()
        );
        assert!(
            tracker
                .resolve(&json!({"id":2,"result":{}}))
                .unwrap()
                .is_some()
        );
    }
}
