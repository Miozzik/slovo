//! API-key persistence.
//!
//! The config is a tiny JSON file at `<config_dir>/slovo/config.json`, e.g. on
//! macOS `~/Library/Application Support/slovo/config.json`. As a fallback, the
//! `DEEPL_API_KEY` environment variable is honored when the file has no key.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;

/// Persisted application configuration.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AppConfig {
    /// The DeepL API key, if one has been saved.
    pub api_key: Option<String>,
    /// The global hotkey accelerator (e.g. "super+shift+KeyT"). `None` = default.
    /// `#[serde(default)]` keeps older config files (without this field) loadable.
    #[serde(default)]
    pub hotkey: Option<String>,
}

/// Returns the path to the config file, creating no directories.
fn config_path() -> Option<PathBuf> {
    dirs::config_dir().map(|d| d.join("slovo").join("config.json"))
}

impl AppConfig {
    /// Load the config from disk. Never panics: a missing or malformed file
    /// yields an empty config. If the file has no key, fall back to the
    /// `DEEPL_API_KEY` environment variable.
    pub fn load() -> AppConfig {
        let mut cfg: AppConfig = config_path()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();

        // Environment variable acts as a fallback only.
        if cfg.api_key.as_deref().unwrap_or("").trim().is_empty() {
            if let Ok(env_key) = std::env::var("DEEPL_API_KEY") {
                if !env_key.trim().is_empty() {
                    cfg.api_key = Some(env_key);
                }
            }
        }

        cfg
    }

    /// Persist the config to disk, creating the parent directory if needed.
    pub fn save(&self) -> Result<(), String> {
        let path = config_path().ok_or_else(|| "Could not determine config directory".to_string())?;

        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create config directory: {e}"))?;
        }

        let json = serde_json::to_string_pretty(self)
            .map_err(|e| format!("Failed to serialize config: {e}"))?;

        std::fs::write(&path, json).map_err(|e| format!("Failed to write config file: {e}"))?;
        Ok(())
    }

    /// Convenience: does a usable API key exist?
    pub fn has_key(&self) -> bool {
        self.api_key.as_deref().map(|k| !k.trim().is_empty()).unwrap_or(false)
    }
}

/// Thread-safe wrapper used as Tauri-managed state.
pub struct ConfigState {
    pub inner: Mutex<AppConfig>,
}

impl ConfigState {
    /// Build state by loading the config from disk.
    pub fn load() -> ConfigState {
        ConfigState {
            inner: Mutex::new(AppConfig::load()),
        }
    }
}
