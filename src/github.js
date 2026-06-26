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

  function authHeaders(token) {
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
    if (parts.length !== 2 || !/^[a-z0-9-]+$/i.test(parts[0]) || !/^[a-z0-9_.-]+$/i.test(parts[1])) {
      throw new Error("Repo must be in 'owner/repo' form.");
    }
    return { owner: parts[0], repo: parts[1] };
  }

  /**
   * Push a { path: contents } map as a single commit.
   * @returns {Promise<{url: string, sha: string, branch: string}>}
   */
  async function pushKit(repoStr, token, files, message) {
    if (!token) throw new Error("A GitHub token with 'repo' + 'workflow' scopes is required.");
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

    var tree = Object.keys(files).map(function (path) {
      return {
        path: path,
        mode: /\.sh$/.test(path) ? "100755" : "100644", // shell scripts executable
        type: "blob",
        content: String(files[path])
      };
    });

    var newTree = await gh("POST", base + "/git/trees", token, { base_tree: baseTreeSha, tree: tree });
    var commit = await gh("POST", base + "/git/commits", token, {
      message: message || "Add Nativize native kit (Capacitor 8)",
      tree: newTree.sha,
      parents: [latestCommitSha]
    });
    await gh("PATCH", base + "/git/refs/heads/" + branch, token, { sha: commit.sha });

    return {
      sha: commit.sha,
      branch: branch,
      url: "https://github.com/" + r.owner + "/" + r.repo + "/commit/" + commit.sha
    };
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
    var sb = getSealedBox();
    var r = splitRepo(repoStr);
    var base = "/repos/" + r.owner + "/" + r.repo;

    // The public key used to encrypt every secret for this repo.
    var pub = await gh("GET", base + "/actions/secrets/public-key", token);

    var set = [], skipped = [];
    var names = Object.keys(secrets);
    for (var i = 0; i < names.length; i++) {
      var name = names[i];
      var value = secrets[name];
      if (value == null || String(value) === "") { skipped.push(name); continue; }
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
   * The API's archive_download_url needs auth, so we hand the user the run page
   * URL — one click, no token handling in the page — plus the API url for tools.
   * @returns {Promise<Array<{name, sizeBytes, downloadUrl, apiUrl}>>}
   */
  async function listArtifacts(repoStr, token, runId) {
    var r = splitRepo(repoStr);
    var base = "/repos/" + r.owner + "/" + r.repo;
    var data = await gh("GET", base + "/actions/runs/" + runId + "/artifacts", token);
    var arts = (data && data.artifacts) || [];
    var runUrl = "https://github.com/" + r.owner + "/" + r.repo + "/actions/runs/" + runId;
    return arts.map(function (a) {
      return { name: a.name, sizeBytes: a.size_in_bytes, downloadUrl: runUrl, apiUrl: a.archive_download_url };
    });
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
  async function downloadRepoZip(repoStr, token, ref) {
    var r = splitRepo(repoStr);
    var url = API + "/repos/" + r.owner + "/" + r.repo + "/zipball" + (ref ? "/" + encodeURIComponent(ref) : "");
    var res = await fetch(url, { headers: authHeaders(token) });
    if (!res.ok) {
      var detail = ""; try { detail = (await res.json()).message; } catch (e) {}
      throw new Error("Couldn't download the project zip (GitHub " + res.status + (detail ? " — " + detail : "") + ").");
    }
    return res.blob();
  }

  return {
    pushKit: pushKit, setSecrets: setSecrets, triggerWorkflow: triggerWorkflow, splitRepo: splitRepo,
    findWorkflowRun: findWorkflowRun, getRun: getRun, listArtifacts: listArtifacts, buildAndWait: buildAndWait,
    downloadRepoZip: downloadRepoZip
  };
});
