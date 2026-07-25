//! Secret storage for provider credentials and user-managed secret values.
//!
//! Release builds keep keys in the OS credential store (macOS Keychain /
//! Windows Credential Manager). Debug builds (`tauri dev`) use a plaintext file
//! instead: every rebuild re-signs the dev binary with a fresh ad-hoc signature,
//! which the Keychain treats as a different app and re-prompts for on every
//! launch — the file backend avoids that friction while iterating. Keys never
//! land in a plaintext file in a release build.

/// Keychain service name matches the app identifier so entries are easy to
/// locate in Keychain Access / Windows Credential Manager.
const SERVICE: &str = "com.tietiezhi.tietiezhi";
/// Legacy single-relay key account (pre multi-provider). Kept for migration.
const API_KEY_USER: &str = "relay-api-key";

/// Keyring account for a provider's API key.
fn provider_account(provider_id: &str) -> String {
    format!("provider-{provider_id}")
}

fn device_core_account(core_id: &str) -> String {
    format!("device-core-{core_id}")
}

fn gateway_session_account(provider_id: &str) -> String {
    format!("gateway-session-{provider_id}")
}

fn gateway_api_key_account(provider_id: &str) -> String {
    format!("gateway-api-key-{provider_id}")
}

fn gateway_issuer_account(provider_id: &str) -> String {
    format!("gateway-issuer-{provider_id}")
}

fn tietiezhi_secret_account(name: &str) -> String {
    format!("tietiezhi-secret-{name}")
}

// MARK: - Public API (backend-agnostic)

pub fn set_provider_key(provider_id: &str, value: &str) -> Result<(), String> {
    backend::set(&provider_account(provider_id), value)
}

pub fn get_provider_key(provider_id: &str) -> Result<Option<String>, String> {
    backend::get(&provider_account(provider_id))
}

pub fn delete_provider_key(provider_id: &str) -> Result<(), String> {
    backend::delete(&provider_account(provider_id))
}

pub fn set_gateway_session(provider_id: &str, value: &str) -> Result<(), String> {
    backend::set(&gateway_session_account(provider_id), value)
}

pub fn get_gateway_session(provider_id: &str) -> Result<Option<String>, String> {
    backend::get(&gateway_session_account(provider_id))
}

pub fn delete_gateway_session(provider_id: &str) -> Result<(), String> {
    backend::delete(&gateway_session_account(provider_id))
}

pub fn set_gateway_api_key(provider_id: &str, value: &str) -> Result<(), String> {
    backend::set(&gateway_api_key_account(provider_id), value)
}

pub fn get_gateway_api_key(provider_id: &str) -> Result<Option<String>, String> {
    backend::get(&gateway_api_key_account(provider_id))
}

pub fn delete_gateway_api_key(provider_id: &str) -> Result<(), String> {
    backend::delete(&gateway_api_key_account(provider_id))
}

pub fn set_gateway_issuer(provider_id: &str, value: &str) -> Result<(), String> {
    backend::set(&gateway_issuer_account(provider_id), value)
}

pub fn get_gateway_issuer(provider_id: &str) -> Result<Option<String>, String> {
    backend::get(&gateway_issuer_account(provider_id))
}

pub fn delete_gateway_issuer(provider_id: &str) -> Result<(), String> {
    backend::delete(&gateway_issuer_account(provider_id))
}

pub fn set_device_core_token(core_id: &str, value: &str) -> Result<(), String> {
    backend::set(&device_core_account(core_id), value)
}

pub fn get_device_core_token(core_id: &str) -> Result<Option<String>, String> {
    backend::get(&device_core_account(core_id))
}

pub fn delete_device_core_token(core_id: &str) -> Result<(), String> {
    backend::delete(&device_core_account(core_id))
}

pub fn set_tietiezhi_secret(name: &str, value: &str) -> Result<(), String> {
    backend::set(&tietiezhi_secret_account(name), value)
}

pub fn get_tietiezhi_secret(name: &str) -> Result<Option<String>, String> {
    backend::get(&tietiezhi_secret_account(name))
}

pub fn delete_tietiezhi_secret(name: &str) -> Result<(), String> {
    backend::delete(&tietiezhi_secret_account(name))
}

/// Legacy single-relay key (read-only, migration only).
pub fn get_api_key() -> Result<Option<String>, String> {
    backend::get(API_KEY_USER)
}

// MARK: - Release backend: OS credential store

#[cfg(not(debug_assertions))]
mod backend {
    use super::SERVICE;
    use keyring::Entry;

    fn entry(account: &str) -> Result<Entry, String> {
        Entry::new(SERVICE, account).map_err(|e| format!("无法访问系统安全存储：{e}"))
    }

    pub fn set(account: &str, value: &str) -> Result<(), String> {
        entry(account)?
            .set_password(value)
            .map_err(|e| format!("保存密钥失败：{e}"))
    }

    pub fn get(account: &str) -> Result<Option<String>, String> {
        match entry(account)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(format!("读取密钥失败：{e}")),
        }
    }

    pub fn delete(account: &str) -> Result<(), String> {
        match entry(account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!("删除密钥失败：{e}")),
        }
    }
}

// MARK: - Debug backend: plaintext file (dev only, no Keychain prompt)

#[cfg(debug_assertions)]
mod backend {
    use super::SERVICE;
    use std::collections::BTreeMap;
    use std::path::PathBuf;

    fn store_path() -> PathBuf {
        dirs::config_dir()
            .unwrap_or_else(std::env::temp_dir)
            .join(SERVICE)
            .join("dev-secrets.json")
    }

    fn load() -> BTreeMap<String, String> {
        let Ok(raw) = std::fs::read_to_string(store_path()) else {
            return BTreeMap::new();
        };
        serde_json::from_str(&raw).unwrap_or_default()
    }

    fn save(map: &BTreeMap<String, String>) -> Result<(), String> {
        let path = store_path();
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("创建开发密钥目录失败：{e}"))?;
        }
        let raw = serde_json::to_string_pretty(map).map_err(|e| e.to_string())?;
        std::fs::write(&path, raw).map_err(|e| format!("写入开发密钥失败：{e}"))
    }

    pub fn set(account: &str, value: &str) -> Result<(), String> {
        let mut map = load();
        map.insert(account.to_owned(), value.to_owned());
        save(&map)
    }

    pub fn get(account: &str) -> Result<Option<String>, String> {
        Ok(load().get(account).cloned())
    }

    pub fn delete(account: &str) -> Result<(), String> {
        let mut map = load();
        map.remove(account);
        save(&map)
    }
}
