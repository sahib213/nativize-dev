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
  var Billing = window.NativizeBilling;

  // ---- Detection ---------------------------------------------------------
  function detectAppName() {
    var t = (document.title || "").trim();
    // Lovable titles look like "My App – Lovable" / "My App | Lovable".
    t = t.replace(/\s*[|–—\-]\s*Lovable.*$/i, "").trim();
    return t || "My Lovable App";
  }

  var GITHUB_OWNER_DENY = {
    about: true, apps: true, blog: true, contact: true, customer: true,
    enterprise: true, explore: true, features: true, github: true,
    login: true, marketplace: true, new: true, orgs: true, organizations: true,
    pricing: true, security: true, settings: true, site: true, sponsors: true,
    topics: true
  };
  var GITHUB_REPO_DENY = {
    actions: true, blob: true, commit: true, commits: true, issues: true,
    network: true, packages: true, projects: true, pull: true, pulls: true,
    releases: true, security: true, settings: true, tree: true
  };
  function validRepoParts(owner, repo) {
    owner = String(owner || "").trim();
    repo = String(repo || "").trim().replace(/\.git$/i, "");
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner)) return null;
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(repo)) return null;
    if (GITHUB_OWNER_DENY[owner.toLowerCase()] || GITHUB_REPO_DENY[repo.toLowerCase()]) return null;
    return owner + "/" + repo;
  }
  function normalizeGithubRepoCandidate(value, allowPlain) {
    value = String(value || "").trim();
    if (!value) return "";
    var git = value.match(/git@github\.com:([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})(?:\.git)?(?:\s|$)/i);
    if (git) return validRepoParts(git[1], git[2]) || "";
    var url = value.match(/(?:https?:)?\/\/(?:www\.)?github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})(?:\.git)?(?:[\/?#\s"'<>]|$)/i);
    if (url) return validRepoParts(url[1], url[2]) || "";
    if (allowPlain || /github|repo|repository/i.test(value)) {
      var plain = value.match(/\b([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})\b/);
      if (plain) return validRepoParts(plain[1], plain[2]) || "";
    }
    return "";
  }
  function addRepoCandidate(candidates, value, score, allowPlain) {
    var repo = normalizeGithubRepoCandidate(value, allowPlain);
    if (!repo) return;
    for (var i = 0; i < candidates.length; i++) {
      if (candidates[i].repo.toLowerCase() === repo.toLowerCase()) {
        candidates[i].score = Math.max(candidates[i].score, score);
        return;
      }
    }
    candidates.push({ repo: repo, score: score });
  }
  function scanRepoText(candidates, text, score) {
    text = String(text || "");
    if (!/github|repo|repository/i.test(text)) return;
    var limited = text.length > 220000 ? text.slice(0, 220000) : text;
    var re = /(?:https?:)?\/\/(?:www\.)?github\.com\/[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}(?:\.git)?/ig;
    var match;
    while ((match = re.exec(limited)) && candidates.length < 20) {
      addRepoCandidate(candidates, match[0], score, false);
    }
    var keyed = /(?:githubRepo|github_repo|githubRepository|github_repository|repositoryFullName|repoFullName|full_name|repo)\s*["':=]+\s*["']?([A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100})/ig;
    while ((match = keyed.exec(limited)) && candidates.length < 20) {
      addRepoCandidate(candidates, match[1], score - 1, true);
    }
  }
  function detectRepo() {
    var candidates = [];
    var links = document.querySelectorAll('a[href*="github.com/"], a[href^="git@github.com:"]');
    for (var i = 0; i < links.length; i++) {
      addRepoCandidate(candidates, links[i].href, 100, false);
      addRepoCandidate(candidates, links[i].textContent, 80, true);
    }

    var nodes = document.querySelectorAll("[href], [aria-label], [title], [data-github-repo], [data-repo], [data-repository], [data-github-url]");
    for (var n = 0; n < nodes.length && n < 1600; n++) {
      var node = nodes[n];
      var text = "";
      for (var a = 0; a < node.attributes.length; a++) {
        var attr = node.attributes[a];
        if (/github|repo|repository/i.test(attr.name + " " + attr.value)) text += " " + attr.value;
      }
      if (text) scanRepoText(candidates, text, 74);
    }

    var scripts = document.querySelectorAll("script:not([src])");
    for (var s = 0; s < scripts.length && s < 30; s++) {
      scanRepoText(candidates, scripts[s].textContent || "", 62);
    }

    try {
      [localStorage, sessionStorage].forEach(function (store) {
        for (var k = 0; k < store.length && k < 80; k++) {
          var key = store.key(k) || "";
          var val = store.getItem(key) || "";
          if (/github|repo|repository/i.test(key + " " + val)) {
            scanRepoText(candidates, key + " " + val, 58);
          }
        }
      });
    } catch (e) {}

    candidates.sort(function (a, b) { return b.score - a.score; });
    return candidates.length ? candidates[0].repo : "";
  }

  function startRepoAutodetect(panelApi) {
    if (!panelApi || typeof panelApi.setRepo !== "function" || typeof panelApi.getState !== "function") return;
    var done = false;
    function applyDetectedRepo() {
      if (done) return true;
      var current = panelApi.getState().githubRepo;
      if (current) { done = true; return true; }
      var repo = detectRepo();
      if (!repo) return false;
      panelApi.setRepo(repo);
      done = true;
      return true;
    }
    if (applyDetectedRepo()) return;
    var timers = [600, 1600, 3400, 7000, 12000].map(function (ms) {
      return setTimeout(applyDetectedRepo, ms);
  });
    var observer = null;
    if (typeof MutationObserver !== "undefined") {
      observer = new MutationObserver(function () {
        if (applyDetectedRepo() && observer) observer.disconnect();
      });
      try { observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true }); } catch (e) {}
    }
    setTimeout(function () {
      timers.forEach(clearTimeout);
      if (observer) observer.disconnect();
    }, 15000);
  }

  // ---- Storage helpers ---------------------------------------------------
  // Store editable fields per Lovable project so opening project B never
  // inherits project A's detected name/repo. The token is intentionally shared
  // across projects but remains in chrome.storage.local.
  var LEGACY_STORAGE_KEY = "nativize:lastConfig";
  var CONFIG_KEY = "nativize:config:" + location.origin + location.pathname;
  var TOKEN_KEY = "nativize:githubToken";
  var SUPABASE_ACCESS_KEY = "nativize:supabaseAccess";
  var SUPABASE_REFRESH_KEY = "nativize:supabaseRefresh";
  var BILLING_KEY = "nativize:billing";
  function loadSaved() {
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.get([CONFIG_KEY, TOKEN_KEY, SUPABASE_ACCESS_KEY, SUPABASE_REFRESH_KEY, BILLING_KEY, LEGACY_STORAGE_KEY], function (res) {
          res = res || {};
          var saved = Object.assign({}, res[CONFIG_KEY] || {});
          saved.token = res[TOKEN_KEY] || (res[LEGACY_STORAGE_KEY] && res[LEGACY_STORAGE_KEY].token) || "";
          saved.supabaseAccess = res[SUPABASE_ACCESS_KEY] || "";
          saved.supabaseRefresh = res[SUPABASE_REFRESH_KEY] || "";
          saved.billing = res[BILLING_KEY] || null;
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
        enablePush: state.enablePush,
        permissions: state.permissions || [],
        socialAuth: state.socialAuth || {}
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

  function cleanDownloadFilename(name, fallback) {
    var out = String(name || fallback || "Nativized App Files").trim()
      .replace(/[<>:"\\|?*\u0000-\u001f]/g, "-")
      .replace(/^[/\\]+/, "")
      .replace(/\.\.+/g, ".");
    if (!out || out === "." || out === "..") out = fallback || "Nativized App Files";
    if (!/\.zip$/i.test(out)) out += ".zip";
    return out.slice(0, 180);
  }

  function artifactDownloadFilename(artifact, state) {
    var n = String((artifact && artifact.name) || "").toLowerCase();
    if (n.indexOf("ios-simulator-preview") >= 0 || n.indexOf("nativized ios preview") >= 0) return "Nativized iOS Preview.zip";
    if (n.indexOf("ios-xcode-project") >= 0 || n.indexOf("nativized ios") >= 0) return "Nativized iOS.zip";
    if (n.indexOf("android") >= 0 || n.indexOf("nativized android") >= 0) return "Nativized Android.zip";
    if (n.indexOf("windows") >= 0 || n.indexOf("desktop-windows") >= 0 || n.indexOf("win") >= 0) return "Nativized Windows.zip";
    if (n.indexOf("desktop") >= 0 || n.indexOf("mac") >= 0) return "Nativized Desktop.zip";
    return cleanDownloadFilename((artifact && artifact.name) || (state && state.appName), "Nativized App Files");
  }

  function sourceDownloadFilename(state) {
    var slug = Kit && Kit.slugify ? Kit.slugify((state && state.appName) || "") : "";
    return cleanDownloadFilename("Nativized Source Code" + (slug ? " - " + slug : ""), "Nativized Source Code");
  }

  // ---- Mount -------------------------------------------------------------
  loadSaved().then(function (saved) {
    var supabaseAccess = saved.supabaseAccess || "";
    var supabaseRefresh = saved.supabaseRefresh || "";
    var billing = Billing ? Billing.normalize(saved.billing) : { planId: "free" };
    var panelApi = null;

    function currentPlanId() {
      return Billing ? Billing.planOf(billing) : "free";
    }

    function storeSupabaseTokens(accessToken, refreshToken) {
      supabaseAccess = accessToken || "";
      if (refreshToken) supabaseRefresh = refreshToken;
      try {
        var obj = {};
        obj[SUPABASE_ACCESS_KEY] = supabaseAccess;
        obj[SUPABASE_REFRESH_KEY] = supabaseRefresh || "";
        chrome.storage.local.set(obj);
      } catch (e) {}
    }

    function setBilling(next) {
      billing = Billing ? Billing.normalize(next) : { planId: "free" };
      try {
        var obj = {};
        obj[BILLING_KEY] = billing;
        chrome.storage.local.set(obj);
      } catch (e) {}
      if (panelApi && typeof panelApi.setPlan === "function") panelApi.setPlan(currentPlanId());
      return billing;
    }

    function refreshBilling() {
      if (!Billing || !supabaseAccess) return Promise.resolve(setBilling(Billing ? Billing.freeStatus() : { planId: "free" }));
      return Billing.status(supabaseAccess)
        .then(setBilling)
        .catch(function (e) {
          if (!supabaseRefresh || (e.status !== 401 && e.status !== 403)) throw e;
          return Billing.refreshSession(supabaseRefresh).then(function (tokens) {
            storeSupabaseTokens(tokens.accessToken, tokens.refreshToken);
            return Billing.status(supabaseAccess).then(setBilling);
          });
        })
        .catch(function () { return billing; });
    }

    function fetchBillingStrict() {
      if (!Billing) return Promise.reject(new Error("Billing verification is unavailable. Reload the extension and try again."));
      if (!supabaseAccess) return Promise.reject(new Error("Sign in with GitHub first so Supabase can verify your paid Nativize plan."));
      return Billing.status(supabaseAccess)
        .catch(function (e) {
          if (!supabaseRefresh || (e.status !== 401 && e.status !== 403)) throw e;
          return Billing.refreshSession(supabaseRefresh).then(function (tokens) {
            storeSupabaseTokens(tokens.accessToken, tokens.refreshToken);
            return Billing.status(supabaseAccess);
          });
        })
        .then(setBilling);
    }

    function isPaidPlan(status) {
      var planId = Billing ? Billing.planOf(status || billing) : "free";
      return ["starter", "pro", "max"].indexOf(planId) > -1;
    }

    function requirePaidSubscription(action) {
      return fetchBillingStrict().then(function (latest) {
        if (isPaidPlan(latest)) return latest;
        throw new Error("A paid Nativize plan is required to " + action + ". Open https://nativize.dev/#pricing and choose Starter, Pro, or Max.");
      });
    }

    function activateRepo(repo) {
      return Billing.activate(supabaseAccess, repo)
        .catch(function (e) {
          if (!supabaseRefresh || (e.status !== 401 && e.status !== 403)) throw e;
          return Billing.refreshSession(supabaseRefresh).then(function (tokens) {
            storeSupabaseTokens(tokens.accessToken, tokens.refreshToken);
            return Billing.activate(supabaseAccess, repo);
          });
        })
        .then(setBilling);
    }

    function withPlan(state) {
      return Object.assign({}, state, { plan: Billing ? Billing.planOf(billing) : "free" });
    }

    var initial = {
      appName: saved.appName || detectAppName(),
      appId: saved.appId || Kit.normalizeAppId("", saved.appName || detectAppName()),
      githubRepo: saved.githubRepo || detectRepo(),
      webDir: saved.webDir || "dist",
      enablePush: saved.enablePush === true,
      token: saved.token || "",
      signedIn: !!supabaseAccess,
      planId: currentPlanId(),
      permissions: Array.isArray(saved.permissions) ? saved.permissions : [],
      socialAuth: saved.socialAuth || {}
    };

    panelApi = Panel.mount({
      initial: initial,
      authRequired: true,
      onChange: function (state) { save(state); },
      // One-click GitHub sign-in. chrome.identity only works in the background
      // service worker, so we relay the request to it and get the token back.
      onSignIn: function () {
        return new Promise(function (resolve, reject) {
          try {
            chrome.runtime.sendMessage({ type: "nativize-signin" }, function (res) {
              if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
              if (!res || !res.ok) return reject(new Error((res && res.error) || "Sign-in failed."));
              if (!res.supabaseAccess) return reject(new Error("Signed in to GitHub, but Supabase did not return a session. Try signing in again."));
              storeSupabaseTokens(res.supabaseAccess || "", res.supabaseRefresh || "");
              refreshBilling();
              resolve(res.token);
            });
          } catch (e) { reject(e); }
        });
      },
      onSignOut: function () {
        supabaseAccess = "";
        supabaseRefresh = "";
        setBilling(Billing ? Billing.freeStatus() : { planId: "free" });
        try { chrome.runtime.sendMessage({ type: "nativize-signout" }, function () {}); } catch (e) {}
      },
      onDownloadProject: function (state) {
        return requirePaidSubscription("download the full project").then(function () {
          var filename = sourceDownloadFilename(state);
          return Billing.downloadProject(supabaseAccess, state.token, state.githubRepo, filename).then(function (blob) {
            triggerDownload(blob, filename);
          });
        });
      },
      onDownload: function (state) {
        return requirePaidSubscription("download a native kit").then(function () {
          var files = Kit.generateKit(withPlan(state));
          var name = (Kit.slugify(state.appName) || "nativize") + "-native-kit.zip";
          triggerDownload(Zip.toBlob(files), name);
          save(state);
        });
      },
      onDownloadArtifact: function (artifact, state) {
        var filename = artifactDownloadFilename(artifact, state);
        return fetchBillingStrict().then(function () {
          return Billing.downloadArtifact(supabaseAccess, state.token, artifact, filename);
        }).then(function (blob) {
          triggerDownload(blob, filename);
        });
      },
      onPush: function (state, token, onProgress) {
        return fetchBillingStrict()
          .then(function () { return activateRepo(state.githubRepo); })
          .then(function () {
            var files = Kit.generateKit(withPlan(state));
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
          });
      }
    });
    startRepoAutodetect(panelApi);
    refreshBilling();
  });
})();
