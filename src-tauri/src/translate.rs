//! Pure DeepL translation client.
//!
//! This module is intentionally free of any Tauri or platform dependencies so
//! it can be unit-tested in isolation (the tests below never touch the network).

use serde::{Deserialize, Serialize};

/// DeepL "free" API endpoint (used when the key ends with `:fx`).
const ENDPOINT_FREE: &str = "https://api-free.deepl.com/v2/translate";
/// DeepL "pro" API endpoint.
const ENDPOINT_PRO: &str = "https://api.deepl.com/v2/translate";

/// Base host for the DeepL "free" tier.
const HOST_FREE: &str = "https://api-free.deepl.com";
/// Base host for the DeepL "pro" tier.
const HOST_PRO: &str = "https://api.deepl.com";

/// Result of a translation, exposed to the frontend as camelCase JSON
/// (`{ "text": "...", "detectedSource": "EN" }`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct TranslateResult {
    pub text: String,
    pub detected_source: String,
}

/// Shape of the DeepL JSON response we care about.
#[derive(Debug, Deserialize)]
struct DeepLResponse {
    translations: Vec<DeepLTranslation>,
}

#[derive(Debug, Deserialize)]
struct DeepLTranslation {
    #[serde(default)]
    detected_source_language: String,
    text: String,
}

/// Pick the correct endpoint based on the key suffix. Free keys end with `:fx`.
fn endpoint_for(api_key: &str) -> &'static str {
    if api_key.trim_end().ends_with(":fx") {
        ENDPOINT_FREE
    } else {
        ENDPOINT_PRO
    }
}

/// Pick the correct base host based on the key suffix. Free keys end with `:fx`.
fn host_for(api_key: &str) -> &'static str {
    if api_key.trim_end().ends_with(":fx") {
        HOST_FREE
    } else {
        HOST_PRO
    }
}

/// A single language option exposed to the frontend as `{ "code": "...", "name": "..." }`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Lang {
    pub code: String,
    pub name: String,
}

/// The set of source and target languages DeepL supports for this key.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct Languages {
    pub source: Vec<Lang>,
    pub target: Vec<Lang>,
}

/// Shape of a single DeepL `/languages` entry. We only need `language` + `name`
/// (the `supports_formality` field on target entries is ignored).
#[derive(Debug, Deserialize)]
struct DeepLLanguage {
    language: String,
    name: String,
}

impl From<DeepLLanguage> for Lang {
    fn from(d: DeepLLanguage) -> Self {
        Lang { code: d.language, name: d.name }
    }
}

/// Map a non-success HTTP status from the `/languages` endpoint to a friendly
/// message, mirroring the translate path.
fn languages_error(status: u16, body: String) -> String {
    match status {
        403 => "Invalid DeepL API key".to_string(),
        456 => "DeepL quota exceeded".to_string(),
        429 => "Too many requests to DeepL — please wait a moment".to_string(),
        code => format!("DeepL error {code}: {body}"),
    }
}

/// Fetch one set of languages (`type=source` or `type=target`) from DeepL.
async fn fetch_languages(
    client: &reqwest::Client,
    host: &str,
    api_key: &str,
    kind: &str,
) -> Result<Vec<Lang>, String> {
    let url = format!("{host}/v2/languages?type={kind}");
    let response = client
        .get(&url)
        .header("Authorization", format!("DeepL-Auth-Key {}", api_key))
        .send()
        .await
        .map_err(|e| format!("Network error contacting DeepL: {e}"))?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(languages_error(status.as_u16(), body));
    }

    let parsed: Vec<DeepLLanguage> = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse DeepL languages response: {e}"))?;

    Ok(parsed.into_iter().map(Lang::from).collect())
}

/// Fetch DeepL's supported source and target languages for the given key.
///
/// Both requests run concurrently via `tokio::join!` (tokio is available through
/// Tauri's runtime). Errors are mapped to the same friendly strings as the
/// translate path.
pub async fn deepl_languages(api_key: &str) -> Result<Languages, String> {
    let host = host_for(api_key);
    let client = reqwest::Client::new();

    let (source, target) = tokio::join!(
        fetch_languages(&client, host, api_key, "source"),
        fetch_languages(&client, host, api_key, "target"),
    );

    Ok(Languages { source: source?, target: target? })
}

/// Translate `text` from `source` to `target` using the DeepL API.
///
/// * `source` may be `"auto"` (any case) to let DeepL detect the language; in
///   that case no `source_lang` is sent.
/// * Empty/whitespace input short-circuits and returns an empty result without
///   making a network call.
pub async fn deepl_translate(
    api_key: &str,
    text: &str,
    source: &str,
    target: &str,
) -> Result<TranslateResult, String> {
    // Short-circuit: nothing to translate, don't waste an API call.
    if text.trim().is_empty() {
        return Ok(TranslateResult::default());
    }

    let endpoint = endpoint_for(api_key);

    // Build the form body. `target_lang` is always required; `source_lang` is
    // only sent when the user did not request auto-detection.
    let mut form: Vec<(&str, &str)> = vec![("text", text), ("target_lang", target)];
    if !source.eq_ignore_ascii_case("auto") {
        form.push(("source_lang", source));
    }

    let client = reqwest::Client::new();
    let response = client
        .post(endpoint)
        .header("Authorization", format!("DeepL-Auth-Key {}", api_key))
        .form(&form)
        .send()
        .await
        .map_err(|e| format!("Network error contacting DeepL: {e}"))?;

    let status = response.status();
    if !status.is_success() {
        // Map the most common DeepL error codes to friendly messages.
        let body = response.text().await.unwrap_or_default();
        let msg = match status.as_u16() {
            403 => "Invalid DeepL API key".to_string(),
            456 => "DeepL quota exceeded".to_string(),
            429 => "Too many requests to DeepL — please wait a moment".to_string(),
            code => format!("DeepL error {code}: {body}"),
        };
        return Err(msg);
    }

    let parsed: DeepLResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse DeepL response: {e}"))?;

    let first = parsed
        .translations
        .into_iter()
        .next()
        .ok_or_else(|| "DeepL returned no translations".to_string())?;

    Ok(TranslateResult {
        text: first.text,
        detected_source: first.detected_source_language,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn free_endpoint_chosen_for_fx_suffix() {
        assert_eq!(
            endpoint_for("00000000-0000-0000-0000-000000000000:fx"),
            ENDPOINT_FREE
        );
    }

    #[test]
    fn pro_endpoint_chosen_without_fx_suffix() {
        assert_eq!(
            endpoint_for("00000000-0000-0000-0000-000000000000"),
            ENDPOINT_PRO
        );
    }

    #[test]
    fn empty_input_short_circuits_without_network() {
        // tokio is not a dependency here, so drive the future with a tiny
        // hand-rolled block_on via futures? Instead we assert on the pure path
        // by using pollster-free manual polling. To keep deps minimal we test
        // the short-circuit through a blocking executor built from std.
        let result = block_on(deepl_translate("any-key", "   ", "auto", "EN"));
        assert_eq!(result, Ok(TranslateResult::default()));
    }

    /// Minimal single-threaded executor so the async short-circuit test does
    /// not require pulling in a full async runtime as a dev-dependency.
    fn block_on<F: std::future::Future>(mut fut: F) -> F::Output {
        use std::pin::Pin;
        use std::task::{Context, Poll, RawWaker, RawWakerVTable, Waker};

        fn noop(_: *const ()) {}
        fn clone(_: *const ()) -> RawWaker {
            RawWaker::new(std::ptr::null(), &VTABLE)
        }
        static VTABLE: RawWakerVTable = RawWakerVTable::new(clone, noop, noop, noop);

        let raw = RawWaker::new(std::ptr::null(), &VTABLE);
        let waker = unsafe { Waker::from_raw(raw) };
        let mut cx = Context::from_waker(&waker);

        // Safe: `fut` lives on the stack for the duration of this function.
        let mut fut = unsafe { Pin::new_unchecked(&mut fut) };
        loop {
            match fut.as_mut().poll(&mut cx) {
                Poll::Ready(v) => return v,
                // The short-circuit path is synchronous and resolves on the
                // first poll, so a spin loop is acceptable for this test only.
                Poll::Pending => continue,
            }
        }
    }
}
