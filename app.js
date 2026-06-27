/* ============================================================
   Nativize Studio (web) — same engine as the extension, in the browser.
   Reuses the shared lib/* modules. Auth = a GitHub token (PAT), since there's
   no extension here. Everything stays client-side.
   ============================================================ */
(function () {
  "use strict";

  var Kit = window.NativizeKit;
  var Zip = window.NativizeZip;
  var GitHub = window.NativizeGitHub;
  var Panel = window.NativizePanel;
  var Plans = window.NativizePlans;
  var License = window.NativizeLicense;

  var $ = function (id) { return document.getElementById(id); };

  /* ---------- Storage ---------- */
  var K = { cfg: "nz_web_config", token: "nz_web_token", lic: "nz_web_license", repos: "nz_web_repos" };
  function load(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch (e) { return fallback; } }
  function store(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {} }

  var savedCfg = load(K.cfg, {});
  var savedToken = (function () { try { return localStorage.getItem(K.token) || ""; } catch (e) { return ""; } })();
  var license = load(K.lic, null);             // normalized license result or null
  var nativizedRepos = load(K.repos, []);      // distinct repos pushed (app-count tracking)

  function currentPlanId() { return License.planOf(license); }
  function appsUsed() { return nativizedRepos.length; }

  /* ---------- Plan bar ---------- */
  function renderPlan() {
    var planId = currentPlanId();
    var plan = Plans.planById(planId);
    $("planBadge").textContent = plan.name;
    $("planName").textContent = plan.name + (license && license.valid ? "" : " (no license)");
    var used = appsUsed();
    var locked = Plans.lockedFeatures(planId);
    var caps = [];
    caps.push("Apps: " + used + " / " + plan.apps);
    caps.push("Platforms: " + plan.platforms.join(", "));
    if (locked.indexOf("push") > -1) caps.push("Push: Pro");
    if (locked.indexOf("social") > -1) caps.push("Sign-in: Pro");
    if (locked.indexOf("storeUpload") > -1) caps.push("Store upload: Pro");
    if (plan.watermark) caps.push("Watermark: yes");
    $("planCaps").innerHTML = caps.map(function (c) { return "<span>" + c + "</span>"; }).join("");
  }

  /* ---------- License activation ---------- */
  $("activateBtn").addEventListener("click", function () {
    var key = $("licenseKey").value.trim();
    var status = $("licStatus");
    if (!key) { status.textContent = "Paste a license key first."; status.className = "lic-status err"; return; }
    status.textContent = "Checking…"; status.className = "lic-status";
    License.validate(key).then(function (res) {
      if (!res.valid) {
        status.textContent = "That key isn't valid (" + (res.status || "invalid") + ").";
        status.className = "lic-status err";
        return;
      }
      res.key = key;
      license = res;
      store(K.lic, license);
      var plan = Plans.planById(res.plan);
      status.textContent = "✓ " + plan.name + " unlocked" + (res.appsLimit != null ? " — " + (res.appsUsed || 0) + "/" + res.appsLimit + " apps" : "") + ".";
      status.className = "lic-status ok";
      renderPlan();
    }).catch(function (e) {
      status.textContent = "Couldn't reach the license server: " + (e && e.message || e);
      status.className = "lic-status err";
    });
  });
  if (license && license.key) $("licenseKey").value = license.key;

  /* ---------- Download helper ---------- */
  function triggerDownload(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(function () { a.remove(); URL.revokeObjectURL(url); }, 1000);
  }

  // Note shown when the free/locked plan stripped features the user toggled on.
  function gatedNote(rawState) {
    var planId = currentPlanId();
    var locked = Plans.lockedFeatures(planId);
    var stripped = [];
    if (locked.indexOf("push") > -1 && rawState.enablePush) stripped.push("push notifications");
    if (locked.indexOf("social") > -1 && rawState.socialAuth && Object.keys(rawState.socialAuth).some(function (k) { return rawState.socialAuth[k] && rawState.socialAuth[k].enabled; })) stripped.push("social sign-in");
    if (locked.indexOf("storeUpload") > -1 && (rawState.iosUpload || rawState.androidUpload)) stripped.push("store auto-upload");
    if (locked.indexOf("platforms") > -1) stripped.push("Android / Mac / Windows builds");
    return stripped;
  }
  function flashUpgrade(stripped) {
    if (!stripped.length) return;
    var status = $("licStatus");
    status.innerHTML = "Heads up — your plan didn't include: <b>" + stripped.join(", ") +
      "</b>. <a href='index.html#pricing'>Upgrade →</a>";
    status.className = "lic-status warn";
  }

  // Enforce the per-plan app cap before a NEW repo is pushed.
  function ensureCanPush(repo) {
    var planId = currentPlanId();
    if (nativizedRepos.indexOf(repo) > -1) return Promise.resolve(); // existing app = update, always ok
    if (!Plans.canAddApp(planId, appsUsed())) {
      var plan = Plans.planById(planId);
      return Promise.reject(new Error("You've used " + appsUsed() + " of " + plan.apps +
        " apps on the " + plan.name + " plan. Upgrade to add another app."));
    }
    // Paid: bind this app to the license (Lemon Squeezy enforces the limit server-side).
    if (license && license.valid && license.key) {
      return License.activate(license.key, repo).then(function (r) {
        if (r.activated === false && /limit|activation/i.test(r.error || "")) {
          throw new Error(r.error || "License activation limit reached. Upgrade to add another app.");
        }
      }).catch(function (e) {
        // Network hiccup shouldn't hard-block a within-limit user; only block on explicit limit errors.
        if (/limit|activation/i.test(e.message || "")) throw e;
      });
    }
    return Promise.resolve();
  }

  function recordRepo(repo) {
    if (nativizedRepos.indexOf(repo) < 0) { nativizedRepos.push(repo); store(K.repos, nativizedRepos); renderPlan(); }
  }

  /* ---------- Existing-kit detection (Update flow) ---------- */
  var detectTimer, lastDetectKey = "";
  function maybeDetect(state) {
    var repo = (state.githubRepo || "").trim();
    var token = (state.token || "").trim();
    var key = repo + "|" + (token ? "t" : "");
    if (!repo || !token || key === lastDetectKey) return;
    lastDetectKey = key;
    clearTimeout(detectTimer);
    detectTimer = setTimeout(function () {
      GitHub.detectKit(repo, token).then(function (d) {
        var bar = $("detectBar");
        if (d.hasKit) {
          bar.hidden = false;
          $("detectSub").textContent = (nativizedRepos.indexOf(repo) > -1 ? "" : "") +
            "Rebuild with your latest changes without re-pushing the kit" + (d.hasRelease ? " (also re-uploads to stores)." : ".");
          bar.dataset.repo = repo; bar.dataset.token = token;
        } else { bar.hidden = true; }
      }).catch(function () { $("detectBar").hidden = true; });
    }, 600);
  }

  $("rebuildBtn").addEventListener("click", function () {
    var bar = $("detectBar");
    var repo = bar.dataset.repo, token = bar.dataset.token;
    var btn = $("rebuildBtn");
    if (!repo || !token) return;
    btn.disabled = true; btn.textContent = "Rebuilding…";
    GitHub.rebuild(repo, token, { onProgress: function (stage) { btn.textContent = "Build: " + stage + "…"; } })
      .then(function (b) {
        btn.textContent = b.conclusion === "success" ? "✓ Rebuilt" : "Build " + (b.conclusion || "finished");
        var status = $("licStatus");
        status.innerHTML = "Rebuild " + (b.conclusion || "done") + " — <a href='" + b.runUrl + "' target='_blank' rel='noopener'>open the run →</a>";
        status.className = "lic-status ok";
      })
      .catch(function (e) {
        btn.textContent = "Just rebuild";
        var status = $("licStatus"); status.textContent = "Rebuild failed: " + (e && e.message || e); status.className = "lic-status err";
      })
      .finally(function () { setTimeout(function () { btn.disabled = false; btn.textContent = "Just rebuild"; }, 2500); });
  });

  /* ---------- Mount the builder panel ---------- */
  var initial = {
    appName: savedCfg.appName || "",
    appId: savedCfg.appId || "",
    githubRepo: savedCfg.githubRepo || "",
    webDir: savedCfg.webDir || "dist",
    enablePush: savedCfg.enablePush === true,
    token: savedToken,
    permissions: Array.isArray(savedCfg.permissions) ? savedCfg.permissions : [],
    socialAuth: savedCfg.socialAuth || {}
  };

  function withPlan(state) { state.plan = currentPlanId(); return state; }

  var panel = Panel.mount({
    initial: initial,
    openNow: true,
    onChange: function (state) {
      store(K.cfg, {
        appName: state.appName, appId: state.appId, githubRepo: state.githubRepo,
        webDir: state.webDir, enablePush: state.enablePush,
        permissions: state.permissions || [], socialAuth: state.socialAuth || {}
      });
      try { localStorage.setItem(K.token, state.token || ""); } catch (e) {}
      maybeDetect(state);
    },
    // No extension here → guide the user to a token.
    onSignIn: function () {
      return Promise.reject(new Error("On the web, paste a GitHub token below (needs 'repo' + 'workflow' scopes). Create one at github.com/settings/tokens."));
    },
    onSignOut: function () {},
    onDownloadProject: function (state) {
      return GitHub.downloadRepoZip(state.githubRepo, state.token).then(function (blob) {
        triggerDownload(blob, (Kit.slugify(state.appName) || "project") + "-full-project.zip");
      });
    },
    onDownload: function (state) {
      var stripped = gatedNote(state);
      var files = Kit.generateKit(withPlan(state));
      triggerDownload(Zip.toBlob(files), (Kit.slugify(state.appName) || "nativize") + "-native-kit.zip");
      flashUpgrade(stripped);
    },
    onPush: function (state, token, onProgress) {
      var repo = state.githubRepo;
      var stripped = gatedNote(state);
      return ensureCanPush(repo).then(function () {
        var files = Kit.generateKit(withPlan(state));
        return GitHub.pushKit(repo, token, files, "Update Nativize kit for " + state.appName + " (Capacitor 8)")
          .then(function (res) {
            recordRepo(repo);
            flashUpgrade(stripped);
            var secrets = state.storeSecrets || {};
            var wantStore = (state.iosUpload || state.androidUpload) && Object.keys(secrets).length;
            if (!wantStore) return res;
            return GitHub.setSecrets(repo, token, secrets).then(function (s) { res.secretsSet = s.set; res.releaseReady = true; return res; });
          })
          .then(function (res) {
            var workflow = res.releaseReady ? "nativize-release.yml" : "nativize-build.yml";
            return GitHub.buildAndWait(repo, token, workflow, { onProgress: onProgress })
              .then(function (b) {
                res.buildStarted = true; res.workflow = workflow; res.runId = b.runId;
                res.runUrl = b.runUrl; res.conclusion = b.conclusion; res.artifacts = b.artifacts; return res;
              })
              .catch(function (e) {
                res.buildStarted = false; res.buildStartError = (e && e.message) || String(e);
                res.actionsUrl = "https://github.com/" + repo + "/actions"; return res;
              });
          });
      });
    }
  });
  window.__nzStudio = panel;

  renderPlan();
})();
