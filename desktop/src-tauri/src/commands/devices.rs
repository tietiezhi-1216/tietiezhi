use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use futures_util::{SinkExt, StreamExt};
use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};
use tokio::sync::broadcast;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::header::AUTHORIZATION;
use tokio_tungstenite::tungstenite::Message;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::{secrets, AppState};

const STORE_VERSION: u32 = 1;
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
const INVOKE_TIMEOUT: Duration = Duration::from_secs(20);
const RECONNECT_DELAY: Duration = Duration::from_secs(3);

pub struct DeviceFabric {
    connections: Mutex<HashMap<String, CancellationToken>>,
    routes: Mutex<HashMap<String, String>>,
    outbound: broadcast::Sender<RemoteFabricMessage>,
}

#[derive(Debug, Clone)]
struct RemoteFabricMessage {
    core_id: String,
    client_id: String,
    payload: Value,
}

impl Default for DeviceFabric {
    fn default() -> Self {
        let (outbound, _) = broadcast::channel(512);
        Self {
            connections: Mutex::new(HashMap::new()),
            routes: Mutex::new(HashMap::new()),
            outbound,
        }
    }
}

impl DeviceFabric {
    pub fn sync_from_store(&self, app: &AppHandle) -> Result<(), String> {
        for core in read_cores(app)? {
            self.connect(app.clone(), core)?;
        }
        Ok(())
    }

    fn connect(&self, app: AppHandle, core: DeviceCore) -> Result<(), String> {
        let mut connections = self
            .connections
            .lock()
            .map_err(|_| "设备连接状态锁已损坏")?;
        if connections.contains_key(&core.id) {
            return Ok(());
        }
        let cancel = CancellationToken::new();
        connections.insert(core.id.clone(), cancel.clone());
        tauri::async_runtime::spawn(run_device_node(app, core, cancel));
        Ok(())
    }

    fn disconnect(&self, core_id: &str) -> Result<(), String> {
        let cancel = self
            .connections
            .lock()
            .map_err(|_| "设备连接状态锁已损坏")?
            .remove(core_id);
        if let Some(cancel) = cancel {
            cancel.cancel();
        }
        self.routes
            .lock()
            .map_err(|_| "设备路由状态锁已损坏")?
            .retain(|_, route_core| route_core != core_id);
        Ok(())
    }

    fn register_route(&self, client_id: &str, core_id: &str) {
        if let Ok(mut routes) = self.routes.lock() {
            routes.insert(client_id.to_owned(), core_id.to_owned());
        }
    }

    fn clear_routes(&self, core_id: &str) {
        if let Ok(mut routes) = self.routes.lock() {
            routes.retain(|_, route_core| route_core != core_id);
        }
    }

    pub(crate) fn send_remote(&self, client_id: &str, payload: Value) -> Result<(), String> {
        let core_id = self
            .routes
            .lock()
            .map_err(|_| "设备路由状态锁已损坏")?
            .get(client_id)
            .cloned()
            .ok_or_else(|| "远程客户端当前不在线".to_string())?;
        self.outbound
            .send(RemoteFabricMessage {
                core_id,
                client_id: client_id.to_owned(),
                payload,
            })
            .map(|_| ())
            .map_err(|_| "设备 Fabric 没有活动连接".to_string())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCore {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub created_at: u64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct DeviceCoresFile {
    version: u32,
    cores: Vec<DeviceCore>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCoreView {
    #[serde(flatten)]
    pub core: DeviceCore,
    pub online: bool,
    pub latency_ms: Option<u64>,
    pub device_count: usize,
    pub last_error: String,
    pub has_token: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteDeviceInfo {
    id: String,
    name: String,
    platform: String,
}

#[derive(Debug, Deserialize)]
struct RemoteDevicesResponse {
    #[serde(default)]
    devices: Vec<RemoteDeviceInfo>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectedDevice {
    pub id: String,
    pub native_id: String,
    pub name: String,
    pub platform: String,
    pub core_id: String,
    pub core_name: String,
    pub role: String,
    pub online: bool,
    pub capabilities: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInvokeResult {
    pub request_id: String,
    pub device_id: String,
    pub capability: String,
    pub ok: bool,
    pub output: Value,
    pub message: String,
    pub duration_ms: u64,
}

#[derive(Debug, Serialize, Deserialize)]
struct InterconnectEnvelope {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    from: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    to: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    name: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    platform: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    payload: Option<Value>,
}

fn store_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn identity_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn cores_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位数据目录：{error}"))?
        .join("device-cores.json"))
}

fn local_identity_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位数据目录：{error}"))?
        .join("device-id"))
}

fn local_identity(app: &AppHandle) -> Result<String, String> {
    let _guard = identity_lock().lock().map_err(|_| "设备身份存储锁已损坏")?;
    let path = local_identity_path(app)?;
    if let Ok(id) = std::fs::read_to_string(&path) {
        let id = id.trim();
        if Uuid::parse_str(id).is_ok() {
            return Ok(id.to_string());
        }
    }
    let id = Uuid::new_v4().to_string();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("创建设备身份目录失败：{error}"))?;
    }
    std::fs::write(path, &id).map_err(|error| format!("保存设备身份失败：{error}"))?;
    Ok(id)
}

fn read_cores_unlocked(app: &AppHandle) -> Result<Vec<DeviceCore>, String> {
    let path = cores_path(app)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw =
        std::fs::read_to_string(path).map_err(|error| format!("读取设备 Core 失败：{error}"))?;
    let file: DeviceCoresFile =
        serde_json::from_str(&raw).map_err(|error| format!("设备 Core 配置损坏：{error}"))?;
    Ok(file.cores)
}

fn read_cores(app: &AppHandle) -> Result<Vec<DeviceCore>, String> {
    let _guard = store_lock().lock().map_err(|_| "设备 Core 存储锁已损坏")?;
    read_cores_unlocked(app)
}

fn write_cores_unlocked(app: &AppHandle, cores: &[DeviceCore]) -> Result<(), String> {
    let path = cores_path(app)?;
    let parent = path
        .parent()
        .ok_or_else(|| "设备 Core 路径无效".to_string())?;
    std::fs::create_dir_all(parent).map_err(|error| format!("创建设备数据目录失败：{error}"))?;
    let raw = serde_json::to_string_pretty(&DeviceCoresFile {
        version: STORE_VERSION,
        cores: cores.to_vec(),
    })
    .map_err(|error| error.to_string())?;
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, raw).map_err(|error| format!("写入设备 Core 失败：{error}"))?;
    if let Err(first) = std::fs::rename(&temp, &path) {
        if cfg!(windows) && path.exists() {
            std::fs::remove_file(&path).map_err(|error| format!("替换设备 Core 失败：{error}"))?;
            std::fs::rename(&temp, &path)
                .map_err(|error| format!("替换设备 Core 失败：{error}"))?;
        } else {
            return Err(format!("保存设备 Core 失败：{first}"));
        }
    }
    Ok(())
}

fn normalize_base_url(raw: &str) -> Result<String, String> {
    let mut url = Url::parse(raw.trim()).map_err(|_| "请输入完整的 http(s) 地址")?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("设备 Core 只支持 http 或 https 地址".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("地址中不能包含用户名或密码，请使用访问令牌".into());
    }
    url.set_query(None);
    url.set_fragment(None);
    let mut path = url.path().trim_end_matches('/').to_string();
    if path.ends_with("/v1") {
        path.truncate(path.len() - 3);
    }
    url.set_path(path.trim_end_matches('/'));
    Ok(url.to_string().trim_end_matches('/').to_string())
}

fn endpoint(base_url: &str, path: &str) -> String {
    format!(
        "{}/{}",
        base_url.trim_end_matches('/'),
        path.trim_start_matches('/')
    )
}

fn authorization(token: Option<&str>) -> Option<String> {
    token
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| format!("Bearer {value}"))
}

async fn fetch_remote_devices(
    http: &reqwest::Client,
    core: &DeviceCore,
    token: Option<&str>,
) -> Result<(Vec<RemoteDeviceInfo>, u64), String> {
    let started = Instant::now();
    let mut request = http
        .get(endpoint(&core.base_url, "v1/devices"))
        .timeout(PROBE_TIMEOUT);
    if let Some(value) = authorization(token) {
        request = request.header(reqwest::header::AUTHORIZATION, value);
    }
    let response = request
        .send()
        .await
        .map_err(|error| format!("无法连接：{error}"))?;
    if !response.status().is_success() {
        return Err(format!("设备接口返回 HTTP {}", response.status().as_u16()));
    }
    let body: RemoteDevicesResponse = response
        .json()
        .await
        .map_err(|error| format!("设备列表格式无效：{error}"))?;
    Ok((body.devices, started.elapsed().as_millis() as u64))
}

async fn core_view(http: &reqwest::Client, core: DeviceCore) -> DeviceCoreView {
    let token = secrets::get_device_core_token(&core.id).ok().flatten();
    let has_token = token.as_ref().is_some_and(|value| !value.trim().is_empty());
    match fetch_remote_devices(http, &core, token.as_deref()).await {
        Ok((devices, latency_ms)) => DeviceCoreView {
            core,
            online: true,
            latency_ms: Some(latency_ms),
            device_count: devices.len(),
            last_error: String::new(),
            has_token,
        },
        Err(last_error) => DeviceCoreView {
            core,
            online: false,
            latency_ms: None,
            device_count: 0,
            last_error,
            has_token,
        },
    }
}

fn platform_name() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "android") {
        "android"
    } else if cfg!(target_os = "ios") {
        "ios"
    } else {
        "linux"
    }
}

fn local_device_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| match platform_name() {
            "macos" => "这台 Mac".into(),
            "windows" => "这台 Windows 设备".into(),
            "android" => "这台 Android 设备".into(),
            _ => "当前设备".into(),
        })
}

fn capabilities_for(platform: &str, role: &str) -> Vec<String> {
    if role == "core" {
        return vec!["core.health".into(), "core.devices".into()];
    }
    match platform.to_ascii_lowercase().as_str() {
        "android" | "ios" => vec![
            "system.status".into(),
            "system.ping".into(),
            "notification.send".into(),
            "camera.capture".into(),
            "location.read".into(),
        ],
        "macos" | "windows" | "linux" => vec![
            "system.status".into(),
            "system.ping".into(),
            "app.focus".into(),
            "files.access".into(),
            "terminal.execute".into(),
            "browser.control".into(),
        ],
        _ => vec!["system.status".into(), "system.ping".into()],
    }
}

fn local_device() -> ConnectedDevice {
    let platform = platform_name().to_string();
    ConnectedDevice {
        id: "local".into(),
        native_id: "local".into(),
        name: local_device_name(),
        platform: platform.clone(),
        core_id: "local".into(),
        core_name: "软件内嵌 Core".into(),
        role: "device".into(),
        online: true,
        capabilities: capabilities_for(&platform, "device"),
    }
}

#[tauri::command]
pub async fn list_device_cores(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<DeviceCoreView>, String> {
    let cores = read_cores(&app)?;
    let futures = cores.into_iter().map(|core| core_view(&state.http, core));
    Ok(futures_util::future::join_all(futures).await)
}

#[tauri::command]
pub async fn add_device_core(
    app: AppHandle,
    state: State<'_, AppState>,
    name: String,
    base_url: String,
    access_token: Option<String>,
) -> Result<DeviceCoreView, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("请输入设备或 Core 名称".into());
    }
    if name.chars().count() > 80 {
        return Err("名称不能超过 80 个字符".into());
    }
    let base_url = normalize_base_url(&base_url)?;
    let core = DeviceCore {
        id: Uuid::new_v4().to_string(),
        name: name.to_string(),
        base_url,
        created_at: now_ms(),
    };

    {
        let _guard = store_lock().lock().map_err(|_| "设备 Core 存储锁已损坏")?;
        let mut cores = read_cores_unlocked(&app)?;
        if cores.iter().any(|item| item.base_url == core.base_url) {
            return Err("这个 Core 地址已经添加".into());
        }
        cores.push(core.clone());
        write_cores_unlocked(&app, &cores)?;
    }

    if let Some(token) = access_token
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if let Err(error) = secrets::set_device_core_token(&core.id, token) {
            let _guard = store_lock().lock().map_err(|_| "设备 Core 存储锁已损坏")?;
            let mut cores = read_cores_unlocked(&app)?;
            cores.retain(|item| item.id != core.id);
            let _ = write_cores_unlocked(&app, &cores);
            return Err(error);
        }
    }

    state.device_fabric.connect(app.clone(), core.clone())?;

    Ok(core_view(&state.http, core).await)
}

#[tauri::command]
pub fn remove_device_core(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    let _guard = store_lock().lock().map_err(|_| "设备 Core 存储锁已损坏")?;
    let mut cores = read_cores_unlocked(&app)?;
    let previous_len = cores.len();
    cores.retain(|core| core.id != id);
    if cores.len() == previous_len {
        return Err("设备 Core 不存在".into());
    }
    write_cores_unlocked(&app, &cores)?;
    secrets::delete_device_core_token(&id)?;
    state.device_fabric.disconnect(&id)
}

#[tauri::command]
pub async fn probe_device_core(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<DeviceCoreView, String> {
    let core = read_cores(&app)?
        .into_iter()
        .find(|core| core.id == id)
        .ok_or_else(|| "设备 Core 不存在".to_string())?;
    Ok(core_view(&state.http, core).await)
}

#[tauri::command]
pub async fn list_connected_devices(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<ConnectedDevice>, String> {
    list_connected_devices_inner(&app, &state.http).await
}

pub(crate) async fn list_connected_devices_inner(
    app: &AppHandle,
    http: &reqwest::Client,
) -> Result<Vec<ConnectedDevice>, String> {
    let mut result = vec![local_device()];
    for core in read_cores(app)? {
        let token = secrets::get_device_core_token(&core.id).ok().flatten();
        let remote = fetch_remote_devices(http, &core, token.as_deref()).await;
        let online = remote.is_ok();
        result.push(ConnectedDevice {
            id: format!("core:{}", core.id),
            native_id: core.id.clone(),
            name: core.name.clone(),
            platform: "core".into(),
            core_id: core.id.clone(),
            core_name: core.name.clone(),
            role: "core".into(),
            online,
            capabilities: capabilities_for("core", "core"),
        });
        if let Ok((devices, _)) = remote {
            result.extend(devices.into_iter().map(|device| ConnectedDevice {
                id: format!("{}/{}", core.id, device.id),
                native_id: device.id,
                name: device.name,
                platform: device.platform.clone(),
                core_id: core.id.clone(),
                core_name: core.name.clone(),
                role: "device".into(),
                online: true,
                capabilities: capabilities_for(&device.platform, "device"),
            }));
        }
    }
    Ok(result)
}

fn local_result(
    app: &AppHandle,
    request_id: String,
    capability: &str,
    started: Instant,
) -> Result<DeviceInvokeResult, String> {
    let output = match capability {
        "system.ping" => json!({"reply":"pong","at":now_ms()}),
        "system.status" => json!({
            "name": local_device_name(),
            "platform": platform_name(),
            "arch": std::env::consts::ARCH,
            "appVersion": app.package_info().version.to_string(),
            "capabilities": capabilities_for(platform_name(), "device"),
            "at": now_ms(),
        }),
        "app.focus" => {
            let window = app
                .get_webview_window("main")
                .ok_or_else(|| "找不到主窗口".to_string())?;
            window
                .show()
                .map_err(|error| format!("显示窗口失败：{error}"))?;
            window
                .set_focus()
                .map_err(|error| format!("聚焦窗口失败：{error}"))?;
            json!({"focused":true})
        }
        _ => return Err(format!("本机尚未实现设备能力：{capability}")),
    };
    Ok(DeviceInvokeResult {
        request_id,
        device_id: "local".into(),
        capability: capability.into(),
        ok: true,
        output,
        message: "本机能力调用完成".into(),
        duration_ms: started.elapsed().as_millis() as u64,
    })
}

fn websocket_endpoint(core: &DeviceCore, client_id: &str) -> Result<String, String> {
    let mut url = Url::parse(&endpoint(&core.base_url, "v1/connect"))
        .map_err(|error| format!("Core 地址无效：{error}"))?;
    url.set_scheme(if url.scheme() == "https" { "wss" } else { "ws" })
        .map_err(|_| "无法转换 WebSocket 地址".to_string())?;
    url.query_pairs_mut().append_pair("id", client_id);
    Ok(url.to_string())
}

async fn invoke_remote_device(
    core: &DeviceCore,
    target_id: &str,
    request_id: String,
    capability: &str,
    input: Value,
    started: Instant,
) -> Result<DeviceInvokeResult, String> {
    let client_id = format!("controller-{}", Uuid::new_v4());
    let ws_url = websocket_endpoint(core, &client_id)?;
    let mut request = ws_url
        .into_client_request()
        .map_err(|error| format!("无法创建设备连接：{error}"))?;
    if let Some(token) = secrets::get_device_core_token(&core.id)?
        .as_deref()
        .and_then(|token| authorization(Some(token)))
    {
        request.headers_mut().insert(
            AUTHORIZATION,
            token.parse().map_err(|_| "访问令牌格式无效".to_string())?,
        );
    }

    let operation = async {
        let (mut socket, _) = connect_async(request)
            .await
            .map_err(|error| format!("无法连接设备 Hub：{error}"))?;
        let hello = InterconnectEnvelope {
            kind: "hello".into(),
            from: String::new(),
            to: String::new(),
            name: "铁铁汁控制端".into(),
            platform: platform_name().into(),
            payload: None,
        };
        socket
            .send(Message::Text(
                serde_json::to_string(&hello)
                    .map_err(|error| error.to_string())?
                    .into(),
            ))
            .await
            .map_err(|error| format!("发送设备握手失败：{error}"))?;

        let payload = json!({
            "type": "capability.invoke",
            "version": 1,
            "requestId": request_id,
            "capability": capability,
            "input": input,
        });
        let invoke = InterconnectEnvelope {
            kind: "message".into(),
            from: String::new(),
            to: target_id.into(),
            name: String::new(),
            platform: String::new(),
            payload: Some(payload),
        };

        let mut sent = false;
        while let Some(message) = socket.next().await {
            let message = message.map_err(|error| format!("读取设备消息失败：{error}"))?;
            if !message.is_text() {
                continue;
            }
            let envelope: InterconnectEnvelope = serde_json::from_str(
                message
                    .to_text()
                    .map_err(|error| format!("设备消息不是文本：{error}"))?,
            )
            .map_err(|error| format!("设备消息格式无效：{error}"))?;
            if envelope.kind == "welcome" && !sent {
                socket
                    .send(Message::Text(
                        serde_json::to_string(&invoke)
                            .map_err(|error| error.to_string())?
                            .into(),
                    ))
                    .await
                    .map_err(|error| format!("发送设备调用失败：{error}"))?;
                sent = true;
                continue;
            }
            let Some(payload) = envelope.payload else {
                continue;
            };
            if payload.get("type").and_then(Value::as_str) != Some("capability.result")
                || payload.get("requestId").and_then(Value::as_str) != Some(request_id.as_str())
            {
                continue;
            }
            let ok = payload.get("ok").and_then(Value::as_bool).unwrap_or(false);
            let message = payload
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or(if ok {
                    "设备能力调用完成"
                } else {
                    "设备能力调用失败"
                })
                .to_string();
            let output = payload.get("output").cloned().unwrap_or(Value::Null);
            return Ok(DeviceInvokeResult {
                request_id,
                device_id: format!("{}/{}", core.id, target_id),
                capability: capability.into(),
                ok,
                output,
                message,
                duration_ms: started.elapsed().as_millis() as u64,
            });
        }
        Err("设备在返回结果前断开连接".to_string())
    };

    tokio::time::timeout(INVOKE_TIMEOUT, operation)
        .await
        .map_err(|_| "等待设备响应超时；请确认目标设备已实现该能力".to_string())?
}

pub(crate) async fn invoke_device_inner(
    app: &AppHandle,
    http: &reqwest::Client,
    device_id: &str,
    capability: &str,
    input: Value,
) -> Result<DeviceInvokeResult, String> {
    let device_id = device_id.trim();
    let capability = capability.trim();
    if device_id.is_empty() || capability.is_empty() {
        return Err("设备 ID 和能力不能为空".into());
    }
    if !input.is_object() && !input.is_null() {
        return Err("设备能力参数必须是 JSON 对象".into());
    }
    let started = Instant::now();
    let request_id = Uuid::new_v4().to_string();
    if device_id == "local" {
        return local_result(app, request_id, capability, started);
    }
    if let Some(core_id) = device_id.strip_prefix("core:") {
        if capability != "core.health" && capability != "core.devices" {
            return Err("Core 节点只支持 core.health 和 core.devices".into());
        }
        let core = read_cores(app)?
            .into_iter()
            .find(|core| core.id == core_id)
            .ok_or_else(|| "设备 Core 不存在".to_string())?;
        let token = secrets::get_device_core_token(&core.id)?;
        let (devices, latency_ms) = fetch_remote_devices(http, &core, token.as_deref()).await?;
        return Ok(DeviceInvokeResult {
            request_id,
            device_id: device_id.into(),
            capability: capability.into(),
            ok: true,
            output: json!({
                "online": true,
                "latencyMs": latency_ms,
                "devices": devices.into_iter().map(|device| json!({
                    "id": device.id,
                    "name": device.name,
                    "platform": device.platform,
                })).collect::<Vec<_>>(),
            }),
            message: "Core 连接正常".into(),
            duration_ms: started.elapsed().as_millis() as u64,
        });
    }
    let (core_id, target_id) = device_id
        .split_once('/')
        .ok_or_else(|| "远程设备 ID 格式无效".to_string())?;
    let core = read_cores(app)?
        .into_iter()
        .find(|core| core.id == core_id)
        .ok_or_else(|| "设备 Core 不存在".to_string())?;
    invoke_remote_device(&core, target_id, request_id, capability, input, started).await
}

async fn run_device_node(app: AppHandle, core: DeviceCore, cancel: CancellationToken) {
    loop {
        if cancel.is_cancelled() {
            return;
        }
        super::codex::update_remote_transport_status(&app, &app.state::<AppState>(), false, None);
        if let Err(error) = device_node_session(&app, &core, &cancel).await {
            app.state::<AppState>().device_fabric.clear_routes(&core.id);
            if !cancel.is_cancelled() {
                eprintln!("[device] {}: {error}", core.name);
                super::codex::update_remote_transport_status(
                    &app,
                    &app.state::<AppState>(),
                    false,
                    Some(error),
                );
            }
        }
        tokio::select! {
            _ = cancel.cancelled() => return,
            _ = tokio::time::sleep(RECONNECT_DELAY) => {}
        }
    }
}

async fn device_node_session(
    app: &AppHandle,
    core: &DeviceCore,
    cancel: &CancellationToken,
) -> Result<(), String> {
    let device_id = local_identity(app)?;
    let ws_url = websocket_endpoint(core, &device_id)?;
    let mut request = ws_url
        .into_client_request()
        .map_err(|error| format!("无法创建设备连接：{error}"))?;
    if let Some(token) = secrets::get_device_core_token(&core.id)?
        .as_deref()
        .and_then(|token| authorization(Some(token)))
    {
        request.headers_mut().insert(
            AUTHORIZATION,
            token.parse().map_err(|_| "访问令牌格式无效".to_string())?,
        );
    }

    let connect = tokio::time::timeout(PROBE_TIMEOUT, connect_async(request));
    let (mut socket, _) = tokio::select! {
        _ = cancel.cancelled() => return Ok(()),
        connected = connect => connected
            .map_err(|_| "连接设备 Hub 超时".to_string())?
            .map_err(|error| format!("连接设备 Hub 失败：{error}"))?,
    };
    let hello = InterconnectEnvelope {
        kind: "hello".into(),
        from: String::new(),
        to: String::new(),
        name: local_device_name(),
        platform: platform_name().into(),
        payload: None,
    };
    socket
        .send(Message::Text(
            serde_json::to_string(&hello)
                .map_err(|error| error.to_string())?
                .into(),
        ))
        .await
        .map_err(|error| format!("发送设备注册失败：{error}"))?;
    super::codex::update_remote_transport_status(app, &app.state::<AppState>(), true, None);
    let mut remote_outbound = app.state::<AppState>().device_fabric.outbound.subscribe();

    loop {
        let message = tokio::select! {
            _ = cancel.cancelled() => {
                let _ = socket.close(None).await;
                return Ok(());
            }
            outbound = remote_outbound.recv() => {
                match outbound {
                    Ok(outbound) if outbound.core_id == core.id => {
                        let envelope = InterconnectEnvelope {
                            kind: "message".into(),
                            from: String::new(),
                            to: outbound.client_id,
                            name: String::new(),
                            platform: String::new(),
                            payload: Some(outbound.payload),
                        };
                        socket
                            .send(Message::Text(
                                serde_json::to_string(&envelope)
                                    .map_err(|error| error.to_string())?
                                    .into(),
                            ))
                            .await
                            .map_err(|error| format!("发送远程 Codex 事件失败：{error}"))?;
                        continue;
                    }
                    Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => {
                        return Err("设备 Fabric 出站通道已关闭".into());
                    }
                }
            }
            message = socket.next() => message,
        };
        let Some(message) = message else {
            return Err("设备 Hub 已关闭连接".into());
        };
        let message = message.map_err(|error| format!("读取设备 Hub 消息失败：{error}"))?;
        match message {
            Message::Ping(payload) => {
                socket
                    .send(Message::Pong(payload))
                    .await
                    .map_err(|error| format!("回复设备心跳失败：{error}"))?;
            }
            Message::Close(_) => return Err("设备 Hub 已断开".into()),
            Message::Text(text) => {
                let Ok(envelope) = serde_json::from_str::<InterconnectEnvelope>(&text) else {
                    continue;
                };
                if envelope.kind != "message" || envelope.from.is_empty() {
                    continue;
                }
                app.state::<AppState>()
                    .device_fabric
                    .register_route(&envelope.from, &core.id);
                let Some(payload) = envelope.payload else {
                    continue;
                };
                let request_id = payload
                    .get("requestId")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                if request_id.is_empty() {
                    continue;
                }
                let payload_type = payload
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let response_type = if payload_type.starts_with("codex.remote.") {
                    "codex.remote.result"
                } else {
                    "capability.result"
                };
                let result = match payload_type {
                    "codex.remote.pair" => super::codex::claim_remote_pairing(
                        app,
                        &app.state::<AppState>(),
                        &envelope.from,
                        &payload,
                    ),
                    "codex.remote.request" | "codex.remote.serverResponse" => {
                        super::codex::dispatch_remote_transport_request(
                            app,
                            &app.state::<AppState>(),
                            &envelope.from,
                            &payload,
                        )
                        .await
                    }
                    "capability.invoke" => {
                        let capability = payload
                            .get("capability")
                            .and_then(Value::as_str)
                            .unwrap_or_default();
                        let started = Instant::now();
                        match capability {
                            "system.ping" | "system.status" => {
                                local_result(app, request_id.clone(), capability, started)
                                    .map(|result| result.output)
                            }
                            _ => Err(format!(
                                "远程调用 {capability} 需要在目标设备上获得用户批准，当前节点未授权"
                            )),
                        }
                    }
                    _ => continue,
                };
                let payload = match result {
                    Ok(output) => json!({
                        "type": response_type,
                        "version": 1,
                        "requestId": request_id,
                        "ok": true,
                        "output": output,
                        "message": "",
                    }),
                    Err(message) => json!({
                        "type": response_type,
                        "version": 1,
                        "requestId": request_id,
                        "ok": false,
                        "output": null,
                        "message": message,
                    }),
                };
                let response = InterconnectEnvelope {
                    kind: "message".into(),
                    from: String::new(),
                    to: envelope.from,
                    name: String::new(),
                    platform: String::new(),
                    payload: Some(payload),
                };
                socket
                    .send(Message::Text(
                        serde_json::to_string(&response)
                            .map_err(|error| error.to_string())?
                            .into(),
                    ))
                    .await
                    .map_err(|error| format!("发送设备调用结果失败：{error}"))?;
            }
            _ => {}
        }
    }
}

#[tauri::command]
pub async fn invoke_device(
    app: AppHandle,
    state: State<'_, AppState>,
    device_id: String,
    capability: String,
    input: Option<Value>,
) -> Result<DeviceInvokeResult, String> {
    invoke_device_inner(
        &app,
        &state.http,
        &device_id,
        &capability,
        input.unwrap_or_else(|| Value::Object(Default::default())),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_base_urls_and_v1_suffix() {
        assert_eq!(
            normalize_base_url("https://home.example/v1/").unwrap(),
            "https://home.example"
        );
        assert_eq!(
            normalize_base_url("http://127.0.0.1:8080/tietiezhi/").unwrap(),
            "http://127.0.0.1:8080/tietiezhi"
        );
    }

    #[test]
    fn rejects_credentials_and_non_http_urls() {
        assert!(normalize_base_url("ws://home.example").is_err());
        assert!(normalize_base_url("https://user:secret@home.example").is_err());
    }

    #[test]
    fn android_and_desktop_capabilities_are_distinct() {
        assert!(capabilities_for("android", "device").contains(&"camera.capture".into()));
        assert!(capabilities_for("macos", "device").contains(&"terminal.execute".into()));
        assert!(!capabilities_for("android", "device").contains(&"terminal.execute".into()));
    }
}
