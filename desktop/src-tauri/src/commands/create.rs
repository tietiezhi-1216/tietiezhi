use std::path::PathBuf;
use std::time::{Duration, Instant};

use base64::Engine;
use futures_util::StreamExt;
use reqwest::multipart::{Form, Part};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tokio::io::AsyncWriteExt;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use super::models::ModelKind;
use super::settings::read_settings;
use super::{api_url, providers, snippet};
use crate::AppState;

const MAX_GENERATED_IMAGE_BYTES: usize = 40 * 1024 * 1024;
const MAX_REFERENCE_IMAGE_BYTES: u64 = 20 * 1024 * 1024;
const MAX_GENERATED_VIDEO_BYTES: u64 = 500 * 1024 * 1024;
const MAX_IMAGE_REFERENCES: usize = 4;
const VIDEO_POLL_INTERVAL: Duration = Duration::from_secs(2);
const VIDEO_GENERATION_TIMEOUT: Duration = Duration::from_secs(15 * 60);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateImageRequest {
    pub provider_id: String,
    pub model: String,
    pub prompt: String,
    pub aspect_ratio: String,
    pub quality: String,
    pub result_count: u8,
    #[serde(default)]
    pub reference_paths: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateImageResult {
    pub provider_id: String,
    pub model: String,
    pub file_path: String,
    pub mime_type: String,
    pub revised_prompt: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateVideoRequest {
    pub provider_id: String,
    pub model: String,
    pub prompt: String,
    pub aspect_ratio: String,
    pub quality: String,
    pub duration_seconds: u16,
    pub reference_path: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateVideoResult {
    pub provider_id: String,
    pub model: String,
    pub file_path: String,
    pub mime_type: String,
    pub duration_seconds: u16,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum CreateVideoEvent {
    Started { provider_id: String, model: String },
    Progress { progress: u8, status: String },
    Completed { result: CreateVideoResult },
    Cancelled,
    Error { message: String },
}

#[derive(Debug, Deserialize)]
struct ImageResponse {
    #[serde(default)]
    data: Vec<ImageResponseItem>,
}

#[derive(Debug, Deserialize)]
struct ImageResponseItem {
    #[serde(default)]
    b64_json: Option<String>,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    revised_prompt: Option<String>,
}

#[derive(Debug, Deserialize)]
struct VideoJob {
    #[serde(default)]
    id: String,
    #[serde(default)]
    status: String,
    #[serde(default)]
    progress: Option<f64>,
    #[serde(default)]
    error: Option<Value>,
}

#[tauri::command]
pub async fn generate_create_image(
    state: State<'_, AppState>,
    app: AppHandle,
    request: CreateImageRequest,
) -> Result<Vec<CreateImageResult>, String> {
    let prompt = request.prompt.trim();
    if prompt.is_empty() {
        return Err("请先填写图片生成描述".into());
    }

    let (provider_id, model) = resolve_selection(
        &app,
        request.provider_id.trim(),
        request.model.trim(),
        ModelKind::Image,
        "图片",
    )?;
    let provider = providers::resolve(&app, &provider_id)?;
    let base = provider.base_url.trim();
    if base.is_empty() {
        return Err("图片模型供应商未配置 baseURL".into());
    }
    let key = provider
        .key
        .filter(|value| !value.trim().is_empty())
        .ok_or("图片模型供应商缺少 API Key，请到「设置 → 供应商」填写")?;

    let response = if request.reference_paths.is_empty() {
        state
            .http
            .post(api_url(base, "images/generations"))
            .bearer_auth(&key)
            .json(&image_request_body(&request, &model))
            .timeout(Duration::from_secs(180))
            .send()
            .await
    } else {
        let form = image_edit_form(&request, &model).await?;
        state
            .http
            .post(api_url(base, "images/edits"))
            .bearer_auth(&key)
            .multipart(form)
            .timeout(Duration::from_secs(240))
            .send()
            .await
    }
    .map_err(|error| format!("图片生成请求失败：{error}"))?;

    let status = response.status();
    let raw = response
        .text()
        .await
        .map_err(|error| format!("读取图片生成响应失败：{error}"))?;
    if !status.is_success() {
        return Err(super::provider_http_error("图片模型", status, &raw));
    }

    let parsed: ImageResponse = serde_json::from_str(&raw)
        .map_err(|_| format!("图片模型响应格式不正确：{}", snippet(&raw)))?;
    if parsed.data.is_empty() {
        return Err("图片模型没有返回生成结果".into());
    }
    let directory = create_assets_dir(&app)?;
    tokio::fs::create_dir_all(&directory)
        .await
        .map_err(|error| format!("创建作品目录失败：{error}"))?;
    let mut results = Vec::new();
    for item in parsed
        .data
        .into_iter()
        .take(request.result_count.clamp(1, 4) as usize)
    {
        let bytes = if let Some(encoded) = item.b64_json.as_deref() {
            decode_image_data(encoded)?
        } else if let Some(url) = item.url.as_deref() {
            download_generated_image(&state.http, url).await?
        } else {
            return Err("图片模型没有返回 b64_json 或 url".into());
        };
        let (mime_type, extension) = detect_image_format(&bytes)?;
        let path = directory.join(format!("{}.{}", Uuid::new_v4(), extension));
        tokio::fs::write(&path, bytes)
            .await
            .map_err(|error| format!("保存生成图片失败：{error}"))?;
        results.push(CreateImageResult {
            provider_id: provider_id.clone(),
            model: model.clone(),
            file_path: path.to_string_lossy().into_owned(),
            mime_type: mime_type.into(),
            revised_prompt: item.revised_prompt,
        });
    }

    Ok(results)
}

#[tauri::command]
pub async fn generate_create_video(
    state: State<'_, AppState>,
    app: AppHandle,
    request_id: u32,
    request: CreateVideoRequest,
    on_event: Channel<CreateVideoEvent>,
) -> Result<(), String> {
    let cancel = CancellationToken::new();
    state
        .create_cancels
        .lock()
        .unwrap()
        .insert(request_id, cancel.clone());

    let result = run_video_generation(&state.http, &app, &request, &cancel, &on_event).await;
    state.create_cancels.lock().unwrap().remove(&request_id);

    let event = match result {
        Ok(Some(result)) => CreateVideoEvent::Completed { result },
        Ok(None) => CreateVideoEvent::Cancelled,
        Err(message) => CreateVideoEvent::Error { message },
    };
    let _ = on_event.send(event);
    Ok(())
}

#[tauri::command]
pub fn cancel_create_generation(state: State<'_, AppState>, request_id: u32) {
    if let Some(token) = state.create_cancels.lock().unwrap().get(&request_id) {
        token.cancel();
    }
}

async fn run_video_generation(
    http: &reqwest::Client,
    app: &AppHandle,
    request: &CreateVideoRequest,
    cancel: &CancellationToken,
    on_event: &Channel<CreateVideoEvent>,
) -> Result<Option<CreateVideoResult>, String> {
    if request.prompt.trim().is_empty() {
        return Err("请先填写视频生成描述".into());
    }
    let (provider_id, model) = resolve_selection(
        app,
        request.provider_id.trim(),
        request.model.trim(),
        ModelKind::Video,
        "视频",
    )?;
    let provider = providers::resolve(app, &provider_id)?;
    if provider.base_url.trim().is_empty() {
        return Err("视频模型供应商未配置 baseURL".into());
    }
    let key = provider
        .key
        .filter(|value| !value.trim().is_empty())
        .ok_or("视频模型供应商缺少 API Key，请到「设置 → 供应商」填写")?;
    let _ = on_event.send(CreateVideoEvent::Started {
        provider_id: provider_id.clone(),
        model: model.clone(),
    });

    let form = video_generation_form(request, &model).await?;
    let create_response = tokio::select! {
        _ = cancel.cancelled() => return Ok(None),
        response = http
            .post(api_url(&provider.base_url, "videos"))
            .bearer_auth(&key)
            .multipart(form)
            .timeout(Duration::from_secs(90))
            .send() => response.map_err(|error| format!("视频生成请求失败：{error}"))?,
    };
    let status = create_response.status();
    let raw = create_response
        .text()
        .await
        .map_err(|error| format!("读取视频生成响应失败：{error}"))?;
    if !status.is_success() {
        return Err(super::provider_http_error("视频模型", status, &raw));
    }
    let mut job: VideoJob = serde_json::from_str(&raw)
        .map_err(|_| format!("视频模型响应格式不正确：{}", snippet(&raw)))?;
    if job.id.trim().is_empty() {
        return Err("视频模型没有返回任务 ID".into());
    }

    let started = Instant::now();
    let mut last_progress = 4_u8;
    loop {
        let normalized = job.status.trim().to_ascii_lowercase();
        if normalized == "completed" || normalized == "succeeded" {
            break;
        }
        if normalized == "failed" || normalized == "error" {
            return Err(video_job_error(&job));
        }
        if normalized == "cancelled" || normalized == "canceled" {
            return Ok(None);
        }
        if started.elapsed() > VIDEO_GENERATION_TIMEOUT {
            return Err("视频生成超过 15 分钟，请稍后在供应商控制台检查任务状态".into());
        }

        last_progress = job
            .progress
            .map(|progress| progress.round().clamp(0.0, 99.0) as u8)
            .unwrap_or_else(|| last_progress.saturating_add(2).min(92));
        let _ = on_event.send(CreateVideoEvent::Progress {
            progress: last_progress,
            status: if job.status.is_empty() {
                "processing".into()
            } else {
                job.status.clone()
            },
        });

        tokio::select! {
            _ = cancel.cancelled() => {
                cancel_remote_video(http, &provider.base_url, &key, &job.id).await;
                return Ok(None);
            }
            _ = tokio::time::sleep(VIDEO_POLL_INTERVAL) => {}
        }
        let poll_response = tokio::select! {
            _ = cancel.cancelled() => {
                cancel_remote_video(http, &provider.base_url, &key, &job.id).await;
                return Ok(None);
            }
            response = http
                .get(api_url(&provider.base_url, &format!("videos/{}", job.id)))
                .bearer_auth(&key)
                .timeout(Duration::from_secs(30))
                .send() => response.map_err(|error| format!("查询视频生成进度失败：{error}"))?,
        };
        let status = poll_response.status();
        let raw = poll_response
            .text()
            .await
            .map_err(|error| format!("读取视频生成进度失败：{error}"))?;
        if !status.is_success() {
            return Err(super::provider_http_error(
                "查询视频生成进度失败",
                status,
                &raw,
            ));
        }
        job = serde_json::from_str(&raw)
            .map_err(|_| format!("视频任务状态格式不正确：{}", snippet(&raw)))?;
    }

    let _ = on_event.send(CreateVideoEvent::Progress {
        progress: 96,
        status: "downloading".into(),
    });
    download_generated_video(
        http,
        app,
        &provider.base_url,
        &key,
        &provider_id,
        &model,
        &job.id,
        request.duration_seconds,
        cancel,
    )
    .await
}

async fn video_generation_form(request: &CreateVideoRequest, model: &str) -> Result<Form, String> {
    let mut form = Form::new()
        .text("model", model.to_string())
        .text("prompt", request.prompt.trim().to_string())
        .text("seconds", request.duration_seconds.clamp(1, 60).to_string())
        .text(
            "size",
            video_size(&request.aspect_ratio, &request.quality).to_string(),
        );
    if let Some(reference_path) = request
        .reference_path
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
    {
        form = form.part(
            "input_reference",
            reference_image_part(reference_path).await?,
        );
    }
    Ok(form)
}

async fn cancel_remote_video(http: &reqwest::Client, base: &str, key: &str, id: &str) {
    let _ = http
        .delete(api_url(base, &format!("videos/{id}")))
        .bearer_auth(key)
        .timeout(Duration::from_secs(15))
        .send()
        .await;
}

#[allow(clippy::too_many_arguments)]
async fn download_generated_video(
    http: &reqwest::Client,
    app: &AppHandle,
    base: &str,
    key: &str,
    provider_id: &str,
    model: &str,
    job_id: &str,
    duration_seconds: u16,
    cancel: &CancellationToken,
) -> Result<Option<CreateVideoResult>, String> {
    let response = tokio::select! {
        _ = cancel.cancelled() => return Ok(None),
        response = http
            .get(api_url(base, &format!("videos/{job_id}/content")))
            .bearer_auth(key)
            .timeout(Duration::from_secs(5 * 60))
            .send() => response.map_err(|error| format!("下载生成视频失败：{error}"))?,
    };
    if !response.status().is_success() {
        let status = response.status();
        let raw = response.text().await.unwrap_or_default();
        return Err(super::provider_http_error("下载生成视频失败", status, &raw));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_GENERATED_VIDEO_BYTES)
    {
        return Err("生成视频超过 500 MB".into());
    }
    let mime_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(normalize_video_mime)
        .unwrap_or("video/mp4");
    let extension = extension_for_video_mime(mime_type);
    let directory = create_assets_dir(app)?;
    tokio::fs::create_dir_all(&directory)
        .await
        .map_err(|error| format!("创建作品目录失败：{error}"))?;
    let id = Uuid::new_v4();
    let path = directory.join(format!("{id}.{extension}"));
    let temporary = directory.join(format!("{id}.{extension}.download"));
    let mut file = tokio::fs::File::create(&temporary)
        .await
        .map_err(|error| format!("创建视频文件失败：{error}"))?;
    let mut stream = response.bytes_stream();
    let mut written = 0_u64;
    while let Some(next) = tokio::select! {
        _ = cancel.cancelled() => {
            drop(file);
            let _ = tokio::fs::remove_file(&temporary).await;
            return Ok(None);
        }
        chunk = stream.next() => chunk,
    } {
        let chunk = next.map_err(|error| format!("读取生成视频失败：{error}"))?;
        written = written.saturating_add(chunk.len() as u64);
        if written > MAX_GENERATED_VIDEO_BYTES {
            drop(file);
            let _ = tokio::fs::remove_file(&temporary).await;
            return Err("生成视频超过 500 MB".into());
        }
        file.write_all(&chunk)
            .await
            .map_err(|error| format!("写入生成视频失败：{error}"))?;
    }
    file.flush()
        .await
        .map_err(|error| format!("写入生成视频失败：{error}"))?;
    drop(file);
    if written == 0 {
        let _ = tokio::fs::remove_file(&temporary).await;
        return Err("视频模型返回了空文件".into());
    }
    tokio::fs::rename(&temporary, &path)
        .await
        .map_err(|error| format!("保存生成视频失败：{error}"))?;
    Ok(Some(CreateVideoResult {
        provider_id: provider_id.into(),
        model: model.into(),
        file_path: path.to_string_lossy().into_owned(),
        mime_type: mime_type.into(),
        duration_seconds,
    }))
}

#[tauri::command]
pub async fn read_create_asset_data_url(
    app: AppHandle,
    file_path: String,
) -> Result<String, String> {
    let path = checked_create_asset_path(&app, &file_path)?;
    let metadata = tokio::fs::metadata(&path)
        .await
        .map_err(|error| format!("读取作品信息失败：{error}"))?;
    if metadata.len() as usize > MAX_GENERATED_IMAGE_BYTES {
        return Err("图片作品超过 40 MB".into());
    }
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|error| format!("读取作品文件失败：{error}"))?;
    let (mime_type, _) = detect_image_format(&bytes)?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    Ok(format!("data:{mime_type};base64,{encoded}"))
}

#[tauri::command]
pub async fn export_create_asset(
    app: AppHandle,
    file_path: String,
) -> Result<Option<String>, String> {
    let source = checked_create_asset_path(&app, &file_path)?;
    let file_name = source
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .ok_or("作品文件名无效")?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("导出作品")
        .set_file_name(&file_name)
        .save_file(move |target| {
            let _ = tx.send(target);
        });
    let target = rx.await.map_err(|_| "选择导出位置失败".to_string())?;
    let Some(target) = target.and_then(|target| target.into_path().ok()) else {
        return Ok(None);
    };
    tokio::fs::copy(&source, &target)
        .await
        .map_err(|error| format!("导出作品失败：{error}"))?;
    Ok(Some(target.to_string_lossy().into_owned()))
}

#[tauri::command]
pub async fn delete_create_asset(app: AppHandle, file_path: String) -> Result<(), String> {
    let path = checked_create_asset_path(&app, &file_path)?;
    tokio::fs::remove_file(path)
        .await
        .map_err(|error| format!("删除作品文件失败：{error}"))
}

fn resolve_selection(
    app: &AppHandle,
    requested_provider_id: &str,
    requested_model: &str,
    kind: ModelKind,
    label: &str,
) -> Result<(String, String), String> {
    let settings = read_settings(app)?;
    if !requested_provider_id.is_empty() || !requested_model.is_empty() {
        if requested_provider_id.is_empty() || requested_model.is_empty() {
            return Err(format!("{label}模型选择不完整，请重新选择模型"));
        }
        let provider = settings
            .providers
            .iter()
            .find(|provider| provider.id == requested_provider_id)
            .ok_or_else(|| format!("找不到所选{label}模型供应商"))?;
        let model = provider
            .models
            .iter()
            .find(|model| model.id == requested_model)
            .ok_or_else(|| format!("所选{label}模型已不存在，请重新获取模型"))?;
        if model.effective_kind() != kind {
            return Err(format!("模型「{requested_model}」不是{label}生成模型"));
        }
        return Ok((requested_provider_id.into(), requested_model.into()));
    }

    settings
        .providers
        .iter()
        .find_map(|provider| {
            provider
                .models
                .iter()
                .find(|model| model.effective_kind() == kind)
                .map(|model| (provider.id.clone(), model.id.clone()))
        })
        .ok_or_else(|| format!("没有可用的{label}模型，请先到「设置 → 供应商」获取模型"))
}

fn image_request_body(request: &CreateImageRequest, model: &str) -> Value {
    let is_dalle = model.to_ascii_lowercase().contains("dall-e");
    let quality = image_quality(model, &request.quality);
    let mut body = json!({
        "model": model,
        "prompt": request.prompt.trim(),
        "n": request.result_count.clamp(1, 4),
        "size": size_for_aspect_ratio(&request.aspect_ratio),
        "quality": quality,
    });
    if let Some(object) = body.as_object_mut() {
        if is_dalle {
            object.insert("response_format".into(), json!("b64_json"));
        } else {
            object.insert("output_format".into(), json!("png"));
        }
    }
    body
}

async fn image_edit_form(request: &CreateImageRequest, model: &str) -> Result<Form, String> {
    let paths: Vec<&str> = request
        .reference_paths
        .iter()
        .map(String::as_str)
        .filter(|path| !path.trim().is_empty())
        .take(MAX_IMAGE_REFERENCES)
        .collect();
    if paths.is_empty() {
        return Err("请先选择有效的参考图".into());
    }
    let image_field = if paths.len() == 1 { "image" } else { "image[]" };
    let mut form = Form::new()
        .text("model", model.to_string())
        .text("prompt", request.prompt.trim().to_string())
        .text("n", request.result_count.clamp(1, 4).to_string())
        .text(
            "size",
            size_for_aspect_ratio(&request.aspect_ratio).to_string(),
        )
        .text(
            "quality",
            image_quality(model, &request.quality).to_string(),
        );
    if model.to_ascii_lowercase().contains("dall-e") {
        form = form.text("response_format", "b64_json");
    } else {
        form = form.text("output_format", "png");
    }
    for path in paths {
        form = form.part(image_field.to_string(), reference_image_part(path).await?);
    }
    Ok(form)
}

async fn reference_image_part(file_path: &str) -> Result<Part, String> {
    let path =
        dunce::canonicalize(file_path).map_err(|error| format!("无法读取参考图：{error}"))?;
    if !path.is_file() {
        return Err("参考图不是普通文件".into());
    }
    let metadata = tokio::fs::metadata(&path)
        .await
        .map_err(|error| format!("读取参考图信息失败：{error}"))?;
    if metadata.len() > MAX_REFERENCE_IMAGE_BYTES {
        return Err("参考图超过 20 MB，请压缩后再添加".into());
    }
    let mime_type = mime_guess::from_path(&path)
        .first()
        .map(|mime| mime.essence_str().to_string())
        .filter(|mime| mime.starts_with("image/"))
        .ok_or("参考文件不是支持的图片格式")?;
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "reference.png".into());
    let bytes = tokio::fs::read(path)
        .await
        .map_err(|error| format!("读取参考图失败：{error}"))?;
    Part::bytes(bytes)
        .file_name(file_name)
        .mime_str(&mime_type)
        .map_err(|error| format!("参考图 MIME 类型无效：{error}"))
}

fn image_quality(model: &str, quality: &str) -> &'static str {
    if model.to_ascii_lowercase().contains("dall-e") {
        if quality == "high" {
            "hd"
        } else {
            "standard"
        }
    } else if quality == "standard" {
        "medium"
    } else {
        "high"
    }
}

fn size_for_aspect_ratio(aspect_ratio: &str) -> &'static str {
    match aspect_ratio {
        "1:1" => "1024x1024",
        "9:16" | "3:4" => "1024x1536",
        "4:3" | "16:9" | "21:9" => "1536x1024",
        _ => "auto",
    }
}

fn video_size(aspect_ratio: &str, quality: &str) -> &'static str {
    let portrait = matches!(aspect_ratio, "9:16" | "3:4");
    match (portrait, quality) {
        (true, "high") => "1024x1792",
        (true, _) => "720x1280",
        (false, "high") => "1792x1024",
        (false, _) => "1280x720",
    }
}

fn decode_image_data(value: &str) -> Result<Vec<u8>, String> {
    let encoded = value
        .split_once(',')
        .filter(|(prefix, _)| prefix.contains("base64"))
        .map(|(_, encoded)| encoded)
        .unwrap_or(value)
        .trim();
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .or_else(|_| base64::engine::general_purpose::URL_SAFE.decode(encoded))
        .map_err(|_| "图片模型返回了无效的 Base64 数据".to_string())?;
    validate_image_size(bytes)
}

async fn download_generated_image(http: &reqwest::Client, url: &str) -> Result<Vec<u8>, String> {
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err("图片模型返回了不支持的下载地址".into());
    }
    let response = http
        .get(url)
        .timeout(Duration::from_secs(60))
        .send()
        .await
        .map_err(|error| format!("下载生成图片失败：{error}"))?;
    if !response.status().is_success() {
        return Err(format!("下载生成图片失败：HTTP {}", response.status()));
    }
    if response
        .content_length()
        .is_some_and(|length| length as usize > MAX_GENERATED_IMAGE_BYTES)
    {
        return Err("生成图片超过 40 MB".into());
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("读取生成图片失败：{error}"))?
        .to_vec();
    validate_image_size(bytes)
}

fn validate_image_size(bytes: Vec<u8>) -> Result<Vec<u8>, String> {
    if bytes.is_empty() {
        return Err("图片模型返回了空文件".into());
    }
    if bytes.len() > MAX_GENERATED_IMAGE_BYTES {
        return Err("生成图片超过 40 MB".into());
    }
    Ok(bytes)
}

fn detect_image_format(bytes: &[u8]) -> Result<(&'static str, &'static str), String> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Ok(("image/png", "png"));
    }
    if bytes.starts_with(b"\xff\xd8\xff") {
        return Ok(("image/jpeg", "jpg"));
    }
    if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Ok(("image/webp", "webp"));
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Ok(("image/gif", "gif"));
    }
    Err("图片模型返回的文件格式不受支持".into())
}

fn normalize_video_mime(value: &str) -> Option<&'static str> {
    let mime = value.split(';').next()?.trim().to_ascii_lowercase();
    match mime.as_str() {
        "video/mp4" => Some("video/mp4"),
        "video/webm" => Some("video/webm"),
        "video/quicktime" => Some("video/quicktime"),
        _ => None,
    }
}

fn extension_for_video_mime(mime_type: &str) -> &'static str {
    match mime_type {
        "video/webm" => "webm",
        "video/quicktime" => "mov",
        _ => "mp4",
    }
}

fn video_job_error(job: &VideoJob) -> String {
    job.error
        .as_ref()
        .and_then(|error| {
            error
                .get("message")
                .and_then(Value::as_str)
                .or_else(|| error.as_str())
        })
        .map(|message| format!("视频生成失败：{message}"))
        .unwrap_or_else(|| "视频生成失败，供应商没有返回具体原因".into())
}

fn checked_create_asset_path(app: &AppHandle, file_path: &str) -> Result<PathBuf, String> {
    let root = create_assets_dir(app)?;
    let root = dunce::canonicalize(&root).map_err(|error| format!("无法定位作品目录：{error}"))?;
    let path =
        dunce::canonicalize(file_path).map_err(|error| format!("无法读取作品文件：{error}"))?;
    if !path.starts_with(&root) || !path.is_file() {
        return Err("作品文件路径无效".into());
    }
    Ok(path)
}

fn create_assets_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|directory| directory.join("create-assets"))
        .map_err(|error| format!("无法定位作品目录：{error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_canvas_aspect_ratios_to_supported_image_sizes() {
        assert_eq!(size_for_aspect_ratio("1:1"), "1024x1024");
        assert_eq!(size_for_aspect_ratio("16:9"), "1536x1024");
        assert_eq!(size_for_aspect_ratio("9:16"), "1024x1536");
        assert_eq!(size_for_aspect_ratio("3:4"), "1024x1536");
    }

    #[test]
    fn maps_video_orientation_and_quality() {
        assert_eq!(video_size("16:9", "standard"), "1280x720");
        assert_eq!(video_size("9:16", "standard"), "720x1280");
        assert_eq!(video_size("16:9", "high"), "1792x1024");
        assert_eq!(video_size("9:16", "high"), "1024x1792");
    }

    #[test]
    fn decodes_and_detects_png_data() {
        let encoded = base64::engine::general_purpose::STANDARD.encode(b"\x89PNG\r\n\x1a\nmock");
        let bytes = decode_image_data(&encoded).unwrap();
        assert_eq!(detect_image_format(&bytes).unwrap(), ("image/png", "png"));
    }
}
