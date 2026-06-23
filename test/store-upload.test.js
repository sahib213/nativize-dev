"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

const Kit = require("../src/kit-generator.js");
const SB = require("../src/sealedbox.js");
const nacl = require("../src/vendor/tweetnacl.js");

function cfg(extra) {
  return Object.assign({ appName: "Demo App", appId: "app.lovable.demo", githubRepo: "o/r" }, extra || {});
}

// ---------------------------------------------------------------------------
// Gating: release workflow only when a store upload is enabled
// ---------------------------------------------------------------------------
test("no release workflow or store setup without upload flags", () => {
  const f = Kit.generateKit(cfg());
  assert.equal(f[".github/workflows/nativize-release.yml"], undefined);
  assert.equal(f["STORE_SETUP.md"], undefined);
});

test("iOS upload adds release workflow with TestFlight job", () => {
  const f = Kit.generateKit(cfg({ iosUpload: true }));
  const wf = f[".github/workflows/nativize-release.yml"];
  assert.ok(wf, "release workflow missing");
  assert.match(wf, /runs-on: macos-26/);
  assert.match(wf, /altool --upload-app/);
  assert.match(wf, /-allowProvisioningUpdates/);
  assert.match(wf, /app-store-connect/);
  assert.match(wf, /PRODUCT_BUNDLE_IDENTIFIER=app\.lovable\.demo/);
  assert.doesNotMatch(wf, /\bandroid:\b/); // android job not present
  assert.ok(f["STORE_SETUP.md"]);
});

test("Android upload adds signed-bundle + Play internal job", () => {
  const f = Kit.generateKit(cfg({ androidUpload: true }));
  const wf = f[".github/workflows/nativize-release.yml"];
  assert.match(wf, /track: internal/);
  assert.match(wf, /android\.injected\.signing\.store\.file/);
  assert.match(wf, /packageName: app\.lovable\.demo/);
  assert.match(wf, /r0adkll\/upload-google-play/);
  assert.doesNotMatch(wf, /macos-26/); // ios job not present
});

test("both uploads → both jobs", () => {
  const wf = Kit.generateKit(cfg({ iosUpload: true, androidUpload: true }))[".github/workflows/nativize-release.yml"];
  assert.match(wf, /^  android:/m);
  assert.match(wf, /^  ios:/m);
});

test("release workflow uses spaces only (no tabs)", () => {
  const wf = Kit.generateKit(cfg({ iosUpload: true, androidUpload: true }))[".github/workflows/nativize-release.yml"];
  assert.doesNotMatch(wf, /\t/);
});

// ---------------------------------------------------------------------------
// requiredSecrets drives what the extension collects
// ---------------------------------------------------------------------------
test("requiredSecrets reflects enabled platforms", () => {
  assert.deepEqual(Kit.requiredSecrets({}), []);
  assert.deepEqual(Kit.requiredSecrets({ iosUpload: true }), Kit.STORE_SECRETS.ios);
  assert.deepEqual(Kit.requiredSecrets({ androidUpload: true }), Kit.STORE_SECRETS.android);
  assert.deepEqual(
    Kit.requiredSecrets({ iosUpload: true, androidUpload: true }),
    Kit.STORE_SECRETS.ios.concat(Kit.STORE_SECRETS.android)
  );
});

test("no leftover placeholders in store files", () => {
  const f = Kit.generateKit(cfg({ iosUpload: true, androidUpload: true, enablePush: true }));
  for (const [name, content] of Object.entries(f)) {
    // Mustache-style {{…}} leftovers, but NOT GitHub Actions ${{ … }} expressions.
    assert.doesNotMatch(content, /(?<!\$)\{\{/, "mustache placeholder in " + name);
    assert.doesNotMatch(content, /undefined|\[object Object\]/, "bad value in " + name);
  }
});

// ---------------------------------------------------------------------------
// Sealed box = libsodium crypto_box_seal (GitHub secret encryption)
// ---------------------------------------------------------------------------
test("sealBase64 produces a box the recipient secret key can open", () => {
  const r = nacl.box.keyPair();
  const pkB64 = Buffer.from(r.publicKey).toString("base64");
  const cipherB64 = SB.sealBase64("ghp_secret_value", pkB64);
  const sealed = new Uint8Array(Buffer.from(cipherB64, "base64"));
  const opened = SB.sealOpen(sealed, r.publicKey, r.secretKey);
  assert.equal(new TextDecoder().decode(opened), "ghp_secret_value");
});

test("sealed box is non-deterministic (fresh ephemeral key each call)", () => {
  const r = nacl.box.keyPair();
  const pk = Buffer.from(r.publicKey).toString("base64");
  assert.notEqual(SB.sealBase64("x", pk), SB.sealBase64("x", pk));
});

test("wrong key cannot open the sealed box", () => {
  const r = nacl.box.keyPair(), bad = nacl.box.keyPair();
  const sealed = new Uint8Array(Buffer.from(SB.sealBase64("secret", Buffer.from(r.publicKey).toString("base64")), "base64"));
  assert.equal(SB.sealOpen(sealed, bad.publicKey, bad.secretKey), null);
});
