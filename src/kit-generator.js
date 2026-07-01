/*
 * Nativize kit generator — PURE, dependency-free.
 *
 * Runs identically in Node (CommonJS, for unit tests) and in the browser
 * content script (attaches to window.NativizeKit). No imports, no globals
 * touched other than the explicit export at the bottom.
 *
 * The whole job of this module: take a small config object and return a
 * { "relative/path": "file contents" } map describing a complete "native
 * kit" that turns a Lovable web app into submittable iOS + Android apps.
 *
 * Every Capacitor-8 footgun we hit the hard way is encoded here as a fix
 * or an inline warning so the user never has to rediscover it.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.NativizeKit = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Pinned toolchain. Capacitor 8 does NOT support AGP 9 — using it breaks
  // the Android build with cryptic Gradle errors. These two versions are a
  // matched, known-good pair.
  var AGP_VERSION = "8.13.0";
  var GRADLE_VERSION = "8.13";
  var LIMITS = {
    appName: 80,
    appId: 120,
    githubRepo: 140,
    webDir: 120,
    permissionDescription: 240,
    socialValue: 500,
    platforms: 4
  };

  function jsString(value) {
    return JSON.stringify(String(value));
  }

  function boundedText(value, max, label) {
    var out = String(value == null ? "" : value).trim();
    if (/[\u0000-\u001f\u007f]/.test(out)) throw new Error(label + " contains invalid control characters.");
    if (out.length > max) throw new Error(label + " is too long.");
    return out;
  }

  // Accept a base64 PNG (optionally a data: URL) for the uploaded logo/splash.
  // Returns clean base64 (no prefix/whitespace) or null. Caps size so a huge
  // upload can't bloat the kit (~8MB of base64 ≈ a 6MB PNG, plenty for an icon).
  function sanitizeBase64(raw) {
    if (!raw) return null;
    var s = String(raw).replace(/^data:image\/[a-z.+-]+;base64,/i, "").replace(/\s+/g, "");
    if (!s) return null;
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return null;
    if (s.length > 8 * 1024 * 1024) throw new Error("Uploaded image is too large.");
    return s;
  }

  function normalizeWebDir(raw) {
    var value = boundedText(raw || "dist", LIMITS.webDir, "Web build dir").replace(/^\.\//, "");
    if (!value) return "dist";
    // Keep this safe to interpolate into the generated shell script and prevent
    // the kit from ever pointing outside the project root.
    if (!/^[a-zA-Z0-9._/-]+$/.test(value) || /(^|\/)\.\.?($|\/)/.test(value) || value.charAt(0) === "/") {
      throw new Error("Web build dir must be a safe relative path (for example: dist or build/web).");
    }
    return value;
  }

  /**
   * Turn an arbitrary app name into a valid reverse-DNS appId segment.
   * "My Cool App!" -> "mycoolapp"
   */
  function slugify(name) {
    return String(name || "")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "")
      .replace(/^[^a-z]+/, ""); // a DNS label can't start with a digit
  }

  /**
   * Build a safe reverse-DNS appId. Accepts an explicit appId or derives one.
   * Guarantees three dot-separated, lowercase, alphanumeric labels.
   */
  function normalizeAppId(rawAppId, appName) {
    var raw = boundedText(rawAppId || "", LIMITS.appId, "App ID");
    var safeName = boundedText(appName || "", LIMITS.appName, "App name");
    var candidate = raw.toLowerCase().normalize("NFKD")
      .replace(/[^a-z0-9.]+/g, ".")
      .replace(/\.+/g, ".")
      .replace(/^\.+|\.+$/g, "");
    var parts = candidate.split(".").map(function (part) {
      // Every Android applicationId segment must start with a letter.
      return /^[a-z]/.test(part) ? part : (part ? "x" + part : "");
    }).filter(Boolean);
    if (parts.length >= 3) {
      return parts.join(".");
    }
    var slug = slugify(safeName) || "app";
    return "app.lovable." + slug;
  }

  function normalizeRepo(rawRepo) {
    var repo = boundedText(rawRepo || "", LIMITS.githubRepo, "GitHub repo");
    if (!repo) return "";
    var cleaned = repo.replace(/^https?:\/\/github\.com\//, "")
      .replace(/[?#].*$/, "")
      .replace(/\.git\/?$/, "")
      .replace(/\/+$/, "");
    if (!/^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9][a-z0-9_.-]{0,99}$/i.test(cleaned)) {
      throw new Error("GitHub repo must be in owner/repo form.");
    }
    return cleaned;
  }

  function normalizePlatforms(input) {
    var allowed = { ios: true, android: true, mac: true, windows: true };
    var list = Array.isArray(input) && input.length ? input : DEFAULT_PLATFORMS;
    var out = [];
    list.forEach(function (p) {
      p = String(p || "").trim().toLowerCase();
      if (allowed[p] && out.indexOf(p) < 0) out.push(p);
    });
    if (!out.length || out.length > LIMITS.platforms) throw new Error("Platform selection is invalid.");
    return out;
  }

  // Resolve the plans module in Node (require) or the browser (global).
  function getPlans() {
    if (typeof module === "object" && module.exports) {
      try { return require("./plans.js"); } catch (e) { return null; }
    }
    var g = (typeof self !== "undefined" ? self : this);
    return g && g.NativizePlans ? g.NativizePlans : null;
  }
  var DEFAULT_PLATFORMS = ["ios", "android", "mac", "windows"];

  function normalizeConfig(input) {
    input = input || {};
    // Plan gating is OPT-IN: only applied when a `plan` is explicitly set (the
    // extension + website always set one). With no plan, behavior is ungated/full
    // so library callers and older flows are unaffected.
    var Plans = getPlans();
    var planId = input.plan;
    var gated = (planId != null && Plans && Plans.gateConfig) ? Plans.gateConfig(input, planId) : input;

    var appName = boundedText(gated.appName || "My Lovable App", LIMITS.appName, "App name") || "My Lovable App";
    var platforms = normalizePlatforms(gated.platforms);
    var cfg = {
      appName: appName,
      appId: normalizeAppId(gated.appId, appName),
      webDir: normalizeWebDir(gated.webDir),
      githubRepo: normalizeRepo(gated.githubRepo),
      enablePush: gated.enablePush === true,
      // Store auto-upload (signed builds → testing tracks via GitHub Actions):
      iosUpload: gated.iosUpload === true,       // App Store Connect → TestFlight
      androidUpload: gated.androidUpload === true, // Google Play → Internal testing
      permissions: normalizePermissions(gated.permissions),
      socialAuth: normalizeSocialAuth(gated.socialAuth),
      plan: gated.plan || planId || null,
      platforms: platforms,
      watermark: gated.watermark === true,
      // Premium: a custom app icon + splash (base64 PNG) and the iOS Dynamic
      // Island header. gateConfig() already nulls these out on the Free plan.
      appIcon: sanitizeBase64(gated.appIcon),
      appSplash: sanitizeBase64(gated.appSplash),
      iosHeader: gated.iosHeader === true,
      agpVersion: AGP_VERSION,
      gradleVersion: GRADLE_VERSION
    };
    cfg.hasCustomIcon = !!cfg.appIcon;
    cfg.storeUpload = cfg.iosUpload || cfg.androidUpload;
    cfg.enableSocialAuth = cfg.socialAuth.length > 0;
    cfg.appleSignIn = hasSocialProvider(cfg.socialAuth, "apple");
    cfg.googleSignIn = hasSocialProvider(cfg.socialAuth, "google");
    // Per-platform build flags drive which workflow jobs run.
    cfg.buildIOS = platforms.indexOf("ios") !== -1;
    cfg.buildAndroid = platforms.indexOf("android") !== -1;
    cfg.buildMac = platforms.indexOf("mac") !== -1;
    cfg.buildWindows = platforms.indexOf("windows") !== -1;
    return cfg;
  }

  // Secret names the release workflow expects. The extension encrypts + writes
  // these to the repo's GitHub Actions secrets (see src/github.js setSecrets).
  var STORE_SECRETS = {
    ios: ["ASC_KEY_ID", "ASC_ISSUER_ID", "ASC_KEY_P8", "APPLE_TEAM_ID"],
    android: ["ANDROID_KEYSTORE_BASE64", "ANDROID_KEYSTORE_PASSWORD", "ANDROID_KEY_ALIAS", "ANDROID_KEY_PASSWORD", "PLAY_SERVICE_ACCOUNT_JSON"]
  };

  // ---------------------------------------------------------------------------
  // App permissions catalog. Each entry maps a human permission to the native
  // bits it needs: iOS Info.plist usage strings + UIBackgroundModes, and Android
  // <uses-permission>. `needsDesc` => iOS requires a usage description string or
  // the App Store rejects the build, so the UI must collect one.
  // ---------------------------------------------------------------------------
  var PERMISSION_CATALOG = [
    { key: "location", label: "Location (when in use)", needsDesc: true,
      iosUsage: ["NSLocationWhenInUseUsageDescription"],
      android: ["android.permission.ACCESS_FINE_LOCATION", "android.permission.ACCESS_COARSE_LOCATION"],
      defaultDesc: "We use your location to show nearby content." },
    { key: "backgroundLocation", label: "Background location", needsDesc: true,
      iosUsage: ["NSLocationAlwaysAndWhenInUseUsageDescription"], iosBackgroundModes: ["location"],
      android: ["android.permission.ACCESS_BACKGROUND_LOCATION", "android.permission.FOREGROUND_SERVICE_LOCATION"],
      defaultDesc: "We use your location in the background to keep features working." },
    { key: "microphone", label: "Microphone / voice", needsDesc: true,
      iosUsage: ["NSMicrophoneUsageDescription"], android: ["android.permission.RECORD_AUDIO"],
      defaultDesc: "We use the microphone for voice features." },
    { key: "camera", label: "Camera", needsDesc: true,
      iosUsage: ["NSCameraUsageDescription"], android: ["android.permission.CAMERA"],
      defaultDesc: "We use the camera to take photos and scan." },
    { key: "photos", label: "Photos", needsDesc: true,
      iosUsage: ["NSPhotoLibraryUsageDescription", "NSPhotoLibraryAddUsageDescription"],
      android: ["android.permission.READ_MEDIA_IMAGES"],
      defaultDesc: "We access your photos so you can pick and save images." },
    { key: "notifications", label: "Notifications", needsDesc: false,
      iosBackgroundModes: ["remote-notification"], android: ["android.permission.POST_NOTIFICATIONS"],
      defaultDesc: "" },
    { key: "contacts", label: "Contacts", needsDesc: true,
      iosUsage: ["NSContactsUsageDescription"], android: ["android.permission.READ_CONTACTS"],
      defaultDesc: "We access contacts so you can invite friends." },
    { key: "bluetooth", label: "Bluetooth", needsDesc: true,
      iosUsage: ["NSBluetoothAlwaysUsageDescription"],
      android: ["android.permission.BLUETOOTH_CONNECT", "android.permission.BLUETOOTH_SCAN"],
      defaultDesc: "We use Bluetooth to connect to nearby devices." },
    { key: "motion", label: "Motion / fitness", needsDesc: true,
      iosUsage: ["NSMotionUsageDescription"], android: ["android.permission.ACTIVITY_RECOGNITION"],
      defaultDesc: "We use motion data for fitness tracking." },
    { key: "speech", label: "Speech recognition", needsDesc: true,
      iosUsage: ["NSSpeechRecognitionUsageDescription"], android: [],
      defaultDesc: "We use speech recognition to transcribe your voice." },
    { key: "files", label: "Storage / files", needsDesc: false,
      iosUsage: [], android: ["android.permission.READ_MEDIA_VIDEO", "android.permission.READ_MEDIA_AUDIO"],
      defaultDesc: "" },
    { key: "backgroundAudio", label: "Background audio", needsDesc: false,
      iosBackgroundModes: ["audio"],
      android: ["android.permission.FOREGROUND_SERVICE", "android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK"],
      defaultDesc: "" }
  ];
  function permissionByKey(key) {
    for (var i = 0; i < PERMISSION_CATALOG.length; i++) if (PERMISSION_CATALOG[i].key === key) return PERMISSION_CATALOG[i];
    return null;
  }

  // Normalize the user's permission selection into [{key, label, description, ...catalog}].
  function normalizePermissions(input) {
    var out = [];
    var list = Array.isArray(input) ? input : [];
    list.forEach(function (p) {
      if (!p || !p.key) return;
      var cat = permissionByKey(p.key);
      if (!cat) return;
      out.push({
        key: cat.key, label: cat.label, needsDesc: cat.needsDesc,
        description: boundedText(p.description == null ? "" : p.description, LIMITS.permissionDescription, cat.label + " description"),
        iosUsage: cat.iosUsage || [], iosBackgroundModes: cat.iosBackgroundModes || [], android: cat.android || []
      });
    });
    return out;
  }

  // Validation: which enabled permissions are missing a required description.
  function validatePermissions(permissions) {
    return normalizePermissions(permissions)
      .filter(function (p) { return p.needsDesc && !p.description; })
      .map(function (p) { return p.label; });
  }

  // ---------------------------------------------------------------------------
  // Social sign-in catalog. Each provider lists the credential fields the native
  // SDKs need. We standardize on @capgo/capacitor-social-login (Capacitor 8,
  // native Apple + Google) and return an idToken you can hand straight to
  // Supabase `auth.signInWithIdToken(...)` — which the generated apps already use.
  //
  //   - Apple on iOS needs no field (the bundle id IS the client id) — it works
  //     with just the "Sign in with Apple" capability. The Services ID + redirect
  //     URL are only used for the Android/web fallback flow, so they're optional.
  //   - Google needs a Web client ID (the OAuth audience Supabase verifies). The
  //     iOS client ID is required for the native iOS flow + its URL scheme.
  // ---------------------------------------------------------------------------
  var SOCIAL_AUTH_CATALOG = [
    { key: "apple", label: "Sign in with Apple",
      fields: [
        { key: "serviceId", label: "Services ID (Android/web)", required: false,
          placeholder: "com.yourapp.web" },
        { key: "redirectUrl", label: "Redirect URL (Android/web)", required: false,
          placeholder: "https://<project>.supabase.co/auth/v1/callback" }
      ] },
    { key: "google", label: "Sign in with Google",
      fields: [
        { key: "webClientId", label: "Web client ID", required: true,
          placeholder: "1234-web.apps.googleusercontent.com" },
        { key: "iosClientId", label: "iOS client ID (required for iOS)", required: false,
          placeholder: "1234-ios.apps.googleusercontent.com" }
      ] }
  ];
  function socialProviderByKey(key) {
    for (var i = 0; i < SOCIAL_AUTH_CATALOG.length; i++) if (SOCIAL_AUTH_CATALOG[i].key === key) return SOCIAL_AUTH_CATALOG[i];
    return null;
  }

  // A Google iOS client id reversed into its URL scheme:
  // "123-ios.apps.googleusercontent.com" -> "com.googleusercontent.apps.123-ios".
  function reverseGoogleClientId(id) {
    return String(id || "").trim().split(".").reverse().join(".");
  }

  // Normalize the social-auth selection into [{key, label, fields, values}] for
  // each ENABLED provider. Input shape: { apple: {enabled, serviceId, ...}, google: {...} }.
  function normalizeSocialAuth(input) {
    input = input || {};
    var out = [];
    SOCIAL_AUTH_CATALOG.forEach(function (prov) {
      var raw = input[prov.key];
      if (!raw || raw.enabled !== true) return;
      var values = {};
      prov.fields.forEach(function (f) {
        var value = boundedText(raw[f.key] == null ? "" : raw[f.key], LIMITS.socialValue, prov.label + " " + f.label);
        if (value && f.key === "redirectUrl") {
          try {
            var u = new URL(value);
            if (u.protocol !== "https:") throw new Error("bad protocol");
          } catch (e) {
            throw new Error(prov.label + " redirect URL must be a valid https URL.");
          }
        } else if (value && !/^[a-zA-Z0-9._~:/@?#[\]$&'()*+,;=%-]+$/.test(value)) {
          throw new Error(prov.label + " " + f.label + " contains invalid characters.");
        }
        values[f.key] = value;
      });
      out.push({ key: prov.key, label: prov.label, fields: prov.fields, values: values });
    });
    return out;
  }
  function hasSocialProvider(list, key) {
    for (var i = 0; i < list.length; i++) if (list[i].key === key) return list[i];
    return null;
  }

  // Validation: enabled providers missing a required credential. Returns
  // ["Sign in with Google: Web client ID", ...] for the UI to surface.
  function validateSocialAuth(input) {
    var problems = [];
    normalizeSocialAuth(input).forEach(function (p) {
      p.fields.forEach(function (f) {
        if (f.required && !p.values[f.key]) problems.push(p.label + ": " + f.label);
      });
    });
    return problems;
  }

  // ---------------------------------------------------------------------------
  // File templates. Each returns a string. Kept as functions so they can close
  // over the normalized config without any templating dependency.
  // ---------------------------------------------------------------------------

  function fileCapacitorConfig(c) {
    var plugins = [
      "    SplashScreen: {",
      "      launchShowDuration: 1200,",
      "      backgroundColor: \"#0b0b12\",",
      "      showSpinner: false,",
      "      androidScaleType: \"CENTER_CROP\"",
      "    }"
    ];
    if (c.enablePush) {
      plugins.push(
        "    ,FirebaseMessaging: {",
        "      presentationOptions: [\"badge\", \"sound\", \"alert\"]",
        "    }"
      );
    }
    return [
      (c.enablePush ? "/// <reference types=\"@capacitor-firebase/messaging\" />\n" : "") +
      "import type { CapacitorConfig } from '@capacitor/cli';",
      "",
      "// Generated by Nativize. appId is reverse-DNS and must match the bundle",
      "// identifier you register in App Store Connect / Google Play Console.",
      "const config: CapacitorConfig = {",
      "  appId: " + jsString(c.appId) + ",",
      "  appName: " + jsString(c.appName) + ",",
      "  webDir: " + jsString(c.webDir) + ",",
      "  // Lovable apps are SPAs; bundledWebRuntime stays false (we ship the web build).",
      "  plugins: {",
      plugins.join("\n"),
      "  }" + (c.iosHeader ? "," : ""),
      // iOS Dynamic Island header: let the WebView draw under the status bar so
      // the injected frosted bar (CSS env(safe-area-inset-top)) owns the strip.
      (c.iosHeader ? "  ios: { contentInset: \"never\" }" : ""),
      "};",
      "",
      "export default config;",
      ""
    ].join("\n");
  }

  function fileNativizeSh(c) {
    var addPush = c.enablePush
      ? "npm install --legacy-peer-deps @capacitor-firebase/messaging firebase\n"
      : "";
    var addSocial = c.enableSocialAuth
      ? "npm install --legacy-peer-deps @capgo/capacitor-social-login\n"
      : "";
    return [
      "#!/usr/bin/env bash",
      "# Nativize one-shot local setup. Run from your project root AFTER you have",
      "# a production web build in ./" + c.webDir + " (e.g. `npm run build`).",
      "set -euo pipefail",
      "",
      "# CocoaPods (iOS) aborts with an Encoding::CompatibilityError unless the",
      "# shell uses a UTF-8 locale. Export one if the environment doesn't set it.",
      "if [ -z \"${LANG:-}\" ] || ! echo \"${LANG:-}\" | grep -qi 'utf-8\\|utf8'; then",
      "  export LANG=en_US.UTF-8",
      "  export LC_ALL=en_US.UTF-8",
      "fi",
      "",
      "NODE_MAJOR=$(node -p \"process.versions.node.split('.')[0]\" 2>/dev/null || echo 0)",
      "if [ \"$NODE_MAJOR\" -lt 22 ]; then",
      "  echo 'Capacitor 8 requires Node.js 22 or newer.' >&2",
      "  exit 1",
      "fi",
      "",
      "echo '==> Installing Capacitor 8 core + CLI + native platforms'",
      "npm install --legacy-peer-deps @capacitor/core@^8 @capacitor/cli@^8 typescript",
      "npm install --legacy-peer-deps @capacitor/ios@^8 @capacitor/android@^8",
      "npm install --legacy-peer-deps @capacitor/splash-screen@^8",
      addPush + addSocial + "",
      "echo '==> Ensuring web build exists in ./" + c.webDir + "'",
      "if [ ! -d \"" + c.webDir + "\" ]; then",
      "  echo 'No ./" + c.webDir + " found — running build first.'",
      "  npm run build",
      "fi",
      (c.watermark || c.iosHeader ? "\necho '==> Injecting selected web snippets'\nbash ./nativize-inject.sh" : ""),
      "",
      "echo '==> Adding native platforms (idempotent)'",
      "if [ -d ios ]; then echo 'ios already added'; else npx cap add ios; fi",
      "if [ -d android ]; then echo 'android already added'; else npx cap add android; fi",
      "",
      "echo '==> Pinning Android toolchain (Capacitor 8 needs AGP " + c.agpVersion + " / Gradle " + c.gradleVersion + ")'",
      "bash ./nativize-patch-android.sh",
      "",
      "echo '==> Syncing web assets + native config'",
      "npx cap sync",
      (c.enablePush ? "\necho '==> Applying Firebase preview config for push'\nbash ./nativize-push-config.sh" : ""),
      "",
      "echo '==> Applying native permissions'",
      "bash ./nativize-permissions.sh",
      (c.hasCustomIcon ? "\necho '==> Generating app icons from your logo'\nbash ./nativize-icons.sh" : ""),
      (c.enableSocialAuth ? "\necho '==> Applying social sign-in native config (iOS)'\nbash ./nativize-social-auth.sh" : ""),
      "",
      "echo '==> Done. Open native projects with:'",
      "echo '      npx cap open ios       # needs Xcode'",
      "echo '      npx cap open android   # needs Android Studio'",
      "echo 'Or just push to GitHub and let .github/workflows/nativize-build.yml build in the cloud.'",
      ""
    ].join("\n");
  }

  function filePatchAndroidSh(c) {
    // AGP/Gradle are written by `cap add android` into generated files; we pin
    // them deterministically with portable sed so the cloud build matches local.
    return [
      "#!/usr/bin/env bash",
      "# Pin the Android toolchain to versions Capacitor 8 actually supports.",
      "# IMPORTANT: Capacitor 8 does NOT support AGP 9. Using AGP 9 fails the build.",
      "set -euo pipefail",
      "",
      "if [ ! -d android ]; then",
      "  echo 'android/ not present yet — run `npx cap add android` first.'",
      "  exit 0",
      "fi",
      "",
      "AGP='" + c.agpVersion + "'",
      "GRADLE='" + c.gradleVersion + "'",
      "",
      "# 1) Pin AGP in android/build.gradle",
      "if [ -f android/build.gradle ]; then",
      "  perl -0pi -e \"s/com\\\\.android\\\\.tools\\\\.build:gradle:[0-9.]+/com.android.tools.build:gradle:$AGP/g\" android/build.gradle || true",
      "fi",
      "",
      "# 2) Pin the Gradle wrapper",
      "WRAP=android/gradle/wrapper/gradle-wrapper.properties",
      "if [ -f \"$WRAP\" ]; then",
      "  perl -0pi -e \"s/gradle-[0-9.]+-(all|bin)\\\\.zip/gradle-$GRADLE-bin.zip/g\" \"$WRAP\"",
      "fi",
      "",
      "# 3) The splash.xml duplicate-resource trap.",
      "#    @capacitor/splash-screen and a generated splash drawable can BOTH define",
      "#    res/drawable/splash.xml, which fails the merge with:",
      "#      'Duplicate resources: drawable/splash.xml'.",
      "#    De-dupe defensively: keep one copy.",
      "SPLASH_A=android/app/src/main/res/drawable/splash.xml",
      "SPLASH_B=android/app/src/main/res/drawable-port-mdpi/splash.xml",
      "if [ -f \"$SPLASH_A\" ] && [ -f \"$SPLASH_B\" ]; then",
      "  echo 'WARNING: duplicate splash.xml detected — removing the drawable-port-mdpi copy.'",
      "  rm -f \"$SPLASH_B\"",
      "fi",
      "",
      "# 4) AdMob launch-crash guard. The Google Mobile Ads SDK (pulled in by",
      "#    @capacitor-community/admob) CRASHES the app on startup if the manifest",
      "#    lacks com.google.android.gms.ads.APPLICATION_ID. A fresh `cap add android`",
      "#    never adds it, so inject Google's official TEST app id when AdMob is used.",
      "#    >>> REPLACE the value with YOUR real AdMob App ID before release. <<<",
      "MANIFEST=android/app/src/main/AndroidManifest.xml",
      "if [ -f package.json ] && grep -qi 'admob' package.json && [ -f \"$MANIFEST\" ]; then",
      "  if ! grep -q 'com.google.android.gms.ads.APPLICATION_ID' \"$MANIFEST\"; then",
      "    echo 'AdMob detected — injecting APPLICATION_ID meta-data (TEST id; replace with yours).'",
      "    export NZ_ADMOB_META='        <meta-data android:name=\"com.google.android.gms.ads.APPLICATION_ID\" android:value=\"ca-app-pub-3940256099942544~3347511713\"/>'",
      "    perl -0pi -e 's/(<activity)/$ENV{NZ_ADMOB_META}\\n        $1/' \"$MANIFEST\"",
      "  fi",
      "  # The Google Mobile Ads SDK auto-init content provider (MobileAdsInitProvider)",
      "  # crashes the app at startup whenever ad config isn't perfect. Remove it via",
      "  # the manifest merger — the admob plugin still initializes ads on demand from JS.",
      "  if ! grep -q 'MobileAdsInitProvider' \"$MANIFEST\"; then",
      "    echo 'Removing MobileAdsInitProvider auto-init to prevent the AdMob startup crash.'",
      "    grep -q 'xmlns:tools' \"$MANIFEST\" || perl -0pi -e 's/(<manifest\\b)/$1 xmlns:tools=\"http:\\/\\/schemas.android.com\\/tools\"/' \"$MANIFEST\"",
      "    export NZ_ADMOB_PROV='        <provider android:name=\"com.google.android.gms.ads.MobileAdsInitProvider\" android:authorities=\"${applicationId}.mobileadsinitprovider\" tools:node=\"remove\" />'",
      "    perl -0pi -e 's/(<activity)/$ENV{NZ_ADMOB_PROV}\\n        $1/' \"$MANIFEST\"",
      "  fi",
      "fi",
      "",
      "echo \"Pinned AGP=$AGP, Gradle=$GRADLE.\"",
      ""
    ].join("\n");
  }

  function fileWorkflow(c) {
    // Two jobs: Android on ubuntu (fast, free, produces installable apk/aab),
    // iOS on macOS (compiles, no signing so it validates the build for free).
    return [
      "name: Nativize Build",
      "",
      "# Manual trigger so builds don't fire on every push. Run it from the",
      "# Actions tab once your web build + Capacitor config are committed.",
      "on:",
      "  workflow_dispatch:",
      "",
      "jobs:",
      "  android:",
      "    name: Android (.apk + .aab)" + (c.buildAndroid ? "" : "\n    if: ${{ false }}  # Android builds require a paid Nativize plan"),
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - uses: actions/checkout@v4",
      "      - uses: actions/setup-node@v4",
      "        with:",
      "          node-version: 22",
      "      - uses: actions/setup-java@v4",
      "        with:",
      "          distribution: temurin",
      "          java-version: 21",
      "      - name: Install deps + build web",
      "        run: |",
      "          npm ci --legacy-peer-deps || npm install --legacy-peer-deps",
      "          npm install --no-save --legacy-peer-deps typescript @capacitor/core@^8 @capacitor/cli@^8 @capacitor/android@^8 @capacitor/splash-screen@^8" + (c.enablePush ? " @capacitor-firebase/messaging firebase" : "") + (c.enableSocialAuth ? " @capgo/capacitor-social-login" : ""),
      "          npm run build" + ((c.watermark || c.iosHeader) ? "\n          bash ./nativize-inject.sh" : ""),
      "      - name: Add Android platform + sync",
      "        run: |",
      "          if [ -d android ]; then echo 'android already added'; else npx cap add android; fi",
      "          bash ./nativize-patch-android.sh",
      "          npx cap sync android",
      (c.enablePush ? "          bash ./nativize-push-config.sh" : ""),
      "          bash ./nativize-permissions.sh",
      (c.hasCustomIcon ? "          bash ./nativize-icons.sh" : ""),
      "      - name: Assemble debug APK",
      "        working-directory: android",
      "        run: ./gradlew assembleDebug --stacktrace",
      "      - name: Bundle release AAB (unsigned)",
      "        working-directory: android",
      "        run: ./gradlew bundleRelease --stacktrace",
      "      - name: Stage Android download",
      "        run: |",
      "          rm -rf \"nativize-downloads/Nativized Android\"",
      "          mkdir -p \"nativize-downloads/Nativized Android/builds\" \"nativize-downloads/Nativized Android/project\"",
      "          cp NATIVIZE_README.md \"nativize-downloads/Nativized Android/NATIVIZE_README.md\"",
      "          cp android/app/build/outputs/apk/debug/*.apk \"nativize-downloads/Nativized Android/builds/\" || true",
      "          cp android/app/build/outputs/bundle/release/*.aab \"nativize-downloads/Nativized Android/builds/\" || true",
      "          rsync -a --exclude 'build' android \"nativize-downloads/Nativized Android/project/\"",
      "          cp capacitor.config.ts \"nativize-downloads/Nativized Android/project/capacitor.config.ts\"",
      "      - name: Upload Nativized Android",
      "        uses: actions/upload-artifact@v4",
      "        with:",
      "          name: Nativized Android",
      "          path: nativize-downloads/Nativized Android/**",
      "          if-no-files-found: error",
      "",
      "  ios:",
      "    name: iOS (compile, unsigned)",
      "    runs-on: macos-26",
      "    steps:",
      "      - uses: actions/checkout@v4",
      "      - uses: actions/setup-node@v4",
      "        with:",
      "          node-version: 22",
      "      - name: Install deps + build web",
      "        run: |",
      "          npm ci --legacy-peer-deps || npm install --legacy-peer-deps",
      "          npm install --no-save --legacy-peer-deps typescript @capacitor/core@^8 @capacitor/cli@^8 @capacitor/ios@^8 @capacitor/splash-screen@^8" + (c.enablePush ? " @capacitor-firebase/messaging firebase" : "") + (c.enableSocialAuth ? " @capgo/capacitor-social-login" : ""),
      "          npm run build" + ((c.watermark || c.iosHeader) ? "\n          bash ./nativize-inject.sh" : ""),
      "      - name: Add iOS platform + sync",
      "        env:",
      "          LANG: en_US.UTF-8",
      "          LC_ALL: en_US.UTF-8",
      "        run: |",
      "          # A committed ios/ can be an incomplete stub (no Xcode project / Podfile),",
      "          # which makes 'cap sync' fail. Recreate it cleanly in that case.",
      "          if [ ! -f ios/App/App.xcodeproj/project.pbxproj ] && [ ! -f ios/App/Podfile ]; then",
      "            rm -rf ios",
      "            npx cap add ios",
      "          fi",
      "          npx cap sync ios",
      (c.enablePush ? "          bash ./nativize-push-config.sh" : ""),
      "          bash ./nativize-permissions.sh",
      (c.enableSocialAuth ? "          bash ./nativize-social-auth.sh" : ""),
      (c.hasCustomIcon ? "          bash ./nativize-icons.sh" : ""),
      "      - name: AdMob iOS guard (GADApplicationIdentifier)",
      "        run: |",
      "          # iOS counterpart of the Android AdMob fix: the Google Mobile Ads SDK",
      "          # crashes at launch if Info.plist lacks GADApplicationIdentifier. Inject",
      "          # Google's TEST id when AdMob is used. >>> Replace with YOUR id before release. <<<",
      "          PLIST=ios/App/App/Info.plist",
      "          if grep -qi admob package.json && [ -f \"$PLIST\" ] && ! /usr/libexec/PlistBuddy -c 'Print :GADApplicationIdentifier' \"$PLIST\" >/dev/null 2>&1; then",
      "            /usr/libexec/PlistBuddy -c 'Add :GADApplicationIdentifier string ca-app-pub-3940256099942544~3347511713' \"$PLIST\"",
      "            echo 'Injected GADApplicationIdentifier (TEST id) to prevent the iOS AdMob launch crash.'",
      "          fi",
      "      - name: Resolve native dependencies",
      "        working-directory: ios/App",
      "        env:",
      "          LANG: en_US.UTF-8",
      "          LC_ALL: en_US.UTF-8",
      "        run: |",
      "          if [ -f Podfile ]; then pod install; else echo 'No Podfile (SPM) - resolved during build'; fi",
      "      - name: Compile app (no signing - validates the build for free)",
      "        working-directory: ios/App",
      "        run: |",
      "          if [ -d App.xcworkspace ]; then PROJ='-workspace App.xcworkspace'; else PROJ='-project App.xcodeproj'; fi",
      "          xcodebuild $PROJ \\",
      "            -scheme App \\",
      "            -configuration Debug \\",
      "            -sdk iphoneos \\",
      "            -destination 'generic/platform=iOS' \\",
      "            -derivedDataPath DerivedData \\",
      "            CODE_SIGNING_ALLOWED=NO \\",
      "            clean build",
      "      - name: Compile for iOS Simulator (runnable in Xcode Simulator)",
      "        working-directory: ios/App",
      "        run: |",
      "          DEVICE=$(python3 - <<'PY'",
      "          import json, subprocess, sys",
      "          data = json.loads(subprocess.check_output(['xcrun', 'simctl', 'list', 'devices', 'available', '-j']))",
      "          candidates = []",
      "          for runtime, devices in data.get('devices', {}).items():",
      "              if 'iOS' not in runtime:",
      "                  continue",
      "              for device in devices:",
      "                  if device.get('isAvailable') and 'iPhone' in device.get('name', ''):",
      "                      candidates.append(device)",
      "          if not candidates:",
      "              raise SystemExit('No available iPhone simulator found')",
      "          booted = next((device for device in candidates if device.get('state') == 'Booted'), None)",
      "          print((booted or candidates[0])['udid'])",
      "          PY",
      "          )",
      "          echo \"Using iOS simulator: $DEVICE\"",
      "          xcrun simctl boot \"$DEVICE\" || true",
      "          xcrun simctl bootstatus \"$DEVICE\" -b",
      "          if [ -d App.xcworkspace ]; then PROJ='-workspace App.xcworkspace'; else PROJ='-project App.xcodeproj'; fi",
      "          xcodebuild $PROJ \\",
      "            -scheme App \\",
      "            -configuration Debug \\",
      "            -sdk iphonesimulator \\",
      "            -destination 'generic/platform=iOS Simulator' \\",
      "            -derivedDataPath DerivedDataSim \\",
      "            clean build",
      "          echo \"$DEVICE\" > DerivedDataSim/nativize-simulator-udid.txt",
      "      - name: Smoke test iOS Simulator launch",
      "        working-directory: ios/App",
      "        run: |",
      "          APP_PATH=$(find DerivedDataSim/Build/Products/Debug-iphonesimulator -maxdepth 1 -name '*.app' -type d | head -n 1)",
      "          test -d \"$APP_PATH\"",
      "          if [ -f DerivedDataSim/nativize-simulator-udid.txt ]; then",
      "            DEVICE=$(cat DerivedDataSim/nativize-simulator-udid.txt)",
      "          else",
      "            DEVICE=$(python3 - <<'PY'",
      "          import json, subprocess, sys",
      "          data = json.loads(subprocess.check_output(['xcrun', 'simctl', 'list', 'devices', 'available', '-j']))",
      "          candidates = []",
      "          for runtime, devices in data.get('devices', {}).items():",
      "              if 'iOS' not in runtime:",
      "                  continue",
      "              for device in devices:",
      "                  if device.get('isAvailable') and 'iPhone' in device.get('name', ''):",
      "                      candidates.append(device)",
      "          if not candidates:",
      "              raise SystemExit('No available iPhone simulator found')",
      "          booted = next((device for device in candidates if device.get('state') == 'Booted'), None)",
      "          print((booted or candidates[0])['udid'])",
      "          PY",
      "            )",
      "          fi",
      "          BUNDLE_ID=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' \"$APP_PATH/Info.plist\" 2>/dev/null || true)",
      "          if [ -z \"$BUNDLE_ID\" ] || [[ \"$BUNDLE_ID\" == *'$('* ]]; then BUNDLE_ID=\"" + c.appId + "\"; fi",
      "          APP_EXEC=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' \"$APP_PATH/Info.plist\" 2>/dev/null || echo App)",
      "          echo \"Smoke testing $BUNDLE_ID from $APP_PATH\"",
      "          xcrun simctl boot \"$DEVICE\" || true",
      "          xcrun simctl bootstatus \"$DEVICE\" -b",
      "          xcrun simctl install \"$DEVICE\" \"$APP_PATH\"",
      "          LAUNCH_LOG=$(mktemp)",
      "          set +e",
      "          xcrun simctl launch --terminate-running-process \"$DEVICE\" \"$BUNDLE_ID\" >\"$LAUNCH_LOG\" 2>&1",
      "          STATUS=$?",
      "          cat \"$LAUNCH_LOG\"",
      "          set -e",
      "          if [ \"$STATUS\" -ne 0 ]; then",
      "            echo '::group::iOS simulator launch diagnostics'",
      "            echo \"Built app: $APP_PATH\"",
      "            /usr/bin/file \"$APP_PATH/$APP_EXEC\" || true",
      "            codesign -dv --verbose=4 \"$APP_PATH\" 2>&1 || true",
      "            xcrun simctl get_app_container \"$DEVICE\" \"$BUNDLE_ID\" app || true",
      "            xcrun simctl spawn \"$DEVICE\" log show --last 3m --style compact --predicate \"process == '$APP_EXEC' OR eventMessage CONTAINS[c] '$BUNDLE_ID' OR eventMessage CONTAINS[c] 'code signature' OR eventMessage CONTAINS[c] 'crash'\" || true",
      "            echo '::endgroup::'",
      "            exit \"$STATUS\"",
      "          fi",
      "          sleep 4",
      "          xcrun simctl terminate \"$DEVICE\" \"$BUNDLE_ID\" || true",
      "      - name: Package iOS Simulator preview",
      "        working-directory: ios/App",
      "        run: |",
      "          APP_PATH=$(find DerivedDataSim/Build/Products/Debug-iphonesimulator -maxdepth 1 -name '*.app' -type d | head -n 1)",
      "          test -d \"$APP_PATH\"",
      "          BUNDLE_ID=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' \"$APP_PATH/Info.plist\" 2>/dev/null || true)",
      "          if [ -z \"$BUNDLE_ID\" ] || [[ \"$BUNDLE_ID\" == *'$('* ]]; then BUNDLE_ID=\"" + c.appId + "\"; fi",
      "          rm -rf \"../nativize-downloads/Nativized iOS Preview\"",
      "          mkdir -p \"../nativize-downloads/Nativized iOS Preview\"",
      "          mkdir -p \"../nativize-downloads/Nativized iOS Preview/payload\"",
      "          cp ../../NATIVIZE_README.md \"../nativize-downloads/Nativized iOS Preview/NATIVIZE_README.md\"",
      "          ditto \"$APP_PATH\" \"../nativize-downloads/Nativized iOS Preview/payload/$(basename \"$APP_PATH\")\"",
      "          (cd \"../nativize-downloads/Nativized iOS Preview/payload\" && /usr/bin/tar -czf ../ios-simulator-preview-app.tar.gz \"$(basename \"$APP_PATH\")\")",
      "          rm -rf \"../nativize-downloads/Nativized iOS Preview/payload\"",
      "          cat > \"../nativize-downloads/Nativized iOS Preview/README.txt\" <<'EOF'",
      "          Nativize iOS Simulator preview",
      "",
      "          This is not a Mac app and should not be double-clicked.",
      "          Chrome downloads this package safely because the simulator app is stored inside:",
      "          ios-simulator-preview-app.tar.gz",
      "",
      "          To open it on a Mac with Xcode installed:",
      "          1. Unzip this download.",
      "          2. Open Terminal.",
      "          3. Run:",
      "             cd into the unzipped Nativized iOS Preview folder",
      "             bash install-in-simulator.txt",
      "",
      "          If your unzipped folder has a different name, cd into that folder first,",
      "          then run:",
      "             bash install-in-simulator.txt",
      "          EOF",
      "          cat > \"../nativize-downloads/Nativized iOS Preview/install-in-simulator.txt\" <<'EOF'",
      "          # Recommended:",
      "          #   cd into the unzipped Nativized iOS Preview folder",
      "          #   bash install-in-simulator.txt",
      "          #",
      "          # If you pasted this whole file instead, it will also try to find the newest",
      "          # Nativize preview in Downloads/Desktop.",
      "          set -euo pipefail",
      "          HERE=\"$(pwd)\"",
      "          if [ ! -f \"$HERE/ios-simulator-preview-app.tar.gz\" ]; then",
      "            FOUND=\"$(python3 - <<'PY'",
      "          from pathlib import Path",
      "          matches = []",
      "          for root in (Path.home() / 'Downloads', Path.home() / 'Desktop'):",
      "              if root.exists():",
      "                  matches.extend(root.glob('**/ios-simulator-preview-app.tar.gz'))",
      "          if matches:",
      "              print(max(matches, key=lambda p: p.stat().st_mtime))",
      "          PY",
      "            )\"",
      "            if [ -n \"$FOUND\" ]; then",
      "              HERE=\"$(cd \"$(dirname \"$FOUND\")\" && pwd)\"",
      "              echo \"Using Nativize preview folder: $HERE\"",
      "            else",
      "              echo 'Could not find ios-simulator-preview-app.tar.gz. Unzip the download, then run these commands from that folder.'",
      "              exit 1",
      "            fi",
      "          fi",
      "          /usr/bin/tar -xzf \"$HERE/ios-simulator-preview-app.tar.gz\" -C \"$HERE\"",
      "          APP_PATH=\"$(find \"$HERE\" -maxdepth 1 -name '*.app' -type d | head -n 1)\"",
      "          if [ ! -d \"$APP_PATH\" ]; then echo 'No iOS Simulator .app found after extracting the preview payload.'; exit 1; fi",
      "          BUNDLE_ID=\"$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' \"$APP_PATH/Info.plist\" 2>/dev/null || true)\"",
      "          if [ -z \"$BUNDLE_ID\" ] || [[ \"$BUNDLE_ID\" == *'$('* ]]; then BUNDLE_ID=\"" + c.appId + "\"; fi",
      "          DEVICE=\"${1:-}\"",
      "          if [ -z \"$DEVICE\" ]; then",
      "            DEVICE=$(python3 - <<'PY'",
      "          import json, subprocess, sys",
      "          data = json.loads(subprocess.check_output(['xcrun', 'simctl', 'list', 'devices', 'available', '-j']))",
      "          candidates = []",
      "          for runtime, devices in data.get('devices', {}).items():",
      "              if 'iOS' not in runtime:",
      "                  continue",
      "              for device in devices:",
      "                  if device.get('isAvailable') and 'iPhone' in device.get('name', ''):",
      "                      candidates.append(device)",
      "          if not candidates:",
      "              raise SystemExit('No available iPhone simulator found')",
      "          booted = next((device for device in candidates if device.get('state') == 'Booted'), None)",
      "          print((booted or candidates[0])['udid'])",
      "          PY",
      "            )",
      "          fi",
      "          open -a Simulator || true",
      "          xcrun simctl boot \"$DEVICE\" 2>/dev/null || true",
      "          xcrun simctl bootstatus \"$DEVICE\" -b",
      "          xcrun simctl install \"$DEVICE\" \"$APP_PATH\"",
      "          xcrun simctl launch --terminate-running-process \"$DEVICE\" \"$BUNDLE_ID\"",
      "          EOF",
      "      - name: Upload tested iOS Simulator preview",
      "        uses: actions/upload-artifact@v4",
      "        with:",
      "          name: Nativized iOS Preview",
      "          path: ios/nativize-downloads/Nativized iOS Preview/**",
      "          if-no-files-found: error",
      "      - name: Stage iOS Xcode project",
      (c.watermark ? "        if: ${{ false }}  # Xcode project download requires a paid Nativize plan" : ""),
      "        run: |",
      "          rm -rf \"nativize-downloads/Nativized iOS\"",
      "          mkdir -p \"nativize-downloads/Nativized iOS/project\"",
      "          cp NATIVIZE_README.md \"nativize-downloads/Nativized iOS/NATIVIZE_README.md\"",
      "          rsync -a --exclude 'DerivedData' --exclude 'DerivedDataSim' ios \"nativize-downloads/Nativized iOS/project/\"",
      "          cp capacitor.config.ts \"nativize-downloads/Nativized iOS/project/capacitor.config.ts\"",
      "      - name: Upload Nativized iOS",
      (c.watermark ? "        if: ${{ false }}  # Xcode project download requires a paid Nativize plan" : ""),
      "        uses: actions/upload-artifact@v4",
      "        with:",
      "          name: Nativized iOS",
      "          path: nativize-downloads/Nativized iOS/**",
      "          if-no-files-found: error",
      "",
      "  # ---- Desktop apps (Electron) - double-click .dmg / .exe ----",
      "  desktop-mac:",
      "    name: Desktop (macOS .dmg)" + (c.buildMac ? "" : "\n    if: ${{ false }}  # macOS builds require a paid Nativize plan"),
      "    runs-on: macos-latest",
      "    steps:",
      "      - uses: actions/checkout@v4",
      "      - uses: actions/setup-node@v4",
      "        with:",
      "          node-version: 22",
      "      - name: Install deps + build web",
      "        run: |",
      "          npm ci --legacy-peer-deps || npm install --legacy-peer-deps",
      "          npm run build" + ((c.watermark || c.iosHeader) ? "\n          bash ./nativize-inject.sh" : ""),
      "      - name: Package desktop app",
      "        run: |",
      "          rm -rf desktop/app && cp -r dist desktop/app",
      "          cd desktop",
      "          npm install",
      "          npx --no-install electron-builder --mac --publish never",
      "      - name: Stage macOS desktop app",
      "        run: |",
      "          rm -rf \"desktop/nativize-downloads/Nativized Desktop\"",
      "          mkdir -p \"desktop/nativize-downloads/Nativized Desktop\"",
      "          cp NATIVIZE_README.md \"desktop/nativize-downloads/Nativized Desktop/NATIVIZE_README.md\"",
      "          cp desktop/out/*.dmg \"desktop/nativize-downloads/Nativized Desktop/\"",
      "      - name: Upload Nativized Desktop",
      "        uses: actions/upload-artifact@v4",
      "        with:",
      "          name: Nativized Desktop",
      "          path: desktop/nativize-downloads/Nativized Desktop/**",
      "          if-no-files-found: error",
      "",
      "  desktop-windows:",
      "    name: Desktop (Windows .exe)" + (c.buildWindows ? "" : "\n    if: ${{ false }}  # Windows builds require a paid Nativize plan"),
      "    runs-on: windows-latest",
      "    steps:",
      "      - uses: actions/checkout@v4",
      "      - uses: actions/setup-node@v4",
      "        with:",
      "          node-version: 22",
      "      - name: Install deps + build web",
      "        shell: bash",
      "        run: |",
      "          npm ci --legacy-peer-deps || npm install --legacy-peer-deps",
      "          npm run build" + ((c.watermark || c.iosHeader) ? "\n          bash ./nativize-inject.sh" : ""),
      "      - name: Package desktop app",
      "        shell: bash",
      "        run: |",
      "          rm -rf desktop/app && cp -r dist desktop/app",
      "          cd desktop",
      "          npm install",
      "          npx --no-install electron-builder --win --publish never",
      "      - name: Stage Windows desktop app",
      "        shell: bash",
      "        run: |",
      "          rm -rf \"desktop/nativize-downloads/Nativized Windows\"",
      "          mkdir -p \"desktop/nativize-downloads/Nativized Windows\"",
      "          cp NATIVIZE_README.md \"desktop/nativize-downloads/Nativized Windows/NATIVIZE_README.md\"",
      "          cp desktop/out/*.exe \"desktop/nativize-downloads/Nativized Windows/\"",
      "      - name: Upload Nativized Windows",
      "        uses: actions/upload-artifact@v4",
      "        with:",
      "          name: Nativized Windows",
      "          path: desktop/nativize-downloads/Nativized Windows/**",
      "          if-no-files-found: error",
      "",
      "  # ---- Materialize native projects INTO the repo so 'Download Full Source Code'",
      "  #      actually contains ios/ + android/ (Capacitor generates them on the fly;",
      "  #      this commits them back so the downloaded project is complete & openable).",
      "  materialize-project:",
      "    name: Commit native projects into the repo" + (c.watermark ? "\n    if: ${{ false }}  # Full native project materialization requires a paid Nativize plan" : ""),
      "    runs-on: macos-latest",
      "    permissions:",
      "      contents: write",
      "    steps:",
      "      - uses: actions/checkout@v4",
      "      - uses: actions/setup-node@v4",
      "        with:",
      "          node-version: 22",
      "      - name: Install deps + build web",
      "        run: |",
      "          npm ci --legacy-peer-deps || npm install --legacy-peer-deps",
      "          npm run build" + ((c.watermark || c.iosHeader) ? "\n          bash ./nativize-inject.sh" : ""),
      "      - name: Generate native projects (idempotent)",
      "        run: |",
      "          if [ ! -f ios/App/App.xcodeproj/project.pbxproj ] && [ ! -f ios/App/Podfile ]; then rm -rf ios; npx cap add ios; fi",
      "          if [ ! -d android/app ]; then npx cap add android; fi",
      "          bash ./nativize-patch-android.sh",
      (c.enableSocialAuth ? "          npm install --no-save --legacy-peer-deps @capgo/capacitor-social-login" : ""),
      "          npx cap sync",
      "          bash ./nativize-permissions.sh",
      (c.enableSocialAuth ? "          bash ./nativize-social-auth.sh" : ""),
      (c.hasCustomIcon ? "          bash ./nativize-icons.sh" : ""),
      "          # iOS AdMob guard so the committed project doesn't crash on launch.",
      "          PLIST=ios/App/App/Info.plist",
      "          if grep -qi admob package.json && [ -f \"$PLIST\" ] && ! /usr/libexec/PlistBuddy -c 'Print :GADApplicationIdentifier' \"$PLIST\" >/dev/null 2>&1; then",
      "            /usr/libexec/PlistBuddy -c 'Add :GADApplicationIdentifier string ca-app-pub-3940256099942544~3347511713' \"$PLIST\"",
      "          fi",
      "      - name: Commit ios/ + android/ + desktop/ back to the repo",
      "        run: |",
      "          git config user.name 'nativize-bot'",
      "          git config user.email '41898282+github-actions[bot]@users.noreply.github.com'",
      "          git add ios android desktop",
      "          if git diff --cached --quiet; then",
      "            echo 'Native projects already up to date.'",
      "          else",
      "            git commit -m 'chore(nativize): materialize ios/android native projects [skip ci]'",
      "            git push",
      "          fi",
      ""
    ].join("\n");
  }

  function fileNativePush(c) {
    // STATIC import only. A dynamic import() of @capacitor-firebase/messaging
    // silently fails to load its chunk inside the iOS WKWebView — the import
    // promise never rejects, push just never initializes. Static import bundles
    // the chunk so it's always present.
    return [
      "// nativePush.ts — generated by Nativize.",
      "// SAFE on web: every native call is guarded so this no-ops in a browser.",
      "//",
      "// CRITICAL: import statically. A dynamic import() of this plugin silently",
      "// fails to load its chunk inside the iOS WebView (no error, push just dies).",
      "import { FirebaseMessaging } from '@capacitor-firebase/messaging';",
      "import { Capacitor } from '@capacitor/core';",
      "",
      "export interface NativePushHandlers {",
      "  onToken?: (token: string) => void;",
      "  onMessage?: (payload: unknown) => void;",
      "}",
      "",
      "export async function initNativePush(handlers: NativePushHandlers = {}): Promise<void> {",
      "  // No native runtime (plain web) → do nothing.",
      "  if (!Capacitor.isNativePlatform()) return;",
      "",
      "  const perm = await FirebaseMessaging.requestPermissions();",
      "  if (perm.receive !== 'granted') return;",
      "",
      "  // APNs note (iOS): your Firebase APNs *Auth Key* must be enabled for BOTH",
      "  // Sandbox AND Production. A Production-only key throws THIRD_PARTY_AUTH_ERROR",
      "  // on local debug builds, which run against the APNs sandbox.",
      "  const { token } = await FirebaseMessaging.getToken();",
      "  handlers.onToken?.(token);",
      "",
      "  await FirebaseMessaging.addListener('notificationReceived', (event) => {",
      "    handlers.onMessage?.(event);",
      "  });",
      "}",
      ""
    ].join("\n");
  }

  function filePushConfigSh(c) {
    return [
      "#!/usr/bin/env bash",
      "# Generated by Nativize — keeps Firebase push preview builds launchable.",
      "# Replace these placeholder Firebase files with real Firebase console exports",
      "# before expecting push tokens or production delivery to work.",
      "set -euo pipefail",
      "APP_ID='" + c.appId + "'",
      "",
      "if [ -d ios/App/App ]; then",
      "  if [ ! -f ios/App/App/GoogleService-Info.plist ]; then",
      "    cat > ios/App/App/GoogleService-Info.plist <<PLIST",
      "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
      "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">",
      "<plist version=\"1.0\"><dict>",
      "  <key>GOOGLE_APP_ID</key><string>1:1234567890:ios:0000000000000000</string>",
      "  <key>GCM_SENDER_ID</key><string>1234567890</string>",
      "  <key>API_KEY</key><string>AIzaSyDUMMY0000000000000000000000000000</string>",
      "  <key>PROJECT_ID</key><string>nativize-preview</string>",
      "  <key>BUNDLE_ID</key><string>$APP_ID</string>",
      "  <key>IS_ADS_ENABLED</key><false/>",
      "  <key>IS_ANALYTICS_ENABLED</key><false/>",
      "  <key>IS_APPINVITE_ENABLED</key><false/>",
      "  <key>IS_GCM_ENABLED</key><true/>",
      "  <key>IS_SIGNIN_ENABLED</key><false/>",
      "</dict></plist>",
      "PLIST",
      "    echo '  created iOS placeholder GoogleService-Info.plist (replace it for real push)'",
      "  fi",
      "  if [ -f ios/App/App.xcodeproj/project.pbxproj ]; then",
      "    python3 - <<'PY'",
      "from pathlib import Path",
      "p = Path('ios/App/App.xcodeproj/project.pbxproj')",
      "s = p.read_text()",
      "if 'GoogleService-Info.plist in Resources' not in s:",
      "    file_id = '6E5A7F000000000000000001'",
      "    build_id = '6E5A7F000000000000000002'",
      "    s = s.replace('/* End PBXBuildFile section */', '\\t\\t' + build_id + ' /* GoogleService-Info.plist in Resources */ = {isa = PBXBuildFile; fileRef = ' + file_id + ' /* GoogleService-Info.plist */; };\\n/* End PBXBuildFile section */')",
      "    s = s.replace('/* End PBXFileReference section */', '\\t\\t' + file_id + ' /* GoogleService-Info.plist */ = {isa = PBXFileReference; lastKnownFileType = text.plist.xml; path = GoogleService-Info.plist; sourceTree = \"<group>\"; };\\n/* End PBXFileReference section */')",
      "    app_marker = '\\t\\t\\t\\t504EC3131FED79650016851F /* Info.plist */,'",
      "    if app_marker in s:",
      "        s = s.replace(app_marker, '\\t\\t\\t\\t' + file_id + ' /* GoogleService-Info.plist */,\\n' + app_marker, 1)",
      "    res_marker = '\\t\\t\\t\\t50379B232058CBB4000EE86E /* capacitor.config.json in Resources */,'",
      "    if res_marker in s:",
      "        s = s.replace(res_marker, '\\t\\t\\t\\t' + build_id + ' /* GoogleService-Info.plist in Resources */,\\n' + res_marker, 1)",
      "    p.write_text(s)",
      "PY",
      "  fi",
      "fi",
      "",
      "if [ -d android/app ] && [ ! -f android/app/google-services.json ]; then",
      "  cat > android/app/google-services.json <<JSON",
      "{",
      "  \"project_info\": {",
      "    \"project_number\": \"1234567890\",",
      "    \"project_id\": \"nativize-preview\",",
      "    \"storage_bucket\": \"nativize-preview.appspot.com\"",
      "  },",
      "  \"client\": [{",
      "    \"client_info\": {",
      "      \"mobilesdk_app_id\": \"1:1234567890:android:0000000000000000\",",
      "      \"android_client_info\": { \"package_name\": \"$APP_ID\" }",
      "    },",
      "    \"api_key\": [{ \"current_key\": \"AIzaSyDUMMY0000000000000000000000000000\" }],",
      "    \"services\": {}",
      "  }],",
      "  \"configuration_version\": \"1\"",
      "}",
      "JSON",
      "  echo '  created Android placeholder google-services.json (replace it for real push)'",
      "fi",
      ""
    ].join("\n");
  }

  function fileChecklist(c) {
    var pushSection = c.enablePush
      ? [
          "",
          "## Push notifications (enabled)",
          "- [ ] Create a Firebase project; add iOS + Android apps with appId `" + c.appId + "`.",
          "- [ ] Nativize adds placeholder Firebase config files so preview builds can launch; replace them before real push testing.",
          "- [ ] Download `google-services.json` → `android/app/`.",
          "- [ ] Download `GoogleService-Info.plist` → `ios/App/App/`.",
          "- [ ] In Apple Developer, create an **APNs Auth Key** enabled for **Sandbox & Production**.",
          "      A Production-only key causes `THIRD_PARTY_AUTH_ERROR` on local debug builds.",
          "- [ ] Upload the APNs key to Firebase → Cloud Messaging.",
          "- [ ] Call `initNativePush()` once after app start; confirm a token logs on a real device.",
          "- [ ] Verify `nativePush.ts` uses a **static** import (dynamic import() dies silently in the iOS WebView)."
        ].join("\n")
      : "";

    var socialSection = c.enableSocialAuth
      ? [
          "",
          "## Social sign-in (enabled)",
          "- [ ] See `SOCIAL_AUTH_SETUP.md` for the full provider setup.",
          (c.googleSignIn ? "- [ ] Google: Web client ID set in Supabase; iOS URL scheme injected by `nativize-social-auth.sh`." : ""),
          (c.appleSignIn ? "- [ ] Apple: add the **Sign in with Apple** capability in Xcode (entitlement is generated)." : ""),
          "- [ ] Wire `signInWith…()` from `src/nativeSocialAuth.ts` into your login screen.",
          "- [ ] Confirm sign-in on a real device returns an idToken and creates a Supabase session."
        ].filter(Boolean).join("\n")
      : "";

    return [
      "# " + c.appName + " — App Store + Play Store submission checklist",
      "",
      "Generated by Nativize. appId: `" + c.appId + "`",
      "",
      "## 0. Build validation (free, in the cloud)",
      "- [ ] Commit this kit to GitHub.",
      "- [ ] Run **Actions → Nativize Build** (workflow_dispatch).",
      "- [ ] Android job is green and uploads an `.apk` artifact.",
      "- [ ] iOS job compiles (xcodebuild with CODE_SIGNING_ALLOWED=NO).",
      "",
      "## 1. Local native setup",
      "- [ ] `bash nativize.sh` runs clean.",
      "- [ ] AGP is " + c.agpVersion + " and Gradle is " + c.gradleVersion + " (Capacitor 8 — NOT AGP 9).",
      "- [ ] No `Duplicate resources: drawable/splash.xml` error.",
      "",
      "## 2. Identity & assets",
      "- [ ] App icon (1024×1024) + adaptive Android icon set.",
      "- [ ] Splash screen matches `#0b0b12` background.",
      "- [ ] App name, appId `" + c.appId + "`, and version/build numbers set.",
      "",
      "## 3. iOS — App Store",
      "- [ ] Apple Developer Program membership active ($99/yr).",
      "- [ ] Bundle ID `" + c.appId + "` registered in the Apple Developer portal.",
      "- [ ] App record created in App Store Connect.",
      "- [ ] Signing: add your Distribution cert + provisioning profile, then archive in Xcode.",
      "- [ ] Upload build via Xcode Organizer / Transporter; submit for TestFlight.",
      "- [ ] Screenshots (6.7\" + 5.5\"), privacy nutrition labels, age rating, support URL.",
      "- [ ] Submit for App Review.",
      "",
      "## 4. Android — Play Store",
      "- [ ] Google Play Console account ($25 one-time).",
      "- [ ] Generate an upload keystore; configure release signing.",
      "- [ ] `./gradlew bundleRelease` → signed `.aab`.",
      "- [ ] Create the app in Play Console; complete the Data safety form.",
      "- [ ] Upload `.aab` to Internal testing, then promote to Production.",
      "- [ ] Store listing: title, descriptions, feature graphic, screenshots.",
      pushSection,
      socialSection,
      ""
    ].join("\n");
  }

  function fileReadme(c) {
    return [
      "# Native kit for " + c.appName,
      "",
      "Generated by **Nativize**. Turns this Lovable web app into native iOS +",
      "Android apps with Capacitor 8.",
      "",
      "## What this download contains",
      "",
      "Every Nativize download includes this `NATIVIZE_README.md` file at the top level.",
      "The exact files depend on your plan and the build you selected:",
      "",
      "- `Nativized iOS Preview` is a free, watermarked simulator preview for Mac users with Xcode installed.",
      "- `Nativized iOS` is the paid Xcode project package.",
      "- `Nativized Android` is the paid Android Studio project package plus APK/AAB build files.",
      "- `Nativized Desktop` is the paid macOS desktop package.",
      "- `Nativized Windows` is the paid Windows desktop package.",
      "- `Nativized Source Code` is the paid full repo archive available after a successful build.",
      "",
      "## Open and run the downloads",
      "",
      "### iOS preview on macOS",
      "",
      "Needed: a Mac with Xcode installed, including the iOS Simulator.",
      "",
      "1. Unzip `Nativized iOS Preview.zip`.",
      "2. Open Terminal.",
      "3. `cd` into the unzipped folder.",
      "4. Run `bash install-in-simulator.txt`.",
      "",
      "Do not double-click the `.app` inside the preview. It is an iOS Simulator app, not a macOS app.",
      "",
      "### iOS project in Xcode",
      "",
      "Needed: a Mac with Xcode installed.",
      "",
      "1. Unzip `Nativized iOS.zip` or the paid Full Source Code zip.",
      "2. Open the Xcode workspace inside `project/ios/App/App.xcworkspace`.",
      "3. Choose an iPhone Simulator and press Run.",
      "4. For App Store upload, add your Apple Developer Team, signing certificate, and provisioning profile in Xcode.",
      "",
      "### Android project in Android Studio",
      "",
      "Needed: Android Studio and JDK 21.",
      "",
      "1. Unzip `Nativized Android.zip`.",
      "2. In Android Studio, choose Open and select `project/android`.",
      "3. Let Gradle sync finish.",
      "4. Run on an emulator/device, or use the files in `builds/` for install and Play Console upload.",
      "",
      "### macOS desktop app",
      "",
      "Needed: a Mac. For sharing with other people, you also need Apple Developer ID signing and notarization.",
      "",
      "1. Unzip `Nativized Desktop.zip`.",
      "2. Open the `.dmg` file.",
      "3. Drag the app to Applications if prompted.",
      "4. If macOS warns about an unsigned app, right-click the app and choose Open for local testing.",
      "",
      "### Windows desktop app",
      "",
      "Needed: Windows 10 or newer. For sharing publicly, use a code-signing certificate.",
      "",
      "1. Unzip `Nativized Windows.zip`.",
      "2. Run the `.exe` installer.",
      "3. If SmartScreen appears during local testing, choose More info, then Run anyway.",
      "",
      "## Quick start",
      "```bash",
      "# 1. Local one-shot setup (needs Node; Xcode/Android Studio optional)",
      "bash nativize.sh",
      "",
      "# 2. OR skip local tooling entirely — push to GitHub and run the workflow:",
      "#    Actions → \"Nativize Build\" → Run workflow",
      "```",
      "",
      "| File | Purpose |",
      "|------|---------|",
      "| `capacitor.config.ts` | App identity + plugin config (appId `" + c.appId + "`). |",
      "| `nativize.sh` | One-shot local setup: install Capacitor, add platforms, sync. |",
      "| `nativize-patch-android.sh` | Pins AGP " + c.agpVersion + " / Gradle " + c.gradleVersion + "; de-dupes splash.xml. |",
      "| `.github/workflows/nativize-build.yml` | Cloud build: Android APK/AAB + iOS compile. |",
      (c.enablePush ? "| `src/nativePush.ts` | Firebase push (static import; no-ops on web). |\n" : "") +
      (c.enableSocialAuth ? "| `src/nativeSocialAuth.ts` | Native Apple/Google sign-in → Supabase idToken (no-ops on web). |\n| `nativize-social-auth.sh` | iOS URL scheme + Sign in with Apple entitlement. |\n" : "") +
      "| `CHECKLIST.md` | Full App Store + Play Store submission path. |",
      "",
      "## Gotchas baked in",
      "- **Capacitor 8 needs AGP " + c.agpVersion + " (NOT AGP 9)** + Gradle " + c.gradleVersion + ". Pinned automatically.",
      "- **splash.xml duplicate-resource trap** — de-duped by `nativize-patch-android.sh`.",
      (c.enablePush
        ? "- **Push uses a static import** — a dynamic import() silently fails in the iOS WebView.\n- **APNs key must be Sandbox & Production** — Production-only throws THIRD_PARTY_AUTH_ERROR on debug.\n"
        : ""),
      (c.enableSocialAuth
        ? "- **Social sign-in uses a static import** — same iOS WebView footgun as push.\n- **Google iOS URL scheme** is the reversed client id; injected into Info.plist automatically.\n- **Sign in with Apple capability** must be enabled in Xcode to sign (the entitlement is pre-written).\n"
        : ""),
      ""
    ].join("\n");
  }

  function fileReleaseWorkflow(c) {
    var lines = [
      "name: Nativize Release",
      "",
      "# Builds SIGNED binaries and ships them straight to your store accounts:",
      "#   iOS     -> App Store Connect / TestFlight",
      "#   Android -> Google Play Internal testing track",
      "# Credentials come from encrypted GitHub Actions secrets (set by the Nativize",
      "# extension). Manual trigger so a release only happens when you ask for it.",
      "on:",
      "  workflow_dispatch:",
      "",
      "jobs:"
    ];

    if (c.androidUpload) {
      lines = lines.concat([
        "  android:",
        "    name: Android -> Play (internal)",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - uses: actions/checkout@v4",
        "      - uses: actions/setup-node@v4",
        "        with:",
        "          node-version: 22",
        "      - uses: actions/setup-java@v4",
        "        with:",
        "          distribution: temurin",
        "          java-version: 21",
        "      - name: Install deps + build web",
        "        run: |",
        "          npm ci --legacy-peer-deps || npm install --legacy-peer-deps",
        "          npm install --no-save --legacy-peer-deps typescript @capacitor/core@^8 @capacitor/cli@^8 @capacitor/android@^8 @capacitor/splash-screen@^8" + (c.enablePush ? " @capacitor-firebase/messaging firebase" : "") + (c.enableSocialAuth ? " @capgo/capacitor-social-login" : ""),
        "          npm run build" + ((c.watermark || c.iosHeader) ? "\n          bash ./nativize-inject.sh" : ""),
        "      - name: Add Android platform + sync",
        "        run: |",
        "          if [ -d android ]; then echo 'android already added'; else npx cap add android; fi",
        "          bash ./nativize-patch-android.sh",
        "          npx cap sync android",
        (c.enablePush ? "          bash ./nativize-push-config.sh" : ""),
        "          bash ./nativize-permissions.sh",
        (c.hasCustomIcon ? "          bash ./nativize-icons.sh" : ""),
        "      - name: Decode upload keystore",
        "        run: echo \"$ANDROID_KEYSTORE_BASE64\" | base64 -d > \"$RUNNER_TEMP/upload-keystore.jks\"",
        "        env:",
        "          ANDROID_KEYSTORE_BASE64: ${{ secrets.ANDROID_KEYSTORE_BASE64 }}",
        "      - name: Build signed release bundle (.aab)",
        "        working-directory: android",
        "        env:",
        "          ANDROID_KEYSTORE_PASSWORD: ${{ secrets.ANDROID_KEYSTORE_PASSWORD }}",
        "          ANDROID_KEY_ALIAS: ${{ secrets.ANDROID_KEY_ALIAS }}",
        "          ANDROID_KEY_PASSWORD: ${{ secrets.ANDROID_KEY_PASSWORD }}",
        "        run: |",
        "          ./gradlew bundleRelease --stacktrace \\",
        "            -Pandroid.injected.signing.store.file=\"$RUNNER_TEMP/upload-keystore.jks\" \\",
        "            -Pandroid.injected.signing.store.password=\"$ANDROID_KEYSTORE_PASSWORD\" \\",
        "            -Pandroid.injected.signing.key.alias=\"$ANDROID_KEY_ALIAS\" \\",
        "            -Pandroid.injected.signing.key.password=\"$ANDROID_KEY_PASSWORD\"",
        "      - name: Upload to Google Play (internal track)",
        "        uses: r0adkll/upload-google-play@v1",
        "        with:",
        "          serviceAccountJsonPlainText: ${{ secrets.PLAY_SERVICE_ACCOUNT_JSON }}",
        "          packageName: " + c.appId,
        "          releaseFiles: android/app/build/outputs/bundle/release/app-release.aab",
        "          track: internal",
        "          status: completed",
        ""
      ]);
    }

    if (c.iosUpload) {
      lines = lines.concat([
        "  ios:",
        "    name: iOS -> TestFlight",
        "    runs-on: macos-26",
        "    steps:",
        "      - uses: actions/checkout@v4",
        "      - uses: actions/setup-node@v4",
        "        with:",
        "          node-version: 22",
        "      - name: Install deps + build web",
        "        run: |",
        "          npm ci --legacy-peer-deps || npm install --legacy-peer-deps",
        "          npm install --no-save --legacy-peer-deps typescript @capacitor/core@^8 @capacitor/cli@^8 @capacitor/ios@^8 @capacitor/splash-screen@^8" + (c.enablePush ? " @capacitor-firebase/messaging firebase" : "") + (c.enableSocialAuth ? " @capgo/capacitor-social-login" : ""),
        "          npm run build" + ((c.watermark || c.iosHeader) ? "\n          bash ./nativize-inject.sh" : ""),
        "      - name: Add iOS platform + sync",
        "        env:",
        "          LANG: en_US.UTF-8",
        "          LC_ALL: en_US.UTF-8",
        "        run: |",
        "          if [ -d ios ]; then echo 'ios already added'; else npx cap add ios --packagemanager CocoaPods; fi",
        "          npx cap sync ios",
        (c.enablePush ? "          bash ./nativize-push-config.sh" : ""),
        "          bash ./nativize-permissions.sh",
        (c.hasCustomIcon ? "          bash ./nativize-icons.sh" : ""),
        (c.enableSocialAuth ? "          bash ./nativize-social-auth.sh" : ""),
        "      - name: Resolve CocoaPods",
        "        working-directory: ios/App",
        "        env:",
        "          LANG: en_US.UTF-8",
        "          LC_ALL: en_US.UTF-8",
        "        run: pod install",
        "      - name: Install App Store Connect API key",
        "        env:",
        "          ASC_KEY_ID: ${{ secrets.ASC_KEY_ID }}",
        "          ASC_KEY_P8: ${{ secrets.ASC_KEY_P8 }}",
        "        run: |",
        "          mkdir -p ~/.appstoreconnect/private_keys",
        "          printf '%s' \"$ASC_KEY_P8\" > ~/.appstoreconnect/private_keys/AuthKey_${ASC_KEY_ID}.p8",
        "      - name: Archive (automatic signing via ASC API key)",
        "        working-directory: ios/App",
        "        env:",
        "          ASC_KEY_ID: ${{ secrets.ASC_KEY_ID }}",
        "          ASC_ISSUER_ID: ${{ secrets.ASC_ISSUER_ID }}",
        "          APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}",
        "        run: |",
        "          xcodebuild -workspace App.xcworkspace -scheme App -configuration Release \\",
        "            -sdk iphoneos -destination 'generic/platform=iOS' \\",
        "            -archivePath \"$RUNNER_TEMP/App.xcarchive\" \\",
        "            -authenticationKeyPath ~/.appstoreconnect/private_keys/AuthKey_${ASC_KEY_ID}.p8 \\",
        "            -authenticationKeyID \"$ASC_KEY_ID\" -authenticationKeyIssuerID \"$ASC_ISSUER_ID\" \\",
        "            -allowProvisioningUpdates DEVELOPMENT_TEAM=\"$APPLE_TEAM_ID\" \\",
        "            PRODUCT_BUNDLE_IDENTIFIER=" + c.appId + " \\",
        "            clean archive",
        "      - name: Export signed .ipa",
        "        working-directory: ios/App",
        "        env:",
        "          ASC_KEY_ID: ${{ secrets.ASC_KEY_ID }}",
        "          ASC_ISSUER_ID: ${{ secrets.ASC_ISSUER_ID }}",
        "          APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}",
        "        run: |",
        "          cat > \"$RUNNER_TEMP/ExportOptions.plist\" <<PLIST",
        "          <?xml version=\"1.0\" encoding=\"UTF-8\"?>",
        "          <!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">",
        "          <plist version=\"1.0\"><dict>",
        "            <key>method</key><string>app-store-connect</string>",
        "            <key>teamID</key><string>${APPLE_TEAM_ID}</string>",
        "            <key>signingStyle</key><string>automatic</string>",
        "            <key>destination</key><string>export</string>",
        "          </dict></plist>",
        "          PLIST",
        "          xcodebuild -exportArchive \\",
        "            -archivePath \"$RUNNER_TEMP/App.xcarchive\" \\",
        "            -exportPath \"$RUNNER_TEMP/export\" \\",
        "            -exportOptionsPlist \"$RUNNER_TEMP/ExportOptions.plist\" \\",
        "            -authenticationKeyPath ~/.appstoreconnect/private_keys/AuthKey_${ASC_KEY_ID}.p8 \\",
        "            -authenticationKeyID \"$ASC_KEY_ID\" -authenticationKeyIssuerID \"$ASC_ISSUER_ID\" \\",
        "            -allowProvisioningUpdates",
        "      - name: Upload to TestFlight",
        "        env:",
        "          ASC_KEY_ID: ${{ secrets.ASC_KEY_ID }}",
        "          ASC_ISSUER_ID: ${{ secrets.ASC_ISSUER_ID }}",
        "        run: |",
        "          IPA=$(ls \"$RUNNER_TEMP\"/export/*.ipa | head -1)",
        "          xcrun altool --upload-app -f \"$IPA\" -t ios \\",
        "            --apiKey \"$ASC_KEY_ID\" --apiIssuer \"$ASC_ISSUER_ID\"",
        ""
      ]);
    }

    return lines.join("\n");
  }

  function fileStoreSetup(c) {
    var lines = [
      "# " + c.appName + " — automated store upload",
      "",
      "`.github/workflows/nativize-release.yml` builds **signed** binaries and ships them",
      "to your store accounts. Run it from **Actions -> Nativize Release -> Run workflow**.",
      "",
      "Credentials are read from encrypted **GitHub Actions secrets**. The Nativize",
      "extension can set these for you, or add them under *Settings -> Secrets and",
      "variables -> Actions*.",
      ""
    ];
    if (c.iosUpload) {
      lines = lines.concat([
        "## iOS -> TestFlight (App Store Connect API)",
        "Secrets: `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8` (contents of the .p8),",
        "`APPLE_TEAM_ID`.",
        "- Create the key in App Store Connect -> Users and Access -> Integrations ->",
        "  App Store Connect API, with the **App Manager** role.",
        "- The key auto-handles signing certs/profiles (`-allowProvisioningUpdates`).",
        "- Bundle ID `" + c.appId + "` is registered automatically on first archive.",
        ""
      ]);
    }
    if (c.androidUpload) {
      lines = lines.concat([
        "## Android -> Google Play (internal testing)",
        "Secrets: `ANDROID_KEYSTORE_BASE64` (base64 of your upload keystore),",
        "`ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`,",
        "`PLAY_SERVICE_ACCOUNT_JSON`.",
        "- Service account: Google Play Console -> Setup -> API access, grant it",
        "  *Release to testing tracks*.",
        "- **One-time manual step:** Google requires the FIRST app release to be created",
        "  manually in Play Console (the API cannot create the app or do the first",
        "  upload). After one manual upload of an `.aab` with package `" + c.appId + "`,",
        "  this workflow can publish to the internal track automatically.",
        "- Generate an upload keystore once:",
        "  `keytool -genkey -v -keystore upload.jks -keyalg RSA -keysize 2048 -validity 9125 -alias upload`",
        "  then `base64 -i upload.jks` for `ANDROID_KEYSTORE_BASE64`.",
        ""
      ]);
    }
    return lines.join("\n");
  }

  // Electron main process: wraps the built web app into a desktop window.
  function fileDesktopMain(c) {
    return [
      "// Electron main process — generated by Nativize.",
      "// Wraps your built web app (./app) into a desktop window users double-click.",
      "const { app, BrowserWindow, shell } = require('electron');",
      "const path = require('path');",
      "const serve = require('electron-serve');",
      "",
      "// Serve the static web build through a custom protocol so SPA routing and",
      "// absolute asset paths work (loading via file:// would break them).",
      "const loadApp = serve({ directory: path.join(__dirname, 'app') });",
      "",
      "async function createWindow() {",
      "  const win = new BrowserWindow({",
      "    width: 1280,",
      "    height: 800,",
      "    webPreferences: { contextIsolation: true }",
      "  });",
      "  // External links open in the real browser, not inside the app window.",
      "  win.webContents.setWindowOpenHandler(function (d) { shell.openExternal(d.url); return { action: 'deny' }; });",
      "  await loadApp(win);",
      "}",
      "",
      "app.whenReady().then(createWindow);",
      "app.on('activate', function () { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });",
      "app.on('window-all-closed', function () { if (process.platform !== 'darwin') app.quit(); });",
      ""
    ].join("\n");
  }

  // Self-contained package for the desktop build (isolated from the web app's
  // package.json so the web/mobile builds are never touched).
  function fileDesktopPackage(c) {
    var name = (slugify(c.appName) || "app") + "-desktop";
    var pkg = {
      name: name,
      version: "1.0.0",
      description: c.appName + " desktop app",
      author: "Nativize",
      main: "main.js",
      scripts: { dist: "electron-builder" },
      dependencies: { "electron-serve": "^1.3.0" },
      devDependencies: { electron: "^31.7.7", "electron-builder": "^24.13.3" },
      build: {
        appId: c.appId,
        productName: c.appName,
        files: ["main.js", "app/**/*"],
        directories: { output: "out" },
        mac: { target: "dmg", identity: null },
        win: { target: "nsis" },
        linux: { target: "AppImage" }
      }
    };
    return JSON.stringify(pkg, null, 2) + "\n";
  }

  function fileDesktopReadme(c) {
    return [
      "# " + c.appName + " — desktop app",
      "",
      "The cloud build produces a **Mac `.dmg`** and a **Windows `.exe`** (Artifacts",
      "on the GitHub Actions run). These are unsigned, so the operating system",
      "guards them on first launch. That's expected — not corruption.",
      "",
      "## macOS — \"App is damaged\" / \"can't be opened\"",
      "macOS quarantines unsigned apps downloaded from the internet. To open YOUR",
      "OWN copy, clear the quarantine flag once, then open normally:",
      "",
      "```bash",
      "xattr -cr \"/Applications/" + c.appName + ".app\"   # or wherever you put it",
      "```",
      "",
      "(Or right-click the app -> Open the first time.)",
      "",
      "## Windows — \"Windows protected your PC\" (SmartScreen)",
      "Click **More info -> Run anyway**.",
      "",
      "## Distributing to OTHER people without warnings",
      "You need real signing: an Apple Developer ID + notarization (macOS) and an",
      "Authenticode certificate (Windows). Add those to the desktop build config",
      "(electron-builder `mac.notarize` / `win.certificateFile`) when you're ready.",
      ""
    ].join("\n");
  }

  // Generated, config-dependent script that applies the user's selected app
  // permissions to the native projects. Idempotent + safe on both macOS (iOS)
  // and Linux (Android) runners — each block is guarded by file/tool presence.
  function fileNativizePermissionsSh(c) {
    var perms = c.permissions || [];
    var shEsc = function (s) { return String(s).replace(/'/g, "'\\''"); };
    var L = [
      "#!/usr/bin/env bash",
      "# Generated by Nativize from the permissions you selected in the app builder.",
      "# iOS: Info.plist usage strings + UIBackgroundModes. Android: <uses-permission>.",
      "# Idempotent; safe to re-run. Each block is guarded so it no-ops off-platform.",
      "set -uo pipefail",
      ""
    ];
    // ---- iOS ----
    L.push('PLIST=ios/App/App/Info.plist');
    L.push('if [ -f "$PLIST" ] && command -v /usr/libexec/PlistBuddy >/dev/null 2>&1; then');
    L.push("  echo '==> iOS permissions (Info.plist)'");
    var bgModes = {};
    perms.forEach(function (p) {
      var desc = (p.description && p.description.trim()) ? p.description : ("This app uses " + p.label + ".");
      var d = shEsc(desc);
      (p.iosUsage || []).forEach(function (key) {
        L.push("  /usr/libexec/PlistBuddy -c 'Set :" + key + " " + d + "' \"$PLIST\" 2>/dev/null || /usr/libexec/PlistBuddy -c 'Add :" + key + " string " + d + "' \"$PLIST\"");
      });
      (p.iosBackgroundModes || []).forEach(function (m) { bgModes[m] = true; });
    });
    var modes = Object.keys(bgModes);
    if (modes.length) {
      L.push("  /usr/libexec/PlistBuddy -c 'Print :UIBackgroundModes' \"$PLIST\" >/dev/null 2>&1 || /usr/libexec/PlistBuddy -c 'Add :UIBackgroundModes array' \"$PLIST\"");
      modes.forEach(function (m) {
        L.push("  /usr/libexec/PlistBuddy -c 'Print :UIBackgroundModes' \"$PLIST\" | grep -q '" + m + "' || /usr/libexec/PlistBuddy -c 'Add :UIBackgroundModes: string " + m + "' \"$PLIST\"");
      });
    }
    L.push("fi");
    L.push("");
    // ---- Android ----
    var androidPerms = {};
    perms.forEach(function (p) { (p.android || []).forEach(function (a) { androidPerms[a] = true; }); });
    L.push('MANIFEST=android/app/src/main/AndroidManifest.xml');
    L.push('if [ -f "$MANIFEST" ]; then');
    L.push("  echo '==> Android permissions (AndroidManifest.xml)'");
    Object.keys(androidPerms).forEach(function (a) {
      L.push("  grep -q '" + a + "' \"$MANIFEST\" || perl -0pi -e 's/(<application)/    <uses-permission android:name=\"" + a + "\" \\/>\\n    $1/' \"$MANIFEST\"");
    });
    L.push("fi");
    L.push("");
    L.push("echo 'Permissions applied.'");
    L.push("");
    return L.join("\n");
  }

  // ---------------------------------------------------------------------------
  // Social sign-in templates.
  // ---------------------------------------------------------------------------

  // src/nativeSocialAuth.ts — a ready-to-use helper. Web-safe (no-ops off-native),
  // static import (a dynamic import() of a Capacitor plugin dies silently in the
  // iOS WebView), and returns an idToken you pass straight to Supabase.
  function fileNativeSocialAuth(c) {
    var google = c.googleSignIn;
    var apple = c.appleSignIn;
    var initBody = ["  const config: Record<string, unknown> = {};"];
    if (apple) {
      var aServiceId = apple.values.serviceId;
      var aRedirect = apple.values.redirectUrl;
      // On iOS the bundle id is the client id; serviceId/redirectUrl drive the
      // Android/web fallback. Only emit them when provided.
      var appleCfg = ["clientId: " + jsString(aServiceId || c.appId)];
      if (aRedirect) appleCfg.push("redirectUrl: " + jsString(aRedirect));
      initBody.push("  config.apple = { " + appleCfg.join(", ") + " };");
    }
    if (google) {
      var gWeb = google.values.webClientId;
      var gIos = google.values.iosClientId;
      var googleCfg = ["webClientId: " + jsString(gWeb)];
      if (gIos) googleCfg.push("iOSClientId: " + jsString(gIos));
      initBody.push("  config.google = { " + googleCfg.join(", ") + " };");
    }

    var lines = [
      "// nativeSocialAuth.ts — generated by Nativize.",
      "// Native Sign in with " + (apple && google ? "Apple + Google" : (apple ? "Apple" : "Google")) + ".",
      "// SAFE on web: every native call is guarded so this no-ops in a browser.",
      "//",
      "// Each login returns an `idToken` you hand straight to Supabase:",
      "//   const { idToken } = await signInWith" + (google ? "Google" : "Apple") + "();",
      "//   await supabase.auth.signInWithIdToken({ provider: " + (google ? "'google'" : "'apple'") + ", token: idToken });",
      "//",
      "// CRITICAL: this import is static on purpose. A dynamic import() of a",
      "// Capacitor plugin silently fails to load inside the iOS WebView.",
      "import { SocialLogin } from '@capgo/capacitor-social-login';",
      "import { Capacitor } from '@capacitor/core';",
      "",
      "let initialized = false;",
      "",
      "/** Call once before the first sign-in. Idempotent; no-ops on web. */",
      "export async function initSocialAuth(): Promise<void> {",
      "  if (initialized || !Capacitor.isNativePlatform()) return;"
    ];
    lines = lines.concat(initBody);
    lines = lines.concat([
      "  await SocialLogin.initialize(config as never);",
      "  initialized = true;",
      "}",
      ""
    ]);

    if (apple) {
      lines = lines.concat([
        "/** Native Sign in with Apple. Returns the OIDC idToken (for Supabase). */",
        "export async function signInWithApple(): Promise<{ idToken: string; raw: unknown }> {",
        "  await initSocialAuth();",
        "  const res = await SocialLogin.login({ provider: 'apple', options: { scopes: ['email', 'name'] } });",
        "  const result = (res as { result?: { idToken?: string } }).result || {};",
        "  return { idToken: result.idToken || '', raw: res };",
        "}",
        ""
      ]);
    }
    if (google) {
      lines = lines.concat([
        "/** Native Sign in with Google. Returns the OIDC idToken (for Supabase). */",
        "export async function signInWithGoogle(): Promise<{ idToken: string; raw: unknown }> {",
        "  await initSocialAuth();",
        "  const res = await SocialLogin.login({ provider: 'google', options: { scopes: ['email', 'profile'] } });",
        "  const result = (res as { result?: { idToken?: string } }).result || {};",
        "  return { idToken: result.idToken || '', raw: res };",
        "}",
        ""
      ]);
    }
    return lines.join("\n");
  }

  // nativize-social-auth.sh — injects the iOS-only native config that the SDKs
  // need: a CFBundleURLTypes URL scheme for Google, and the Sign in with Apple
  // entitlement. Uses python3 + plistlib (reliable + idempotent) over PlistBuddy
  // index juggling. Android needs no manifest edits (Credential Manager handles it).
  function fileSocialAuthSh(c) {
    var google = c.googleSignIn;
    var apple = c.appleSignIn;
    var reversed = (google && google.values.iosClientId) ? reverseGoogleClientId(google.values.iosClientId) : "";
    return [
      "#!/usr/bin/env bash",
      "# Generated by Nativize — native config for social sign-in (iOS).",
      "# Idempotent; safe to re-run. No-ops when the iOS project isn't present.",
      "set -uo pipefail",
      "",
      "PLIST=ios/App/App/Info.plist",
      "ENT=ios/App/App/App.entitlements",
      "",
      "if [ -f \"$PLIST\" ] && command -v python3 >/dev/null 2>&1; then",
      "  echo '==> iOS social sign-in native config'",
      "  python3 - \"$PLIST\" \"$ENT\" <<'PY'",
      "import plistlib, sys, os",
      "plist_path, ent_path = sys.argv[1], sys.argv[2]",
      "",
      "GOOGLE_REVERSED = " + JSON.stringify(reversed),
      "APPLE = " + (apple ? "True" : "False"),
      "",
      "with open(plist_path, 'rb') as f:",
      "    info = plistlib.load(f)",
      "",
      "if GOOGLE_REVERSED:",
      "    url_types = info.get('CFBundleURLTypes', [])",
      "    have = any(GOOGLE_REVERSED in (t.get('CFBundleURLSchemes') or []) for t in url_types)",
      "    if not have:",
      "        url_types.append({'CFBundleURLSchemes': [GOOGLE_REVERSED]})",
      "        info['CFBundleURLTypes'] = url_types",
      "        with open(plist_path, 'wb') as f:",
      "            plistlib.dump(info, f)",
      "        print('  added Google URL scheme: ' + GOOGLE_REVERSED)",
      "",
      "if APPLE:",
      "    ent = {}",
      "    if os.path.exists(ent_path):",
      "        with open(ent_path, 'rb') as f:",
      "            ent = plistlib.load(f)",
      "    key = 'com.apple.developer.applesignin'",
      "    if key not in ent:",
      "        ent[key] = ['Default']",
      "        with open(ent_path, 'wb') as f:",
      "            plistlib.dump(ent, f)",
      "        print('  added Sign in with Apple entitlement (enable the capability in Xcode to sign)')",
      "PY",
      "fi",
      "",
      "echo 'Social sign-in native config applied.'",
      ""
    ].join("\n");
  }

  function fileSocialAuthSetup(c) {
    var L = [
      "# " + c.appName + " — Social sign-in setup",
      "",
      "Generated by **Nativize**. The kit installed `@capgo/capacitor-social-login`",
      "and a ready-to-use helper at `src/nativeSocialAuth.ts`. Each sign-in returns",
      "an `idToken` you pass to Supabase:",
      "",
      "```ts",
      "import { signInWith" + (c.googleSignIn ? "Google" : "Apple") + " } from './nativeSocialAuth';",
      "import { supabase } from './integrations/supabase/client';",
      "",
      "const { idToken } = await signInWith" + (c.googleSignIn ? "Google" : "Apple") + "();",
      "await supabase.auth.signInWithIdToken({ provider: " + (c.googleSignIn ? "'google'" : "'apple'") + ", token: idToken });",
      "```",
      ""
    ];
    if (c.googleSignIn) {
      var gIos = c.googleSignIn.values.iosClientId;
      L = L.concat([
        "## Google",
        "- [ ] In Google Cloud → Credentials, create OAuth client IDs:",
        "      a **Web** client (for the `webClientId` audience Supabase verifies) and an **iOS** client.",
        "- [ ] In Supabase → Auth → Providers → Google, paste the **Web** client ID + secret.",
        (gIos
          ? "- [x] iOS URL scheme `" + reverseGoogleClientId(gIos) + "` is added to Info.plist by `nativize-social-auth.sh`."
          : "- [ ] Add an iOS client ID in the builder so the native iOS flow + URL scheme are wired up."),
        ""
      ]);
    }
    if (c.appleSignIn) {
      L = L.concat([
        "## Apple",
        "- [ ] In Xcode → Signing & Capabilities, add the **Sign in with Apple** capability",
        "      (the entitlement file is created by `nativize-social-auth.sh`; the capability links it for signing).",
        "- [ ] In the Apple Developer portal, enable Sign in with Apple on the App ID `" + c.appId + "`.",
        "- [ ] In Supabase → Auth → Providers → Apple, configure your Services ID + key for the Android/web flow.",
        ""
      ]);
    }
    L.push("After signing in, the user's session lives in Supabase like any other login.");
    L.push("");
    return L.join("\n");
  }

  // nativize-watermark.html — the "Built with Nativize" badge injected into the
  // built web app on the Free plan. The build workflow appends this before
  // </body> in the production index.html. Removed automatically on a paid plan
  // (the file isn't generated, and the workflow step no-ops without it).
  function fileWatermark(c) {
    return [
      '<a id="nativize-wm" href="https://nativize.app" target="_blank" rel="noopener"',
      '   style="position:fixed;left:50%;bottom:10px;transform:translateX(-50%);z-index:2147483647;',
      '          display:inline-flex;align-items:center;gap:6px;font:600 11px/1 -apple-system,system-ui,sans-serif;',
      '          color:#fff;text-decoration:none;background:linear-gradient(135deg,#7c3aed,#2563eb);',
      '          padding:6px 12px;border-radius:999px;box-shadow:0 6px 18px rgba(0,0,0,.35);opacity:.94">',
      '  ⚡ Built with Nativize',
      '</a>',
      ''
    ].join("\n");
  }

  // nativize-island-header.html — a frosted top bar that fills the iOS Dynamic
  // Island / notch strip, injected before </body> of the built app (like the
  // watermark). Height is the real safe-area inset, so it collapses to 0 on
  // devices without a notch and is a no-op on the web.
  function fileIslandHeader(c) {
    return [
      '<style id="nativize-island-style">',
      '  #nativize-island{position:fixed;top:0;left:0;right:0;height:env(safe-area-inset-top,0px);',
      '    z-index:2147483646;pointer-events:none;background:rgba(10,10,18,.72);',
      '    -webkit-backdrop-filter:blur(22px) saturate(180%);backdrop-filter:blur(22px) saturate(180%);}',
      '</style>',
      '<script>(function(){try{',
      '  var m=document.querySelector(\'meta[name="viewport"]\');',
      '  if(m){ if(m.content.indexOf("viewport-fit")<0) m.content+=", viewport-fit=cover"; }',
      '  else { m=document.createElement("meta"); m.name="viewport"; m.content="width=device-width, initial-scale=1, viewport-fit=cover"; document.head.appendChild(m); }',
      '  if(!document.getElementById("nativize-island")){ var d=document.createElement("div"); d.id="nativize-island"; d.setAttribute("aria-hidden","true"); document.body.appendChild(d); }',
      '}catch(e){}})();</script>',
      ''
    ].join("\n");
  }

  // nativize-inject.sh — injects the generated snippets (watermark, iOS island
  // header) into the built web app before Capacitor copies it native. One place,
  // idempotent, each snippet only injects if its file exists.
  function fileInjectSh(c) {
    var L = [
      "#!/usr/bin/env bash",
      "# Generated by Nativize — injects HTML snippets into the built web app.",
      "set -uo pipefail",
      "P='" + c.webDir + "/index.html'",
      "inject(){",
      "  [ -f \"$1\" ] || return 0",
      "  [ -f \"$P\" ] || return 0",
      "  grep -q \"$2\" \"$P\" && return 0",
      "  node -e \"const fs=require('fs');const p='$P';fs.writeFileSync(p,fs.readFileSync(p,'utf8').replace('</body>',fs.readFileSync(process.argv[1],'utf8')+'</body>'))\" \"$1\"",
      "}"
    ];
    if (c.watermark) L.push("inject nativize-watermark.html nativize-wm");
    if (c.iosHeader) L.push("inject nativize-island-header.html nativize-island");
    L.push("");
    return L.join("\n");
  }

  // nativize-icons.sh — decodes the uploaded logo (shipped as base64 text) and
  // runs @capacitor/assets to generate every iOS/Android/Mac/Windows icon size.
  // Run after the native platforms exist (cap add/sync). Idempotent + safe.
  function fileIconsSh(c) {
    return [
      "#!/usr/bin/env bash",
      "# Generated by Nativize — turns your uploaded logo into all native app icons.",
      "set -uo pipefail",
      "mkdir -p resources",
      "if [ -f resources/icon.b64.txt ]; then",
      "  node -e \"const fs=require('fs');fs.writeFileSync('resources/icon.png',Buffer.from(fs.readFileSync('resources/icon.b64.txt','utf8').replace(/\\s+/g,''),'base64'))\"",
      "fi",
      "if [ -f resources/splash.b64.txt ]; then",
      "  node -e \"const fs=require('fs');fs.writeFileSync('resources/splash.png',Buffer.from(fs.readFileSync('resources/splash.b64.txt','utf8').replace(/\\s+/g,''),'base64'))\"",
      "fi",
      "if [ -f resources/icon.png ]; then",
      "  echo '==> Generating native app icons from your logo'",
      "  npm install --no-save --legacy-peer-deps @capacitor/assets@^3 >/dev/null 2>&1 || npm install --no-save @capacitor/assets >/dev/null 2>&1 || true",
      "  node -e \"const fs=require('fs');let sharp;try{sharp=require('sharp')}catch(e){process.exit(0)};(async()=>{if(!fs.existsSync('resources/icon.png'))return;await sharp('resources/icon.png').resize(1024,1024,{fit:'contain',background:{r:255,g:255,b:255,alpha:1}}).png().toFile('resources/icon.normalized.png');fs.renameSync('resources/icon.normalized.png','resources/icon.png')})().catch(e=>{console.warn('Icon normalization skipped: '+e.message)})\" || true",
      "  npx --yes @capacitor/assets generate --ios --android --iconBackgroundColor '#ffffff' --iconBackgroundColorDark '#0b0b12' --splashBackgroundColor '#0b0b12' --splashBackgroundColorDark '#0b0b12' || npx @capacitor/assets generate --ios --android || echo 'Icon generation skipped (assets tool unavailable).'",
      "fi",
      ""
    ].join("\n");
  }

  /**
   * Main entry. Returns a { path: contents } map for the whole kit.
   */
  function generateKit(input) {
    var c = normalizeConfig(input);
    var files = {};

    files["capacitor.config.ts"] = fileCapacitorConfig(c);
    files["nativize.sh"] = fileNativizeSh(c);
    files["nativize-patch-android.sh"] = filePatchAndroidSh(c);
    files["nativize-permissions.sh"] = fileNativizePermissionsSh(c);
    files[".github/workflows/nativize-build.yml"] = fileWorkflow(c);
    files["desktop/main.js"] = fileDesktopMain(c);
    files["desktop/package.json"] = fileDesktopPackage(c);
    files["desktop/README.md"] = fileDesktopReadme(c);
    files["CHECKLIST.md"] = fileChecklist(c);
    files["NATIVIZE_README.md"] = fileReadme(c);

    if (c.enablePush) {
      files["src/nativePush.ts"] = fileNativePush(c);
      files["nativize-push-config.sh"] = filePushConfigSh(c);
    }

    if (c.enableSocialAuth) {
      files["src/nativeSocialAuth.ts"] = fileNativeSocialAuth(c);
      files["nativize-social-auth.sh"] = fileSocialAuthSh(c);
      files["SOCIAL_AUTH_SETUP.md"] = fileSocialAuthSetup(c);
    }

    if (c.storeUpload) {
      files[".github/workflows/nativize-release.yml"] = fileReleaseWorkflow(c);
      files["STORE_SETUP.md"] = fileStoreSetup(c);
    }

    if (c.watermark) {
      files["nativize-watermark.html"] = fileWatermark(c);
    }

    // Premium: a custom app icon. We ship the logo as base64 text (keeps the kit
    // text-only) plus a script + workflow step that decodes it and runs
    // @capacitor/assets to generate every iOS/Android/Mac/Windows icon size.
    if (c.appIcon) {
      files["resources/icon.b64.txt"] = c.appIcon + "\n";
      if (c.appSplash) files["resources/splash.b64.txt"] = c.appSplash + "\n";
      files["nativize-icons.sh"] = fileIconsSh(c);
    }

    // Premium: the iOS Dynamic Island / notch header, injected into the built
    // index.html (like the watermark) so the app gets a clean frosted top bar.
    if (c.iosHeader) {
      files["nativize-island-header.html"] = fileIslandHeader(c);
    }

    // Shared injector for whichever HTML snippets are enabled.
    if (c.watermark || c.iosHeader) {
      files["nativize-inject.sh"] = fileInjectSh(c);
    }

    return files;
  }

  /**
   * The GitHub Actions secret names required for the enabled store uploads.
   * Drives what the extension collects + encrypts. Returns [] when no upload.
   */
  function requiredSecrets(input) {
    var c = normalizeConfig(input);
    var names = [];
    if (c.iosUpload) names = names.concat(STORE_SECRETS.ios);
    if (c.androidUpload) names = names.concat(STORE_SECRETS.android);
    return names;
  }

  return {
    generateKit: generateKit,
    normalizeConfig: normalizeConfig,
    normalizeAppId: normalizeAppId,
    normalizeWebDir: normalizeWebDir,
    slugify: slugify,
    requiredSecrets: requiredSecrets,
    STORE_SECRETS: STORE_SECRETS,
    PERMISSION_CATALOG: PERMISSION_CATALOG,
    normalizePermissions: normalizePermissions,
    validatePermissions: validatePermissions,
    SOCIAL_AUTH_CATALOG: SOCIAL_AUTH_CATALOG,
    normalizeSocialAuth: normalizeSocialAuth,
    validateSocialAuth: validateSocialAuth,
    reverseGoogleClientId: reverseGoogleClientId,
    AGP_VERSION: AGP_VERSION,
    GRADLE_VERSION: GRADLE_VERSION
  };
});
