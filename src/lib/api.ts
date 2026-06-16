import { invoke } from "@tauri-apps/api/core";

import type { Provider, Settings } from "./types";

export const getSettings = () => invoke<Settings>("get_settings");
export const saveSettings = (settings: Settings) =>
  invoke<void>("save_settings", { settings });

export const listAudioInputs = () => invoke<string[]>("list_audio_inputs");

export const startHotkeyCapture = () => invoke<void>("start_hotkey_capture");
export const cancelHotkeyCapture = () => invoke<void>("cancel_hotkey_capture");

export const dictationToggle = () => invoke<void>("dictation_toggle");
export const dictationCancel = () => invoke<void>("dictation_cancel");

export const testProvider = (provider: Provider) =>
  invoke<string>("test_provider", { provider });

export const fetchModels = (provider: Provider) =>
  invoke<string[]>("fetch_models", { provider });
