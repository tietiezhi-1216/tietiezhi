//! Dictation orchestration: the state machine that ties recording, ASR
//! (HTTP or realtime WS), LLM polishing and auto-insert together, while driving
//! the on-screen recording pill via events.
//!
//! Flow: hotkey/▶ starts a session → audio streams → hotkey-again/✓ commits →
//! recognize → (optional) polish → (optional) insert. ✗ cancels and discards.

use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

use crate::config::ResolvedModel;
use crate::realtime::RtEvent;
use crate::state::{AppState, SessionCtrl};

const HTTP_RATE: u32 = 16_000;
const REALTIME_RATE: u32 = 24_000; // OpenAI realtime pcm16

// ---- Public entry points (called from hotkey + commands) -------------------

/// First press → start recording. Subsequent press → commit (finish & recognize).
pub fn toggle(app: &AppHandle) {
    let state = app.state::<Arc<AppState>>().inner().clone();
    let mut dict = state.dict.lock();
    if dict.active {
        if let Some(tx) = &dict.ctrl_tx {
            let _ = tx.try_send(SessionCtrl::Commit);
        }
        return;
    }
    dict.active = true;
    let (tx, rx) = mpsc::channel::<SessionCtrl>(8);
    dict.ctrl_tx = Some(tx);
    drop(dict);

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        run_session(app, rx).await;
    });
}

/// Abort the active session and discard (✗).
pub fn cancel(app: &AppHandle) {
    let state = app.state::<Arc<AppState>>().inner().clone();
    let dict = state.dict.lock();
    if let Some(tx) = &dict.ctrl_tx {
        let _ = tx.try_send(SessionCtrl::Cancel);
    }
}

// ---- Session ---------------------------------------------------------------

async fn run_session(app: AppHandle, mut ctrl_rx: mpsc::Receiver<SessionCtrl>) {
    let state = app.state::<Arc<AppState>>().inner().clone();
    let settings = state.settings.lock().clone();

    let asr = match settings.asr_model().cloned() {
        Some(m) => m,
        None => {
            emit_error(&app, "未选择语音识别模型，请在「模型」里添加并选择。");
            return finish_idle(&app, &state);
        }
    };
    let resolved = match settings.resolve(&asr) {
        Some(r) => r,
        None => {
            emit_error(&app, "所选语音识别模型没有对应的服务商。");
            return finish_idle(&app, &state);
        }
    };

    show_pill(&app);
    emit_state(&app, "recording", "", 0.0);

    let recognized = if resolved.transport == "realtime_ws" {
        run_realtime(&app, &resolved, &mut ctrl_rx).await
    } else {
        run_http(&app, &resolved, &mut ctrl_rx).await
    };

    let text = match recognized {
        Ok(Some(t)) => t,
        Ok(None) => {
            // cancelled
            hide_pill(&app);
            emit_state(&app, "idle", "", 0.0);
            return finish_idle(&app, &state);
        }
        Err(e) => {
            emit_error(&app, &format!("识别失败：{e}"));
            hide_pill(&app);
            return finish_idle(&app, &state);
        }
    };

    let mut final_text = text;

    // Optional LLM polish.
    if settings.llm_polish_enabled {
        if let Some(llm) = settings.llm_model() {
            if let Some(rllm) = settings.resolve(llm) {
                emit_state(&app, "polishing", &final_text, 0.0);
                let template = settings
                    .active_template()
                    .map(|t| t.template.clone())
                    .unwrap_or_else(|| "{{transcript}}".to_string());
                match crate::llm::polish(&rllm, &template, &settings.insert_position, &final_text)
                    .await
                {
                    Ok(t) if !t.is_empty() => final_text = t,
                    Ok(_) => {}
                    Err(e) => emit_error(&app, &format!("润色失败：{e}")),
                }
            }
        }
    }

    // Deliver result + optional auto-insert.
    let _ = app.emit("dictation://result", serde_json::json!({ "text": final_text }));
    if settings.auto_insert && !final_text.is_empty() {
        emit_state(&app, "inserting", &final_text, 0.0);
        let to_insert = final_text.clone();
        let _ = app.run_on_main_thread(move || {
            if let Err(e) = crate::insert::type_text(&to_insert) {
                eprintln!("[insert] {e:?}");
            }
        });
    }

    hide_pill(&app);
    emit_state(&app, "idle", "", 0.0);
    finish_idle(&app, &state);
}

/// HTTP mode: buffer the whole utterance, then POST it once.
async fn run_http(
    app: &AppHandle,
    model: &ResolvedModel,
    ctrl_rx: &mut mpsc::Receiver<SessionCtrl>,
) -> anyhow::Result<Option<String>> {
    let (frames_tx, mut frames_rx) = mpsc::channel::<Vec<i16>>(64);
    let capture = crate::audio::start(HTTP_RATE, frames_tx)?;

    let mut buffer: Vec<i16> = Vec::new();
    let committed = loop {
        tokio::select! {
            frame = frames_rx.recv() => {
                if let Some(frame) = frame {
                    emit_state(app, "recording", "", crate::audio::level(&frame));
                    buffer.extend_from_slice(&frame);
                }
            }
            ctrl = ctrl_rx.recv() => match ctrl {
                Some(SessionCtrl::Commit) | None => break true,
                Some(SessionCtrl::Cancel) => break false,
            },
        }
    };
    capture.stop();

    if !committed {
        return Ok(None);
    }
    if buffer.is_empty() {
        return Ok(Some(String::new()));
    }

    emit_state(app, "transcribing", "", 0.0);
    let wav = crate::asr::encode_wav(&buffer, HTTP_RATE)?;
    Ok(Some(crate::asr::transcribe_http(model, wav).await?))
}

/// Realtime mode: stream PCM over the WebSocket and surface live deltas.
async fn run_realtime(
    app: &AppHandle,
    model: &ResolvedModel,
    ctrl_rx: &mut mpsc::Receiver<SessionCtrl>,
) -> anyhow::Result<Option<String>> {
    let ws = crate::realtime::connect(model).await?;
    let (mut write, mut read) = ws.split();
    write.send(crate::realtime::session_update(model)).await?;

    let (frames_tx, mut frames_rx) = mpsc::channel::<Vec<i16>>(64);
    let capture = crate::audio::start(REALTIME_RATE, frames_tx)?;

    let mut text = String::new();
    let mut committing = false;
    let mut cancelled = false;
    // After commit, don't wait forever for the final event.
    let mut deadline: Option<tokio::time::Instant> = None;

    loop {
        tokio::select! {
            frame = frames_rx.recv() => {
                if let Some(frame) = frame {
                    if !committing {
                        emit_state(app, "recording", &text, crate::audio::level(&frame));
                        let _ = write.send(crate::realtime::append(&frame)).await;
                    }
                }
            }
            ctrl = ctrl_rx.recv() => match ctrl {
                Some(SessionCtrl::Commit) | None => {
                    committing = true;
                    capture.stop();
                    deadline = Some(tokio::time::Instant::now() + Duration::from_secs(6));
                    emit_state(app, "transcribing", &text, 0.0);
                    let _ = write.send(crate::realtime::commit()).await;
                }
                Some(SessionCtrl::Cancel) => { cancelled = true; break; }
            },
            msg = read.next() => match msg {
                Some(Ok(Message::Text(txt))) => {
                    match crate::realtime::parse_event(&txt) {
                        Some(RtEvent::Delta(d)) => {
                            text.push_str(&d);
                            emit_state(app, if committing { "transcribing" } else { "recording" }, &text, 0.0);
                        }
                        Some(RtEvent::Completed(t)) => {
                            if !t.is_empty() { text = t; }
                            if committing { break; }
                        }
                        Some(RtEvent::Error(e)) => { capture.stop(); return Err(anyhow::anyhow!(e)); }
                        None => {}
                    }
                }
                Some(Ok(Message::Close(_))) | None => break,
                Some(Ok(_)) => {}
                Some(Err(e)) => { capture.stop(); return Err(e.into()); }
            },
            _ = async {
                match deadline {
                    Some(d) => tokio::time::sleep_until(d).await,
                    None => std::future::pending::<()>().await,
                }
            } => break,
        }
    }

    capture.stop();
    let _ = write.send(Message::Close(None)).await;

    if cancelled {
        Ok(None)
    } else {
        Ok(Some(text))
    }
}

// ---- Helpers ---------------------------------------------------------------

fn finish_idle(app: &AppHandle, state: &Arc<AppState>) {
    let mut dict = state.dict.lock();
    dict.active = false;
    dict.ctrl_tx = None;
    let _ = app;
}

fn emit_state(app: &AppHandle, status: &str, text: &str, level: f32) {
    let _ = app.emit(
        "dictation://state",
        serde_json::json!({ "status": status, "text": text, "level": level }),
    );
}

fn emit_error(app: &AppHandle, message: &str) {
    eprintln!("[dictation] {message}");
    let _ = app.emit("dictation://error", serde_json::json!({ "message": message }));
    emit_state(app, "error", message, 0.0);
}

fn show_pill(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("pill") {
        let _ = position_pill(&win);
        let _ = win.show();
        let _ = win.set_always_on_top(true);
    }
}

fn hide_pill(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("pill") {
        let _ = win.hide();
    }
}

fn position_pill(win: &tauri::WebviewWindow) -> tauri::Result<()> {
    if let Some(monitor) = win.primary_monitor()? {
        let screen = monitor.size();
        let size = win.outer_size()?;
        let x = (screen.width as i32 - size.width as i32) / 2;
        let y = screen.height as i32 - size.height as i32 - 120;
        win.set_position(tauri::PhysicalPosition::new(x, y))?;
    }
    Ok(())
}
