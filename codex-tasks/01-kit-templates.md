# Codex packet 01 — kit template strings

## Goal
Implement the file-template functions inside a PURE, dependency-free module
`src/kit-generator.js`. Given a normalized config, return a `{ path: contents }`
map describing the full Capacitor 8 native kit.

## Module contract
- UMD: `module.exports` in Node, `window.NativizeKit` in the browser. No imports.
- Exports: `generateKit(config)`, `normalizeConfig`, `normalizeAppId`, `slugify`,
  `normalizeWebDir`, `AGP_VERSION`, `GRADLE_VERSION`.
- `normalizeConfig(input)` → `{ appName, appId, webDir, githubRepo, enablePush,
  agpVersion, gradleVersion }`.
- `normalizeAppId(rawAppId, appName)` → valid 3+ label reverse-DNS, lowercase,
  alphanumeric labels, never starting with a digit; fallback `app.lovable.<slug>`.

## Files generateKit must emit
1. `capacitor.config.ts` — TS exporting a `CapacitorConfig` with `appId`,
   `appName`, `webDir`, a `SplashScreen` plugin block, and (only if `enablePush`)
   a `FirebaseMessaging` block.
2. `nativize.sh` — bash, `set -euo pipefail`: install `@capacitor/core@^8` +
   cli + TypeScript + ios + android + splash-screen (+ firebase messaging and
   `firebase` if push), require Node 22+, ensure a
   `webDir` build exists, `npx cap add ios/android` (idempotent), call
   `nativize-patch-android.sh`, `npx cap sync`, print open/build hints.
3. `nativize-patch-android.sh` — bash: pin AGP to `8.13.0` in
   `android/build.gradle` and Gradle wrapper to `8.13`
   (`gradle-$GRADLE-bin.zip`); de-dupe a duplicate `res/drawable*/splash.xml`
   with a warning. Must contain the text "does NOT support AGP 9".
4. `CHECKLIST.md` — App Store **and** Play Store submission steps; a push
   section only when enabled (Firebase config files, APNs Sandbox+Production key,
   `THIRD_PARTY_AUTH_ERROR` warning).
5. `NATIVIZE_README.md` — short usage + gotchas table.
6. `src/nativePush.ts` — ONLY when `enablePush`. See packet notes: STATIC import
   of `@capacitor-firebase/messaging`, `Capacitor.isNativePlatform()` guard,
   APNs Sandbox+Production note.

## Hard requirements (these are the whole point)
- AGP `8.13.0` + Gradle `8.13`. Never AGP 9.
- `nativePush.ts` uses a **static** `import { FirebaseMessaging }`; NO dynamic
  `import()` in code.
- Do not install the competing `@capacitor/push-notifications` plugin.
- No unresolved placeholders, `undefined`, or `[object Object]` in any output.

## Acceptance criteria
- `require('./src/kit-generator.js').generateKit({appName:'X'})` returns the 6
  base files; with `enablePush:true` it also returns `src/nativePush.ts`.
- All files are non-empty strings.
- The unit tests in packet 03 pass against your implementation.
- `bash -n` passes on both generated `.sh` files; the YAML (packet 02) parses.
