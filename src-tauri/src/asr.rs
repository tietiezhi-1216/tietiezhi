//! Speech recognition over OpenAI's HTTP transcription endpoint
//! (`POST /audio/transcriptions`). Used after recording stops.

use std::io::Cursor;

use crate::config::ResolvedModel;

/// Encode mono `i16` PCM as a WAV container in memory.
pub fn encode_wav(samples: &[i16], rate: u32) -> anyhow::Result<Vec<u8>> {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut cursor = Cursor::new(Vec::<u8>::new());
    {
        let mut writer = hound::WavWriter::new(&mut cursor, spec)?;
        for s in samples {
            writer.write_sample(*s)?;
        }
        writer.finalize()?;
    }
    Ok(cursor.into_inner())
}

/// Transcribe a recorded WAV. Returns the recognized text.
pub async fn transcribe_http(model: &ResolvedModel, wav: Vec<u8>) -> anyhow::Result<String> {
    if model.api_key.trim().is_empty() {
        anyhow::bail!("所选语音识别服务商缺少 API Key");
    }
    let url = format!("{}/audio/transcriptions", model.base_url.trim_end_matches('/'));

    let part = reqwest::multipart::Part::bytes(wav)
        .file_name("audio.wav")
        .mime_str("audio/wav")?;
    let mut form = reqwest::multipart::Form::new()
        .part("file", part)
        .text("model", model.model.clone())
        .text("response_format", "json".to_string());
    if let Some(lang) = &model.language {
        if !lang.is_empty() {
            form = form.text("language", lang.clone());
        }
    }

    let resp = reqwest::Client::new()
        .post(url)
        .bearer_auth(&model.api_key)
        .multipart(form)
        .send()
        .await?;

    let status = resp.status();
    let body = resp.text().await?;
    if !status.is_success() {
        anyhow::bail!("语音识别请求失败（{status}）：{body}");
    }

    let v: serde_json::Value = serde_json::from_str(&body)?;
    Ok(v.get("text")
        .and_then(|t| t.as_str())
        .unwrap_or_default()
        .to_string())
}
