// =========================================================================
// Slovo — frontend logic
// Vanilla ES, no build step. Talks to the Tauri v2 backend via the injected
// global `window.__TAURI__`. Degrades gracefully in a plain browser.
// =========================================================================

"use strict";

// ---------------------------------------------------------------------------
// Language table: label -> DeepL source code -> DeepL target code.
// `auto` is selectable only as a source. Languages without a distinct target
// code reuse their source code.
//
// This hardcoded list is the OFFLINE FALLBACK only. At runtime the dropdowns
// are (re)built from DeepL's live `get_languages` command (see loadLanguages),
// and the result is cached in localStorage for instant population next launch.
// ---------------------------------------------------------------------------
const LANGS = [
  { label: "Auto",      src: "auto", tgt: null   },
  { label: "English",   src: "EN",   tgt: "EN-US" },
  { label: "Ukrainian", src: "UK",   tgt: "UK"    },
  { label: "Russian",   src: "RU",   tgt: "RU"    },
  { label: "German",    src: "DE",   tgt: "DE"    },
  { label: "Polish",    src: "PL",   tgt: "PL"    },
  { label: "Spanish",   src: "ES",   tgt: "ES"    },
  { label: "French",    src: "FR",   tgt: "FR"    },
  { label: "Italian",   src: "IT",   tgt: "IT"    },
];

const STORAGE_SRC = "slovo.sourceLang";
const STORAGE_TGT = "slovo.targetLang";
const STORAGE_LANGS = "slovo.languages"; // cached { source:[…], target:[…] }

const DEBOUNCE_MS = 550;

// ---------------------------------------------------------------------------
// Tauri bridge — safe wrappers so the page never throws in a plain browser.
// ---------------------------------------------------------------------------
const TAURI = typeof window !== "undefined" ? window.__TAURI__ : undefined;

async function invoke(cmd, args) {
  if (!TAURI?.core?.invoke) {
    console.info(`[slovo] (no Tauri) invoke('${cmd}')`, args || "");
    return undefined; // no-op outside the desktop app
  }
  return TAURI.core.invoke(cmd, args);
}

function listen(event, handler) {
  if (!TAURI?.event?.listen) {
    console.info(`[slovo] (no Tauri) listen('${event}') skipped`);
    return;
  }
  TAURI.event.listen(event, handler);
}

// ---------------------------------------------------------------------------
// Window sizing — the window hugs its content. We measure the .window element's
// natural height and resize the OS window to match, so there is never empty
// translucent space below the UI. A ResizeObserver keeps it synced as content
// changes (typing grows the result box, opening settings adds the panel, etc.).
// No-ops cleanly when Tauri is absent (plain browser).
// ---------------------------------------------------------------------------
const WIN_WIDTH = 440;

function fitWindow() {
  const win = TAURI?.window;
  if (!win?.getCurrentWindow || !win?.LogicalSize) return; // plain browser → no-op
  const el = document.querySelector(".window");
  if (!el) return;
  const h = Math.ceil(el.getBoundingClientRect().height);
  if (h < 80) return; // ignore transient zero/early-layout measurements
  try {
    win.getCurrentWindow().setSize(new win.LogicalSize(WIN_WIDTH, h)).catch(() => {});
  } catch (err) {
    console.info("[slovo] setSize failed:", err);
  }
}

// Re-fit on the next animation frame (coalesces bursts of layout changes).
let fitScheduled = false;
function scheduleFit() {
  if (fitScheduled) return;
  fitScheduled = true;
  requestAnimationFrame(() => {
    fitScheduled = false;
    fitWindow();
  });
}

// Watch the content box; any height change → resync the OS window. Because
// .window is content-sized (not viewport-sized), resizing the OS window does
// NOT feed back into its height, so there is no resize loop.
function observeWindowSize() {
  const el = document.querySelector(".window");
  if (!el || typeof ResizeObserver === "undefined") return;
  new ResizeObserver(scheduleFit).observe(el);
}

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const els = {
  source:       $("sourceText"),
  result:       $("result"),
  sourceLang:   $("sourceLang"),
  targetLang:   $("targetLang"),
  swap:         $("swapBtn"),
  translate:    $("translateBtn"),
  settingsBtn:  $("settingsBtn"),
  settings:     $("settingsPanel"),
  apiKey:       $("apiKey"),
  saveSettings: $("saveSettingsBtn"),
  autostart:    $("autostartToggle"),
  keyStatus:    $("keyStatus"),
  accessStatus: $("accessStatus"),
  grantAccess:  $("grantAccessBtn"),
  hotkeyRecorder: $("hotkeyRecorder"),
  hotkeyReset:    $("hotkeyReset"),
  hotkeyError:    $("hotkeyError"),
};

// Platform default global hotkey (macOS ⌘⇧T) in global-hotkey accelerator form.
const DEFAULT_HOTKEY = "super+shift+KeyT";

// Last detected source language (DeepL code), used by Swap when source = Auto.
let lastDetectedSource = null;
let inFlight = false;

// Live language lists, as { source: [{code,name}], target: [{code,name}] }.
// Populated from cache → live DeepL → hardcoded fallback. Used by swap mapping.
let langLists = null;

// Debounce timer for auto-translate-on-type.
let typeTimer = null;

// Monotonic request id: only the newest in-flight translation may apply its
// result, so a fast typist never sees a stale older result overwrite a newer.
let requestSeq = 0;

// Tuple of the last successfully *issued* translation, to skip duplicates.
let lastRequest = { text: null, source: null, target: null };

// ---------------------------------------------------------------------------
// Language lists — shape & normalization
// ---------------------------------------------------------------------------
// DeepL's `get_languages` resolves to { source:[{code,name}], target:[{code,name}] }.
// Source codes look like "EN","UK","DE"; target codes like "EN-US","UK","DE".
// We normalize everything into that same { source, target } shape regardless of
// origin (live response, localStorage cache, or the hardcoded LANGS fallback).
function langsFromFallback() {
  return {
    source: LANGS.filter((l) => l.src !== "auto").map((l) => ({ code: l.src, name: l.label })),
    target: LANGS.filter((l) => l.tgt !== null).map((l) => ({ code: l.tgt, name: l.label })),
  };
}

// Defensive normalizer for whatever `get_languages` (or the cache) hands back.
function normalizeLangs(raw) {
  const pick = (arr) =>
    Array.isArray(arr)
      ? arr
          .filter((x) => x && typeof x.code === "string" && x.code)
          .map((x) => ({ code: x.code, name: String(x.name || x.code) }))
      : [];
  const source = pick(raw?.source);
  const target = pick(raw?.target);
  if (!source.length || !target.length) return null; // unusable
  return { source, target };
}

// ---------------------------------------------------------------------------
// Dropdown construction
// ---------------------------------------------------------------------------
// Rebuild both dropdowns from a normalized { source, target } list, preserving
// the current/persisted selection across rebuilds.
function buildDropdownsFrom(lists) {
  langLists = lists;

  // Remember what was selected so we can restore it after rebuilding.
  const prevSrc = els.sourceLang.value || localStorage.getItem(STORAGE_SRC) || "auto";
  const prevTgt = els.targetLang.value || localStorage.getItem(STORAGE_TGT) || "UK";

  els.sourceLang.replaceChildren();
  els.targetLang.replaceChildren();

  // Source: prepend an "Auto" option, then the live source languages.
  els.sourceLang.appendChild(new Option("Auto", "auto"));
  for (const l of lists.source) {
    els.sourceLang.appendChild(new Option(l.name, l.code));
  }
  // Target: the live target languages (no Auto).
  for (const l of lists.target) {
    els.targetLang.appendChild(new Option(l.name, l.code));
  }

  // Restore selection, falling back to defaults (Auto / Ukrainian).
  setSelectValue(els.sourceLang, prevSrc, "auto");
  setSelectValue(els.targetLang, prevTgt, "UK");
}

// Set a <select> to `value` if present, else to `fallback` if present, else
// leave the first option selected. Case-insensitive code match.
function setSelectValue(select, value, fallback) {
  const opt = (v) => [...select.options].find((o) => o.value.toUpperCase() === String(v).toUpperCase());
  const chosen = opt(value) || opt(fallback);
  if (chosen) select.value = chosen.value;
}

function persistLangs() {
  localStorage.setItem(STORAGE_SRC, els.sourceLang.value);
  localStorage.setItem(STORAGE_TGT, els.targetLang.value);
}

// ---------------------------------------------------------------------------
// Load DeepL's supported languages, (re)build dropdowns, cache the result.
// Order of precedence on boot: cache (instant) → live DeepL → hardcoded.
// Called again after the API key is saved so the lists can fill in.
// ---------------------------------------------------------------------------
async function loadLanguages() {
  try {
    const raw = await invoke("get_languages");
    const lists = normalizeLangs(raw);
    if (lists) {
      localStorage.setItem(STORAGE_LANGS, JSON.stringify(lists));
      buildDropdownsFrom(lists);
      return;
    }
    // Live call returned something unusable — keep whatever is shown.
  } catch (err) {
    // Rejects with a string when there's no key / no network. Fall back to
    // cache if present; otherwise the hardcoded list already populated on boot.
    console.info("[slovo] get_languages unavailable:", err);
    const cached = readCachedLangs();
    if (cached && !langLists) buildDropdownsFrom(cached);
  }
}

function readCachedLangs() {
  try {
    return normalizeLangs(JSON.parse(localStorage.getItem(STORAGE_LANGS) || "null"));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Result rendering helpers
// ---------------------------------------------------------------------------
function setResult(text) {
  els.result.className = "text-area result";
  els.result.textContent = text;
  els.result.dataset.empty = text ? "false" : "true";
}

// Inline SVG markup (no build step → icons live as strings the JS can inject).
const SPINNER_SVG =
  '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M10 2.5v3"/><path d="M10 14.5v3"/><path d="M17.5 10h-3"/><path d="M5.5 10h-3"/>' +
  '<path d="M15.3 4.7l-2.1 2.1"/><path d="M6.8 13.2l-2.1 2.1"/><path d="M15.3 15.3l-2.1-2.1"/><path d="M6.8 6.8L4.7 4.7"/>' +
  "</svg>";
const ERROR_SVG =
  '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M10 3L2.5 16.5h15z"/><path d="M10 8v3.5"/><path d="M10 14h.01"/>' +
  "</svg>";

function setLoading() {
  els.result.className = "text-area result loading";
  els.result.dataset.empty = "false";
  els.result.innerHTML = '<span class="spinner">' + SPINNER_SVG + "</span>Translating&hellip;";
}

function setError(message) {
  els.result.className = "text-area result error";
  els.result.dataset.empty = "false";
  // Build with a text node so the message can never be interpreted as HTML.
  els.result.innerHTML = '<span class="result-glyph">' + ERROR_SVG + "</span>";
  els.result.appendChild(document.createTextNode(message));
}

function setBusy(busy) {
  inFlight = busy;
  els.translate.disabled = busy;
}

// ---------------------------------------------------------------------------
// Auto-translate scheduling
// ---------------------------------------------------------------------------
// Debounced trigger used while the user types: fires ~550ms after they stop.
function scheduleTranslate() {
  clearTimeout(typeTimer);
  const text = els.source.value.trim();
  if (!text) {
    setResult(""); // cleared the box → clear the result, nothing pending
    lastRequest = { text: null, source: null, target: null };
    return;
  }
  typeTimer = setTimeout(() => translate(), DEBOUNCE_MS);
}

// Fire immediately (used by events, language changes, and the manual button).
function translateNow() {
  clearTimeout(typeTimer);
  translate();
}

// ---------------------------------------------------------------------------
// Translation
// ---------------------------------------------------------------------------
async function translate() {
  const text = els.source.value.trim();
  if (!text) {
    setResult("");
    lastRequest = { text: null, source: null, target: null };
    return;
  }

  const source = els.sourceLang.value;     // "auto" or a DeepL source code
  const target = els.targetLang.value;     // a DeepL target code

  // Skip if this exact (text, source, target) was already the last request.
  if (text === lastRequest.text && source === lastRequest.source && target === lastRequest.target) {
    return;
  }
  lastRequest = { text, source, target };

  // Tag this request; only the newest may apply its result.
  const reqId = ++requestSeq;

  setBusy(true);
  setLoading();

  try {
    const res = await invoke("translate", { text, source, target });
    if (reqId !== requestSeq) return; // a newer request superseded us — drop result
    if (res && typeof res.text === "string") {
      lastDetectedSource = res.detectedSource || lastDetectedSource;
      setResult(res.text);
    } else {
      // No Tauri (browser preview) or empty response.
      setResult("");
    }
  } catch (err) {
    if (reqId !== requestSeq) return; // stale failure — ignore
    // Backend rejects with a string message — show it, don't crash.
    const msg = typeof err === "string" ? err : err?.message || "Translation failed.";
    setError(msg);
    lastRequest = { text: null, source: null, target: null }; // allow retry
  } finally {
    if (reqId === requestSeq) setBusy(false);
  }
}

// ---------------------------------------------------------------------------
// Swap languages (and the texts).
// ---------------------------------------------------------------------------
function swapLanguages() {
  let srcVal = els.sourceLang.value;

  // If source is Auto, resolve it to a concrete language: prefer the last
  // detected source, otherwise fall back to English.
  if (srcVal === "auto") {
    srcVal = lastDetectedSource ? lastDetectedSource.toUpperCase() : "EN";
  }

  const tgtVal = els.targetLang.value; // a DeepL target code

  // Map the current target code to an equivalent SOURCE code for the source
  // dropdown, and the resolved source code to an equivalent TARGET code.
  const newSourceCode = targetCodeToSource(tgtVal);
  const newTargetCode = sourceCodeToTarget(srcVal);

  if (hasOption(els.sourceLang, newSourceCode)) els.sourceLang.value = newSourceCode;
  if (hasOption(els.targetLang, newTargetCode)) els.targetLang.value = newTargetCode;

  // Swap the visible texts: the prior translation becomes the new source.
  const resultText = els.result.classList.contains("error") ? "" : els.result.textContent;
  els.source.value = resultText || "";
  setResult("");
  persistLangs();
  // Re-translate in the new direction if there is now source text.
  if (els.source.value.trim()) translateNow();
}

// Map a TARGET code (e.g. "EN-US") to its best SOURCE code (e.g. "EN").
// DeepL target codes can carry a region suffix that source codes don't, so we
// match on the base code; fall back to the raw value if no match is found.
function targetCodeToSource(tgtCode) {
  const base = String(tgtCode).split("-")[0].toUpperCase();
  const src = (langLists?.source || []).find((l) => l.code.toUpperCase() === base);
  return src ? src.code : tgtCode;
}
// Map a SOURCE code (e.g. "EN") to its best TARGET code (e.g. "EN-US"). Prefer
// an exact match, then a region variant of the same base, else the raw value.
function sourceCodeToTarget(srcCode) {
  const code = String(srcCode).toUpperCase();
  const targets = langLists?.target || [];
  const exact = targets.find((l) => l.code.toUpperCase() === code);
  if (exact) return exact.code;
  const variant = targets.find((l) => l.code.toUpperCase().split("-")[0] === code);
  return variant ? variant.code : srcCode;
}
function hasOption(select, value) {
  return [...select.options].some((o) => o.value.toUpperCase() === String(value).toUpperCase());
}

// ---------------------------------------------------------------------------
// Settings panel
// ---------------------------------------------------------------------------
function openSettings(focus = true) {
  els.settings.hidden = false;
  scheduleFit();                // grow the window to fit the settings panel
  loadAutostart();              // reflect the current launch-at-login state
  refreshStatuses();            // refresh key + accessibility status badges
  loadHotkey();                 // render the current global hotkey as symbols
  if (focus) els.apiKey.focus();
}
function closeSettings() {
  els.settings.hidden = true;
  stopRecording();              // never leave the recorder listening when hidden
  scheduleFit();                // shrink back to fit the compact UI
}
function toggleSettings() {
  els.settings.hidden ? openSettings() : closeSettings();
}

// ---------------------------------------------------------------------------
// Launch at login (autostart) toggle
// ---------------------------------------------------------------------------
// Reflect the backend's current autostart state on the toggle.
async function loadAutostart() {
  if (!els.autostart) return;
  try {
    const enabled = await invoke("get_autostart");
    els.autostart.checked = enabled === true;
  } catch (err) {
    console.info("[slovo] get_autostart unavailable:", err);
  }
}

// On change, push the new state to the backend; revert + flag on failure.
async function onAutostartChange() {
  const enabled = els.autostart.checked;
  els.autostart.disabled = true;
  els.settings.querySelector(".toggle-row")?.classList.remove("error");
  try {
    await invoke("set_autostart", { enabled });
  } catch (err) {
    console.info("[slovo] set_autostart failed:", err);
    els.autostart.checked = !enabled; // revert the visible state
    els.settings.querySelector(".toggle-row")?.classList.add("error");
  } finally {
    els.autostart.disabled = false;
  }
}

async function saveSettings() {
  const apiKey = els.apiKey.value.trim();
  try {
    await invoke("save_settings", { apiKey });
    els.apiKey.value = "";
    closeSettings();
    await checkSettings();   // re-check; reopens if key still missing
    await loadLanguages();   // a fresh key may unlock DeepL's live language list
    refreshStatuses();       // the key status badge may have changed
  } catch (err) {
    const msg = typeof err === "string" ? err : err?.message || "Could not save settings.";
    setError(msg);
  }
}

// On load, ask the backend whether a key exists; if not, prompt for one.
async function checkSettings() {
  try {
    const res = await invoke("get_settings");
    if (res && res.hasKey === false) {
      openSettings(true);
    }
  } catch (err) {
    console.warn("[slovo] get_settings failed:", err);
  }
}

// ---------------------------------------------------------------------------
// Status indicators (DeepL key + macOS Accessibility permission)
// ---------------------------------------------------------------------------
// Apply an "ok" (green) / "warn" (muted/red) state + label to a badge element.
function setBadge(el, ok, label) {
  if (!el) return;
  el.classList.toggle("ok", ok);
  el.classList.toggle("warn", !ok);
  el.textContent = label;
}

// Reflect whether a DeepL key is stored. Source: get_settings → { hasKey }.
async function refreshKeyStatus() {
  let hasKey = false;
  try {
    const res = await invoke("get_settings");
    hasKey = res?.hasKey === true;
  } catch (err) {
    console.info("[slovo] get_settings unavailable:", err);
  }
  setBadge(els.keyStatus, hasKey, hasKey ? "Connected" : "Not set");
}

// Reflect the macOS Accessibility permission (silent check — no system prompt).
// Source: get_accessibility → boolean. Shows the Grant button only when missing.
async function refreshAccessStatus() {
  let granted = false;
  try {
    granted = (await invoke("get_accessibility")) === true;
  } catch (err) {
    console.info("[slovo] get_accessibility unavailable:", err);
  }
  setBadge(els.accessStatus, granted, granted ? "Granted ✓" : "Not granted");
  if (els.grantAccess) els.grantAccess.hidden = granted;
}

// Refresh both badges. Called when settings opens, after saving, after a Grant
// request, and when the window regains focus.
function refreshStatuses() {
  refreshKeyStatus();
  refreshAccessStatus();
}

// Grant button: trigger the macOS system prompt, then re-check. The user
// actually grants the permission in System Settings, so we re-poll after a
// short delay (and a focus handler re-checks when they return to the app).
async function onGrantAccess() {
  if (els.grantAccess) els.grantAccess.disabled = true;
  try {
    await invoke("request_accessibility");
  } catch (err) {
    console.info("[slovo] request_accessibility failed:", err);
  } finally {
    if (els.grantAccess) els.grantAccess.disabled = false;
  }
  // The permission may flip a moment later (or after a System Settings round
  // trip); re-check shortly. The window 'focus' handler covers the rest.
  setTimeout(refreshAccessStatus, 800);
}

// ---------------------------------------------------------------------------
// Global hotkey recorder
// ---------------------------------------------------------------------------
// Lifecycle: on settings open we fetch the current accelerator and render it as
// friendly Apple symbols. Clicking the pill enters "recording" mode and captures
// the next real key combo, validates it has a modifier, and saves it via the
// set_hotkey backend command (which rejects invalid combos and keeps the old one).

// The accelerator currently shown/active, e.g. "super+shift+KeyT". Used to revert
// the display if recording is cancelled or a save is rejected.
let currentHotkey = DEFAULT_HOTKEY;

// True while we're listening for a key combo (one-shot keydown attached).
let recording = false;

// Timer for the brief inline error/validation message.
let hotkeyErrorTimer = null;

// Modifier-symbol map (case-insensitive). Order of OUTPUT is fixed below.
const MOD_SYMBOLS = {
  control: "⌃", ctrl: "⌃",          // ⌃
  alt: "⌥", option: "⌥",            // ⌥
  shift: "⇧",                            // ⇧
  super: "⌘", meta: "⌘", command: "⌘", cmd: "⌘", // ⌘
};
// Apple convention orders modifier symbols ⌃⌥⇧⌘.
const MOD_ORDER = ["⌃", "⌥", "⇧", "⌘"];

// Named key codes → display glyphs. Letters/digits are handled procedurally.
const KEY_SYMBOLS = {
  Space: "Space",
  ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→",
  Enter: "↵", Escape: "⎋",
  Comma: ",", Period: ".", Slash: "/", Minus: "-", Equal: "=",
};

// Map a single key-code token to its friendly display form.
function formatKeyToken(token) {
  if (/^Key[A-Z]$/.test(token)) return token.slice(3);            // KeyT → T
  if (/^Digit[0-9]$/.test(token)) return token.slice(5);          // Digit1 → 1
  if (Object.prototype.hasOwnProperty.call(KEY_SYMBOLS, token)) return KEY_SYMBOLS[token];
  return token; // unknown → show as-is (robust to new codes)
}

// Convert an accelerator string ("super+shift+KeyT") to friendly symbols
// ("⇧⌘T"). Modifiers are emitted in ⌃⌥⇧⌘ order, then the key, no separators.
function formatHotkey(accel) {
  if (!accel || typeof accel !== "string") return "…"; // … placeholder
  const mods = [];
  const keys = [];
  for (const raw of accel.split("+")) {
    const token = raw.trim();
    if (!token) continue;
    const sym = MOD_SYMBOLS[token.toLowerCase()];
    if (sym) mods.push(sym);
    else keys.push(formatKeyToken(token));
  }
  const orderedMods = MOD_ORDER.filter((s) => mods.includes(s));
  return orderedMods.join("") + keys.join("");
}

// Render an accelerator into the recorder pill (or a placeholder when empty).
function renderHotkey(accel) {
  if (!els.hotkeyRecorder) return;
  els.hotkeyRecorder.textContent = formatHotkey(accel);
}

// Briefly flash an inline message beside the recorder, then clear it.
function showHotkeyError(message) {
  if (!els.hotkeyError) return;
  clearTimeout(hotkeyErrorTimer);
  els.hotkeyError.textContent = message;
  els.hotkeyError.hidden = false;
  hotkeyErrorTimer = setTimeout(() => {
    els.hotkeyError.hidden = true;
    els.hotkeyError.textContent = "";
  }, 2600);
}

// Fetch the current accelerator from the backend and render it. Called on open.
async function loadHotkey() {
  if (!els.hotkeyRecorder) return;
  try {
    const accel = await invoke("get_hotkey");
    if (typeof accel === "string" && accel) {
      currentHotkey = accel;
    }
  } catch (err) {
    console.info("[slovo] get_hotkey unavailable:", err);
  }
  renderHotkey(currentHotkey);
}

// Leave recording mode: drop the listener, clear the visual state, restore text.
function stopRecording() {
  if (!recording) return;
  recording = false;
  els.hotkeyRecorder.classList.remove("recording");
  document.removeEventListener("keydown", onHotkeyKeydown, true);
  renderHotkey(currentHotkey);
}

// One-shot-ish keydown handler while recording (capture phase so nothing else
// reacts to the combo). Ignores lone modifiers, cancels on Escape, and on a
// real key builds + saves the accelerator.
async function onHotkeyKeydown(e) {
  e.preventDefault();
  e.stopPropagation();

  // Cancel cleanly on Escape — restore the previous display, no change.
  if (e.key === "Escape") {
    stopRecording();
    return;
  }

  // Ignore pure modifier presses — keep waiting for a real key.
  const MODIFIER_KEYS = new Set(["Shift", "Meta", "Control", "Alt"]);
  if (MODIFIER_KEYS.has(e.key)) return;

  // Collect active modifiers in the backend's expected order.
  const mods = [];
  if (e.ctrlKey) mods.push("control");
  if (e.altKey) mods.push("alt");
  if (e.shiftKey) mods.push("shift");
  if (e.metaKey) mods.push("super");

  // Require at least one modifier; otherwise the global shortcut would be far
  // too greedy. Keep recording so the user can add one.
  if (mods.length === 0) {
    showHotkeyError("Add a modifier (⌘/⌥/⌃/⇧)"); // ⌘/⌥/⌃/⇧
    return;
  }

  const shortcut = [...mods, e.code].join("+"); // e.g. "super+shift+KeyT"

  // Stop listening before the async save so a second keypress can't double-fire.
  recording = false;
  els.hotkeyRecorder.classList.remove("recording");
  document.removeEventListener("keydown", onHotkeyKeydown, true);

  try {
    await invoke("set_hotkey", { shortcut });
    currentHotkey = shortcut;        // commit on success
    renderHotkey(currentHotkey);
  } catch (err) {
    // Backend rejected (invalid accelerator); old hotkey stays active.
    const msg = typeof err === "string" ? err : err?.message || "Invalid shortcut.";
    showHotkeyError(msg);
    renderHotkey(currentHotkey);     // revert to the previous display
  }
}

// Enter recording mode on click: show the prompt, add the class, attach listener.
function startRecording() {
  if (!TAURI || recording || !els.hotkeyRecorder) return; // no-op without Tauri
  recording = true;
  clearTimeout(hotkeyErrorTimer);
  if (els.hotkeyError) els.hotkeyError.hidden = true;
  els.hotkeyRecorder.classList.add("recording");
  els.hotkeyRecorder.textContent = "Press keys…"; // "Press keys…"
  document.addEventListener("keydown", onHotkeyKeydown, true);
}

// Reset to the platform default and persist it through the backend.
async function resetHotkey() {
  if (!TAURI) return; // no-op without Tauri
  stopRecording();
  try {
    await invoke("set_hotkey", { shortcut: DEFAULT_HOTKEY });
    currentHotkey = DEFAULT_HOTKEY;
  } catch (err) {
    const msg = typeof err === "string" ? err : err?.message || "Could not reset shortcut.";
    showHotkeyError(msg);
  }
  renderHotkey(currentHotkey);
}

// ---------------------------------------------------------------------------
// Tauri events from Rust
// ---------------------------------------------------------------------------
function wireEvents() {
  // Text captured from the user's screen selection.
  listen("set-source", (e) => {
    const text = typeof e?.payload === "string" ? e.payload : "";
    els.source.value = text;
    if (text.trim()) {
      translateNow(); // auto-translate non-empty selections immediately
    } else {
      setResult("");
      els.source.focus();
    }
  });

  // Focus + select the source field.
  listen("focus-input", () => {
    els.source.focus();
    els.source.select();
  });
}

// ---------------------------------------------------------------------------
// DOM event wiring
// ---------------------------------------------------------------------------
function wireUI() {
  // Manual fallback — still works, but no longer the only way to translate.
  els.translate.addEventListener("click", translateNow);
  els.swap.addEventListener("click", swapLanguages);

  // Auto-translate as the user types (debounced).
  els.source.addEventListener("input", scheduleTranslate);

  // Changing a language persists it and re-translates immediately (if any text).
  const onLangChange = () => {
    persistLangs();
    if (els.source.value.trim()) translateNow();
  };
  els.sourceLang.addEventListener("change", onLangChange);
  els.targetLang.addEventListener("change", onLangChange);

  els.settingsBtn.addEventListener("click", toggleSettings);
  els.saveSettings.addEventListener("click", saveSettings);
  if (els.autostart) els.autostart.addEventListener("change", onAutostartChange);
  if (els.grantAccess) els.grantAccess.addEventListener("click", onGrantAccess);

  // Global hotkey recorder: click to record, Reset to restore the default.
  if (els.hotkeyRecorder) els.hotkeyRecorder.addEventListener("click", startRecording);
  if (els.hotkeyReset) els.hotkeyReset.addEventListener("click", resetHotkey);

  // Re-check statuses when the app regains focus — so granting Accessibility in
  // System Settings reflects without reopening. Only meaningful while settings
  // is open, so guard on that.
  window.addEventListener("focus", () => {
    if (!els.settings.hidden) refreshStatuses();
  });

  // Cmd/Ctrl+Enter in the source field forces an immediate translation.
  els.source.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      translateNow();
    }
  });

  // Enter saves the API key when the settings input is focused.
  els.apiKey.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      saveSettings();
    }
  });

  // Escape hides the window (or closes settings if it's open).
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!els.settings.hidden) {
      closeSettings();
    } else {
      invoke("hide_window");
    }
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
// The Tauri webview ignores `target="_blank"` (no popups), so external links do
// nothing on click. Route every http(s) link through the backend `open_url`
// command, which opens it in the system default browser.
function wireExternalLinks() {
  document.querySelectorAll('a[href^="http"]').forEach((a) => {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      invoke("open_url", { url: a.getAttribute("href") });
    });
  });
}

function init() {
  // Populate dropdowns instantly from cache (or hardcoded fallback) so the UI
  // is usable immediately, then refresh from DeepL's live list in the background.
  buildDropdownsFrom(readCachedLangs() || langsFromFallback());
  wireUI();
  wireEvents();
  wireExternalLinks();    // open external links in the system browser
  setResult("");          // start with empty/placeholder result
  observeWindowSize();    // keep the OS window synced to the content height
  scheduleFit();          // fit once on boot
  checkSettings();        // prompt for API key if none stored
  loadLanguages();        // (re)build from DeepL's live supported languages
  els.source.focus();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
