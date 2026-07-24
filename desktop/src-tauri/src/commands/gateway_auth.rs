use std::time::Duration;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use uuid::Uuid;

use super::settings::read_settings;
use crate::{secrets, AppState};

const CLIENT_ID: &str = "tietiezhi-desktop";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayAccountView {
    pub provider_id: String,
    pub supported: bool,
    pub logged_in: bool,
    pub account: Option<GatewayAccount>,
    pub expires: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayAccount {
    #[serde(alias = "user_id")]
    pub user_id: u64,
    pub email: String,
    pub nickname: String,
    pub avatar: String,
}

#[derive(Deserialize)]
struct Discovery {
    issuer: String,
    authorization_endpoint: String,
    token_endpoint: String,
    session_endpoint: String,
    revocation_endpoint: String,
    #[serde(default)]
    quota_endpoint: Option<String>,
    #[serde(default)]
    catalog_endpoint: Option<String>,
    #[serde(default)]
    order_endpoint: Option<String>,
    #[serde(default)]
    order_status_endpoint: Option<String>,
    client_id: String,
}

#[derive(Deserialize)]
struct APIResponse<T> {
    success: bool,
    #[serde(default)]
    message: String,
    data: Option<T>,
}

#[derive(Deserialize)]
struct TokenData {
    session_token: String,
    api_key: String,
    expires: i64,
    account: GatewayAccount,
}

#[derive(Deserialize)]
struct SessionData {
    expires: i64,
    account: GatewayAccount,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayWallet {
    #[serde(alias = "balance_micro")]
    pub balance_micro: i64,
    #[serde(alias = "frozen_micro")]
    pub frozen_micro: i64,
    #[serde(alias = "total_topup_micro")]
    pub total_topup_micro: i64,
    #[serde(alias = "total_spend_micro")]
    pub total_spend_micro: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayOwnedPackage {
    pub id: u64,
    pub name: String,
    pub status: String,
    #[serde(alias = "meter_by")]
    pub meter_by: String,
    #[serde(alias = "quota_per_window")]
    pub quota_per_window: i64,
    #[serde(alias = "total_quota_cap")]
    pub total_quota_cap: i64,
    #[serde(alias = "total_used")]
    pub total_used: i64,
    #[serde(alias = "window_remaining")]
    pub window_remaining: i64,
    #[serde(alias = "valid_until")]
    pub valid_until: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayConsumption {
    #[serde(alias = "request_id")]
    pub request_id: String,
    #[serde(alias = "public_model")]
    pub public_model: String,
    #[serde(alias = "amount_micro")]
    pub amount_micro: i64,
    #[serde(alias = "user_package_id")]
    pub user_package_id: u64,
    #[serde(alias = "card_measure")]
    pub card_measure: i64,
    #[serde(alias = "created_at")]
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayPaymentChannels {
    pub alipay: bool,
    pub wechat: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayQuotaView {
    pub wallet: GatewayWallet,
    pub packages: Vec<GatewayOwnedPackage>,
    #[serde(alias = "recent_consumption")]
    pub recent_consumption: Vec<GatewayConsumption>,
    #[serde(alias = "payment_channels")]
    pub payment_channels: GatewayPaymentChannels,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayCatalogPackage {
    pub id: u64,
    pub name: String,
    pub description: String,
    #[serde(alias = "meter_by")]
    pub meter_by: String,
    #[serde(alias = "quota_per_window")]
    pub quota_per_window: i64,
    #[serde(alias = "valid_days")]
    pub valid_days: i32,
    #[serde(alias = "max_purchases_per_user")]
    pub max_purchases_per_user: i32,
    #[serde(alias = "price_micro")]
    pub price_micro: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayPackageCatalog {
    pub items: Vec<GatewayCatalogPackage>,
    #[serde(alias = "payment_channels")]
    pub payment_channels: GatewayPaymentChannels,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayPackageOrder {
    #[serde(alias = "order_no")]
    pub order_no: String,
    #[serde(alias = "package_id")]
    pub package_id: u64,
    #[serde(alias = "package_name")]
    pub package_name: String,
    pub provider: String,
    #[serde(alias = "pay_amount_micro")]
    pub pay_amount_micro: i64,
    #[serde(alias = "pay_amount_cny")]
    pub pay_amount_cny: String,
    #[serde(alias = "payment_url")]
    pub payment_url: String,
    pub status: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayOrderStatus {
    #[serde(alias = "order_no")]
    pub order_no: String,
    #[serde(alias = "package_id")]
    pub package_id: u64,
    pub provider: String,
    #[serde(alias = "pay_amount_micro")]
    pub pay_amount_micro: i64,
    pub status: i32,
    #[serde(alias = "paid_at")]
    pub paid_at: Option<String>,
    #[serde(alias = "promotion_status")]
    pub promotion_status: Option<String>,
    #[serde(alias = "promotion_message")]
    pub promotion_message: Option<String>,
}

#[tauri::command]
pub async fn gateway_account(
    state: State<'_, AppState>,
    app: AppHandle,
    provider_id: String,
) -> Result<GatewayAccountView, String> {
    let base_url = provider_base_url(&app, &provider_id)?;
    let discovery = match fetch_discovery(&state.http, &base_url).await {
        Ok(value) => value,
        Err(_) => {
            return Ok(GatewayAccountView {
                provider_id,
                supported: false,
                logged_in: false,
                account: None,
                expires: None,
            })
        }
    };
    let issuer = gateway_root(&base_url)?;
    if secrets::get_gateway_issuer(&provider_id)?.as_deref() != Some(issuer.as_str()) {
        clear_gateway_secrets(&provider_id)?;
        return Ok(GatewayAccountView {
            provider_id,
            supported: true,
            logged_in: false,
            account: None,
            expires: None,
        });
    }
    let Some(session_token) = secrets::get_gateway_session(&provider_id)? else {
        return Ok(GatewayAccountView {
            provider_id,
            supported: true,
            logged_in: false,
            account: None,
            expires: None,
        });
    };
    let result: APIResponse<SessionData> = post_json(
        &state.http,
        &discovery.session_endpoint,
        &serde_json::json!({ "session_token": session_token }),
    )
    .await?;
    let Some(data) = result.data.filter(|_| result.success) else {
        clear_gateway_secrets(&provider_id)?;
        return Ok(GatewayAccountView {
            provider_id,
            supported: true,
            logged_in: false,
            account: None,
            expires: None,
        });
    };
    Ok(GatewayAccountView {
        provider_id,
        supported: true,
        logged_in: true,
        account: Some(data.account),
        expires: Some(data.expires),
    })
}

#[tauri::command]
pub async fn gateway_login(
    state: State<'_, AppState>,
    app: AppHandle,
    provider_id: String,
) -> Result<GatewayAccountView, String> {
    let base_url = provider_base_url(&app, &provider_id)?;
    let discovery = fetch_discovery(&state.http, &base_url).await?;
    if discovery.client_id != CLIENT_ID {
        return Err("当前中转站不支持此版本的铁铁汁登录".into());
    }

    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("无法启动登录回调：{e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("无法读取登录回调地址：{e}"))?
        .port();
    let redirect_uri = format!("http://127.0.0.1:{port}/callback");
    let state_value = random_urlsafe();
    let verifier = format!("{}{}", random_urlsafe(), random_urlsafe());
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let device_id = load_or_create_device_id(&app)?;
    let device_name = desktop_device_name();

    let mut authorize_url = reqwest::Url::parse(&discovery.authorization_endpoint)
        .map_err(|_| "中转站返回了无效的登录地址".to_string())?;
    authorize_url
        .query_pairs_mut()
        .append_pair("client_id", CLIENT_ID)
        .append_pair("device_id", &device_id)
        .append_pair("device_name", &device_name)
        .append_pair("redirect_uri", &redirect_uri)
        .append_pair("code_challenge", &challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", &state_value);
    open_system_browser(authorize_url.as_str())?;

    let (code, returned_state) = wait_for_callback(listener).await?;
    if returned_state != state_value {
        return Err("登录状态校验失败，请重试".into());
    }
    let token: APIResponse<TokenData> = post_json(
        &state.http,
        &discovery.token_endpoint,
        &serde_json::json!({
            "client_id": CLIENT_ID,
            "code": code,
            "code_verifier": verifier,
            "redirect_uri": redirect_uri,
        }),
    )
    .await?;
    let data = token
        .data
        .filter(|_| token.success)
        .ok_or_else(|| api_error(token.message, "登录失败"))?;
    let issuer = gateway_root(&base_url)?;
    if let Err(error) =
        store_gateway_secrets(&provider_id, &issuer, &data.session_token, &data.api_key)
    {
        let _ = clear_gateway_secrets(&provider_id);
        return Err(error);
    }
    Ok(GatewayAccountView {
        provider_id,
        supported: true,
        logged_in: true,
        account: Some(data.account),
        expires: Some(data.expires),
    })
}

#[tauri::command]
pub async fn gateway_logout(
    state: State<'_, AppState>,
    app: AppHandle,
    provider_id: String,
) -> Result<(), String> {
    let session = secrets::get_gateway_session(&provider_id)?;
    let issuer = secrets::get_gateway_issuer(&provider_id)?
        .or_else(|| provider_base_url(&app, &provider_id).ok());
    if let (Some(session_token), Some(base_url)) = (session, issuer) {
        if let Ok(discovery) = fetch_discovery(&state.http, &base_url).await {
            let _: Result<APIResponse<serde_json::Value>, String> = post_json(
                &state.http,
                &discovery.revocation_endpoint,
                &serde_json::json!({ "session_token": session_token }),
            )
            .await;
        }
    }
    clear_gateway_secrets(&provider_id)
}

#[tauri::command]
pub async fn gateway_quota(
    state: State<'_, AppState>,
    app: AppHandle,
    provider_id: String,
) -> Result<GatewayQuotaView, String> {
    let (discovery, session_token) =
        native_billing_context(&state.http, &app, &provider_id).await?;
    let endpoint = discovery
        .quota_endpoint
        .ok_or_else(|| "当前中转站版本不支持额度中心".to_string())?;
    let result: APIResponse<GatewayQuotaView> = post_json(
        &state.http,
        &endpoint,
        &serde_json::json!({ "session_token": session_token }),
    )
    .await?;
    result
        .data
        .filter(|_| result.success)
        .ok_or_else(|| api_error(result.message, "获取额度失败"))
}

#[tauri::command]
pub async fn gateway_package_catalog(
    state: State<'_, AppState>,
    app: AppHandle,
    provider_id: String,
) -> Result<GatewayPackageCatalog, String> {
    let (discovery, session_token) =
        native_billing_context(&state.http, &app, &provider_id).await?;
    let endpoint = discovery
        .catalog_endpoint
        .ok_or_else(|| "当前中转站版本不支持套餐目录".to_string())?;
    let result: APIResponse<GatewayPackageCatalog> = post_json(
        &state.http,
        &endpoint,
        &serde_json::json!({ "session_token": session_token }),
    )
    .await?;
    result
        .data
        .filter(|_| result.success)
        .ok_or_else(|| api_error(result.message, "获取套餐失败"))
}

#[tauri::command]
pub async fn gateway_create_package_order(
    state: State<'_, AppState>,
    app: AppHandle,
    provider_id: String,
    package_id: u64,
    payment_provider: String,
) -> Result<GatewayPackageOrder, String> {
    if payment_provider != "alipay" && payment_provider != "wechat" {
        return Err("不支持的支付方式".into());
    }
    let (discovery, session_token) =
        native_billing_context(&state.http, &app, &provider_id).await?;
    let endpoint = discovery
        .order_endpoint
        .ok_or_else(|| "当前中转站版本不支持桌面购买".to_string())?;
    let result: APIResponse<GatewayPackageOrder> = post_json(
        &state.http,
        &endpoint,
        &serde_json::json!({
            "session_token": session_token,
            "package_id": package_id,
            "provider": payment_provider,
        }),
    )
    .await?;
    let order = result
        .data
        .filter(|_| result.success)
        .ok_or_else(|| api_error(result.message, "创建订单失败"))?;
    open_system_browser(&order.payment_url)?;
    Ok(order)
}

#[tauri::command]
pub async fn gateway_package_order_status(
    state: State<'_, AppState>,
    app: AppHandle,
    provider_id: String,
    order_no: String,
) -> Result<GatewayOrderStatus, String> {
    let (discovery, session_token) =
        native_billing_context(&state.http, &app, &provider_id).await?;
    let endpoint = discovery
        .order_status_endpoint
        .ok_or_else(|| "当前中转站版本不支持订单查询".to_string())?;
    let result: APIResponse<GatewayOrderStatus> = post_json(
        &state.http,
        &endpoint,
        &serde_json::json!({
            "session_token": session_token,
            "order_no": order_no,
        }),
    )
    .await?;
    result
        .data
        .filter(|_| result.success)
        .ok_or_else(|| api_error(result.message, "查询订单失败"))
}

async fn native_billing_context(
    http: &reqwest::Client,
    app: &AppHandle,
    provider_id: &str,
) -> Result<(Discovery, String), String> {
    let base_url = provider_base_url(app, provider_id)?;
    let issuer = gateway_root(&base_url)?;
    if secrets::get_gateway_issuer(provider_id)?.as_deref() != Some(issuer.as_str()) {
        return Err("请先登录当前中转站".into());
    }
    let session_token = secrets::get_gateway_session(provider_id)?
        .ok_or_else(|| "请先登录当前中转站".to_string())?;
    let discovery = fetch_discovery(http, &base_url).await?;
    Ok((discovery, session_token))
}

fn provider_base_url(app: &AppHandle, provider_id: &str) -> Result<String, String> {
    read_settings(app)?
        .providers
        .into_iter()
        .find(|provider| provider.id == provider_id)
        .map(|provider| provider.base_url)
        .ok_or_else(|| "未找到当前中转站".into())
}

async fn fetch_discovery(http: &reqwest::Client, base_url: &str) -> Result<Discovery, String> {
    let expected_issuer = gateway_root(base_url)?;
    let url = expected_issuer.clone() + "/.well-known/tietiezhi-gateway";
    let response = http
        .get(url)
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("无法连接当前中转站：{e}"))?;
    if !response.status().is_success() {
        return Err("当前服务不是支持账号登录的 Tietiezhi Gateway".into());
    }
    let discovery = response
        .json::<Discovery>()
        .await
        .map_err(|_| "中转站登录配置无效".to_string())?;
    validate_discovery(&expected_issuer, &discovery)?;
    Ok(discovery)
}

async fn post_json<T: DeserializeOwned>(
    http: &reqwest::Client,
    url: &str,
    body: &serde_json::Value,
) -> Result<T, String> {
    let response = http
        .post(url)
        .json(body)
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| format!("中转站请求失败：{e}"))?;
    response
        .json::<T>()
        .await
        .map_err(|_| "中转站返回了无法识别的响应".into())
}

fn gateway_root(base_url: &str) -> Result<String, String> {
    let trimmed = base_url.trim().trim_end_matches('/');
    if !trimmed.starts_with("http://") && !trimmed.starts_with("https://") {
        return Err("baseURL 需以 http:// 或 https:// 开头".into());
    }
    Ok(trimmed.strip_suffix("/v1").unwrap_or(trimmed).to_owned())
}

fn validate_discovery(expected_issuer: &str, discovery: &Discovery) -> Result<(), String> {
    let issuer = gateway_root(&discovery.issuer)?;
    if issuer != expected_issuer {
        return Err("中转站登录签发方与当前地址不一致".into());
    }
    for endpoint in [
        &discovery.authorization_endpoint,
        &discovery.token_endpoint,
        &discovery.session_endpoint,
        &discovery.revocation_endpoint,
    ] {
        let parsed =
            reqwest::Url::parse(endpoint).map_err(|_| "中转站返回了无效的登录地址".to_string())?;
        let origin = format!(
            "{}://{}{}",
            parsed.scheme(),
            parsed
                .host_str()
                .ok_or_else(|| "中转站返回了无效的登录地址".to_string())?,
            parsed
                .port()
                .map(|port| format!(":{port}"))
                .unwrap_or_default(),
        );
        if origin != issuer {
            return Err("中转站登录端点必须与签发方同源".into());
        }
    }
    for endpoint in [
        discovery.quota_endpoint.as_ref(),
        discovery.catalog_endpoint.as_ref(),
        discovery.order_endpoint.as_ref(),
        discovery.order_status_endpoint.as_ref(),
    ]
    .into_iter()
    .flatten()
    {
        let parsed =
            reqwest::Url::parse(endpoint).map_err(|_| "中转站返回了无效的额度地址".to_string())?;
        let origin = format!(
            "{}://{}{}",
            parsed.scheme(),
            parsed
                .host_str()
                .ok_or_else(|| "中转站返回了无效的额度地址".to_string())?,
            parsed
                .port()
                .map(|port| format!(":{port}"))
                .unwrap_or_default(),
        );
        if origin != issuer {
            return Err("中转站额度端点必须与签发方同源".into());
        }
    }
    Ok(())
}

async fn wait_for_callback(listener: TcpListener) -> Result<(String, String), String> {
    let (mut stream, _) = tokio::time::timeout(Duration::from_secs(180), listener.accept())
        .await
        .map_err(|_| "登录等待超时，请重试".to_string())?
        .map_err(|e| format!("接收登录回调失败：{e}"))?;
    let mut buffer = vec![0u8; 8192];
    let size = stream
        .read(&mut buffer)
        .await
        .map_err(|e| format!("读取登录回调失败：{e}"))?;
    let request = String::from_utf8_lossy(&buffer[..size]);
    let target = request
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .ok_or_else(|| "登录回调无效".to_string())?;
    let parsed = reqwest::Url::parse(&format!("http://127.0.0.1{target}"))
        .map_err(|_| "登录回调无效".to_string())?;
    let code = parsed
        .query_pairs()
        .find(|(key, _)| key == "code")
        .map(|(_, value)| value.into_owned())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "中转站未返回授权码".to_string())?;
    let state = parsed
        .query_pairs()
        .find(|(key, _)| key == "state")
        .map(|(_, value)| value.into_owned())
        .unwrap_or_default();
    let html = "<!doctype html><meta charset=\"utf-8\"><title>登录成功</title><main><h1>已连接铁铁汁</h1><p>可以关闭此页面并返回桌面端。</p></main>";
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        html.len(),
        html
    );
    let _ = stream.write_all(response.as_bytes()).await;
    Ok((code, state))
}

fn open_system_browser(url: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = std::process::Command::new("open");
        command.arg(url);
        command
    };
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = std::process::Command::new("rundll32");
        command.arg("url.dll,FileProtocolHandler").arg(url);
        command
    };
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let mut command = {
        let mut command = std::process::Command::new("xdg-open");
        command.arg(url);
        command
    };
    command
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("无法打开系统浏览器：{e}"))
}

fn load_or_create_device_id(app: &AppHandle) -> Result<String, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("无法定位配置目录：{e}"))?;
    let path = dir.join("device-id");
    if let Ok(value) = std::fs::read_to_string(&path) {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return Ok(trimmed.to_owned());
        }
    }
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建配置目录失败：{e}"))?;
    let value = Uuid::new_v4().to_string();
    std::fs::write(path, &value).map_err(|e| format!("保存设备标识失败：{e}"))?;
    Ok(value)
}

fn desktop_device_name() -> String {
    match std::env::consts::OS {
        "macos" => "Mac 上的铁铁汁".into(),
        "windows" => "Windows 上的铁铁汁".into(),
        _ => "铁铁汁桌面端".into(),
    }
}

fn random_urlsafe() -> String {
    Uuid::new_v4().simple().to_string()
}

fn clear_gateway_secrets(provider_id: &str) -> Result<(), String> {
    secrets::delete_gateway_session(provider_id)?;
    secrets::delete_gateway_api_key(provider_id)?;
    secrets::delete_gateway_issuer(provider_id)
}

fn store_gateway_secrets(
    provider_id: &str,
    issuer: &str,
    session_token: &str,
    api_key: &str,
) -> Result<(), String> {
    secrets::set_gateway_session(provider_id, session_token)?;
    secrets::set_gateway_api_key(provider_id, api_key)?;
    secrets::set_gateway_issuer(provider_id, issuer)
}

pub(crate) fn gateway_api_key(provider_id: &str, base_url: &str) -> Result<Option<String>, String> {
    let issuer = gateway_root(base_url)?;
    if secrets::get_gateway_issuer(provider_id)?.as_deref() != Some(issuer.as_str()) {
        return Ok(None);
    }
    secrets::get_gateway_api_key(provider_id)
}

fn api_error(message: String, fallback: &str) -> String {
    let message = message.trim();
    if message.is_empty() {
        fallback.into()
    } else {
        message.into()
    }
}

#[cfg(test)]
mod tests {
    use super::{gateway_root, validate_discovery, Discovery, GatewayQuotaView};

    #[test]
    fn derives_gateway_root() {
        assert_eq!(
            gateway_root("https://gateway.example.test/v1").unwrap(),
            "https://gateway.example.test"
        );
    }

    #[test]
    fn discovery_endpoints_must_match_the_gateway_origin() {
        let discovery = Discovery {
            issuer: "https://gateway.example.test".into(),
            authorization_endpoint: "https://gateway.example.test/desktop-authorize".into(),
            token_endpoint: "https://gateway.example.test/app-api/user/auth/native/token".into(),
            session_endpoint: "https://gateway.example.test/app-api/user/auth/native/session"
                .into(),
            revocation_endpoint: "https://gateway.example.test/app-api/user/auth/native/revoke"
                .into(),
            quota_endpoint: Some(
                "https://gateway.example.test/app-api/user/auth/native/quota".into(),
            ),
            catalog_endpoint: Some(
                "https://gateway.example.test/app-api/user/auth/native/catalog".into(),
            ),
            order_endpoint: Some(
                "https://gateway.example.test/app-api/user/auth/native/orders".into(),
            ),
            order_status_endpoint: Some(
                "https://gateway.example.test/app-api/user/auth/native/orders/status".into(),
            ),
            client_id: super::CLIENT_ID.into(),
        };
        assert!(validate_discovery("https://gateway.example.test", &discovery).is_ok());

        let mut foreign = discovery;
        foreign.token_endpoint = "https://other.example.test/token".into();
        assert!(validate_discovery("https://gateway.example.test", &foreign).is_err());
    }

    #[test]
    fn gateway_quota_deserializes_snake_case_api_fields() {
        let quota: GatewayQuotaView = serde_json::from_value(serde_json::json!({
            "wallet": {
                "balance_micro": 10_000_000,
                "frozen_micro": 0,
                "total_topup_micro": 10_000_000,
                "total_spend_micro": 0
            },
            "packages": [{
                "id": 1,
                "name": "新人首充包",
                "status": "active",
                "meter_by": "sale_amount",
                "quota_per_window": 10_000_000,
                "total_quota_cap": 10_000_000,
                "total_used": 0,
                "window_remaining": 10_000_000,
                "valid_until": null
            }],
            "recent_consumption": [],
            "payment_channels": {"alipay": true, "wechat": false}
        }))
        .unwrap();
        assert_eq!(quota.wallet.balance_micro, 10_000_000);
        assert_eq!(quota.packages[0].window_remaining, 10_000_000);
        assert!(quota.payment_channels.alipay);
    }
}
