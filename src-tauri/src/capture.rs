//! Capture the user's current text selection from the foreground app.
//!
//! On macOS we simulate ⌘C and read the resulting clipboard contents. On every
//! other platform (notably the Linux CI VM) this compiles to a harmless stub
//! that returns an empty string.

/// A marker we place on the clipboard BEFORE pressing ⌘C. If it's still there
/// afterwards, the synthetic ⌘C did not actually copy anything (no selection,
/// or — more likely during setup — the Accessibility permission isn't effective).
#[cfg(target_os = "macos")]
const SENTINEL: &str = "\u{0000}SLOVO_CAPTURE_SENTINEL\u{0000}";

/// Capture the currently selected text. Returns an empty string if nothing
/// could be captured. Never panics.
#[cfg(target_os = "macos")]
pub fn capture_selection() -> String {
    use enigo::{
        Direction::{Click, Press, Release},
        Enigo, Key, Keyboard, Settings,
    };

    // macOS virtual keycode for the "C" key (kVK_ANSI_C). We send the raw
    // keycode rather than `Key::Unicode('c')`: enigo's Unicode path types the
    // character directly and IGNORES held modifiers, so `⌘ + Unicode('c')` does
    // NOT produce a real ⌘C. `Key::Other(8)` posts the physical C key.
    const KEYCODE_C: u16 = 8;

    // The global hotkey is ⌘⇧T. The user is very likely STILL holding ⌘ and ⇧
    // at this instant; if we inject C while they're held it becomes ⌘⇧C, not
    // ⌘C, and nothing is copied. Wait briefly for the physical modifiers to be
    // released before synthesizing the copy.
    std::thread::sleep(std::time::Duration::from_millis(250));

    // Best-effort: remember the existing clipboard so we can restore it after.
    let previous = arboard::Clipboard::new()
        .ok()
        .and_then(|mut cb| cb.get_text().ok());

    // Put a sentinel on the clipboard so we can tell whether ⌘C actually copied.
    if let Ok(mut cb) = arboard::Clipboard::new() {
        let _ = cb.set_text(SENTINEL.to_string());
    }

    let mut enigo = match Enigo::new(&Settings::default()) {
        Ok(e) => e,
        Err(_) => return String::new(),
    };

    // Press Cmd (Meta), pause so the modifier registers, tap the physical C key,
    // pause, release Cmd. The inter-key pauses matter: without them macOS often
    // drops the combo and ⌘C never fires.
    let _ = enigo.key(Key::Meta, Press);
    std::thread::sleep(std::time::Duration::from_millis(40));
    let _ = enigo.key(Key::Other(KEYCODE_C as u32), Click);
    std::thread::sleep(std::time::Duration::from_millis(40));
    let _ = enigo.key(Key::Meta, Release);

    // Give the foreground app time to populate the clipboard.
    std::thread::sleep(std::time::Duration::from_millis(200));

    let after = arboard::Clipboard::new()
        .ok()
        .and_then(|mut cb| cb.get_text().ok())
        .unwrap_or_default();

    // If the clipboard still holds the sentinel, the copy did not happen
    // (nothing was selected) — return empty rather than stale clipboard text.
    let copied = after != SENTINEL && !after.is_empty();
    let captured = if copied { after } else { String::new() };

    // Restore the user's original clipboard.
    if let Ok(mut cb) = arboard::Clipboard::new() {
        match &previous {
            Some(prev) => {
                let _ = cb.set_text(prev.clone());
            }
            None => {
                let _ = cb.set_text(String::new());
            }
        }
    }

    captured
}

/// Stub for non-macOS targets. Real selection capture is macOS-only; here we
/// simply return an empty string so the app still compiles and runs.
#[cfg(not(target_os = "macos"))]
pub fn capture_selection() -> String {
    String::new()
}
