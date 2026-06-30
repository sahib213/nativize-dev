/*
 * Nativize GitHub push — dependency-free, uses fetch + the GitHub REST API.
 *
 * Commits the whole kit as ONE commit via the Git Data API (blobs are passed
 * inline through the tree endpoint, so no separate blob round-trips):
 *   1. resolve default branch + its tip commit
 *   2. create a tree (base = current tree) with all kit files
 *   3. create a commit pointing at that tree
 *   4. fast-forward the branch ref
 *
 * Token (repo scope) is passed in by the caller — it lives only in
 * chrome.storage.local and is never persisted by this module.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.NativizeGitHub = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var API = "https://api.github.com";
  var MAX_TOKEN_LENGTH = 5000;
  var MAX_FILES = 100;
  var MAX_FILE_BYTES = 250000;
  var MAX_TOTAL_BYTES = 2500000;
  var MAX_SECRET_VALUE_BYTES = 250000;

  function authHeaders(token) {
    token = String(token || "");
    if (!token || token.length > MAX_TOKEN_LENGTH || /[\s\u0000-\u001f\u007f]/.test(token)) {
      throw new Error("GitHub token is missing or malformed.");
    }
    return {
      Authorization: "Bearer " + token,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28"
    };
  }

  async function gh(method, url, token, body) {
    var res = await fetch(API + url, {
      method: method,
      headers: Object.assign(authHeaders(token), body ? { "Content-Type": "application/json" } : {}),
      body: body ? JSON.stringify(body) : undefined
    });
    if (!res.ok) {
      var detail = "";
      try { detail = (await res.json()).message; } catch (e) {}
      // The #1 real-world failure: a repo-only token can't add/run workflow files.
      if ((res.status === 403 || res.status === 404) && /workflow/i.test(detail || "") && /scope/i.test(detail || "")) {
        throw new Error("Your GitHub token is missing the 'workflow' scope, which is required to add and run " +
          "the build. Create a new token with BOTH 'repo' and 'workflow' scopes, then paste it and build again.");
      }
      throw new Error("GitHub " + res.status + (detail ? " — " + detail : "") + " (" + method + " " + url + ")");
    }
    return res.status === 204 ? null : res.json();
  }

  function splitRepo(repo) {
    var cleaned = String(repo || "").trim()
      .replace(/^https?:\/\/github\.com\//, "")
      .replace(/[?#].*$/, "")
      .replace(/\.git\/?$/, "")
      .replace(/\/+$/, "");
    var parts = cleaned.split("/");
    if (cleaned.length > 140 || parts.length !== 2 || !/^[a-z0-9][a-z0-9-]{0,38}$/i.test(parts[0]) || !/^[a-z0-9][a-z0-9_.-]{0,99}$/i.test(parts[1])) {
      throw new Error("Repo must be in 'owner/repo' form.");
    }
    return { owner: parts[0], repo: parts[1] };
  }

  function byteLength(text) {
    if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(String(text)).length;
    return Buffer.byteLength(String(text));
  }

  function validateFileMap(files) {
    if (!files || typeof files !== "object" || Array.isArray(files)) throw new Error("Generated file map is invalid.");
    var paths = Object.keys(files);
    if (!paths.length || paths.length > MAX_FILES) throw new Error("Generated file set is too large.");
    var total = 0;
    paths.forEach(function (path) {
      if (!/^[A-Za-z0-9._\/-]{1,180}$/.test(path) || /(^|\/)\.\.?($|\/)/.test(path) || path.charAt(0) === "/") {
        throw new Error("Generated file path is invalid: " + path);
      }
      var size = byteLength(files[path]);
      if (size > MAX_FILE_BYTES) throw new Error("Generated file is too large: " + path);
      total += size;
    });
    if (total > MAX_TOTAL_BYTES) throw new Error("Generated kit is too large.");
  }

  function validateSecretName(name) {
    if (!/^[A-Z0-9_]{1,80}$/.test(name)) throw new Error("Secret name is invalid.");
  }

  /**
   * Push a { path: contents } map as a single commit.
   * @returns {Promise<{url: string, sha: string, branch: string}>}
   */
  async function pushKit(repoStr, token, files, message, opts) {
    opts = opts || {};
    var sleep = opts.sleep || defaultSleep;
    if (!token) throw new Error("A GitHub token with 'repo' + 'workflow' scopes is required.");
    validateFileMap(files);
    var r = splitRepo(repoStr);
    var base = "/repos/" + r.owner + "/" + r.repo;

    var repoInfo = await gh("GET", base, token);
    var branch = repoInfo.default_branch || "main";

    // An empty repo (no commits) has no app source to build, and the Git Data
    // API can't add onto a missing ref. Catch it with an actionable message.
    if (repoInfo.size === 0) {
      throw new Error("Repo '" + r.owner + "/" + r.repo + "' is empty — connect your " +
        "Lovable project to GitHub first so your app's source is in the repo, then push the kit.");
    }

    var tree = Object.keys(files).map(function (path) {
      return {
        path: path,
        mode: /\.sh$/.test(path) ? "100755" : "100644", // shell scripts executable
        type: "blob",
        content: String(files[path])
      };
    });

    for (var attempt = 0; attempt < 3; attempt++) {
      var ref;
      try {
        ref = await gh("GET", base + "/git/ref/heads/" + branch, token);
      } catch (e) {
        throw new Error("Branch '" + branch + "' has no commits yet. Sync your Lovable app to " +
          "this repo first (it needs source + a build script), then push the kit.");
      }
      var latestCommitSha = ref.object.sha;
      var latestCommit = await gh("GET", base + "/git/commits/" + latestCommitSha, token);
      var baseTreeSha = latestCommit.tree.sha;

      var newTree = await gh("POST", base + "/git/trees", token, { base_tree: baseTreeSha, tree: tree });
      var commit = await gh("POST", base + "/git/commits", token, {
        message: message || "Add Nativize native kit (Capacitor 8)",
        tree: newTree.sha,
        parents: [latestCommitSha]
      });

      try {
        await gh("PATCH", base + "/git/refs/heads/" + branch, token, { sha: commit.sha });
        return {
          sha: commit.sha,
          branch: branch,
          url: "https://github.com/" + r.owner + "/" + r.repo + "/commit/" + commit.sha
        };
      } catch (e) {
        if (!/not a fast forward|reference update failed/i.test(e.message || "") || attempt === 2) throw e;
        await sleep(700 * (attempt + 1));
      }
    }
  }

  /**
   * Trigger a workflow_dispatch run so the cloud build actually starts.
   *
   * A workflow file we JUST pushed isn't registered by GitHub for a few seconds,
   * so the first dispatch can 404 ("Workflow does not exist"). We retry with a
   * short delay so the build reliably starts instead of silently no-op'ing.
   * @param {object} [opts] { attempts, intervalMs, sleep }
   * @returns {Promise<{actionsUrl: string, ref: string}>}
   */
  async function triggerWorkflow(repoStr, token, workflowFile, ref, opts) {
    opts = opts || {};
    var sleep = opts.sleep || defaultSleep;
    var attempts = opts.attempts || 6;
    var r = splitRepo(repoStr);
    var base = "/repos/" + r.owner + "/" + r.repo;
    if (!ref) {
      var info = await gh("GET", base, token);
      ref = info.default_branch || "main";
    }
    var lastErr;
    for (var i = 0; i < attempts; i++) {
      try {
        await gh("POST", base + "/actions/workflows/" + encodeURIComponent(workflowFile) + "/dispatches",
          token, { ref: ref });
        return { ref: ref, actionsUrl: "https://github.com/" + r.owner + "/" + r.repo + "/actions" };
      } catch (e) {
        lastErr = e;
        // Only the "not registered yet" class of error is worth retrying.
        if (!/does not exist|not found|404|422/i.test(e.message || "")) throw e;
        if (i < attempts - 1) await sleep(opts.intervalMs || 4000);
      }
    }
    throw lastErr;
  }

  // Resolve the sealed-box module in either environment (Node require / browser global).
  function getSealedBox() {
    if (typeof module === "object" && module.exports) return require("./sealedbox.js");
    var g = (typeof self !== "undefined" ? self : window);
    if (!g.NativizeSealedBox) throw new Error("Sealed-box crypto not loaded (sealedbox.js).");
    return g.NativizeSealedBox;
  }

  /**
   * Encrypt and store repo-level GitHub Actions secrets.
   * @param {string} repoStr  "owner/repo"
   * @param {string} token    GitHub token with 'repo' (and Actions) scope
   * @param {Object} secrets  { SECRET_NAME: "value", ... } — empty values skipped
   * @returns {Promise<{set: string[], skipped: string[]}>}
   */
  async function setSecrets(repoStr, token, secrets) {
    if (!token) throw new Error("A GitHub token with 'repo' + 'workflow' scopes is required.");
    if (!secrets || typeof secrets !== "object" || Array.isArray(secrets)) throw new Error("Store secrets are invalid.");
    var sb = getSealedBox();
    var r = splitRepo(repoStr);
    var base = "/repos/" + r.owner + "/" + r.repo;

    // The public key used to encrypt every secret for this repo.
    var pub = await gh("GET", base + "/actions/secrets/public-key", token);

    var set = [], skipped = [];
    var names = Object.keys(secrets);
    if (names.length > 20) throw new Error("Too many store secrets.");
    for (var i = 0; i < names.length; i++) {
      var name = names[i];
      validateSecretName(name);
      var value = secrets[name];
      if (value == null || String(value) === "") { skipped.push(name); continue; }
      if (byteLength(value) > MAX_SECRET_VALUE_BYTES) throw new Error("Store secret value is too large: " + name);
      var encrypted = sb.sealBase64(String(value), pub.key);
      await gh("PUT", base + "/actions/secrets/" + encodeURIComponent(name), token, {
        encrypted_value: encrypted,
        key_id: pub.key_id
      });
      set.push(name);
    }
    return { set: set, skipped: skipped };
  }

  /**
   * Find the run created by a dispatch we just sent. There's a short lag
   * between dispatching and the run appearing, so callers poll this.
   * @returns {Promise<object|null>} the newest matching run, or null if none yet
   */
  async function findWorkflowRun(repoStr, token, workflowFile, sinceMs) {
    var r = splitRepo(repoStr);
    var base = "/repos/" + r.owner + "/" + r.repo;
    var data = await gh("GET", base + "/actions/workflows/" +
      encodeURIComponent(workflowFile) + "/runs?event=workflow_dispatch&per_page=10", token);
    var runs = (data && data.workflow_runs) || [];
    var skew = 60 * 1000; // tolerate clock skew between the browser and GitHub
    var match = null;
    for (var i = 0; i < runs.length; i++) {
      var t = Date.parse(runs[i].created_at);
      if (sinceMs && t < sinceMs - skew) continue;
      if (!match || t > Date.parse(match.created_at)) match = runs[i];
    }
    return match;
  }

  /** Fetch one run's current status/conclusion. */
  async function getRun(repoStr, token, runId) {
    var r = splitRepo(repoStr);
    return gh("GET", "/repos/" + r.owner + "/" + r.repo + "/actions/runs/" + runId, token);
  }

  /**
   * List a finished run's downloadable artifacts (the .apk / .aab / iOS app).
   * The artifact API URL needs auth; the app uses it to download directly in
   * the browser, with fallbackUrl only for debugging failed builds.
   * @returns {Promise<Array<{name, sizeBytes, downloadUrl, apiUrl, fallbackUrl}>>}
   */
  async function listArtifacts(repoStr, token, runId) {
    var r = splitRepo(repoStr);
    var base = "/repos/" + r.owner + "/" + r.repo;
    var data = await gh("GET", base + "/actions/runs/" + runId + "/artifacts", token);
    var arts = (data && data.artifacts) || [];
    var runUrl = "https://github.com/" + r.owner + "/" + r.repo + "/actions/runs/" + runId;
    return arts.map(function (a) {
      return { name: a.name, sizeBytes: a.size_in_bytes, downloadUrl: a.archive_download_url, apiUrl: a.archive_download_url, fallbackUrl: runUrl };
    });
  }

  /** Download a GitHub Actions artifact archive as a Blob. */
  async function downloadArtifact(artifact, token) {
    var url = artifact && (artifact.apiUrl || artifact.downloadUrl);
    if (!url) throw new Error("Artifact download URL is missing.");
    var res = await fetch(url, { headers: authHeaders(token) });
    if (!res.ok) {
      var detail = ""; try { detail = (await res.json()).message; } catch (e) {}
      throw new Error("Couldn't download the artifact (GitHub " + res.status + (detail ? " — " + detail : "") + ").");
    }
    return res.blob();
  }

  function defaultSleep(ms) { return new Promise(function (res) { setTimeout(res, ms); }); }

  /**
   * Dispatch a workflow and WAIT for the run to finish, reporting progress.
   * This is what turns "build started, go check Actions" into "here's your app".
   *
   * @param {object} [opts] { ref, onProgress(stage,info), sleep(ms),
   *                          intervalMs, timeoutMs }
   *   stages reported: "dispatched" | "queued" | "in_progress" | "completed"
   * @returns {Promise<{runId, runUrl, conclusion, artifacts}>}
   */
  async function buildAndWait(repoStr, token, workflowFile, opts) {
    opts = opts || {};
    var sleep = opts.sleep || defaultSleep;
    var interval = opts.intervalMs || 6000;
    var deadline = Date.now() + (opts.timeoutMs || 20 * 60 * 1000);
    var startedAt = Date.now();
    var report = function (stage, info) { if (opts.onProgress) opts.onProgress(stage, info || {}); };

    var trig = await triggerWorkflow(repoStr, token, workflowFile, opts.ref,
      { sleep: sleep, intervalMs: interval });
    report("dispatched", { actionsUrl: trig.actionsUrl });

    // 1) wait for the dispatched run to appear
    var run = null;
    while (!run) {
      if (Date.now() > deadline) throw new Error("Timed out waiting for the build to start.");
      await sleep(interval);
      run = await findWorkflowRun(repoStr, token, workflowFile, startedAt);
      if (run) report(run.status || "queued", { runUrl: run.html_url });
    }

    // 2) poll until it completes
    while (run.status !== "completed") {
      if (Date.now() > deadline) throw new Error("Timed out waiting for the build to finish.");
      await sleep(interval);
      run = await getRun(repoStr, token, run.id);
      report(run.status, { runUrl: run.html_url });
    }

    var artifacts = [];
    try { artifacts = await listArtifacts(repoStr, token, run.id); } catch (e) { /* artifacts optional */ }
    var result = { runId: run.id, runUrl: run.html_url, conclusion: run.conclusion, artifacts: artifacts };
    report("completed", result);
    return result;
  }

  /**
   * Download the WHOLE project (src + ios + android + desktop + configs) as a
   * .zip — GitHub's repo archive. This is the full source project; the compiled
   * apps (.dmg/.exe/.apk/.aab) stay as build artifacts (a browser can't bundle
   * hundreds of MB of binaries).
   * @returns {Promise<Blob>}
   */
  // Resolve the zip module in Node (require) or the browser (global).
  function getZip() {
    if (typeof module === "object" && module.exports) return require("./zip.js");
    var g = (typeof self !== "undefined" ? self : window);
    if (!g.NativizeZip) throw new Error("Zip module not loaded (zip.js).");
    return g.NativizeZip;
  }
  function b64ToBytes(b64) {
    b64 = String(b64 || "").replace(/\s+/g, "");
    if (typeof atob === "function") {
      var bin = atob(b64), len = bin.length, bytes = new Uint8Array(len);
      for (var i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
      return bytes;
    }
    return new Uint8Array(Buffer.from(b64, "base64"));
  }

  /**
   * Download the WHOLE project (src + generated ios/android/desktop + configs)
   * as a .zip — built CLIENT-SIDE from the Git Trees + Blobs API.
   *
   * Why not the /zipball endpoint? It 302-redirects to codeload.github.com,
   * which sends no CORS headers AND the browser drops the Authorization header
   * on the cross-origin redirect — so a browser fetch() throws "Failed to fetch".
   * The Trees/Blobs API lives on api.github.com (CORS-enabled), so we read every
   * blob and zip it ourselves. Works for private repos too.
   * @returns {Promise<Blob>}
   */
  async function downloadRepoZip(repoStr, token, ref, onProgress) {
    var r = splitRepo(repoStr);
    var base = "/repos/" + r.owner + "/" + r.repo;
    var info = await gh("GET", base, token);
    var branch = ref || info.default_branch || "main";
    var refData = await gh("GET", base + "/git/ref/heads/" + encodeURIComponent(branch), token);
    var commit = await gh("GET", base + "/git/commits/" + refData.object.sha, token);
    var tree = await gh("GET", base + "/git/trees/" + commit.tree.sha + "?recursive=1", token);
    var blobs = (tree.tree || []).filter(function (n) { return n.type === "blob"; });
    if (!blobs.length) throw new Error("That repo has no files to download yet — connect your app's source first.");

    var files = {};
    var prefix = r.repo + "/"; // GitHub archives nest everything under a top folder
    var done = 0, queue = blobs.slice();
    async function fetchBlob(node) {
      var blob = await gh("GET", base + "/git/blobs/" + encodeURIComponent(node.sha), token);
      files[prefix + node.path] = blob.encoding === "base64"
        ? b64ToBytes(blob.content)
        : String(blob.content == null ? "" : blob.content);
      done++;
      if (onProgress) onProgress({ done: done, total: blobs.length });
    }
    async function worker() { while (queue.length) { await fetchBlob(queue.shift()); } }
    var pool = [];
    for (var w = 0; w < Math.min(8, blobs.length); w++) pool.push(worker());
    await Promise.all(pool);

    if (tree.truncated) {
      files[prefix + "NATIVIZE_DOWNLOAD_NOTE.txt"] =
        "This repository is very large; GitHub's tree API truncated the listing, so a few files may be missing from this archive.\n";
    }
    return getZip().toBlob(files);
  }

  /**
   * Does this repo already have a Nativize kit? Lets the UI offer "Update &
   * rebuild" / "Just rebuild" instead of the full first-time setup, so users
   * don't have to redo everything to ship a change.
   * @returns {Promise<{hasKit:boolean, hasRelease:boolean, defaultBranch:string}>}
   */
  async function detectKit(repoStr, token) {
    var r = splitRepo(repoStr);
    var base = "/repos/" + r.owner + "/" + r.repo;
    var info = await gh("GET", base, token);
    var branch = info.default_branch || "main";
    async function exists(path) {
      try {
        await gh("GET", base + "/contents/" + path + "?ref=" + encodeURIComponent(branch), token);
        return true;
      } catch (e) { return false; }
    }
    var hasBuild = await exists(".github/workflows/nativize-build.yml");
    var hasRelease = await exists(".github/workflows/nativize-release.yml");
    return { hasKit: hasBuild || hasRelease, hasRelease: hasRelease, defaultBranch: branch };
  }

  /**
   * Re-run the cloud build on an EXISTING kit without re-pushing anything — for
   * "I changed my app, just rebuild it." Picks the release workflow if present.
   */
  async function rebuild(repoStr, token, opts) {
    opts = opts || {};
    var det = await detectKit(repoStr, token);
    if (!det.hasKit) throw new Error("This repo isn't Nativized yet — push the kit first.");
    var workflow = det.hasRelease ? "nativize-release.yml" : "nativize-build.yml";
    return buildAndWait(repoStr, token, workflow, { ref: det.defaultBranch, onProgress: opts.onProgress });
  }

  return {
    pushKit: pushKit, setSecrets: setSecrets, triggerWorkflow: triggerWorkflow, splitRepo: splitRepo,
    findWorkflowRun: findWorkflowRun, getRun: getRun, listArtifacts: listArtifacts, buildAndWait: buildAndWait,
    downloadRepoZip: downloadRepoZip, downloadArtifact: downloadArtifact, detectKit: detectKit, rebuild: rebuild
  };
});
