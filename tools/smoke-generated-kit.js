"use strict";

// Creates a throwaway Vite-like web project, generates the real Nativize kit,
// runs nativize.sh, and asserts that Capacitor produced both native projects.
// This intentionally uses only Node built-ins; npm downloads are performed by
// the generated script being tested.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const Kit = require("../src/kit-generator.js");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nativize-smoke-"));
const enablePush = process.env.NATIVIZE_SMOKE_PUSH === "1";

function write(relative, contents, mode) {
  const target = path.join(dir, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents, mode ? { mode } : undefined);
}

try {
  write("package.json", JSON.stringify({
    name: "nativize-smoke-app",
    version: "1.0.0",
    private: true,
    scripts: { build: "node build.js" }
  }, null, 2) + "\n");
  write("build.js", [
    'const fs = require("node:fs");',
    'fs.mkdirSync("dist", { recursive: true });',
    'fs.writeFileSync("dist/index.html", "<!doctype html><title>Nativize smoke</title>");',
    ""
  ].join("\n"));

  const kit = Kit.generateKit({
    appName: "Nativize Smoke",
    appId: "app.nativize.smoke",
    webDir: "dist",
    enablePush
  });
  for (const [relative, contents] of Object.entries(kit)) {
    write(relative, contents, relative.endsWith(".sh") ? 0o755 : undefined);
  }

  console.log("Smoke project:", dir);
  execFileSync("bash", ["nativize.sh"], { cwd: dir, stdio: "inherit" });

  if (enablePush) {
    execFileSync("npx", [
      "tsc", "--noEmit", "--target", "ES2022", "--module", "NodeNext",
      "--moduleResolution", "NodeNext", "src/nativePush.ts"
    ], { cwd: dir, stdio: "inherit" });
  }

  for (const required of [
    "android/app/src/main/assets/public/index.html",
    "android/gradle/wrapper/gradle-wrapper.properties",
    "ios/App/App/public/index.html"
  ]) {
    if (!fs.existsSync(path.join(dir, required))) {
      throw new Error("Capacitor smoke test did not create " + required);
    }
  }

  const wrapper = fs.readFileSync(path.join(dir, "android/gradle/wrapper/gradle-wrapper.properties"), "utf8");
  if (!wrapper.includes("gradle-8.13-bin.zip")) {
    throw new Error("Android Gradle wrapper was not pinned to 8.13");
  }

  if (process.env.NATIVIZE_BUILD_NATIVE === "1") {
    console.log("Compiling Android debug APK…");
    execFileSync("./gradlew", ["assembleDebug", "--stacktrace"], {
      cwd: path.join(dir, "android"),
      stdio: "inherit"
    });
    if (!fs.existsSync(path.join(dir, "android/app/build/outputs/apk/debug/app-debug.apk"))) {
      throw new Error("Android smoke build did not produce app-debug.apk");
    }

    console.log("Recreating iOS with CocoaPods to mirror GitHub Actions…");
    fs.rmSync(path.join(dir, "ios"), { recursive: true, force: true });
    execFileSync("npx", ["cap", "add", "ios", "--packagemanager", "CocoaPods"], {
      cwd: dir,
      stdio: "inherit"
    });
    execFileSync("npx", ["cap", "sync", "ios"], { cwd: dir, stdio: "inherit" });
    execFileSync("pod", ["install"], { cwd: path.join(dir, "ios/App"), stdio: "inherit" });

    console.log("Compiling iOS app without signing…");
    execFileSync("xcodebuild", [
      "-workspace", "App.xcworkspace",
      "-scheme", "App",
      "-configuration", "Debug",
      "-sdk", "iphoneos",
      "-destination", "generic/platform=iOS",
      "-derivedDataPath", "DerivedData",
      "CODE_SIGNING_ALLOWED=NO",
      "clean", "build"
    ], { cwd: path.join(dir, "ios/App"), stdio: "inherit" });
    if (!fs.existsSync(path.join(dir, "ios/App/DerivedData/Build/Products/Debug-iphoneos/App.app"))) {
      throw new Error("iOS smoke build did not produce App.app");
    }
  }

  console.log("Nativize native smoke test passed.");
} finally {
  if (process.env.KEEP_NATIVIZE_SMOKE !== "1") {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
