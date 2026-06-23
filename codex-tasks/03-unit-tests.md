# Codex packet 03 — Node unit tests

## Goal
Write `test/kit-generator.test.js` using the built-in `node:test` runner
(`node --test test/*.test.js`). No external test deps.

## Cover
1. **slug/appId**: `slugify` strips non-alphanumerics and leading digits;
   `normalizeAppId` derives `app.lovable.<slug>`, preserves a valid 3-label id,
   collapses junk, and falls back when given < 3 labels.
2. **file presence**: `generateKit` returns the 6 base files non-empty;
   `src/nativePush.ts` present iff `enablePush`.
3. **capacitor.config.ts**: contains the given `appId`, `appName`, `webDir`.
4. **Capacitor 8 fixes**:
   - patch script pins `AGP='8.13.0'`, `GRADLE='8.13'`, applies
     `gradle-$GRADLE-bin.zip`, and says "does NOT support AGP 9".
   - patch script handles/warns about duplicate `splash.xml`.
   - workflow has `workflow_dispatch:`, `assembleDebug`, ubuntu + macos runners,
     `xcodebuild`, `CODE_SIGNING_ALLOWED=NO`.
   - `nativePush.ts` has a STATIC `import { FirebaseMessaging }`, NO actual
     dynamic `import()` in code (a comment mentioning it is fine — assert against
     `await import(` / `= import(`, not the bare word), plus
     `THIRD_PARTY_AUTH_ERROR`, "Sandbox AND Production", and
     `isNativePlatform()`.
   - CHECKLIST mentions `App Store Connect` and `Play Console`.
5. **no placeholders**: no `{{`, `}}`, `undefined`, `[object Object]` in any file.
6. **zip** (`src/zip.js`): `toUint8Array` starts with local-file-header signature
   `50 4B 03 04`, contains an EOCD record `50 4B 05 06` whose total-entries field
   equals the file count; round-trip through the system `unzip` yields a
   byte-identical `capacitor.config.ts`; `crc32("123456789") === 0xCBF43926`.

## Acceptance criteria
- `node --test test/*.test.js` → all tests pass, zero failures.
- Tests are deterministic (no network).
