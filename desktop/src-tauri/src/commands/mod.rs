pub mod agents;
pub mod assets;
pub mod automations;
pub mod capsule;
pub mod chat;
pub mod conversations;
pub mod create;
pub mod devices;
pub mod dictation;
pub mod gateway_auth;
pub mod hotkey;
pub mod mcp;
pub mod models;
pub mod permissions;
pub mod projects;
pub mod providers;
pub mod settings;
pub mod skills;
pub mod text_insert;
pub mod tietiezhi;
pub mod titles;
pub mod workspace;

use reqwest::StatusCode;
use serde_json::Value;

/// Join a user-supplied base URL with an API path, normalizing the common
/// "/v1 or not" ambiguity: both `https://x.com` and `https://x.com/v1` work.
pub(crate) fn api_url(base_url: &str, path: &str) -> String {
    let base = base_url.trim().trim_end_matches('/');
    let base = base.strip_suffix("/v1").unwrap_or(base);
    format!("{base}/v1/{}", path.trim_start_matches('/'))
}

/// Truncate an (error) response body so UI messages stay readable.
pub(crate) fn snippet(body: &str) -> String {
    const LIMIT: usize = 200;
    let trimmed = body.trim();
    let mut out: String = trimmed.chars().take(LIMIT).collect();
    if trimmed.chars().count() > LIMIT {
        out.push('…');
    }
    out
}

/// Convert provider HTTP failures into stable, actionable messages without
/// exposing authentication payloads or raw JSON to the frontend.
pub(crate) fn provider_http_error(service: &str, status: StatusCode, body: &str) -> String {
    let upstream_message = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|value| {
            value
                .pointer("/error/message")
                .and_then(Value::as_str)
                .or_else(|| value.get("message").and_then(Value::as_str))
                .map(str::to_owned)
        })
        .unwrap_or_default();
    let normalized = upstream_message.to_ascii_lowercase();

    if normalized.contains("api key quota exceeded") {
        return "API Key 额度已用尽，请调整 Key 限额或更换可用的 API Key".into();
    }
    if status == StatusCode::PAYMENT_REQUIRED || normalized.contains("insufficient balance") {
        return "当前额度不足，请充值或购买套餐后重试".into();
    }
    if normalized.contains("account disabled") {
        return "当前账号已停用，请联系管理员处理".into();
    }

    match status {
        StatusCode::UNAUTHORIZED => "认证状态已失效，请重新登录中转站或检查供应商 API Key".into(),
        StatusCode::FORBIDDEN => "当前账号或 API Key 无权使用该模型".into(),
        StatusCode::TOO_MANY_REQUESTS => "请求过于频繁，请稍后重试".into(),
        _ => {
            let detail = if upstream_message.trim().is_empty() {
                snippet(body)
            } else {
                snippet(&upstream_message)
            };
            if detail.is_empty() {
                format!("{service}返回 HTTP {}", status.as_u16())
            } else {
                format!("{service}返回 HTTP {}：{detail}", status.as_u16())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{api_url, provider_http_error};
    use reqwest::StatusCode;

    #[test]
    fn api_url_appends_v1() {
        assert_eq!(
            api_url("https://relay.example.com", "models"),
            "https://relay.example.com/v1/models"
        );
    }

    #[test]
    fn api_url_keeps_existing_v1() {
        assert_eq!(
            api_url("https://relay.example.com/v1", "models"),
            "https://relay.example.com/v1/models"
        );
        assert_eq!(
            api_url("https://relay.example.com/v1/", "/chat/completions"),
            "https://relay.example.com/v1/chat/completions"
        );
    }

    #[test]
    fn api_url_trims_whitespace_and_slashes() {
        assert_eq!(
            api_url("  https://relay.example.com/  ", "models"),
            "https://relay.example.com/v1/models"
        );
    }

    #[test]
    fn provider_auth_error_does_not_expose_raw_json() {
        let error = provider_http_error(
            "供应商",
            StatusCode::UNAUTHORIZED,
            r#"{"error":{"code":"unauthorized","message":"invalid api key"}}"#,
        );

        assert_eq!(
            error,
            "认证状态已失效，请重新登录中转站或检查供应商 API Key"
        );
        assert!(!error.contains('{'));
    }

    #[test]
    fn provider_quota_errors_are_distinct() {
        assert_eq!(
            provider_http_error(
                "供应商",
                StatusCode::PAYMENT_REQUIRED,
                r#"{"error":{"message":"api key quota exceeded"}}"#,
            ),
            "API Key 额度已用尽，请调整 Key 限额或更换可用的 API Key"
        );
        assert_eq!(
            provider_http_error(
                "供应商",
                StatusCode::PAYMENT_REQUIRED,
                r#"{"error":{"message":"insufficient balance"}}"#,
            ),
            "当前额度不足，请充值或购买套餐后重试"
        );
    }
}
