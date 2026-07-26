use std::time::Duration;

use serde_json::json;

use super::models::ModelWireApi;
use super::providers::Resolved;

pub(crate) struct TextGeneration {
    pub text: String,
    pub total_tokens: u64,
}

pub(crate) async fn generate_text(
    http: &reqwest::Client,
    provider: &Resolved,
    model: &str,
    instructions: &str,
    prompt: &str,
    timeout: Duration,
) -> Result<TextGeneration, String> {
    let mut request = tietiezhi_agent_model::ResponsesApiRequest::text(
        model,
        vec![json!({
            "type":"message",
            "role":"user",
            "content":[{"type":"input_text","text":prompt}]
        })],
    );
    request.instructions = instructions.to_owned();
    let wire_api = match provider.wire_api_for_model(model) {
        ModelWireApi::Auto | ModelWireApi::Responses => tietiezhi_agent_model::WireApi::Responses,
        ModelWireApi::ChatCompletions => tietiezhi_agent_model::WireApi::ChatCompletions,
        ModelWireApi::AnthropicMessages => tietiezhi_agent_model::WireApi::AnthropicMessages,
        ModelWireApi::GeminiGenerateContent => {
            tietiezhi_agent_model::WireApi::GeminiGenerateContent
        }
    };
    let canonical_base_url = super::api_url(&provider.base_url, "");
    let transport = tietiezhi_agent_model::Provider::openai_compatible(
        &provider.kind,
        canonical_base_url,
        provider.key.clone(),
    )
    .with_wire_api(wire_api);
    let client = tietiezhi_agent_model::ResponsesClient::new(http.clone(), transport);
    let mut text = String::new();
    let mut total_tokens = 0;
    tokio::time::timeout(
        timeout,
        client.stream(&request, |event| {
            match event {
                tietiezhi_agent_model::ResponseEvent::OutputTextDelta(delta) => {
                    text.push_str(&delta);
                }
                tietiezhi_agent_model::ResponseEvent::Completed {
                    token_usage: Some(usage),
                    ..
                } => {
                    total_tokens = usage.total_tokens.max(0) as u64;
                }
                _ => {}
            }
            Ok(())
        }),
    )
    .await
    .map_err(|_| "模型响应超时".to_string())?
    .map_err(|error| error.to_string())?;
    Ok(TextGeneration { text, total_tokens })
}
