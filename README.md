# Nativize

A Chrome extension that overlays the **Lovable** app builder (`lovable.dev`) and
turns any Lovable web app into native **iOS + Android** apps that are ready to
submit to the App Store and Play Store — without leaving your browser.

A browser can't compile native apps, so Nativize splits the job:

- **The extension is the brain.** It detects your current Lovable project, asks a
  few questions, and generates a complete **native kit** (Capacitor 8).
- **GitHub Actions is the muscle.** The kit ships a workflow that builds an
  installable Android `.apk`/`.aab` and compiles the iOS app in the cloud — free,
  no local Xcode / Android Studio required to validate the build.
- **Delivery is your choice.** Download the kit as a `.zip`, or push it straight
  to your GitHub repo via the GitHub REST API. The generation workflow runs in
  your browser. Your GitHub token lives only in `chrome.storage.local`.

## Install (Load unpacked)

1. `git clone` / unzip this repo, then run `node icons/generate-icons.js` (icons
   are committed, but this regenerates them if needed).
2. Open `chrome://extensions`, toggle **Developer mode** (top-right).
3. Click **Load unpacked** and select this folder (the one with `manifest.json`).
4. Visit a project on `https://lovable.dev` — a floating **Nativize** button
   appears bottom-right.

## Usage

1. Click the floating button to open the panel.
2. Nativize auto-detects your **app name** (page title) and **GitHub repo** (any
   `github.com` link on the page). Edit any field.
3. Toggle **Push notifications** if you want Firebase messaging wired up.
4. **Download .zip** — unzip into your project root and run `bash nativize.sh`.
   **Or Push to GitHub** — paste a token with `repo` scope; the kit is committed
   in one commit.
5. Run **Actions → Nativize Build** on GitHub to build in the cloud.

## What's in the generated kit

| File | Purpose |
|------|---------|
| `capacitor.config.ts` | App identity (reverse-DNS appId) + splash/push plugins. |
| `nativize.sh` | One-shot local setup: install Capacitor 8, add iOS/Android, sync. |
| `nativize-patch-android.sh` | Pins AGP 8.13.0 / Gradle 8.13; de-dupes `splash.xml`. |
| `.github/workflows/nativize-build.yml` | Cloud build: Android assembleDebug (ubuntu) + iOS xcodebuild `CODE_SIGNING_ALLOWED=NO` (macos), `workflow_dispatch`. |
| `src/nativePush.ts` *(optional)* | Firebase push via **static** import; no-ops on web. |
| `.github/workflows/nativize-release.yml` *(optional)* | **Signed** build + auto-upload to TestFlight / Play internal testing. |
| `STORE_SETUP.md` *(optional)* | Which secrets the release workflow needs + how to get them. |
| `CHECKLIST.md` | Full App Store + Play Store submission path. |

## Direct store upload (no manual archive/upload)

Flip **Auto-upload to stores** in the panel and the kit gains a
`nativize-release.yml` workflow that builds **signed** binaries and ships them
straight to your accounts:

- **iOS → TestFlight** using an App Store Connect **API key** (`-allowProvisioningUpdates`
  handles signing certs/profiles; `xcrun altool` uploads the `.ipa`).
- **Android → Play Internal testing** using an upload keystore (AGP injected
  signing) + a Play service-account JSON.

Credentials never get committed. The extension encrypts each one with the repo's
public key using libsodium **`crypto_box_seal`** (vendored tweetnacl + BLAKE2b,
since WebCrypto can't do it) and writes them as **GitHub Actions secrets** via the
API. Two honest caveats: public App Store "Submit for Review" stays manual, and
Google requires the **first** Play release to be created manually once (the API
can't create the app) — after that, uploads are automatic.

## Capacitor 8 footguns baked in

- **AGP 9 breaks Capacitor 8.** The kit pins **AGP 8.13.0 + Gradle 8.13**.
- **`splash.xml` duplicate-resource trap.** `@capacitor/splash-screen` and a
  generated drawable can both define `res/drawable/splash.xml` → merge failure.
  The patch script de-dupes and warns.
- **Push must use a static import.** A dynamic `import()` of
  `@capacitor-firebase/messaging` silently fails to load its chunk inside the iOS
  WebView. `nativePush.ts` imports it statically.
- **APNs key must be Sandbox & Production.** A Production-only key throws
  `THIRD_PARTY_AUTH_ERROR` on local debug builds.
- **Peer-dep conflicts abort `npm ci`.** Real Lovable apps mix plugin versions
  (e.g. a Capacitor-6 plugin on a Capacitor-8 project). Every install in the
  cloud build uses `--legacy-peer-deps` so it never dies at install.
- **Capacitor 8 requires JDK 21.** The Android job runs Java 21 — Java 17 fails
  the `capacitor-android` compile with `invalid source release: 21`.
- **A half-scaffolded `ios/` folder breaks `cap sync`.** Some repos ship an
  incomplete `ios/` stub (no Xcode project / Podfile). The build detects that,
  recreates iOS cleanly, and adapts to whichever package manager Capacitor uses
  (CocoaPods *or* SPM).
- **AdMob crashes the app on launch.** `@capacitor-community/admob` pulls in the
  Google Mobile Ads SDK, whose `MobileAdsInitProvider` aborts at startup unless
  ad config is perfect. The Android patch (a) injects the required
  `com.google.android.gms.ads.APPLICATION_ID` meta-data (Google's TEST id by
  default — replace with yours) and (b) removes the auto-init provider via the
  manifest merger, so the app never crashes; the plugin still initializes ads
  on demand from JS.

## Architecture

```
manifest.json            MV3: content script, GitHub + Supabase host perms, storage + identity
src/kit-generator.js     PURE, dependency-free kit generator (Node + browser via UMD)
src/billing.js           Supabase billing/client RPC helper (Stripe secrets stay server-side)
src/zip.js               PURE store-only ZIP writer (no deps)
src/github.js            GitHub REST push (single commit via Git Data API)
src/panel.js             Shadow-DOM glassmorphism UI (reused by content script + harness)
src/content.js           Entry: detection + storage + wiring
src/popup.html           Toolbar popup (instructions)
supabase/                Billing migration + Stripe checkout/webhook edge functions
icons/generate-icons.js  Pure-Node gradient PNG generator
test/                    Node unit tests (node --test)
tools/harness.html       Browser preview harness for the panel
codex-tasks/             Self-contained specs for the chunks delegated to Codex
```

## Develop

```bash
npm test                 # node --test — generator + zip tests
npm run icons            # regenerate gradient icons
npm run smoke:native     # generate a throwaway app and run real `cap add` + `cap sync`
NATIVIZE_BUILD_NATIVE=1 npm run smoke:native  # also compile a real APK + unsigned iOS app
NATIVIZE_SMOKE_PUSH=1 npm run smoke:native    # also install + type-check Firebase push
python3 -m http.server 8777   # then open /tools/harness.html to preview the panel
```

The kit generator is a **pure, dependency-free module** used identically in Node
tests and in the content script — so what the tests verify is exactly what ships.
