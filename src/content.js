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
      onDownload: function (state) {
        var files = Kit.generateKit(state);
        var name = (Kit.slugify(state.appName) || "nativize") + "-native-kit.zip";
        triggerDownload(Zip.toBlob(files), name);
        save(state);
      },
      onPush: function (state, token) {
        var files = Kit.generateKit(state);
        save(state);
        return GitHub.pushKit(state.githubRepo, token, files,
          "Add Nativize native kit for " + state.appName + " (Capacitor 8)");
      }
    });
  });
})();
