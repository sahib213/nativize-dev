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
    if (!token) throw new Error("A GitHub token with 'repo' scope is required.");
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
   * The workflow file must already exist on the default branch (we just pushed it).
   * @returns {Promise<{actionsUrl: string, ref: string}>}
   */
  async function triggerWorkflow(repoStr, token, workflowFile, ref) {
    var r = splitRepo(repoStr);
    var base = "/repos/" + r.owner + "/" + r.repo;
    if (!ref) {
      var info = await gh("GET", base, token);
      ref = info.default_branch || "main";
    }
    await gh("POST", base + "/actions/workflows/" + encodeURIComponent(workflowFile) + "/dispatches",
      token, { ref: ref });
    return {
      ref: ref,
      actionsUrl: "https://github.com/" + r.owner + "/" + r.repo + "/actions"
    };
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
    if (!token) throw new Error("A GitHub token with 'repo' scope is required.");
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

  return { pushKit: pushKit, setSecrets: setSecrets, triggerWorkflow: triggerWorkflow, splitRepo: splitRepo };
});
