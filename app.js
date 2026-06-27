/* ============================================================
   Nativize Studio (web) - same engine as the extension, in the browser.
   Auth = Supabase GitHub OAuth; GitHub provider token stays in localStorage.
   Billing = Supabase RPCs + Stripe Checkout edge function.
   ============================================================ */
(function () {
  "use strict";

  var Kit = window.NativizeKit;
  var Zip = window.NativizeZip;
  var GitHub = window.NativizeGitHub;
  var Panel = window.NativizePanel;
  var Plans = window.NativizePlans;
  var Billing = window.NativizeBilling;

  var $ = function (id) { return document.getElementById(id); };

  /* ---------- Storage ---------- */
  var K = {
    cfg: "nz_web_config",
    token: "nz_web_token",
    billing: "nz_web_billing",
    supabaseAccess: "nz_web_supabase_access",
    supabaseRefresh: "nz_web_supabase_refresh",
    pendingPlan: "nz_web_pending_plan",
    repos: "nz_web_repos"
  };
  function load(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch (e) { return fallback; } }
  function store(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {} }
  function loadText(key) { try { return localStorage.getItem(key) || ""; } catch (e) { return ""; } }
  function storeText(key, val) { try { if (val) localStorage.setItem(key, val); else localStorage.removeItem(key); } catch (e) {} }

  var savedCfg = load(K.cfg, {});
  var savedToken = loadText(K.token);
  var supabaseAccess = loadText(K.supabaseAccess);
  var supabaseRefresh = loadText(K.supabaseRefresh);
  var billingStatus = Billing.normalize(load(K.billing, null));
  var nativizedRepos = load(K.repos, []);

  function setStatus(message, cls) {
    var status = $("licStatus");
    if (!status) return;
    status.textContent = message || "";
    status.className = "lic-status" + (cls ? " " + cls : "");
  }

  function clearAuthHash() {
    if (!window.location.hash) return;
    history.replaceState(null, "", window.location.pathname + window.location.search);
  }

  function handleAuthRedirect() {
    var tokens = Billing.parseAuthTokens(window.location.href);
    if (tokens.error) {
      setStatus("Sign-in failed: " + tokens.error, "err");
      clearAuthHash();
      return;
    }
    if (!tokens.accessToken) return;

    supabaseAccess = tokens.accessToken;
    supabaseRefresh = tokens.refreshToken || supabaseRefresh;
    storeText(K.supabaseAccess, supabaseAccess);
    storeText(K.supabaseRefresh, supabaseRefresh || "");
    if (tokens.githubToken) {
      savedToken = tokens.githubToken;
      storeText(K.token, savedToken);
    }
    clearAuthHash();
    setStatus("Signed in with GitHub. Checking your plan...", "ok");
  }
  handleAuthRedirect();

  function currentPlanId() { return Billing.planOf(billingStatus); }
  function appsUsed() { return Number.isFinite(Number(billingStatus.appsUsed)) ? Number(billingStatus.appsUsed) : nativizedRepos.length; }

  function setBillingStatus(next) {
    billingStatus = Billing.normalize(next);
    store(K.billing, billingStatus);
    renderPlan();
    return billingStatus;
  }

  function storeSupabaseTokens(tokens) {
    supabaseAccess = tokens.accessToken || "";
    supabaseRefresh = tokens.refreshToken || supabaseRefresh || "";
    storeText(K.supabaseAccess, supabaseAccess);
    storeText(K.supabaseRefresh, supabaseRefresh);
  }

  function shouldRefresh(err) {
    return supabaseRefresh && err && (err.status === 401 || err.status === 403);
  }

  function renewSession() {
    return Billing.refreshSession(supabaseRefresh).then(function (tokens) {
      storeSupabaseTokens(tokens);
      return tokens;
    });
  }

  function billingStatusRequest() {
    return Billing.status(supabaseAccess).catch(function (err) {
      if (!shouldRefresh(err)) throw err;
      return renewSession().then(function () { return Billing.status(supabaseAccess); });
    });
  }

  function activateRequest(repo) {
    return Billing.activate(supabaseAccess, repo).catch(function (err) {
      if (!shouldRefresh(err)) throw err;
      return renewSession().then(function () { return Billing.activate(supabaseAccess, repo); });
    });
  }

  function checkoutRequest(planId, opts) {
    return Billing.checkout(supabaseAccess, planId, opts).catch(function (err) {
      if (!shouldRefresh(err)) throw err;
      return renewSession().then(function () { return Billing.checkout(supabaseAccess, planId, opts); });
    });
  }

  /* ---------- Plan bar ---------- */
  function renderPlan() {
    var planId = currentPlanId();
    var plan = Plans.planById(planId);
    $("planBadge").textContent = plan.name;
    $("planName").textContent = plan.name + (supabaseAccess ? "" : " (not signed in)");
    var used = appsUsed();
    var limit = billingStatus.appsLimit || plan.apps;
    var locked = Plans.lockedFeatures(planId);
    var caps = [];
    caps.push("Apps: " + used + " / " + limit);
    caps.push("Platforms: " + plan.platforms.join(", "));
    if (locked.indexOf("push") > -1) caps.push("Push: paid");
    if (locked.indexOf("social") > -1) caps.push("Sign-in: paid");
    if (locked.indexOf("storeUpload") > -1) caps.push("Store upload: paid");
    if (plan.watermark) caps.push("Watermark: yes");
    $("planCaps").innerHTML = caps.map(function (c) { return "<span>" + c + "</span>"; }).join("");
    $("accountBtn").textContent = supabaseAccess ? "Refresh plan" : "Sign in with GitHub";
    $("checkoutBtn").textContent = planId === "free" ? "Choose plan" : "Change plan";
  }

  function refreshBilling(opts) {
    opts = opts || {};
    if (!supabaseAccess) {
      setBillingStatus(Billing.freeStatus({ apps_used: nativizedRepos.length }));
      if (opts.flash) setStatus("Sign in with GitHub to unlock paid plans.", "warn");
      return Promise.resolve(billingStatus);
    }
    return billingStatusRequest()
      .then(function (res) {
        setBillingStatus(res);
        if (opts.flash) setStatus("Plan refreshed.", "ok");
        return billingStatus;
      })
      .catch(function (e) {
        if (opts.flash) setStatus("Could not refresh billing: " + (e && e.message || e), "err");
        return billingStatus;
      });
  }

  function appUrl(params) {
    var url = new URL(window.location.href);
    url.hash = "";
    url.search = "";
    Object.keys(params || {}).forEach(function (key) {
      if (params[key] != null) url.searchParams.set(key, params[key]);
    });
    return url.toString();
  }

  function signInWithGitHub(planId) {
    if (planId) storeText(K.pendingPlan, planId);
    window.location.href = Billing.authorizeUrl(window.location.href.split("#")[0]);
    return new Promise(function () {});
  }

  function startCheckout(planId) {
    planId = String(planId || "").trim();
    if (["starter", "pro", "max"].indexOf(planId) < 0) {
      window.location.href = "index.html#pricing";
      return Promise.resolve();
    }
    if (!supabaseAccess) return signInWithGitHub(planId);

    $("checkoutBtn").disabled = true;
    setStatus("Opening secure checkout...", "");
    return checkoutRequest(planId, {
      successUrl: appUrl({ checkout: "success" }),
      cancelUrl: appUrl({ checkout: "cancelled" })
    }).then(function (res) {
      window.location.href = res.url;
    }).catch(function (e) {
      setStatus("Checkout failed: " + (e && e.message || e), "err");
      $("checkoutBtn").disabled = false;
      throw e;
    });
  }

  $("accountBtn").addEventListener("click", function () {
    if (supabaseAccess) refreshBilling({ flash: true });
    else signInWithGitHub();
  });
  $("checkoutBtn").addEventListener("click", function () {
    window.location.href = "index.html#pricing";
  });

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
    status.innerHTML = "Heads up - your plan did not include: <b>" + stripped.join(", ") +
      "</b>. <a href='index.html#pricing'>Upgrade -></a>";
    status.className = "lic-status warn";
  }

  // Enforce the per-plan app cap before a NEW repo is pushed.
  function ensureCanPush(repo) {
    repo = String(repo || "").trim();
    if (supabaseAccess) {
      return activateRequest(repo).then(function (res) {
        setBillingStatus(res);
        return res;
      });
    }

    var planId = currentPlanId();
    if (nativizedRepos.indexOf(repo) > -1) return Promise.resolve(); // existing app = update, always ok
    if (!Plans.canAddApp(planId, appsUsed())) {
      var plan = Plans.planById(planId);
      return Promise.reject(new Error("You've used " + appsUsed() + " of " + plan.apps +
        " apps on the " + plan.name + " plan. Upgrade to add another app."));
    }
    return Promise.resolve();
  }

  function recordRepo(repo) {
    if (nativizedRepos.indexOf(repo) < 0) {
      nativizedRepos.push(repo);
      store(K.repos, nativizedRepos);
      renderPlan();
    }
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
    btn.disabled = true; btn.textContent = "Rebuilding...";
    GitHub.rebuild(repo, token, { onProgress: function (stage) { btn.textContent = "Build: " + stage + "..."; } })
      .then(function (b) {
        btn.textContent = b.conclusion === "success" ? "Rebuilt" : "Build " + (b.conclusion || "finished");
        var status = $("licStatus");
        status.innerHTML = "Rebuild " + (b.conclusion || "done") + " - <a href='" + b.runUrl + "' target='_blank' rel='noopener'>open the run -></a>";
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

  function withPlan(state) { return Object.assign({}, state, { plan: currentPlanId() }); }

  var panel = Panel.mount({
    initial: initial,
    openNow: true,
    onChange: function (state) {
      store(K.cfg, {
        appName: state.appName, appId: state.appId, githubRepo: state.githubRepo,
        webDir: state.webDir, enablePush: state.enablePush,
        permissions: state.permissions || [], socialAuth: state.socialAuth || {}
      });
      storeText(K.token, state.token || "");
      maybeDetect(state);
    },
    onSignIn: function () {
      return signInWithGitHub();
    },
    onSignOut: function () {
      supabaseAccess = "";
      supabaseRefresh = "";
      storeText(K.supabaseAccess, "");
      storeText(K.supabaseRefresh, "");
      setBillingStatus(Billing.freeStatus({ apps_used: nativizedRepos.length }));
    },
    onDownloadProject: function (state) {
      return GitHub.downloadRepoZip(state.githubRepo, state.token).then(function (blob) {
        triggerDownload(blob, (Kit.slugify(state.appName) || "project") + "-full-project.zip");
      });
    },
    onDownload: function (state) {
      return refreshBilling().then(function () {
        var stripped = gatedNote(state);
        var files = Kit.generateKit(withPlan(state));
        triggerDownload(Zip.toBlob(files), (Kit.slugify(state.appName) || "nativize") + "-native-kit.zip");
        flashUpgrade(stripped);
      });
    },
    onPush: function (state, token, onProgress) {
      var repo = state.githubRepo;
      var stripped = gatedNote(state);
      return refreshBilling().then(function () {
        return ensureCanPush(repo);
      }).then(function () {
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

  var query = new URLSearchParams(window.location.search);
  var requestedPlan = query.get("plan");
  var checkoutState = query.get("checkout");
  if (checkoutState === "success") {
    storeText(K.pendingPlan, "");
    setStatus("Payment received. Refreshing your plan...", "ok");
    refreshBilling();
  } else if (checkoutState === "cancelled") {
    setStatus("Checkout cancelled. Your current plan is unchanged.", "warn");
  }

  if (["starter", "pro", "max"].indexOf(requestedPlan) > -1) {
    startCheckout(requestedPlan);
  } else {
    var pendingPlan = loadText(K.pendingPlan);
    if (supabaseAccess && ["starter", "pro", "max"].indexOf(pendingPlan) > -1) {
      storeText(K.pendingPlan, "");
      startCheckout(pendingPlan);
    } else {
      refreshBilling();
    }
  }
})();
