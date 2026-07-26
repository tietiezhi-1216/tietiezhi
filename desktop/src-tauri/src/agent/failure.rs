use reqwest::StatusCode;
use serde_json::Value;

#[derive(Debug, Clone)]
pub struct ChatFailure {
    pub summary: String,
    pub detail: String,
    pub code: Option<String>,
    pub status: Option<u16>,
    pub retryable: bool,
    pub retries: u8,
    pub output_started: bool,
}

impl ChatFailure {
    pub fn message(message: impl Into<String>) -> Self {
        let detail = user_facing(message.into());
        Self {
            summary: detail.clone(),
            detail,
            code: None,
            status: None,
            retryable: false,
            retries: 0,
            output_started: false,
        }
    }

    pub fn channel(message: impl Into<String>) -> Self {
        Self {
            summary: "界面连接已断开".into(),
            detail: user_facing(message.into()),
            code: Some("ui_channel_closed".into()),
            status: None,
            retryable: false,
            retries: 0,
            output_started: false,
        }
    }

    pub fn transport(message: impl Into<String>, output_started: bool) -> Self {
        Self {
            summary: if output_started {
                "模型服务连接中断".into()
            } else {
                "无法连接模型服务".into()
            },
            detail: user_facing(message.into()),
            code: Some(if output_started {
                "stream_interrupted".into()
            } else {
                "connection_failed".into()
            }),
            status: None,
            retryable: true,
            retries: 0,
            output_started,
        }
    }

    pub fn http(status: StatusCode, body: String) -> Self {
        let status_code = status.as_u16();
        let parsed = serde_json::from_str::<Value>(&body).ok();
        let upstream_code = parsed
            .as_ref()
            .and_then(|value| {
                value
                    .pointer("/error/code")
                    .or_else(|| value.get("code"))
                    .and_then(Value::as_str)
            })
            .map(str::to_owned);
        let upstream_message = parsed
            .as_ref()
            .and_then(|value| {
                value
                    .pointer("/error/message")
                    .or_else(|| value.get("message"))
                    .and_then(Value::as_str)
            })
            .unwrap_or_default();
        let normalized_message = upstream_message.to_ascii_lowercase();
        let code = if normalized_message.contains("api key quota exceeded") {
            Some("api_key_quota_exceeded".into())
        } else if normalized_message.contains("insufficient balance") {
            Some("insufficient_balance".into())
        } else if normalized_message.contains("account disabled") {
            Some("account_disabled".into())
        } else {
            upstream_code
        };
        let formatted_body = parsed
            .as_ref()
            .and_then(|value| serde_json::to_string_pretty(value).ok())
            .unwrap_or_else(|| body.trim().to_owned());
        let detail = if formatted_body.is_empty() {
            format!("模型服务返回 HTTP {status_code}")
        } else {
            format!("模型服务返回 HTTP {status_code}\n\n{formatted_body}")
        };
        let retryable = matches!(status_code, 408 | 425 | 429 | 500 | 502 | 503 | 504);
        let summary = match code.as_deref() {
            Some("api_key_quota_exceeded") => "API Key 额度已用尽",
            Some("insufficient_balance") => "当前额度不足",
            Some("account_disabled") => "当前账号已停用",
            _ => match status_code {
                400 | 422 => "请求未被模型服务接受",
                401 => "模型服务认证失败",
                402 => "当前额度不足",
                403 => "模型服务拒绝访问",
                404 => "模型或接口不存在",
                408 => "模型服务响应超时",
                425 => "模型服务暂未就绪",
                429 => "请求过于频繁",
                500 => "模型服务暂时不可用",
                502..=504 => "模型服务暂时不可用",
                _ => "模型服务请求失败",
            },
        };
        let detail = match code.as_deref() {
            Some("api_key_quota_exceeded") => {
                "API Key 额度已用尽，请调整 Key 限额或更换可用的 API Key".into()
            }
            Some("insufficient_balance") => "当前额度不足，请充值或购买套餐后重试".into(),
            Some("account_disabled") => "当前账号已停用，请联系管理员处理".into(),
            _ => match status_code {
                401 => "认证状态已失效，请重新登录中转站或检查供应商 API Key".into(),
                402 => "当前额度不足，请充值或购买套餐后重试".into(),
                403 => "当前账号或 API Key 无权使用该模型".into(),
                _ => detail,
            },
        };

        Self {
            summary: summary.into(),
            detail,
            code,
            status: Some(status_code),
            retryable,
            retries: 0,
            output_started: false,
        }
    }
}

fn user_facing(message: String) -> String {
    message.replace("中转站", "模型服务")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retryable_statuses_are_classified() {
        for status in [408, 425, 429, 500, 502, 503, 504] {
            let failure = ChatFailure::http(StatusCode::from_u16(status).unwrap(), String::new());
            assert!(failure.retryable, "HTTP {status} should be retryable");
        }
        for status in [400, 401, 402, 403, 404, 422] {
            let failure = ChatFailure::http(StatusCode::from_u16(status).unwrap(), String::new());
            assert!(!failure.retryable, "HTTP {status} should not be retryable");
        }
    }

    #[test]
    fn http_failure_preserves_and_formats_detail() {
        let failure = ChatFailure::http(
            StatusCode::SERVICE_UNAVAILABLE,
            r#"{"error":{"code":"do_request_failed","message":"all nodes failed"}}"#.into(),
        );
        assert_eq!(failure.code.as_deref(), Some("do_request_failed"));
        assert!(failure.detail.contains("all nodes failed"));
    }

    #[test]
    fn transport_failure_keeps_manual_retry_available() {
        let failure = ChatFailure::transport("stream closed", true);

        assert_eq!(failure.summary, "模型服务连接中断");
        assert_eq!(failure.code.as_deref(), Some("stream_interrupted"));
        assert!(failure.retryable);
        assert!(failure.output_started);
    }

    #[test]
    fn insufficient_balance_is_user_facing() {
        let failure = ChatFailure::http(
            StatusCode::PAYMENT_REQUIRED,
            r#"{"error":{"code":"unauthorized","message":"insufficient balance"}}"#.into(),
        );

        assert_eq!(failure.summary, "当前额度不足");
        assert_eq!(failure.detail, "当前额度不足，请充值或购买套餐后重试");
        assert_eq!(failure.code.as_deref(), Some("insufficient_balance"));
        assert!(!failure.retryable);
    }

    #[test]
    fn api_key_quota_is_distinct_from_account_balance() {
        let failure = ChatFailure::http(
            StatusCode::PAYMENT_REQUIRED,
            r#"{"error":{"code":"unauthorized","message":"api key quota exceeded"}}"#.into(),
        );

        assert_eq!(failure.summary, "API Key 额度已用尽");
        assert_eq!(
            failure.detail,
            "API Key 额度已用尽，请调整 Key 限额或更换可用的 API Key"
        );
        assert_eq!(failure.code.as_deref(), Some("api_key_quota_exceeded"));
        assert!(!failure.retryable);
    }

    #[test]
    fn disabled_account_is_user_facing() {
        let failure = ChatFailure::http(
            StatusCode::FORBIDDEN,
            r#"{"error":{"code":"unauthorized","message":"account disabled"}}"#.into(),
        );

        assert_eq!(failure.summary, "当前账号已停用");
        assert_eq!(failure.detail, "当前账号已停用，请联系管理员处理");
        assert_eq!(failure.code.as_deref(), Some("account_disabled"));
    }

    #[test]
    fn internal_term_is_not_exposed() {
        let failure = ChatFailure::message("无法连接中转站");
        assert_eq!(failure.summary, "无法连接模型服务");
    }
}
