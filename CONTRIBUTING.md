# Contributing to Slovo

Thanks for your interest in improving Slovo! Whether it's a bug report, a feature
idea, or a pull request, contributions are genuinely appreciated. This project is
small and friendly — don't be shy.

## Getting set up

Slovo builds with the standard Tauri v2 + Rust toolchain. The full prerequisites and
build steps live in the README — see [**Build from source**](README.md#build-from-source).

The short version:

```bash
git clone https://github.com/Miozzik/slovo.git
cd slovo/src-tauri
cargo tauri dev      # for development
cargo tauri build    # to produce the .app / .dmg
```

A couple of things that often trip people up:

### The frontend is static — no npm

The UI in `src/` is plain HTML, CSS, and JavaScript. There is **no framework, no
bundler, and no `npm install` step**. Edit the files directly and Tauri serves them
as-is. Please keep it that way; the zero-build frontend is a feature.

### Do not run `cargo update`

The committed `src-tauri/Cargo.lock` pins the `time` crate to **`0.3.47`** on purpose.
Version `0.3.48` fails to compile on current `rustc` (an `E0119` trait conflict). If you
run `cargo update`, the build may break. Keep the lockfile committed and unchanged unless
you're deliberately, carefully bumping dependencies and have verified the build still
passes.

## Validating your changes

Run the functional test harness before opening a PR:

```bash
./scripts/test_slovo.sh
```

It runs the Rust unit tests, checks that the project compiles, exercises the DeepL
translate and languages endpoints (if a key is configured), and verifies the app bundle.
It prints a clear PASS / FAIL / SKIP report. It also lists a short manual GUI checklist
for things that can't be automated (window appearance, hotkey capture, etc.) — please walk
through those if your change touches the UI or capture flow.

## Code style

- **Rust:** idiomatic and `rustfmt`-clean. Run `cargo fmt` and address `cargo clippy`
  warnings before submitting.
- **Keep files small.** Aim to stay well under ~500 lines per file; prefer focused modules
  over giant ones.
- **Comment the *why*, not the *what*.** The existing source (e.g. `capture.rs`) explains
  the non-obvious macOS quirks — match that spirit.

## Reporting issues

Found a bug or have an idea? [Open an issue](https://github.com/Miozzik/slovo/issues) and
include, where relevant:

- Your macOS version and chip (Apple Silicon / Intel).
- Steps to reproduce.
- What you expected vs. what happened.
- Any console/log output.

## Opening a pull request

1. Fork the repo and create a topic branch (`git checkout -b my-fix`).
2. Make your change, keeping commits focused and messages clear.
3. Run `./scripts/test_slovo.sh` and `cargo fmt` / `cargo clippy`.
4. Push and open a PR against `main`, describing what you changed and why.

By contributing, you agree that your contributions are licensed under the project's
[MIT License](LICENSE).

Happy hacking — and thanks for helping make Slovo better. 🌍
