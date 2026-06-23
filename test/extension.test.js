"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("Manifest V3 is scoped to Lovable and GitHub with local storage only", () => {
  const manifest = JSON.parse(read("manifest.json"));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ["storage"]);
  assert.deepEqual(manifest.host_permissions, ["https://api.github.com/*"]);
  assert.deepEqual(manifest.content_scripts[0].matches, ["https://lovable.dev/*"]);
  assert.equal(manifest.action.default_popup, "src/popup.html");
  assert.deepEqual(Object.keys(manifest.icons).sort(), ["128", "16", "48"]);
});

test("content script stores config per Lovable project and token in local storage", () => {
  const source = read("src/content.js");
  assert.match(source, /location\.origin \+ location\.pathname/);
  assert.match(source, /nativize:githubToken/);
  assert.match(source, /chrome\.storage\.local/);
});

test("panel uses a shadow root and masks the GitHub token", () => {
  const source = read("src/panel.js");
  assert.match(source, /attachShadow\(\{ mode: "open" \}\)/);
  assert.match(source, /type="password" id="nz-token"/);
});
