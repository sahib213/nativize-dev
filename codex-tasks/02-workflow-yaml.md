# Codex packet 02 — GitHub Actions workflow

## Goal
Implement the `fileWorkflow(config)` template in `src/kit-generator.js` that emits
`.github/workflows/nativize-build.yml` — a cloud build that produces an
installable Android artifact and compiles iOS, with no local toolchain needed.

## Spec
- `name: Nativize Build`
- Trigger: **`workflow_dispatch:` only** (manual; no push trigger).
- Job `android` on `ubuntu-latest`:
  - checkout; setup-node 22; setup-java temurin 17.
  - `npm ci || npm install`, install the Capacitor 8 Android dependencies and
    TypeScript, then `npm run build`.
  - add Android only when missing → `bash ./nativize-patch-android.sh` → `npx cap sync android`.
  - `./gradlew assembleDebug --stacktrace` in `android/`.
  - `./gradlew bundleRelease` (unsigned build artifact; do not mask errors).
  - upload `android/app/build/outputs/apk/debug/*.apk` and
    `.../bundle/release/*.aab` via `actions/upload-artifact@v4`,
    `if-no-files-found: warn`.
- Job `ios` on `macos-26` (Capacitor 8 requires Xcode 26+):
  - checkout; setup-node 22; install the Capacitor 8 iOS dependencies and
    TypeScript; `npm run build`.
  - add iOS only when missing using `--packagemanager CocoaPods`, then sync and
    run `pod install`.
  - `xcodebuild -workspace App.xcworkspace -scheme App -configuration Debug
    -sdk iphoneos -destination 'generic/platform=iOS' CODE_SIGNING_ALLOWED=NO
    clean build`, with an explicit DerivedData path.
  - upload the compiled unsigned `.app` using `actions/upload-artifact@v4`.

## Hard requirements
- Spaces only, no tabs (YAML).
- Must contain: `workflow_dispatch:`, `assembleDebug`, `runs-on: ubuntu-latest`,
  `runs-on: macos-26`, `xcodebuild`, `CODE_SIGNING_ALLOWED=NO`.

## Acceptance criteria
- `ruby -ryaml -e "YAML.load_file('.github/workflows/nativize-build.yml')"`
  succeeds (valid YAML).
- Both jobs (`android`, `ios`) present at the correct indentation.
- Packet 03's workflow test passes.
