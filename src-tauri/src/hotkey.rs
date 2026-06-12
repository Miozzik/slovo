//! Global shortcut registration and handling.
//!
//! Registers a configurable system-wide hotkey that captures the current
//! selection, reveals the popup window, and notifies the frontend. The hotkey
//! is stored as an accelerator string (e.g. "super+shift+KeyT") so the user can
//! change it from settings; it can be re-registered at runtime.

use std::str::FromStr;

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use crate::capture;

/// The default hotkey accelerator. macOS: ⌘⇧T (`super` == the Command key).
/// Other platforms: Ctrl+Shift+T.
pub fn default_hotkey() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        "super+shift+KeyT"
    }
    #[cfg(not(target_os = "macos"))]
    {
        "control+shift+KeyT"
    }
}

/// Parse an accelerator string into a `Shortcut`, with a friendly error.
fn parse(shortcut_str: &str) -> Result<Shortcut, String> {
    Shortcut::from_str(shortcut_str)
        .map_err(|e| format!("Invalid shortcut '{shortcut_str}': {e}"))
}

/// Register the global hotkey from an accelerator string.
pub fn register_global_hotkey(app: &AppHandle, shortcut_str: &str) -> Result<(), String> {
    let shortcut = parse(shortcut_str)?;
    let app_handle = app.clone();

    app.global_shortcut()
        .on_shortcut(shortcut, move |_app, _shortcut, event| {
            // Only act on key-press, not the matching release, so we fire once.
            if event.state() != ShortcutState::Pressed {
                return;
            }
            handle_trigger(&app_handle);
        })
        .map_err(|e| format!("Failed to register global shortcut: {e}"))?;

    Ok(())
}

/// Replace the current hotkey with a new one. Validates the new accelerator
/// BEFORE unregistering, so a bad combo can never leave the app with no hotkey.
pub fn set_global_hotkey(app: &AppHandle, shortcut_str: &str) -> Result<(), String> {
    let _ = parse(shortcut_str)?;
    app.global_shortcut()
        .unregister_all()
        .map_err(|e| format!("Failed to clear old shortcut: {e}"))?;
    register_global_hotkey(app, shortcut_str)
}

/// React to a hotkey press: capture selection, reveal the window, and notify
/// the frontend.
fn handle_trigger(app: &AppHandle) {
    // 1. Capture whatever the user currently has selected (best-effort).
    let selected = capture::capture_selection();

    // 2. Restore the Dock icon (Regular policy), show, and focus the popup.
    crate::reveal_window(app);

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.center();
        let _ = window.set_focus();

        // 3. Hand the captured text to the frontend so it can prefill the input.
        let _ = window.emit("set-source", selected);

        // 4. Ask the frontend to focus its input field.
        let _ = window.emit("focus-input", ());
    }
}
