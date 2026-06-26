/*
 * Nativize content script — entry point on https://lovable.dev/*.
 *
 * Loaded AFTER kit-generator.js, zip.js, github.js, panel.js (see manifest
 * content_scripts order), so it can use the globals they expose.
 *
 * Responsibilities:
 *   - detect app name (page title) + GitHub repo (scrape github.com links)
 *   - restore last-used config + token from chrome.storage.local
 *   - mount the shadow-DOM panel and wire its callbacks to:
 *       Download .zip   -> NativizeZip
 *       Push to GitHub  -> NativizeGitHub
 *   - persist edits back to chrome.storage.local
 */
(function () {
  "use strict";
  if (window.__nativizeMounted) return; // guard against double-injection
  window.__nativizeMounted = true;

  var Kit = window.NativizeKit;
  var Zip = window.NativizeZip;
  var GitHub = window.NativizeGitHub;
  var Panel = window.NativizePanel;

  // ---- Detection ---------------------------------------------------------
  function detectAppName() {
    var t = (document.title || "").trim();
    // Lovable titles look like "My App – Lovable" / "My App | Lovable".
    t = t.replace(/\s*[|–—\-]\s*Lovable.*$/i, "").trim();
    return t || "My Lovable App";
  }

  function detectRepo() {
    var links = document.querySelectorAll('a[href*="github.com/"]');
    for (var i = 0; i < links.length; i++) {
      var m = links[i].href.match(/github\.com\/([^\/\s]+)\/([^\/\s#?]+)/i);
      if (m) {
        var owner = m[1], repo = m[2].replace(/\.git$/, "");
        if (owner && repo && owner !== "apps" && owner !== "marketplace") {
          return owner + "/" + repo;
        }
      }
    }
    return "";
  }

  // ---- Storage helpers ---------------------------------------------------
  // Store editable fields per Lovable project so opening project B never
  // inherits project A's detected name/repo. The token is intentionally shared
  // across projects but remains in chrome.storage.local.
  var LEGACY_STORAGE_KEY = "nativize:lastConfig";
  var CONFIG_KEY = "nativize:config:" + location.origin + location.pathname;
  var TOKEN_KEY = "nativize:githubToken";
  function loadSaved() {
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.get([CONFIG_KEY, TOKEN_KEY, LEGACY_STORAGE_KEY], function (res) {
          res = res || {};
          var saved = Object.assign({}, res[CONFIG_KEY] || {});
          saved.token = res[TOKEN_KEY] || (res[LEGACY_STORAGE_KEY] && res[LEGACY_STORAGE_KEY].token) || "";
          resolve(saved);
        });
      } catch (e) { resolve({}); }
    });
  }
  function save(state) {
    try {
      var obj = {};
      obj[CONFIG_KEY] = {
        appName: state.appName,
        appId: state.appId,
        githubRepo: state.githubRepo,
        webDir: state.webDir,
        enablePush: state.enablePush
      };
      obj[TOKEN_KEY] = state.token || "";
      chrome.storage.local.set(obj);
    } catch (e) {}
  }

  function triggerDownload(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { a.remove(); URL.revokeObjectURL(url); }, 1000);
  }

  // ---- Mount -------------------------------------------------------------
  loadSaved().then(function (saved) {
    var initial = {
      appName: saved.appName || detectAppName(),
      appId: saved.appId || Kit.normalizeAppId("", saved.appName || detectAppName()),
      githubRepo: saved.githubRepo || detectRepo(),
      webDir: saved.webDir || "dist",
      enablePush: saved.enablePush === true,
      token: saved.token || ""
    };

    Panel.mount({
      initial: initial,
      onChange: function (state) { save(state); },
      // One-click GitHub sign-in. chrome.identity only works in the background
      // service worker, so we relay the request to it and get the token back.
      onSignIn: function () {
        return new Promise(function (resolve, reject) {
          try {
            chrome.runtime.sendMessage({ type: "nativize-signin" }, function (res) {
              if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
              if (!res || !res.ok) return reject(new Error((res && res.error) || "Sign-in failed."));
              resolve(res.token);
            });
          } catch (e) { reject(e); }
        });
      },
      onSignOut: function () {
        try { chrome.runtime.sendMessage({ type: "nativize-signout" }, function () {}); } catch (e) {}
      },
      // Download the full project (src + ios + android + desktop) as a .zip.
      onDownloadProject: function (state) {
        return GitHub.downloadRepoZip(state.githubRepo, state.token).then(function (blob) {
          triggerDownload(blob, (Kit.slugify(state.appName) || "project") + "-full-project.zip");
        });
      },
      onDownload: function (state) {
        var files = Kit.generateKit(state);
        var name = (Kit.slugify(state.appName) || "nativize") + "-native-kit.zip";
        triggerDownload(Zip.toBlob(files), name);
        save(state);
      },
      onPush: function (state, token, onProgress) {
        var files = Kit.generateKit(state);
        save(state);
        // 1) commit the kit, then 2) if store upload is on, encrypt + store the
        //    credentials as GitHub Actions secrets so the release workflow can run.
        return GitHub.pushKit(state.githubRepo, token, files,
          "Add Nativize native kit for " + state.appName + " (Capacitor 8)")
          .then(function (res) {
            var secrets = state.storeSecrets || {};
            var wantStore = (state.iosUpload || state.androidUpload) && Object.keys(secrets).length;
            if (!wantStore) return res;
            return GitHub.setSecrets(state.githubRepo, token, secrets).then(function (s) {
              res.secretsSet = s.set;
              res.releaseReady = true;
              return res;
            });
          })
          .then(function (res) {
            // Start the cloud build AND wait for it, so we can hand the user real
            // download links to the finished .apk / .aab / iOS app instead of just
            // "go check Actions". The release workflow (if store upload is on) also
            // ships to the stores. A dispatch/wait failure is non-fatal — we fall
            // back to a manual-run message.
            var workflow = res.releaseReady ? "nativize-release.yml" : "nativize-build.yml";
            return GitHub.buildAndWait(state.githubRepo, token, workflow, { onProgress: onProgress })
              .then(function (b) {
                res.buildStarted = true;
                res.workflow = workflow;
                res.runId = b.runId;
                res.runUrl = b.runUrl;
                res.conclusion = b.conclusion;
                res.artifacts = b.artifacts;
                return res;
              })
              .catch(function (e) {
                res.buildStarted = false;
                res.buildStartError = (e && e.message) || String(e);
                res.actionsUrl = "https://github.com/" + state.githubRepo + "/actions";
                return res;
              });
          });
      }
    });
  });
})();
