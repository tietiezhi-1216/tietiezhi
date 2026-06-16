//! LLM polishing step. After ASR, the recognized text is injected into the
//! active prompt template and sent to an OpenAI chat model, which rewrites it.

use crate::config::ResolvedModel;

/// Build the final prompt by substituting the transcript into the template.
/// `placeholder` is the name inside `{{...}}`; if it is absent the transcript is
/// appended after the template.
pub fn render_prompt(template: &str, placeholder: &str, transcript: &str) -> String {
    let token = String::from("{{") + placeholder + "}}"; // "{{<placeholder>}}"
    if template.contains(&token) {
        template.replace(&token, transcript)
    } else {
        format!("{template}\n\n{transcript}")
    }
}

pub async fn polish(
    model: &ResolvedModel,
    template: &str,
    placeholder: &str,
    transcript: &str,
) -> anyhow::Result<String> {
    if model.api_key.trim().is_empty() {
        anyhow::bail!("所选大模型服务商缺少 API Key");
    }
    let content = render_prompt(template, placeholder, transcript);
    let url = format!("{}/chat/completions", model.base_url.trim_end_matches('/'));
    let body = serde_json::json!({
        "model": model.model,
        "messages": [ { "role": "user", "content": content } ],
        "temperature": 0.3
    });

    let resp = reqwest::Client::new()
        .post(url)
        .bearer_auth(&model.api_key)
        .json(&body)
        .send()
        .await?;

    let status = resp.status();
    let text = resp.text().await?;
    if !status.is_success() {
        anyhow::bail!("大模型请求失败（{status}）：{text}");
    }

    let v: serde_json::Value = serde_json::from_str(&text)?;
    Ok(v["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or_default()
        .trim()
        .to_string())
}
