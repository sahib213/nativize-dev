"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

const Kit = require("../src/kit-generator.js");
const Zip = require("../src/zip.js");
const GitHub = require("../src/github.js");
const Plans = require("../src/plans.js");
const Billing = require("../src/billing.js");

// ---------------------------------------------------------------------------
// appId / slug normalization
// ---------------------------------------------------------------------------
test("slugify strips non-alphanumerics and leading digits", () => {
  assert.equal(Kit.slugify("My Cool App!"), "mycoolapp");
  assert.equal(Kit.slugify("123 Go"), "go"); // DNS label can't start with digit
  assert.equal(Kit.slugify(""), "");
});

test("normalizeAppId derives a valid 3-label reverse-DNS id", () => {
  assert.equal(Kit.normalizeAppId("", "My Cool App"), "app.lovable.mycoolapp");
  assert.equal(Kit.normalizeAppId("com.acme.widget", "X"), "com.acme.widget");
  // sanitizes junk + collapses dots
  assert.equal(Kit.normalizeAppId("Com..Acme  Widget!!", "X"), "com.acme.widget");
});

test("normalizeAppId falls back when fewer than 3 labels", () => {
  assert.equal(Kit.normalizeAppId("acme.widget", "Fallback Name"), "app.lovable.fallbackname");
});

test("normalizeAppId makes every Android package segment start with a letter", () => {
  assert.equal(Kit.normalizeAppId("com.123.demo", "X"), "com.x123.demo");
  assert.equal(Kit.normalizeAppId("com.acme.9lives", "X"), "com.acme.x9lives");
});

test("normalizeWebDir accepts project-relative paths and rejects traversal", () => {
  assert.equal(Kit.normalizeWebDir("./build/web"), "build/web");
  assert.throws(() => Kit.normalizeWebDir("../dist"), /safe relative path/);
  assert.throws(() => Kit.normalizeWebDir('dist"; rm -rf .'), /safe relative path/);
});

test("input hardening rejects oversized or malformed builder config", () => {
  assert.throws(() => Kit.generateKit(baseConfig({ appName: "x".repeat(81) })), /App name is too long/);
  assert.throws(() => Kit.generateKit(baseConfig({ githubRepo: "octo/demo/issues" })), /GitHub repo/);
  assert.throws(() => Kit.generateKit(baseConfig({
    permissions: [{ key: "camera", description: "x".repeat(241) }]
  })), /description is too long/);
  assert.throws(() => Kit.generateKit(baseConfig({
    socialAuth: { google: { enabled: true, webClientId: "bad <id>" } }
  })), /invalid characters/);
});

// ---------------------------------------------------------------------------
// generateKit — file presence
// ---------------------------------------------------------------------------
function baseConfig(extra) {
  return Object.assign(
    { appName: "Demo App", githubRepo: "octo/demo", webDir: "dist" },
    extra || {}
  );
}

test("generateKit produces all core files", () => {
  const files = Kit.generateKit(baseConfig());
  for (const f of [
    "capacitor.config.ts",
    "nativize.sh",
    "nativize-patch-android.sh",
    "nativize-permissions.sh",
    ".github/workflows/nativize-build.yml",
    "desktop/main.js",
    "desktop/package.json",
    "CHECKLIST.md",
    "NATIVIZE_README.md"
  ]) {
    assert.ok(files[f], "missing " + f);
    assert.ok(files[f].length > 0, "empty " + f);
  }
});

test("permissions: nativize-permissions.sh writes iOS usage strings + UIBackgroundModes + Android perms", () => {
  const sh = Kit.generateKit(baseConfig({ permissions: [
    { key: "camera", description: "Scan docs." },
    { key: "backgroundAudio" },
    { key: "notifications" }
  ] }))["nativize-permissions.sh"];
  assert.match(sh, /NSCameraUsageDescription string Scan docs\./);
  assert.match(sh, /UIBackgroundModes/);
  assert.match(sh, /string audio/);
  assert.match(sh, /android\.permission\.CAMERA/);
  assert.match(sh, /android\.permission\.POST_NOTIFICATIONS/);
  assert.match(sh, /android\.permission\.FOREGROUND_SERVICE_MEDIA_PLAYBACK/);
});

test("permissions: validatePermissions flags enabled perms missing a required description", () => {
  assert.deepEqual(Kit.validatePermissions([{ key: "camera", description: "" }]), ["Camera"]);
  assert.deepEqual(Kit.validatePermissions([{ key: "camera", description: "ok" }]), []);
  assert.deepEqual(Kit.validatePermissions([{ key: "notifications", description: "" }]), []); // no desc needed
});

test("permissions: unknown keys dropped; empty desc falls back; workflow calls the script", () => {
  assert.equal(Kit.normalizePermissions([{ key: "bogus" }, { key: "camera", description: "x" }]).length, 1);
  const sh = Kit.generateKit(baseConfig({ permissions: [{ key: "location", description: "" }] }))["nativize-permissions.sh"];
  assert.match(sh, /NSLocationWhenInUseUsageDescription string This app uses Location/); // fallback, never empty
  const wf = Kit.generateKit(baseConfig())[".github/workflows/nativize-build.yml"];
  assert.match(wf, /bash \.\/nativize-permissions\.sh/);
});

// ---------------------------------------------------------------------------
// social sign-in
// ---------------------------------------------------------------------------
test("social: no social files when no provider enabled", () => {
  const files = Kit.generateKit(baseConfig());
  assert.equal(files["src/nativeSocialAuth.ts"], undefined);
  assert.equal(files["nativize-social-auth.sh"], undefined);
  assert.equal(files["SOCIAL_AUTH_SETUP.md"], undefined);
  // a disabled provider object must not switch it on
  const off = Kit.generateKit(baseConfig({ socialAuth: { google: { enabled: false, webClientId: "x" } } }));
  assert.equal(off["src/nativeSocialAuth.ts"], undefined);
});

test("social: validateSocialAuth flags a required credential that is missing", () => {
  assert.deepEqual(
    Kit.validateSocialAuth({ google: { enabled: true, webClientId: "" } }),
    ["Sign in with Google: Web client ID"]
  );
  assert.deepEqual(Kit.validateSocialAuth({ google: { enabled: true, webClientId: "abc.apps" } }), []);
  // Apple has no required fields → always valid, even with no service id
  assert.deepEqual(Kit.validateSocialAuth({ apple: { enabled: true } }), []);
});

test("social: reverseGoogleClientId builds the iOS URL scheme", () => {
  assert.equal(
    Kit.reverseGoogleClientId("123-ios.apps.googleusercontent.com"),
    "com.googleusercontent.apps.123-ios"
  );
});

test("social: Google enabled emits helper, init config, and reversed URL scheme", () => {
  const files = Kit.generateKit(baseConfig({ socialAuth: {
    google: { enabled: true, webClientId: "web-abc.apps.googleusercontent.com", iosClientId: "123-ios.apps.googleusercontent.com" }
  } }));
  const ts = files["src/nativeSocialAuth.ts"];
  assert.ok(ts, "helper missing");
  assert.match(ts, /import \{ SocialLogin \} from '@capgo\/capacitor-social-login'/);
  assert.match(ts, /webClientId: "web-abc\.apps\.googleusercontent\.com"/);
  assert.match(ts, /iOSClientId: "123-ios\.apps\.googleusercontent\.com"/);
  assert.match(ts, /export async function signInWithGoogle/);
  const sh = files["nativize-social-auth.sh"];
  assert.match(sh, /GOOGLE_REVERSED = "com\.googleusercontent\.apps\.123-ios"/);
  assert.match(sh, /APPLE = False/);
  // build workflow installs the plugin and calls the script
  const wf = files[".github/workflows/nativize-build.yml"];
  assert.match(wf, /@capgo\/capacitor-social-login/);
  assert.match(wf, /bash \.\/nativize-social-auth\.sh/);
});

test("social: Apple enabled writes the entitlement flag and uses the bundle id as client id", () => {
  const files = Kit.generateKit(baseConfig({ appId: "com.acme.demo", socialAuth: {
    apple: { enabled: true }
  } }));
  const ts = files["src/nativeSocialAuth.ts"];
  assert.match(ts, /config\.apple = \{ clientId: "com\.acme\.demo" \}/);
  assert.match(ts, /export async function signInWithApple/);
  const sh = files["nativize-social-auth.sh"];
  assert.match(sh, /APPLE = True/);
  assert.match(sh, /com\.apple\.developer\.applesignin/);
  assert.match(sh, /GOOGLE_REVERSED = ""/); // no google → no scheme
});

test("social: both providers → both helpers and a setup doc", () => {
  const files = Kit.generateKit(baseConfig({ socialAuth: {
    apple: { enabled: true, serviceId: "com.acme.web" },
    google: { enabled: true, webClientId: "web.apps", iosClientId: "ios.apps" }
  } }));
  const ts = files["src/nativeSocialAuth.ts"];
  assert.match(ts, /signInWithApple/);
  assert.match(ts, /signInWithGoogle/);
  assert.match(ts, /clientId: "com\.acme\.web"/); // serviceId overrides the bundle id
  assert.ok(files["SOCIAL_AUTH_SETUP.md"]);
});

// ---------------------------------------------------------------------------
// plans + gating
// ---------------------------------------------------------------------------
test("plans: gateConfig strips paid features + watermarks + iOS-only on free", () => {
  const gated = Plans.gateConfig({
    appName: "X", enablePush: true, iosUpload: true,
    socialAuth: { google: { enabled: true, webClientId: "w" } }
  }, "free");
  assert.equal(gated.enablePush, false);
  assert.deepEqual(gated.socialAuth, {});
  assert.equal(gated.iosUpload, false);
  assert.equal(gated.watermark, true);
  assert.deepEqual(gated.platforms, ["ios"]);
});

test("plans: pro keeps features + all platforms + no watermark", () => {
  const p = Plans.planById("pro");
  assert.equal(p.apps, 3);
  const gated = Plans.gateConfig({ enablePush: true, iosUpload: true }, "pro");
  assert.equal(gated.enablePush, true);
  assert.equal(gated.iosUpload, true);
  assert.equal(gated.watermark, false);
  assert.equal(gated.platforms.length, 4);
});

test("plans: canAddApp respects per-plan app limits", () => {
  assert.equal(Plans.canAddApp("free", 0), true);
  assert.equal(Plans.canAddApp("free", 1), false);
  assert.equal(Plans.canAddApp("pro", 2), true);
  assert.equal(Plans.canAddApp("pro", 3), false);
  assert.equal(Plans.canAddApp("max", 9), true);
});

test("gating: free plan generates iOS-only workflow + watermark, no push/social/release", () => {
  const files = Kit.generateKit(baseConfig({
    plan: "free", enablePush: true, iosUpload: true,
    socialAuth: { apple: { enabled: true } }
  }));
  // watermark file present + build injects it
  assert.ok(files["nativize-watermark.html"]);
  assert.match(files["nativize-watermark.html"], /Built with Nativize/);
  const wf = files[".github/workflows/nativize-build.yml"];
  assert.match(wf, /nativize-watermark\.html/);          // injection step
  assert.match(wf, /Android \(\.apk \+ \.aab\)\n    if: \$\{\{ false \}\}/); // android gated off
  assert.match(wf, /Desktop \(macOS \.dmg\)\n    if: \$\{\{ false \}\}/);    // mac gated off
  // paid-only artifacts are absent
  assert.equal(files["src/nativePush.ts"], undefined);
  assert.equal(files["src/nativeSocialAuth.ts"], undefined);
  assert.equal(files[".github/workflows/nativize-release.yml"], undefined);
});

test("gating: pro plan builds all platforms, no watermark, keeps paid features", () => {
  const files = Kit.generateKit(baseConfig({
    plan: "pro", enablePush: true, iosUpload: true,
    storeSecrets: { ASC_KEY_ID: "k" }
  }));
  assert.equal(files["nativize-watermark.html"], undefined);
  const wf = files[".github/workflows/nativize-build.yml"];
  assert.doesNotMatch(wf, /if: \$\{\{ false \}\}/); // every platform builds
  assert.doesNotMatch(wf, /nativize-watermark/);
  assert.ok(files["src/nativePush.ts"]);
  assert.ok(files[".github/workflows/nativize-release.yml"]);
});

test("gating: no plan field → ungated/full (back-compat)", () => {
  const files = Kit.generateKit(baseConfig({ enablePush: true }));
  assert.equal(files["nativize-watermark.html"], undefined);
  assert.doesNotMatch(files[".github/workflows/nativize-build.yml"], /if: \$\{\{ false \}\}/);
  assert.ok(files["src/nativePush.ts"]);
});

// ---------------------------------------------------------------------------
// billing
// ---------------------------------------------------------------------------
test("billing: inactive or missing entitlement falls back to free; active status maps to a plan", () => {
  assert.equal(Billing.planOf(null), "free");
  assert.equal(Billing.planOf({ plan_id: "pro", billing: "subscription", status: "active" }), "pro");
  assert.equal(Billing.planOf({ plan_id: "max", billing: "subscription", status: "trialing" }), "max");
  assert.equal(Billing.planOf({ plan_id: "pro", billing: "subscription", status: "canceled" }), "free");
});

test("billing: status, activation, and checkout call the Supabase APIs", async () => {
  const calls = [];
  const fakeFetch = (url, opts) => {
    calls.push({ url, opts });
    if (url.endsWith("/rest/v1/rpc/get_billing_status")) {
      return Promise.resolve({
        ok: true,
        text: () => Promise.resolve(JSON.stringify([{ plan_id: "pro", billing: "subscription", status: "active", apps_limit: 3, apps_used: 1 }]))
      });
    }
    if (url.endsWith("/rest/v1/rpc/activate_app")) {
      return Promise.resolve({
        ok: true,
        text: () => Promise.resolve(JSON.stringify([{ plan_id: "pro", billing: "subscription", status: "active", apps_limit: 3, apps_used: 2, activated: true, already_activated: false }]))
      });
    }
    return Promise.resolve({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ id: "cs_test", url: "https://checkout.stripe.com/c/test" }))
    });
  };

  const opts = { fetch: fakeFetch, supabaseUrl: "https://example.supabase.co" };
  const status = await Billing.status("jwt", opts);
  assert.equal(status.plan, "pro");
  assert.equal(status.appsLimit, 3);
  assert.equal(status.appsUsed, 1);

  const activated = await Billing.activate("jwt", "octo/demo", opts);
  assert.equal(activated.activated, true);
  assert.equal(activated.appsUsed, 2);

  const checkout = await Billing.checkout("jwt", "pro", Object.assign({}, opts, {
    successUrl: "https://nativize.dev/app.html?checkout=success"
  }));
  assert.equal(checkout.url, "https://checkout.stripe.com/c/test");

  assert.equal(calls[0].opts.headers.Authorization, "Bearer jwt");
  assert.equal(JSON.parse(calls[1].opts.body).repo, "octo/demo");
  assert.equal(JSON.parse(calls[2].opts.body).planId, "pro");
});

test("desktop build: valid Electron main + package.json with mac/win targets", () => {
  const files = Kit.generateKit(baseConfig({ appId: "com.acme.demo" }));
  const main = files["desktop/main.js"];
  assert.match(main, /require\('electron'\)/);
  assert.match(main, /electron-serve/);
  assert.match(main, /BrowserWindow/);
  const pkg = JSON.parse(files["desktop/package.json"]); // must be valid JSON
  assert.equal(pkg.main, "main.js");
  assert.ok(pkg.devDependencies["electron-builder"]);
  assert.equal(pkg.build.appId, "com.acme.demo");
  assert.equal(pkg.build.mac.target, "dmg");
  assert.equal(pkg.build.win.target, "nsis");
  assert.equal(pkg.build.mac.identity, null); // unsigned so it builds without an Apple cert
  const wf = files[".github/workflows/nativize-build.yml"];
  assert.match(wf, /desktop-mac:/);
  assert.match(wf, /desktop-windows:/);
  assert.match(wf, /runs-on: macos-latest/);
  assert.match(wf, /runs-on: windows-latest/);
  assert.match(wf, /electron-builder --mac/);
  assert.match(wf, /electron-builder --win/);
});

test("nativePush.ts only present when push enabled", () => {
  assert.equal(Kit.generateKit(baseConfig({ enablePush: false }))["src/nativePush.ts"], undefined);
  assert.ok(Kit.generateKit(baseConfig({ enablePush: true }))["src/nativePush.ts"]);
});

// ---------------------------------------------------------------------------
// capacitor.config.ts content
// ---------------------------------------------------------------------------
test("capacitor.config.ts carries appId / appName / webDir", () => {
  const cfg = Kit.generateKit(baseConfig({ appId: "com.acme.demo", webDir: "build" }))["capacitor.config.ts"];
  assert.match(cfg, /appId: "com\.acme\.demo"/);
  assert.match(cfg, /appName: "Demo App"/);
  assert.match(cfg, /webDir: "build"/);
});

test("capacitor.config.ts safely escapes quotes and backslashes", () => {
  const name = 'Sahib\'s \\ App';
  const cfg = Kit.generateKit(baseConfig({ appName: name }))["capacitor.config.ts"];
  assert.ok(cfg.includes("appName: " + JSON.stringify(name)));
});

// ---------------------------------------------------------------------------
// Capacitor 8 hard-won fixes are encoded
// ---------------------------------------------------------------------------
test("Android toolchain is pinned to AGP 8.13.0 + Gradle 8.13 (NOT AGP 9)", () => {
  const patch = Kit.generateKit(baseConfig())["nativize-patch-android.sh"];
  assert.match(patch, /AGP='8\.13\.0'/);          // AGP pin
  assert.match(patch, /GRADLE='8\.13'/);          // Gradle pin
  assert.match(patch, /gradle-\$GRADLE-bin\.zip/); // applied to the wrapper
  assert.match(patch, /does NOT support AGP 9/i);
  assert.equal(Kit.AGP_VERSION, "8.13.0");
  assert.equal(Kit.GRADLE_VERSION, "8.13");
});

test("splash.xml duplicate-resource trap is handled + warned", () => {
  const patch = Kit.generateKit(baseConfig())["nativize-patch-android.sh"];
  assert.match(patch, /splash\.xml/);
  assert.match(patch, /[Dd]uplicate/);
});

test("workflow has dispatch trigger + android assembleDebug + ios xcodebuild no-signing", () => {
  const wf = Kit.generateKit(baseConfig())[".github/workflows/nativize-build.yml"];
  assert.match(wf, /workflow_dispatch:/);
  assert.match(wf, /assembleDebug/);
  assert.match(wf, /runs-on: ubuntu-latest/);
  assert.match(wf, /runs-on: macos-26/);
  assert.match(wf, /node-version: 22/);
  assert.match(wf, /npm install --no-save --legacy-peer-deps typescript/);
  // Real Lovable apps often have peer-dep conflicts (e.g. a Capacitor-6 plugin on
  // a Capacitor-8 project) — installs MUST tolerate them or the build dies at npm ci.
  assert.match(wf, /npm ci --legacy-peer-deps \|\| npm install --legacy-peer-deps/);
  assert.match(wf, /@capacitor\/android@\^8/);
  assert.match(wf, /@capacitor\/ios@\^8/);
  assert.match(wf, /cap add ios/);
  assert.match(wf, /pod install/);
  assert.match(wf, /-workspace App\.xcworkspace/);
  assert.match(wf, /xcodebuild/);
  assert.match(wf, /CODE_SIGNING_ALLOWED=NO/);
  assert.match(wf, /ios-unsigned-app/);
  assert.doesNotMatch(wf, /bundleRelease.*\|\|/);
});

test("workflow installs optional native push dependencies when enabled", () => {
  const wf = Kit.generateKit(baseConfig({ enablePush: true }))[".github/workflows/nativize-build.yml"];
  assert.match(wf, /@capacitor-firebase\/messaging/);
  assert.match(wf, /\bfirebase\b/);
  assert.doesNotMatch(wf, /@capacitor\/push-notifications/);
});

test("nativize.sh fails early with a clear Node 22 requirement", () => {
  const sh = Kit.generateKit(baseConfig())["nativize.sh"];
  assert.match(sh, /NODE_MAJOR/);
  assert.match(sh, /Capacitor 8 requires Node\.js 22 or newer/);
  assert.match(sh, /@capacitor\/cli@\^8 typescript/);
});

test("generated shell scripts and workflow are syntactically valid", () => {
  const os = require("node:os");
  const fs = require("node:fs");
  const path = require("node:path");
  const { execFileSync } = require("node:child_process");
  const files = Kit.generateKit(baseConfig({ enablePush: true }));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nz-syntax-"));

  for (const name of ["nativize.sh", "nativize-patch-android.sh"]) {
    const target = path.join(dir, name);
    fs.writeFileSync(target, files[name]);
    execFileSync("bash", ["-n", target]);
  }

  const workflow = path.join(dir, "workflow.yml");
  fs.writeFileSync(workflow, files[".github/workflows/nativize-build.yml"]);
  execFileSync("ruby", ["-e", "require 'yaml'; YAML.safe_load(File.read(ARGV[0]), aliases: true)", workflow]);
});

test("nativePush uses a STATIC import (not dynamic) + APNs sandbox/production note", () => {
  const push = Kit.generateKit(baseConfig({ enablePush: true }))["src/nativePush.ts"];
  assert.match(push, /^import \{ FirebaseMessaging \} from '@capacitor-firebase\/messaging';/m);
  // no ACTUAL dynamic import in code (the comment may mention the word).
  assert.doesNotMatch(push, /await\s+import\(|=\s*import\(|\bawait import\(/);
  assert.match(push, /THIRD_PARTY_AUTH_ERROR/);
  assert.match(push, /Sandbox AND Production/i);
  assert.match(push, /isNativePlatform\(\)/); // web no-op guard
});

test("push config targets FirebaseMessaging and avoids the competing Capacitor plugin", () => {
  const files = Kit.generateKit(baseConfig({ enablePush: true }));
  assert.match(files["capacitor.config.ts"], /FirebaseMessaging:/);
  assert.doesNotMatch(files["capacitor.config.ts"], /\bPushNotifications:/);
  assert.match(files["nativize.sh"], /@capacitor-firebase\/messaging firebase/);
  assert.doesNotMatch(files["nativize.sh"], /@capacitor\/push-notifications/);
});

test("CHECKLIST covers both App Store and Play Store", () => {
  const cl = Kit.generateKit(baseConfig())["CHECKLIST.md"];
  assert.match(cl, /App Store Connect/);
  assert.match(cl, /Play Console/);
});

// ---------------------------------------------------------------------------
// No leftover template placeholders anywhere
// ---------------------------------------------------------------------------
test("no unresolved placeholders in any generated file", () => {
  const files = Kit.generateKit(baseConfig({ enablePush: true }));
  for (const [name, content] of Object.entries(files)) {
    assert.doesNotMatch(content, /\{\{|\}\}|undefined|\[object Object\]/, "placeholder in " + name);
  }
});

// ---------------------------------------------------------------------------
// ZIP writer produces a valid, parseable archive
// ---------------------------------------------------------------------------
test("zip.toUint8Array yields a valid ZIP (signature + EOCD + entry count)", () => {
  const files = Kit.generateKit(baseConfig({ enablePush: true }));
  const bytes = Zip.toUint8Array(files);
  // local file header signature at start
  assert.deepEqual(Array.from(bytes.slice(0, 4)), [0x50, 0x4b, 0x03, 0x04]);
  // EOCD signature appears
  const buf = Buffer.from(bytes);
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd > 0, "no EOCD record");
  const total = buf.readUInt16LE(eocd + 10);
  assert.equal(total, Object.keys(files).length);
});

test("zip round-trips through system unzip", async () => {
  // Write a real zip and extract it with the OS `unzip` to prove validity.
  const os = require("node:os");
  const fs = require("node:fs");
  const path = require("node:path");
  const { execFileSync } = require("node:child_process");

  const files = Kit.generateKit(baseConfig());
  const bytes = Zip.toUint8Array(files);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nz-"));
  const zipPath = path.join(dir, "kit.zip");
  fs.writeFileSync(zipPath, Buffer.from(bytes));

  execFileSync("unzip", ["-o", zipPath, "-d", path.join(dir, "out")], { stdio: "ignore" });
  const extracted = fs.readFileSync(path.join(dir, "out", "capacitor.config.ts"), "utf8");
  assert.match(extracted, /appId:/);
  assert.equal(extracted, files["capacitor.config.ts"]); // byte-identical
});

test("crc32 matches a known value", () => {
  // CRC-32 of "123456789" is 0xCBF43926.
  const bytes = new TextEncoder().encode("123456789");
  assert.equal(Zip.crc32(bytes), 0xcbf43926);
});

test("GitHub repo parser accepts canonical inputs and rejects extra paths", () => {
  assert.deepEqual(GitHub.splitRepo("octocat/hello-world"), { owner: "octocat", repo: "hello-world" });
  assert.deepEqual(GitHub.splitRepo("https://github.com/octocat/hello-world.git"), { owner: "octocat", repo: "hello-world" });
  assert.throws(() => GitHub.splitRepo("octocat/hello-world/issues"), /owner\/repo/);
});
