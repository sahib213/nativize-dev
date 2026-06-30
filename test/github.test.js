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
  assert.throws(() => GitHub.splitRepo("octo/demo/issues"), /owner\/repo/);
  assert.throws(() => GitHub.splitRepo("octo/" + "x".repeat(101)), /owner\/repo/);
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

test("triggerWorkflow retries while a freshly-pushed workflow isn't registered yet", async () => {
  let dispatchTries = 0;
  global.fetch = async (url, opts) => {
    const u = new URL(url);
    if ((opts.method || "GET") === "GET" && u.pathname === "/repos/octo/demo") {
      return { ok: true, status: 200, json: async () => ({ default_branch: "main" }) };
    }
    if (opts.method === "POST" && /\/dispatches$/.test(u.pathname)) {
      dispatchTries++;
      if (dispatchTries < 3) return { ok: false, status: 404, json: async () => ({ message: "Workflow does not exist." }) };
      return { ok: true, status: 204, json: async () => null };
    }
    return { ok: false, status: 500, json: async () => ({ message: "x" }) };
  };
  const res = await GitHub.triggerWorkflow("octo/demo", "tok", "nativize-build.yml", null,
    { sleep: async () => {}, attempts: 6 });
  assert.equal(dispatchTries, 3);          // retried twice, succeeded on the 3rd
  assert.match(res.actionsUrl, /octo\/demo\/actions/);
});

test("pushKit retries on non-fast-forward by rebuilding on the newest branch tip", async () => {
  let refCalls = 0;
  let patchCalls = 0;
  const treeBodies = [];
  const commitBodies = [];
  const patchBodies = [];
  global.fetch = async (url, opts) => {
    opts = opts || {};
    const u = new URL(url);
    const key = (opts.method || "GET") + " " + u.pathname;

    if (key === "GET /repos/octo/demo") {
      return { ok: true, status: 200, json: async () => ({ default_branch: "main", size: 1 }) };
    }
    if (key === "GET /repos/octo/demo/git/ref/heads/main") {
      refCalls++;
      return { ok: true, status: 200, json: async () => ({ object: { sha: refCalls === 1 ? "oldsha" : "newsha" } }) };
    }
    if (key === "GET /repos/octo/demo/git/commits/oldsha") {
      return { ok: true, status: 200, json: async () => ({ tree: { sha: "oldtree" } }) };
    }
    if (key === "GET /repos/octo/demo/git/commits/newsha") {
      return { ok: true, status: 200, json: async () => ({ tree: { sha: "newtree" } }) };
    }
    if (key === "POST /repos/octo/demo/git/trees") {
      treeBodies.push(JSON.parse(opts.body));
      return { ok: true, status: 200, json: async () => ({ sha: "tree" + treeBodies.length }) };
    }
    if (key === "POST /repos/octo/demo/git/commits") {
      commitBodies.push(JSON.parse(opts.body));
      return { ok: true, status: 200, json: async () => ({ sha: "commit" + commitBodies.length }) };
    }
    if (key === "PATCH /repos/octo/demo/git/refs/heads/main") {
      patchCalls++;
      patchBodies.push(JSON.parse(opts.body));
      if (patchCalls === 1) {
        return { ok: false, status: 422, json: async () => ({ message: "Update is not a fast forward" }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    }
    return { ok: false, status: 404, json: async () => ({ message: "no route " + key }) };
  };

  const res = await GitHub.pushKit("octo/demo", "tok", { "nativize.sh": "echo ok" }, "Update kit", {
    sleep: async () => {}
  });

  assert.equal(res.sha, "commit2");
  assert.equal(refCalls, 2);
  assert.equal(patchCalls, 2);
  assert.equal(treeBodies[0].base_tree, "oldtree");
  assert.equal(treeBodies[1].base_tree, "newtree");
  assert.deepEqual(commitBodies[0].parents, ["oldsha"]);
  assert.deepEqual(commitBodies[1].parents, ["newsha"]);
  assert.deepEqual(patchBodies, [{ sha: "commit1" }, { sha: "commit2" }]);
});

test("downloadRepoZip rebuilds the project from trees+blobs (CORS-safe, not /zipball)", async () => {
  const b64 = (s) => Buffer.from(s).toString("base64");
  const calls = mockFetch({
    "GET /repos/octo/demo": () => ({ body: { default_branch: "main" } }),
    "GET /repos/octo/demo/git/ref/heads/main": () => ({ body: { object: { sha: "C1" } } }),
    "GET /repos/octo/demo/git/commits/C1": () => ({ body: { tree: { sha: "T1" } } }),
    "GET /repos/octo/demo/git/trees/T1": () => ({ body: { truncated: false, tree: [
      { path: "README.md", type: "blob", sha: "B1" },
      { path: "assets/logo.png", type: "blob", sha: "B2" },
      { path: "sub", type: "tree", sha: "T2" } // directories are skipped
    ] } }),
    "GET /repos/octo/demo/git/blobs/B1": () => ({ body: { content: b64("hello"), encoding: "base64" } }),
    "GET /repos/octo/demo/git/blobs/B2": () => ({ body: { content: b64("\x89PNG\r\n"), encoding: "base64" } })
  });
  let progressEnd = 0;
  const blob = await GitHub.downloadRepoZip("octo/demo", "tok", null, (p) => { progressEnd = p.done; });
  // Never touches the CORS-blocked zipball endpoint.
  assert.ok(!calls.some((c) => /\/zipball/.test(c.url)), "must not call /zipball");
  assert.ok(calls.some((c) => /\/git\/trees\//.test(c.url)), "should read the git tree");
  assert.equal(progressEnd, 2);       // 2 blobs fetched (the dir was skipped)
  assert.ok(blob.size > 0);
});

test("findWorkflowRun returns the newest dispatched run after the start time", async () => {
  const now = Date.now();
  mockFetch({
    "GET /repos/octo/demo/actions/workflows/nativize-build.yml/runs": () => ({
      body: { workflow_runs: [
        { id: 1, created_at: new Date(now - 5 * 60000).toISOString(), status: "completed", html_url: "u1" }, // too old
        { id: 2, created_at: new Date(now + 1000).toISOString(), status: "in_progress", html_url: "u2" },
        { id: 3, created_at: new Date(now + 2000).toISOString(), status: "queued", html_url: "u3" }
      ] }
    })
  });
  const run = await GitHub.findWorkflowRun("octo/demo", "tok", "nativize-build.yml", now);
  assert.equal(run.id, 3); // newest of the ones after `now`
});

test("listArtifacts maps artifacts to direct API download url plus fallback run page", async () => {
  mockFetch({
    "GET /repos/octo/demo/actions/runs/77/artifacts": () => ({
      body: { artifacts: [
        { name: "android-aab", size_in_bytes: 1234, archive_download_url: "https://api.github.com/x" }
      ] }
    })
  });
  const arts = await GitHub.listArtifacts("octo/demo", "tok", 77);
  assert.equal(arts.length, 1);
  assert.equal(arts[0].name, "android-aab");
  assert.equal(arts[0].sizeBytes, 1234);
  assert.equal(arts[0].downloadUrl, "https://api.github.com/x");
  assert.equal(arts[0].apiUrl, "https://api.github.com/x");
  assert.match(arts[0].fallbackUrl, /\/actions\/runs\/77$/);
});

test("downloadArtifact fetches the artifact archive directly with auth", async () => {
  let calledUrl = "";
  let auth = "";
  global.fetch = async (url, opts) => {
    calledUrl = String(url);
    auth = opts.headers.Authorization;
    return { ok: true, status: 200, blob: async () => new Blob([new Uint8Array([80, 75, 3, 4])], { type: "application/zip" }) };
  };
  const blob = await GitHub.downloadArtifact({ apiUrl: "https://api.github.com/artifact.zip", name: "ios-app" }, "tok");
  assert.equal(calledUrl, "https://api.github.com/artifact.zip");
  assert.match(auth, /Bearer tok/);
  assert.ok(blob.size >= 4);
});

test("buildAndWait dispatches, waits for completion, returns artifacts + progress", async () => {
  const now = Date.now();
  let runCalls = 0;
  mockFetch({
    "GET /repos/octo/demo": () => ({ body: { default_branch: "main" } }),
    "POST /repos/octo/demo/actions/workflows/nativize-build.yml/dispatches": () => ({ status: 204, body: null }),
    "GET /repos/octo/demo/actions/workflows/nativize-build.yml/runs": () => ({
      body: { workflow_runs: [{ id: 9, created_at: new Date(now + 1000).toISOString(), status: "in_progress", html_url: "https://github.com/octo/demo/actions/runs/9" }] }
    }),
    "GET /repos/octo/demo/actions/runs/9": () => {
      runCalls++;
      return { body: { id: 9, status: runCalls >= 2 ? "completed" : "in_progress", conclusion: runCalls >= 2 ? "success" : null, html_url: "https://github.com/octo/demo/actions/runs/9" } };
    },
    "GET /repos/octo/demo/actions/runs/9/artifacts": () => ({
      body: { artifacts: [{ name: "android-aab", size_in_bytes: 50, archive_download_url: "x" }] }
    })
  });
  const stages = [];
  const res = await GitHub.buildAndWait("octo/demo", "tok", "nativize-build.yml", {
    sleep: async () => {},              // no real waiting in tests
    intervalMs: 1,
    onProgress: (stage) => stages.push(stage)
  });
  assert.equal(res.conclusion, "success");
  assert.equal(res.runId, 9);
  assert.equal(res.artifacts[0].name, "android-aab");
  assert.ok(stages.includes("dispatched"));
  assert.ok(stages.includes("completed"));
});
