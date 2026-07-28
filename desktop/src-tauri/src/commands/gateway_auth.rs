use std::time::Duration;

use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine as _,
};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use uuid::Uuid;

use super::settings::read_settings;
use crate::{secrets, AppState};

const CLIENT_ID: &str = "tietiezhi-desktop";
const CALLBACK_HTML_TEMPLATE: &str = r##"<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="theme-color" content="#07080d">
  <title>已连接铁铁汁</title>
  <link rel="icon" href="data:image/png;base64,__APP_ICON__">
  <style>
    :root { color-scheme: dark; font-family: "SF Pro Display", "PingFang SC", "Microsoft YaHei", sans-serif; }
    * { box-sizing: border-box; }
    body {
      min-height: 100vh;
      margin: 0;
      display: grid;
      place-items: center;
      overflow: hidden;
      color: #f7f8fb;
      background:
        radial-gradient(circle at 18% 18%, rgba(90, 216, 255, .18), transparent 32rem),
        radial-gradient(circle at 82% 76%, rgba(118, 87, 255, .2), transparent 34rem),
        #07080d;
    }
    body::before {
      content: "";
      position: fixed;
      inset: 0;
      pointer-events: none;
      opacity: .24;
      background-image:
        radial-gradient(circle, rgba(255, 255, 255, .8) 0 1px, transparent 1.2px),
        radial-gradient(circle, rgba(139, 223, 255, .65) 0 1px, transparent 1.2px);
      background-position: 0 0, 36px 52px;
      background-size: 92px 92px, 136px 136px;
      mask-image: linear-gradient(to bottom, black, transparent 92%);
    }
    main {
      position: relative;
      width: min(92vw, 500px);
      padding: 42px;
      overflow: hidden;
      border: 1px solid rgba(255, 255, 255, .12);
      border-radius: 30px;
      background: linear-gradient(145deg, rgba(28, 31, 43, .82), rgba(12, 14, 21, .72));
      box-shadow: inset 0 1px rgba(255, 255, 255, .1), 0 32px 100px rgba(0, 0, 0, .52);
      backdrop-filter: blur(28px);
    }
    main::after {
      content: "";
      position: absolute;
      width: 220px;
      height: 220px;
      top: -150px;
      right: -80px;
      border-radius: 999px;
      background: rgba(90, 216, 255, .18);
      filter: blur(18px);
    }
    .brand {
      position: relative;
      z-index: 1;
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 38px;
      color: rgba(255, 255, 255, .78);
      font-size: 13px;
      font-weight: 650;
      letter-spacing: .16em;
      text-transform: uppercase;
    }
    .brand img {
      width: 42px;
      height: 42px;
      border-radius: 13px;
      filter: drop-shadow(0 8px 18px rgba(90, 216, 255, .22));
    }
    .status {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 18px;
      padding: 7px 11px;
      border: 1px solid rgba(90, 216, 255, .22);
      border-radius: 999px;
      color: #b9efff;
      background: rgba(90, 216, 255, .08);
      font-size: 12px;
      font-weight: 650;
    }
    .status i {
      width: 7px;
      height: 7px;
      border-radius: 999px;
      background: #75e3ff;
      box-shadow: 0 0 16px #75e3ff;
    }
    h1 {
      margin: 0;
      font-size: clamp(30px, 7vw, 45px);
      line-height: 1.08;
      letter-spacing: -.045em;
    }
    p {
      max-width: 380px;
      margin: 16px 0 30px;
      color: rgba(240, 243, 250, .62);
      font-size: 15px;
      line-height: 1.7;
    }
    button {
      width: 100%;
      min-height: 54px;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      border: 0;
      border-radius: 17px;
      color: #090b12;
      background: linear-gradient(120deg, #bdf2ff, #d8ccff);
      box-shadow: 0 14px 34px rgba(105, 204, 255, .2);
      cursor: pointer;
      font: inherit;
      font-size: 14px;
      font-weight: 750;
      transition: transform .2s ease, box-shadow .2s ease, opacity .2s ease;
    }
    button:hover { transform: translateY(-2px); box-shadow: 0 18px 42px rgba(105, 204, 255, .28); }
    button:active { transform: translateY(0); }
    button:focus-visible { outline: 3px solid rgba(139, 223, 255, .42); outline-offset: 3px; }
    button:disabled { cursor: wait; opacity: .72; transform: none; }
    button svg { width: 18px; height: 18px; }
    .hint {
      margin: 18px 0 0;
      text-align: center;
      color: rgba(240, 243, 250, .38);
      font-size: 12px;
    }
    @media (max-width: 560px) {
      main { padding: 30px 24px; border-radius: 24px; }
      .brand { margin-bottom: 30px; }
    }
    @media (prefers-reduced-motion: reduce) {
      button { transition: none; }
    }
  </style>
</head>
<body>
  <main>
    <div class="brand">
      <img src="data:image/png;base64,__APP_ICON__" alt="">
      <span>Tietiezhi Desktop</span>
    </div>
    <div class="status"><i></i><span>安全连接已建立</span></div>
    <h1>已连接铁铁汁</h1>
    <p>账号授权已经完成。返回桌面端后即可继续使用中转站账号、模型和额度服务。</p>
    <button id="return-button" type="button">
      <span id="return-label">返回铁铁汁</span>
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </button>
    <div class="hint" id="return-hint">也可以关闭此页面，手动返回桌面端</div>
  </main>
  <script>
    const button = document.getElementById("return-button");
    const label = document.getElementById("return-label");
    const hint = document.getElementById("return-hint");
    button.addEventListener("click", async () => {
      button.disabled = true;
      label.textContent = "正在返回…";
      try {
        const response = await fetch("/return", { cache: "no-store" });
        if (!response.ok) throw new Error("focus request failed");
        label.textContent = "已返回铁铁汁";
        hint.textContent = "此页面现在可以安全关闭";
        window.setTimeout(() => window.close(), 500);
      } catch {
        button.disabled = false;
        label.textContent = "重新返回铁铁汁";
        hint.textContent = "未能自动切换，请手动返回桌面端";
      }
    });
  </script>
</body>
</html>"##;

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
    #[serde(default)]
    responses_api_version: Option<u32>,
    #[serde(default)]
    wire_apis: Vec<String>,
    #[serde(default)]
    responses_endpoint: Option<String>,
    #[serde(default)]
    chat_completions_api_version: Option<u32>,
    #[serde(default)]
    chat_completions_endpoint: Option<String>,
    #[serde(default)]
    anthropic_messages_api_version: Option<u32>,
    #[serde(default)]
    anthropic_messages_endpoint: Option<String>,
    #[serde(default)]
    gemini_generate_content_api_version: Option<u32>,
    #[serde(default)]
    gemini_generate_content_endpoint_template: Option<String>,
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

pub(crate) struct GatewayLoginAttempt {
    provider_id: String,
    base_url: String,
    discovery: Discovery,
    listener: TcpListener,
    redirect_uri: String,
    state_value: String,
    verifier: String,
    auth_url: String,
}

impl GatewayLoginAttempt {
    pub(crate) fn auth_url(&self) -> &str {
        &self.auth_url
    }
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
    load_gateway_account(&state.http, &app, provider_id).await
}

pub(crate) async fn load_gateway_account(
    http: &reqwest::Client,
    app: &AppHandle,
    provider_id: String,
) -> Result<GatewayAccountView, String> {
    let base_url = provider_base_url(app, &provider_id)?;
    let discovery = match fetch_discovery(http, &base_url).await {
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
        clear_gateway_secrets(&provider_id)?;
        return Ok(GatewayAccountView {
            provider_id,
            supported: true,
            logged_in: false,
            account: None,
            expires: None,
        });
    };
    let result: APIResponse<SessionData> = post_json(
        http,
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
    let attempt = prepare_gateway_login(&state.http, &app, provider_id).await?;
    open_system_browser(attempt.auth_url())?;
    complete_gateway_login(&state.http, app, attempt).await
}

pub(crate) async fn prepare_gateway_login(
    http: &reqwest::Client,
    app: &AppHandle,
    provider_id: String,
) -> Result<GatewayLoginAttempt, String> {
    let base_url = provider_base_url(app, &provider_id)?;
    let discovery = fetch_discovery(http, &base_url).await?;
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
    let device_id = load_or_create_device_id(app)?;
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
    Ok(GatewayLoginAttempt {
        provider_id,
        base_url,
        discovery,
        listener,
        redirect_uri,
        state_value,
        verifier,
        auth_url: authorize_url.into(),
    })
}

pub(crate) async fn complete_gateway_login(
    http: &reqwest::Client,
    app: AppHandle,
    attempt: GatewayLoginAttempt,
) -> Result<GatewayAccountView, String> {
    let GatewayLoginAttempt {
        provider_id,
        base_url,
        discovery,
        listener,
        redirect_uri,
        state_value,
        verifier,
        ..
    } = attempt;
    let (code, returned_state) = wait_for_callback(listener, app.clone()).await?;
    if returned_state != state_value {
        return Err("登录状态校验失败，请重试".into());
    }
    let token: APIResponse<TokenData> = post_json(
        http,
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
    // The new session belongs to the official gateway; migrate a leftover
    // legacy builtin URL so chat and account use the same host from now on.
    if provider_id == super::settings::BUILTIN_PROVIDER_ID {
        if let Err(error) = super::settings::upgrade_legacy_builtin_provider_url(&app) {
            eprintln!("[gateway] 迁移旧版内置中转站地址失败：{error}");
        }
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
    revoke_gateway_login(&state.http, &app, &provider_id).await
}

pub(crate) async fn revoke_gateway_login(
    http: &reqwest::Client,
    app: &AppHandle,
    provider_id: &str,
) -> Result<(), String> {
    let session = secrets::get_gateway_session(provider_id)?;
    let issuer = secrets::get_gateway_issuer(provider_id)?
        .or_else(|| provider_base_url(app, provider_id).ok());
    if let (Some(session_token), Some(base_url)) = (session, issuer) {
        if let Ok(discovery) = fetch_discovery(http, &base_url).await {
            let _: Result<APIResponse<serde_json::Value>, String> = post_json(
                http,
                &discovery.revocation_endpoint,
                &serde_json::json!({ "session_token": session_token }),
            )
            .await;
        }
    }
    clear_gateway_secrets(provider_id)
}

#[tauri::command]
pub async fn gateway_quota(
    state: State<'_, AppState>,
    app: AppHandle,
    provider_id: String,
) -> Result<GatewayQuotaView, String> {
    load_gateway_quota(&state.http, &app, &provider_id).await
}

pub(crate) async fn load_gateway_quota(
    http: &reqwest::Client,
    app: &AppHandle,
    provider_id: &str,
) -> Result<GatewayQuotaView, String> {
    let (discovery, session_token) = native_billing_context(http, app, provider_id).await?;
    let endpoint = discovery
        .quota_endpoint
        .ok_or_else(|| "当前中转站版本不支持额度中心".to_string())?;
    let result: APIResponse<GatewayQuotaView> = post_json(
        http,
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
    let base_url = read_settings(app)?
        .providers
        .into_iter()
        .find(|provider| provider.id == provider_id)
        .map(|provider| provider.base_url)
        .ok_or_else(|| "未找到当前中转站".to_string())?;
    // The legacy builtin host has no account endpoints (its discovery route
    // answers HTTP 200 "Not Found", which surfaced as「中转站登录配置无效」).
    // Builtin accounts live on the official gateway, so auth/billing flows
    // must target it even while chat still uses the stored legacy URL.
    if provider_id == super::settings::BUILTIN_PROVIDER_ID
        && super::settings::is_legacy_builtin_provider_url(&base_url)
    {
        return Ok(super::settings::BUILTIN_PROVIDER_URL.into());
    }
    Ok(base_url)
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
        .map_err(|_| "中转站登录配置无效（服务返回了无法识别的内容，可能是旧版或不兼容的中转站）".to_string())?;
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
        discovery.responses_endpoint.as_ref(),
        discovery.chat_completions_endpoint.as_ref(),
        discovery.anthropic_messages_endpoint.as_ref(),
        discovery.gemini_generate_content_endpoint_template.as_ref(),
        discovery.quota_endpoint.as_ref(),
        discovery.catalog_endpoint.as_ref(),
        discovery.order_endpoint.as_ref(),
        discovery.order_status_endpoint.as_ref(),
    ]
    .into_iter()
    .flatten()
    {
        let parsed =
            reqwest::Url::parse(endpoint).map_err(|_| "中转站返回了无效的能力地址".to_string())?;
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
            return Err("中转站能力端点必须与签发方同源".into());
        }
    }
    if discovery
        .wire_apis
        .iter()
        .any(|wire_api| wire_api == "responses")
        && (discovery.responses_api_version != Some(1) || discovery.responses_endpoint.is_none())
    {
        return Err("中转站 Responses 能力声明不完整".into());
    }
    for (wire_api, version, endpoint) in [
        (
            "chat_completions",
            discovery.chat_completions_api_version,
            discovery.chat_completions_endpoint.as_ref(),
        ),
        (
            "anthropic_messages",
            discovery.anthropic_messages_api_version,
            discovery.anthropic_messages_endpoint.as_ref(),
        ),
        (
            "gemini_generate_content",
            discovery.gemini_generate_content_api_version,
            discovery.gemini_generate_content_endpoint_template.as_ref(),
        ),
    ] {
        if discovery
            .wire_apis
            .iter()
            .any(|candidate| candidate == wire_api)
            && (version != Some(1) || endpoint.is_none())
        {
            return Err(format!("中转站 {wire_api} 能力声明不完整"));
        }
    }
    Ok(())
}

async fn wait_for_callback(
    listener: TcpListener,
    app: AppHandle,
) -> Result<(String, String), String> {
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
    let html = callback_html();
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Security-Policy: default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        html.len(),
        html
    );
    let _ = stream.write_all(response.as_bytes()).await;
    tokio::spawn(wait_for_return_to_app(listener, app));
    Ok((code, state))
}

fn callback_html() -> String {
    let icon = STANDARD.encode(include_bytes!("../../icons/128x128.png"));
    CALLBACK_HTML_TEMPLATE.replace("__APP_ICON__", &icon)
}

async fn wait_for_return_to_app(listener: TcpListener, app: AppHandle) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(180);
    loop {
        let Some(remaining) = deadline.checked_duration_since(tokio::time::Instant::now()) else {
            return;
        };
        let Ok(Ok((mut stream, _))) = tokio::time::timeout(remaining, listener.accept()).await
        else {
            return;
        };
        let mut buffer = vec![0u8; 2048];
        let Ok(size) = stream.read(&mut buffer).await else {
            continue;
        };
        let request = String::from_utf8_lossy(&buffer[..size]);
        let target = request
            .lines()
            .next()
            .and_then(|line| line.split_whitespace().nth(1))
            .unwrap_or_default();
        if target.split('?').next() != Some("/return") {
            let _ = stream
                .write_all(
                    b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .await;
            continue;
        }
        let _ = stream
            .write_all(
                b"HTTP/1.1 204 No Content\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
            )
            .await;
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
        return;
    }
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
    if secrets::get_gateway_session(provider_id)?.is_none() {
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
    use super::{callback_html, gateway_root, validate_discovery, Discovery, GatewayQuotaView};

    #[test]
    fn login_callback_page_has_branding_and_return_action() {
        let html = callback_html();

        assert!(html.contains("Tietiezhi Desktop"));
        assert!(html.contains("返回铁铁汁"));
        assert!(html.contains("fetch(\"/return\""));
        assert!(html.contains("data:image/png;base64,"));
        assert!(!html.contains("__APP_ICON__"));
    }

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
            responses_api_version: Some(1),
            wire_apis: vec!["responses".into()],
            responses_endpoint: Some("https://gateway.example.test/v1/responses".into()),
            chat_completions_api_version: None,
            chat_completions_endpoint: None,
            anthropic_messages_api_version: None,
            anthropic_messages_endpoint: None,
            gemini_generate_content_api_version: None,
            gemini_generate_content_endpoint_template: None,
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
    fn responses_discovery_requires_a_same_origin_versioned_endpoint() {
        let raw = serde_json::json!({
            "issuer": "https://gateway.example.test",
            "responses_api_version": 1,
            "wire_apis": ["responses"],
            "responses_endpoint": "https://gateway.example.test/v1/responses",
            "authorization_endpoint": "https://gateway.example.test/desktop-authorize",
            "token_endpoint": "https://gateway.example.test/app-api/user/auth/native/token",
            "session_endpoint": "https://gateway.example.test/app-api/user/auth/native/session",
            "revocation_endpoint": "https://gateway.example.test/app-api/user/auth/native/revoke",
            "client_id": super::CLIENT_ID
        });
        let discovery: Discovery = serde_json::from_value(raw).unwrap();
        assert!(validate_discovery("https://gateway.example.test", &discovery).is_ok());

        let mut invalid = discovery;
        invalid.responses_endpoint = Some("https://other.example.test/v1/responses".into());
        assert!(validate_discovery("https://gateway.example.test", &invalid).is_err());
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
