//! Slovo — a minimalist Apple-style popup translator.
//!
//! This is the application wiring: state, Tauri commands, the setup hook
//! (vibrancy + hotkey), and the entry point `run()`.

mod capture;
mod config;
mod hotkey;
mod translate;

use config::ConfigState;
use serde::Serialize;
use tauri::{Manager, State};
use tauri_plugin_autostart::ManagerExt;
use translate::{Languages, TranslateResult};

/// Settings surface exposed to the frontend. We never send the key itself —
/// only whether one is set.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub has_key: bool,
}

/// Translate `text` from `source` to `target`.
///
/// Reads the API key from managed config state. Returns a friendly error if no
/// key is configured.
#[tauri::command]
async fn translate(
    state: State<'_, ConfigState>,
    text: String,
    source: String,
    target: String,
) -> Result<TranslateResult, String> {
    // Clone the key out of the lock so we don't hold the mutex across `await`.
    let api_key = {
        let cfg = state.inner.lock().map_err(|_| "Config state poisoned".to_string())?;
        cfg.api_key.clone()
    };

    let api_key = match api_key {
        Some(k) if !k.trim().is_empty() => k,
        _ => return Err("No DeepL API key set — open settings (⚙) and paste your key.".to_string()),
    };

    translate::deepl_translate(&api_key, &text, &source, &target).await
}

/// Fetch DeepL's supported source/target languages using the configured key.
#[tauri::command]
async fn get_languages(state: State<'_, ConfigState>) -> Result<Languages, String> {
    // Clone the key out of the lock so we don't hold the mutex across `await`.
    let api_key = {
        let cfg = state.inner.lock().map_err(|_| "Config state poisoned".to_string())?;
        cfg.api_key.clone()
    };

    let api_key = match api_key {
        Some(k) if !k.trim().is_empty() => k,
        _ => return Err("No DeepL API key set — open settings (⚙) and paste your key.".to_string()),
    };

    translate::deepl_languages(&api_key).await
}

/// Report whether an API key is configured.
#[tauri::command]
fn get_settings(state: State<'_, ConfigState>) -> Result<Settings, String> {
    let cfg = state.inner.lock().map_err(|_| "Config state poisoned".to_string())?;
    Ok(Settings { has_key: cfg.has_key() })
}

/// Persist a new API key and update the in-memory state.
#[tauri::command]
fn save_settings(
    state: State<'_, ConfigState>,
    api_key: String,
) -> Result<(), String> {
    let mut cfg = state.inner.lock().map_err(|_| "Config state poisoned".to_string())?;
    let trimmed = api_key.trim();
    cfg.api_key = if trimmed.is_empty() { None } else { Some(trimmed.to_string()) };
    cfg.save()
}

/// Reveal the popup: on macOS restore the `Regular` activation policy so the
/// Dock icon reappears (and Cmd+Tab reaches the app) while the window is open,
/// then show + focus it.
pub(crate) fn reveal_window(app: &tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Conceal the popup: hide the window and, on macOS, drop to the `Accessory`
/// activation policy so the app disappears from the Dock and lives only in the
/// menubar / status bar (it keeps running for the hotkey).
pub(crate) fn conceal_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
}

/// Hide the popup window (used when the user dismisses it with × or Escape).
/// This removes the Dock icon; the app stays alive in the menubar.
#[tauri::command]
fn hide_window(app: tauri::AppHandle) {
    conceal_window(&app);
}

/// Report whether launch-at-login (autostart) is currently enabled. With the
/// AppleScript launcher this queries System Events' login items, which is
/// accurate (unlike the LaunchAgent mode's plist check).
#[tauri::command]
fn get_autostart(app: tauri::AppHandle) -> Result<bool, String> {
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

/// Enable or disable launch-at-login (autostart) for Slovo.
#[tauri::command]
fn set_autostart(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let manager = app.autolaunch();
    if enabled {
        manager.enable().map_err(|e| e.to_string())
    } else {
        manager.disable().map_err(|e| e.to_string())
    }
}

/// Return the current global hotkey accelerator (configured or default).
#[tauri::command]
fn get_hotkey(state: State<'_, ConfigState>) -> Result<String, String> {
    let cfg = state.inner.lock().map_err(|_| "Config state poisoned".to_string())?;
    Ok(cfg
        .hotkey
        .clone()
        .unwrap_or_else(|| hotkey::default_hotkey().to_string()))
}

/// Set a new global hotkey: re-register it live, then persist it. Validation
/// happens before unregistering, so an invalid combo leaves the old one intact.
#[tauri::command]
fn set_hotkey(
    app: tauri::AppHandle,
    state: State<'_, ConfigState>,
    shortcut: String,
) -> Result<(), String> {
    hotkey::set_global_hotkey(&app, &shortcut)?;
    let mut cfg = state.inner.lock().map_err(|_| "Config state poisoned".to_string())?;
    cfg.hotkey = Some(shortcut);
    cfg.save()
}

/// Whether macOS Accessibility (needed for ⌘⇧T text capture) is granted.
/// SILENT check — never shows a prompt, so it's safe to call on every settings
/// open without nagging the user.
#[tauri::command]
fn get_accessibility() -> bool {
    #[cfg(target_os = "macos")]
    {
        macos_accessibility_client::accessibility::application_is_trusted()
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

/// Show the macOS Accessibility prompt and add Slovo to the list. Returns the
/// (possibly still-false) trust state. Invoked only by the settings "Grant"
/// button, never automatically.
#[tauri::command]
fn request_accessibility() -> bool {
    #[cfg(target_os = "macos")]
    {
        macos_accessibility_client::accessibility::application_is_trusted_with_prompt()
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

/// Application entry point. Builds and runs the Tauri app.
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        // AppleScript launcher (NOT LaunchAgent): on macOS this registers Slovo
        // as a real Login Item via System Events, so it actually appears in
        // System Settings → General → Login Items and launches at login. The
        // LaunchAgent/plist mode is known not to show up there nor run reliably.
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::AppleScript,
            None,
        ))
        .manage(ConfigState::load())
        .setup(|app| {
            let window = app
                .get_webview_window("main")
                .ok_or("main window not found")?;

            // System tray (menubar) icon. Two menu items plus a left-click on the
            // icon itself all reveal and focus the main popup window.
            {
                use tauri::menu::{MenuBuilder, MenuItemBuilder};
                use tauri::tray::{
                    MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent,
                };

                let open_i = MenuItemBuilder::with_id("open", "Open Slovo").build(app)?;
                let quit_i = MenuItemBuilder::with_id("quit", "Quit").build(app)?;
                let menu = MenuBuilder::new(app).items(&[&open_i, &quit_i]).build()?;

                // Monochrome template menubar icon — macOS auto-tints it for the
                // light/dark menubar so it matches the native system icons (the
                // colored app icon would clash). `icon_as_template(true)` is what
                // tells macOS to treat the alpha-only image as a template.
                let tray_icon = tauri::include_image!("icons/tray.png");
                let tray = TrayIconBuilder::new()
                    .icon(tray_icon)
                    .icon_as_template(true)
                    .menu(&menu)
                    .on_menu_event(|app, event| match event.id().as_ref() {
                        "open" => reveal_window(app),
                        "quit" => app.exit(0),
                        _ => {}
                    })
                    .on_tray_icon_event(|tray, event| {
                        if let TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        } = event
                        {
                            reveal_window(tray.app_handle());
                        }
                    });

                tray.build(app)?;
            }

            // NOTE: we intentionally do NOT prompt for Accessibility on startup —
            // that made the system dialog pop up on every launch. Instead the
            // settings panel shows the live status (get_accessibility) and offers
            // a "Grant" button (request_accessibility) only when it's missing.

            // Apply translucent "HUD" vibrancy on macOS for the popover look.
            #[cfg(target_os = "macos")]
            {
                use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial};
                // No custom corner radius — the native window frame already
                // rounds and clips the window, so let the OS own the shape.
                let _ = apply_vibrancy(&window, NSVisualEffectMaterial::HudWindow, None, None);
            }

            // Register the global hotkey — the user's configured accelerator if
            // set, otherwise the default (⌘⇧T on macOS).
            let configured_hotkey = app
                .state::<ConfigState>()
                .inner
                .lock()
                .ok()
                .and_then(|c| c.hotkey.clone())
                .unwrap_or_else(|| hotkey::default_hotkey().to_string());
            hotkey::register_global_hotkey(app.handle(), &configured_hotkey)
                .map_err(|e| -> Box<dyn std::error::Error> { e.into() })?;

            // Native close (red traffic light) and any other close request should
            // NOT quit the app — hide the window to the menubar instead, dropping
            // the Dock icon. The app keeps running for the global hotkey.
            {
                let app_handle = app.handle().clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        conceal_window(&app_handle);
                    }
                });
            }

            // First-run convenience: if no API key is configured yet, reveal the
            // window so the user can open settings (⚙) and paste their DeepL key.
            // Otherwise launch as a menubar-only background app (no Dock icon)
            // until the global hotkey or the tray icon summons it.
            {
                let has_key = app
                    .state::<ConfigState>()
                    .inner
                    .lock()
                    .map(|c| c.has_key())
                    .unwrap_or(false);
                if has_key {
                    #[cfg(target_os = "macos")]
                    let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
                } else {
                    reveal_window(app.handle());
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            translate,
            get_languages,
            get_settings,
            save_settings,
            hide_window,
            get_autostart,
            set_autostart,
            get_accessibility,
            request_accessibility,
            get_hotkey,
            set_hotkey
        ])
        .build(tauri::generate_context!())
        .expect("error while running Slovo")
        .run(|_app, _event| {
            // macOS: clicking the Dock icon (Reopen) should re-summon the popup.
            // `RunEvent::Reopen` only exists on macOS, so gate it to keep the
            // Linux dev/CI build (which has no such variant) compiling.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = _event {
                reveal_window(_app);
            }
        });
}
