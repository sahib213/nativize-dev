"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

const GitHub = require("../src/github.js");

// Minimal fetch mock: routes by method+path, records calls.
function mockFetch(routes) {
  const calls = [];
  global.fetch = async (url, opts) => {
    opts = opts || {};
    const u = new URL(url);
    const key = (opts.method || "GET") + " " + u.pathname;
    calls.push({ key, url, body: opts.body ? JSON.parse(opts.body) : null, headers: opts.headers });
    const handler = routes[key];
    if (!handler) return { ok: false, status: 404, json: async () => ({ message: "no route " + key }) };
    const res = handler();
    return { ok: true, status: res.status || 200, json: async () => res.body };
  };
  return calls;
}

test("splitRepo accepts owner/repo and full URLs, rejects junk", () => {
  assert.deepEqual(GitHub.splitRepo("octo/demo"), { owner: "octo", repo: "demo" });
  assert.deepEqual(GitHub.splitRepo("https://github.com/octo/demo.git"), { owner: "octo", repo: "demo" });
  assert.throws(() => GitHub.splitRepo("not-a-repo"));
});

test("triggerWorkflow dispatches the named workflow on the default branch", async () => {
  const calls = mockFetch({
    "GET /repos/octo/demo": () => ({ body: { default_branch: "main" } }),
    "POST /repos/octo/demo/actions/workflows/nativize-build.yml/dispatches": () => ({ status: 204, body: null })
  });
  const res = await GitHub.triggerWorkflow("octo/demo", "tok", "nativize-build.yml");
  assert.equal(res.ref, "main");
  assert.match(res.actionsUrl, /github\.com\/octo\/demo\/actions/);
  const dispatch = calls.find(c => c.key.includes("/dispatches"));
  assert.deepEqual(dispatch.body, { ref: "main" });
  assert.match(dispatch.headers.Authorization, /Bearer tok/);
});

test("setSecrets fetches the public key then PUTs an encrypted value per secret", async () => {
  const nacl = require("../src/vendor/tweetnacl.js");
  const kp = nacl.box.keyPair();
  const puts = [];
  mockFetch({
    "GET /repos/octo/demo/actions/secrets/public-key": () => ({
      body: { key_id: "kid-1", key: Buffer.from(kp.publicKey).toString("base64") }
    }),
    "PUT /repos/octo/demo/actions/secrets/ASC_KEY_ID": () => ({ status: 201, body: null }),
    "PUT /repos/octo/demo/actions/secrets/EMPTY_ONE": () => ({ status: 201, body: null })
  });
  // capture PUT bodies
  const origFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if ((opts.method) === "PUT") puts.push({ url: String(url), body: JSON.parse(opts.body) });
    return origFetch(url, opts);
  };

  const res = await GitHub.setSecrets("octo/demo", "tok", { ASC_KEY_ID: "ABC123", EMPTY_ONE: "" });
  assert.deepEqual(res.set, ["ASC_KEY_ID"]);   // non-empty set
  assert.deepEqual(res.skipped, ["EMPTY_ONE"]); // empty skipped
  assert.equal(puts.length, 1);
  assert.equal(puts[0].body.key_id, "kid-1");
  assert.ok(puts[0].body.encrypted_value && puts[0].body.encrypted_value.length > 0);

  // The encrypted value must actually decrypt back to the plaintext.
  const SB = require("../src/sealedbox.js");
  const sealed = new Uint8Array(Buffer.from(puts[0].body.encrypted_value, "base64"));
  assert.equal(new TextDecoder().decode(SB.sealOpen(sealed, kp.publicKey, kp.secretKey)), "ABC123");
});
