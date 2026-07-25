use reqwest::StatusCode;
use serde_json::Value;

pub const MAX_RETRIES: u8 = 5;

#[derive(Debug, Clone)]
pub struct ChatFailure {
    pub summary: String,
    pub detail: String,
    pub code: Option<String>,
    pub status: Option<u16>,
    pub retryable: bool,
    pub retries: u8,
    pub output_started: bool,
    pub retry_after_ms: Option<u64>,
    retry_reason: String,
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
            retry_after_ms: None,
            retry_reason: "请求无法继续".into(),
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
            retry_after_ms: None,
            retry_reason: "界面连接已断开".into(),
        }
    }

    pub fn request(error: reqwest::Error) -> Self {
        let timeout = error.is_timeout();
        let retryable = timeout || error.is_connect() || error.is_request() || error.is_body();
        let summary = if timeout {
            "连接模型服务超时"
        } else {
            "无法连接模型服务"
        };
        let retry_reason = if timeout {
            "连接超时"
        } else {
            "连接失败"
        };
        Self {
            summary: summary.into(),
            detail: user_facing(error.to_string()),
            code: Some(if timeout {
                "request_timeout".into()
            } else {
                "connection_failed".into()
            }),
            status: None,
            retryable,
            retries: 0,
            output_started: false,
            retry_after_ms: None,
            retry_reason: retry_reason.into(),
        }
    }

    pub fn stream(error: reqwest::Error, output_started: bool) -> Self {
        let timeout = error.is_timeout();
        Self {
            summary: if timeout {
                "模型服务响应超时".into()
            } else {
                "模型服务连接中断".into()
            },
            detail: user_facing(error.to_string()),
            code: Some(if timeout {
                "stream_timeout".into()
            } else {
                "stream_interrupted".into()
            }),
            status: None,
            retryable: true,
            retries: 0,
            output_started,
            retry_after_ms: None,
            retry_reason: if timeout {
                "响应超时".into()
            } else {
                "连接中断".into()
            },
        }
    }

    pub fn response_timeout(output_started: bool) -> Self {
        Self {
            summary: "模型服务响应超时".into(),
            detail: "模型服务长时间没有返回新数据，请重试或先使用 /compact 压缩上下文".into(),
            code: Some("stream_idle_timeout".into()),
            status: None,
            retryable: !output_started,
            retries: 0,
            output_started,
            retry_after_ms: None,
            retry_reason: "长时间没有返回新数据".into(),
        }
    }

    pub fn http(status: StatusCode, body: String, retry_after_ms: Option<u64>) -> Self {
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
        let (summary, reason) = match code.as_deref() {
            Some("api_key_quota_exceeded") => ("API Key 额度已用尽", "Key 额度已用尽"),
            Some("insufficient_balance") => ("当前额度不足", "额度不足"),
            Some("account_disabled") => ("当前账号已停用", "账号已停用"),
            _ => match status_code {
                400 | 422 => ("请求未被模型服务接受", "请求参数有误"),
                401 => ("模型服务认证失败", "认证失败"),
                402 => ("当前额度不足", "额度不足"),
                403 => ("模型服务拒绝访问", "访问被拒绝"),
                404 => ("模型或接口不存在", "服务不存在"),
                408 => ("模型服务响应超时", "响应超时"),
                425 => ("模型服务暂未就绪", "服务尚未就绪"),
                429 => ("请求过于频繁", "请求过于频繁"),
                500 => ("模型服务暂时不可用", "服务内部错误"),
                502..=504 => ("模型服务暂时不可用", "服务暂时不可用"),
                _ => ("模型服务请求失败", "请求失败"),
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
            retry_after_ms,
            retry_reason: format!("{reason}（{status_code}）"),
        }
    }

    pub fn retry_reason(&self) -> &str {
        &self.retry_reason
    }

    pub fn max_retries(&self) -> u8 {
        match self.code.as_deref() {
            Some("request_timeout" | "stream_timeout") => 0,
            Some("stream_idle_timeout") => 1,
            _ => MAX_RETRIES,
        }
    }

    pub fn with_retries(mut self, retries: u8) -> Self {
        self.retries = retries;
        self
    }
}

pub fn retry_delay_ms(retry: u8, server_hint_ms: Option<u64>) -> u64 {
    const BACKOFF: [u64; MAX_RETRIES as usize] = [800, 1_600, 3_200, 5_000, 8_000];
    server_hint_ms
        .unwrap_or(BACKOFF[usize::from(retry.saturating_sub(1).min(MAX_RETRIES - 1))])
        .clamp(250, 30_000)
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
            let failure =
                ChatFailure::http(StatusCode::from_u16(status).unwrap(), String::new(), None);
            assert!(failure.retryable, "HTTP {status} should be retryable");
        }
        for status in [400, 401, 402, 403, 404, 422] {
            let failure =
                ChatFailure::http(StatusCode::from_u16(status).unwrap(), String::new(), None);
            assert!(!failure.retryable, "HTTP {status} should not be retryable");
        }
    }

    #[test]
    fn http_failure_preserves_and_formats_detail() {
        let failure = ChatFailure::http(
            StatusCode::SERVICE_UNAVAILABLE,
            r#"{"error":{"code":"do_request_failed","message":"all nodes failed"}}"#.into(),
            None,
        );
        assert_eq!(failure.code.as_deref(), Some("do_request_failed"));
        assert!(failure.detail.contains("all nodes failed"));
        assert_eq!(failure.retry_reason(), "服务暂时不可用（503）");
    }

    #[test]
    fn insufficient_balance_is_user_facing() {
        let failure = ChatFailure::http(
            StatusCode::PAYMENT_REQUIRED,
            r#"{"error":{"code":"unauthorized","message":"insufficient balance"}}"#.into(),
            None,
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
            None,
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
            None,
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

    #[test]
    fn backoff_has_five_steps_and_honors_hint() {
        assert_eq!(retry_delay_ms(1, None), 800);
        assert_eq!(retry_delay_ms(5, None), 8_000);
        assert_eq!(retry_delay_ms(2, Some(12_000)), 12_000);
    }

    #[test]
    fn timeouts_retry_only_once_and_never_repeat_partial_output() {
        let failure = ChatFailure::response_timeout(false);
        assert!(failure.retryable);
        assert_eq!(failure.max_retries(), 1);

        let partial = ChatFailure::response_timeout(true);
        assert!(!partial.retryable);
        assert_eq!(partial.max_retries(), 1);
    }
}
