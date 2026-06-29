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
      // Download the full project (src + ios + android + desktop) as a .zip.
      onDownloadProject: function (state) {
        return requirePaidSubscription("download the full project").then(function () {
          return GitHub.downloadRepoZip(state.githubRepo, state.token).then(function (blob) {
            triggerDownload(blob, (Kit.slugify(state.appName) || "project") + "-full-project.zip");
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
        var filename = (Kit.slugify((artifact && artifact.name) || state.appName || "nativize-artifact") || "nativize-artifact") + ".zip";
        return GitHub.downloadArtifact(artifact, state.token).then(function (blob) {
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
    refreshBilling();
  });
})();
