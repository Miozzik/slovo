#!/usr/bin/env bash
# =============================================================================
# test_slovo.sh — functional test harness for "Slovo" (Tauri v2 macOS popup
# translator backed by the DeepL API).
#
# Runs every check that can be validated programmatically and prints a clear
# PASS / FAIL / SKIP report plus a final summary, so the developer never has to
# re-describe the test plan by hand.
#
# Runs ON macOS (the host). Rust toolchain checks are delegated to the OrbStack
# Linux VM (`orb -m rust-dev`) to avoid cluttering the Mac with build artefacts.
#
# Usage:   ./scripts/test_slovo.sh
# Exit:    0 if all non-skipped automated checks pass, 1 otherwise.
# Deps:    bash, curl; jq preferred for JSON, python3 fallback, grep last resort.
# =============================================================================
set -uo pipefail

# --- colours / emoji --------------------------------------------------------
if [[ -t 1 ]]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GRN=$'\033[32m'
  YLW=$'\033[33m'; CYN=$'\033[36m'; RST=$'\033[0m'
else
  BOLD=""; DIM=""; RED=""; GRN=""; YLW=""; CYN=""; RST=""
fi

PASS_CT=0; FAIL_CT=0; SKIP_CT=0
pass() { printf "  ${GRN}✅ PASS${RST}  %s\n" "$1"; PASS_CT=$((PASS_CT+1)); }
fail() { printf "  ${RED}❌ FAIL${RST}  %s\n" "$1"; FAIL_CT=$((FAIL_CT+1)); }
skip() { printf "  ${YLW}⚠️  SKIP${RST}  %s\n" "$1"; SKIP_CT=$((SKIP_CT+1)); }
warn() { printf "  ${YLW}⚠️${RST}      %s\n" "$1"; }
head() { printf "\n${BOLD}${CYN}%s${RST}\n" "$1"; }

# --- constants (mirror src-tauri/src/{translate,config}.rs) -----------------
ORB_PROJECT="cd ~/projects/slovo/src-tauri"
CONFIG_FILE="$HOME/Library/Application Support/slovo/config.json"
BUNDLE_DEBUG="/Users/miozz/Library/Caches/slovo-target-macos/debug/bundle/macos/Slovo.app"
BUNDLE_RELEASE="/Users/miozz/Library/Caches/slovo-target-macos/release/bundle/macos/Slovo.app"

# --- JSON helper: prefer jq, fall back to python3 ---------------------------
HAVE_JQ=0; HAVE_PY=0
command -v jq      >/dev/null 2>&1 && HAVE_JQ=1
command -v python3 >/dev/null 2>&1 && HAVE_PY=1

# json_get <json-string> <jq-filter> <python-expr>
# python-expr receives the parsed object as `d`; must print the value.
json_get() {
  local json="$1" jqf="$2" pyf="$3"
  if [[ $HAVE_JQ -eq 1 ]]; then
    printf '%s' "$json" | jq -r "$jqf" 2>/dev/null
  elif [[ $HAVE_PY -eq 1 ]]; then
    printf '%s' "$json" | python3 -c "import sys,json
try:
  d=json.load(sys.stdin); print($pyf)
except Exception: print('')" 2>/dev/null
  else
    printf ''   # caller falls back to grep
  fi
}

printf "${BOLD}🌍 Slovo functional test harness${RST}  ${DIM}(%s)${RST}\n" "$(date '+%Y-%m-%d %H:%M:%S')"

# =============================================================================
head "Automated checks"

# --- 1. Rust unit tests -----------------------------------------------------
if command -v orb >/dev/null 2>&1; then
  OUT=$(orb -m rust-dev bash -lc "$ORB_PROJECT && cargo test 2>&1")
  if grep -q "test result: ok" <<<"$OUT"; then
    NTESTS=$(grep -oE '[0-9]+ passed' <<<"$OUT" | head -1)
    pass "Rust unit tests (translate.rs): ${NTESTS:-ok}"
  else
    fail "Rust unit tests: no 'test result: ok' (run: orb -m rust-dev cargo test)"
  fi
else
  skip "Rust unit tests: 'orb' not found on PATH"
fi

# --- 2. Cargo check (compiles) ----------------------------------------------
if command -v orb >/dev/null 2>&1; then
  if orb -m rust-dev bash -lc "$ORB_PROJECT && cargo check 2>&1" >/dev/null 2>&1; then
    pass "Cargo check: project compiles (exit 0)"
  else
    fail "Cargo check: compilation failed"
  fi
else
  skip "Cargo check: 'orb' not found on PATH"
fi

# --- 3. API key present -----------------------------------------------------
API_KEY=""
if [[ -f "$CONFIG_FILE" ]]; then
  CFG=$(cat "$CONFIG_FILE")
  API_KEY=$(json_get "$CFG" '.api_key // ""' "d.get('api_key') or ''")
  if [[ -z "$API_KEY" && $HAVE_JQ -eq 0 && $HAVE_PY -eq 0 ]]; then
    # last-resort grep: pull the api_key string value
    API_KEY=$(grep -oE '"api_key"[[:space:]]*:[[:space:]]*"[^"]*"' <<<"$CFG" | sed -E 's/.*"api_key"[^"]*"([^"]*)".*/\1/')
  fi
fi
if [[ -n "$API_KEY" ]]; then
  LEN=${#API_KEY}; TAIL=${API_KEY: -3}
  pass "API key present (len=${LEN}, ends …${TAIL})"
else
  fail "API key missing/empty in $CONFIG_FILE"
fi

# Pick DeepL host from the key suffix (free keys end with :fx) — mirrors Rust.
if [[ "$API_KEY" == *:fx ]]; then HOST="https://api-free.deepl.com"; else HOST="https://api.deepl.com"; fi

# --- 4. DeepL translate works -----------------------------------------------
if [[ -n "$API_KEY" ]]; then
  RESP=$(curl -sS -m 20 -w $'\n%{http_code}' -X POST "$HOST/v2/translate" \
    -H "Authorization: DeepL-Auth-Key $API_KEY" \
    --data-urlencode "text=Hello world" --data-urlencode "target_lang=UK" 2>/dev/null)
  CODE="${RESP##*$'\n'}"; BODY="${RESP%$'\n'*}"
  TXT=$(json_get "$BODY" '.translations[0].text // ""' "d['translations'][0]['text']")
  if [[ "$CODE" == "200" && -n "$TXT" ]]; then
    pass "DeepL translate (HTTP 200): 'Hello world' → '${TXT}'"
  else
    fail "DeepL translate failed (HTTP ${CODE:-?}): ${BODY:0:120}"
  fi
else
  skip "DeepL translate: no API key to test with"
fi

# --- 5. DeepL languages work ------------------------------------------------
if [[ -n "$API_KEY" ]]; then
  lang_count() { # <type> -> echoes "HTTP_CODE COUNT"
    local r c b n
    r=$(curl -sS -m 20 -w $'\n%{http_code}' -X GET "$HOST/v2/languages?type=$1" \
      -H "Authorization: DeepL-Auth-Key $API_KEY" 2>/dev/null)
    c="${r##*$'\n'}"; b="${r%$'\n'*}"
    n=$(json_get "$b" 'length' "len(d)")
    [[ -z "$n" ]] && n=$(grep -oc '"language"' <<<"$b")
    printf '%s %s' "$c" "${n:-0}"
  }
  read -r SC SN < <(lang_count source)
  read -r TC TN < <(lang_count target)
  if [[ "$SC" == "200" && "$TC" == "200" && "${SN:-0}" -gt 0 && "${TN:-0}" -gt 0 ]]; then
    pass "DeepL languages: source=${SN}, target=${TN} (both HTTP 200)"
  else
    fail "DeepL languages failed (source HTTP ${SC}/n=${SN}, target HTTP ${TC}/n=${TN})"
  fi
else
  skip "DeepL languages: no API key to test with"
fi

# --- 6. App bundle exists ---------------------------------------------------
APP_PATH=""
if [[ -d "$BUNDLE_DEBUG" ]]; then APP_PATH="$BUNDLE_DEBUG"
elif [[ -d "$BUNDLE_RELEASE" ]]; then APP_PATH="$BUNDLE_RELEASE"; fi
if [[ -n "$APP_PATH" ]]; then
  pass "App bundle exists: $APP_PATH"
else
  fail "App bundle not found (build with: orb -m rust-dev cargo tauri build --debug)"
fi

# --- 7. App process running -------------------------------------------------
if pgrep -f "Slovo.app/Contents/MacOS/slovo" >/dev/null 2>&1; then
  pass "App process running (slovo)"
else
  warn "App not running — not fatal. Launch with: open '${APP_PATH:-$BUNDLE_DEBUG}'"
fi

# --- 8. Accessibility hint (cannot be read programmatically under SIP) -------
warn "Accessibility: ⌘⇧T text-capture needs Slovo granted in"
warn "  System Settings → Privacy & Security → Accessibility (verify manually)."

# =============================================================================
head "Manual GUI checklist (cannot be automated reliably)"
cat <<'EOF'
  [ ] Window has NO dark substrate (clean transparent popup, no grey box)
  [ ] Typing auto-translates after ~0.5s debounce (no button press needed)
  [ ] ⌘⇧T captures the current selection and translates it
  [ ] Source/target language dropdowns are populated from DeepL
  [ ] Cmd+Tab reaches the Slovo app (it appears in the app switcher)
EOF

# =============================================================================
head "Summary"
printf "  ${GRN}%d passed${RST}, ${RED}%d failed${RST}, ${YLW}%d skipped${RST}\n" \
  "$PASS_CT" "$FAIL_CT" "$SKIP_CT"

if [[ $FAIL_CT -eq 0 ]]; then
  printf "  ${BOLD}${GRN}✅ ALL AUTOMATED CHECKS PASSED${RST}\n\n"
  exit 0
else
  printf "  ${BOLD}${RED}❌ %d CHECK(S) FAILED${RST}\n\n" "$FAIL_CT"
  exit 1
fi
