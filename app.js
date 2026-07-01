/* ============================================================
   Nativize Studio (web) - same engine as the extension, in the browser.
   Auth = Supabase GitHub OAuth; GitHub provider token stays in sessionStorage.
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
    pkceVerifier: "nz_web_pkce_verifier",
    loginAttempts: "nz_web_login_attempts",
    repos: "nz_web_repos"
  };
  function load(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch (e) { return fallback; } }
  function store(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {} }
  function loadSession(key, fallback) { try { return JSON.parse(sessionStorage.getItem(key)) || fallback; } catch (e) { return fallback; } }
  function storeSession(key, val) { try { if (val == null) sessionStorage.removeItem(key); else sessionStorage.setItem(key, JSON.stringify(val)); } catch (e) {} }
  function loadText(key) { try { return sessionStorage.getItem(key) || ""; } catch (e) { return ""; } }
  function storeText(key, val) { try { if (val) sessionStorage.setItem(key, val); else sessionStorage.removeItem(key); } catch (e) {} }
  function throttleLocal(key, maxHits, windowMs, message) {
    var now = Date.now();
    var attempts = load(key, []);
    attempts = Array.isArray(attempts) ? attempts.filter(function (t) { return now - Number(t) < windowMs; }) : [];
    if (attempts.length >= maxHits) throw new Error(message);
    attempts.push(now);
    store(key, attempts);
  }

  var savedCfg = load(K.cfg, {});
  var savedToken = loadText(K.token);
  var supabaseAccess = loadText(K.supabaseAccess);
  var supabaseRefresh = loadText(K.supabaseRefresh);
  var billingStatus = Billing.normalize(loadSession(K.billing, null));
  var nativizedRepos = load(K.repos, []);

  function setStatus(message, cls) {
    var status = $("licStatus");
    if (!status) return;
    status.textContent = message || "";
    status.className = "lic-status" + (cls ? " " + cls : "");
  }

  function clearAuthCallback() {
    var url = new URL(window.location.href);
    var changed = !!url.hash;
    url.hash = "";
    ["code", "access_token", "refresh_token", "provider_token", "expires_at", "expires_in", "token_type", "state", "error", "error_description"].forEach(function (key) {
      if (url.searchParams.has(key)) {
        url.searchParams.delete(key);
        changed = true;
      }
    });
    if (changed) history.replaceState(null, "", url.pathname + (url.search ? url.search : ""));
  }

  function handleAuthRedirect() {
    var tokens = Billing.parseAuthTokens(window.location.href);
    if (tokens.error) {
      storeText(K.pkceVerifier, "");
      setStatus("Sign-in failed: " + tokens.error, "err");
      clearAuthCallback();
      return;
    }
    if (tokens.accessToken || tokens.refreshToken || tokens.githubToken) {
      storeText(K.pkceVerifier, "");
      setStatus("Sign-in failed a security check. Please start again.", "err");
      clearAuthCallback();
      return;
    }
    if (!tokens.code) return;

    var verifier = loadText(K.pkceVerifier);
    if (!verifier) {
      setStatus("Sign-in failed a security check. Please start again.", "err");
      clearAuthCallback();
      return;
    }
    setStatus("Finishing GitHub sign-in...", "");
    Billing.exchangeCodeForSession(tokens.code, verifier)
      .then(function (session) {
        if (!session.accessToken) throw new Error("Supabase did not return a session.");
        if (!session.githubToken) throw new Error("GitHub did not return a repo token. Check the Supabase GitHub provider scopes.");
        storeText(K.pkceVerifier, "");
        supabaseAccess = session.accessToken;
        supabaseRefresh = session.refreshToken || supabaseRefresh;
        storeText(K.supabaseAccess, supabaseAccess);
        storeText(K.supabaseRefresh, supabaseRefresh || "");
        if (session.githubToken) {
          savedToken = session.githubToken;
          storeText(K.token, savedToken);
        }
        clearAuthCallback();
        window.location.reload();
      })
      .catch(function (err) {
        storeText(K.pkceVerifier, "");
        setStatus("Sign-in failed: " + (err && err.message || err), "err");
        clearAuthCallback();
      });
  }
  handleAuthRedirect();

  function currentPlanId() { return Billing.planOf(billingStatus); }
  function appsUsed() { return Number.isFinite(Number(billingStatus.appsUsed)) ? Number(billingStatus.appsUsed) : nativizedRepos.length; }

  function setBillingStatus(next) {
    billingStatus = Billing.normalize(next);
    storeSession(K.billing, billingStatus);
    renderPlan();
    if (panel && typeof panel.setPlan === "function") panel.setPlan(currentPlanId());
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
    if (locked.indexOf("permissions") > -1) caps.push("Permissions: paid");
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

  function signedInError(action) {
    return new Error("Sign in with GitHub first so Supabase can verify your Nativize plan before you " + action + ".");
  }

  function requireSignedIn(action) {
    if (supabaseAccess) return Promise.resolve();
    var err = signedInError(action || "make an app");
    setStatus(err.message, "err");
    return Promise.reject(err);
  }

  function refreshBillingStrict(action) {
    return requireSignedIn(action || "make an app")
      .then(billingStatusRequest)
      .then(function (res) {
        setBillingStatus(res);
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
    try {
      throttleLocal(K.loginAttempts, 5, 15 * 60 * 1000, "Too many sign-in attempts. Please wait 15 minutes and try again.");
    } catch (err) {
      setStatus(err && err.message || String(err), "err");
      return Promise.reject(err);
    }
    return Billing.createPkce().then(function (pkce) {
      storeText(K.pkceVerifier, pkce.codeVerifier);
      window.location.href = Billing.authorizeUrl(window.location.href.split("#")[0], {
        codeChallenge: pkce.codeChallenge,
        codeChallengeMethod: pkce.codeChallengeMethod
      });
      return new Promise(function () {});
    });
  }

  function startCheckout(planId) {
    planId = String(planId || "").trim();
    if (["starter", "pro", "max"].indexOf(planId) < 0) {
      window.location.href = "/pricing/";
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
    window.location.href = "/pricing/";
  });

  function consumeGitHubLoginIntent() {
    var url = new URL(window.location.href);
    if (url.searchParams.get("login") !== "github") return;
    if (supabaseAccess) {
      url.searchParams.delete("login");
      history.replaceState(null, "", url.pathname + (url.search ? url.search : ""));
      refreshBilling({ flash: true });
      return;
    }
    signInWithGitHub().catch(function () {});
  }
  consumeGitHubLoginIntent();

  /* ---------- Download helper ---------- */
  function triggerDownload(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
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

  // Note shown when the free/locked plan stripped features the user toggled on.
  function gatedNote(rawState) {
    var planId = currentPlanId();
    var locked = Plans.lockedFeatures(planId);
    var stripped = [];
    if (locked.indexOf("push") > -1 && rawState.enablePush) stripped.push("push notifications");
    if (locked.indexOf("permissions") > -1 && rawState.permissions && rawState.permissions.length) stripped.push("app permissions");
    if (locked.indexOf("social") > -1 && rawState.socialAuth && Object.keys(rawState.socialAuth).some(function (k) { return rawState.socialAuth[k] && rawState.socialAuth[k].enabled; })) stripped.push("social sign-in");
    if (locked.indexOf("storeUpload") > -1 && (rawState.iosUpload || rawState.androidUpload)) stripped.push("store auto-upload");
    return stripped;
  }
  function flashUpgrade(stripped) {
    if (!stripped.length) return;
    var status = $("licStatus");
    status.innerHTML = "Heads up - your plan did not include: <b>" + stripped.join(", ") +
      "</b>. <a href='/pricing/'>Upgrade -></a>";
    status.className = "lic-status warn";
  }

  // Enforce the per-plan app cap before a NEW repo is pushed.
  function ensureCanPush(repo) {
    repo = String(repo || "").trim();
    return requireSignedIn("build an app").then(function () {
      return activateRequest(repo).then(function (res) {
        setBillingStatus(res);
        return res;
      });
    });
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
    refreshBillingStrict("rebuild an app")
      .then(function () {
        return GitHub.rebuild(repo, token, { onProgress: function (stage) { btn.textContent = "Build: " + stage + "..."; } });
      })
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
    signedIn: !!supabaseAccess,
    planId: currentPlanId(),
    permissions: Array.isArray(savedCfg.permissions) ? savedCfg.permissions : [],
    socialAuth: savedCfg.socialAuth || {}
  };

  function withPlan(state) { return Object.assign({}, state, { plan: currentPlanId() }); }

  var panel = Panel.mount({
    initial: initial,
    authRequired: true,
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
      savedToken = "";
      storeText(K.token, "");
      storeText(K.supabaseAccess, "");
      storeText(K.supabaseRefresh, "");
      storeSession(K.billing, null);
      setBillingStatus(Billing.freeStatus({ apps_used: nativizedRepos.length }));
    },
    onDownloadProject: function (state) {
      return refreshBillingStrict("download the full project").then(function () {
        var filename = sourceDownloadFilename(state);
        return Billing.downloadProject(supabaseAccess, state.token, state.githubRepo, filename).then(function (blob) {
          triggerDownload(blob, filename);
        });
      });
    },
    onDownload: function (state) {
      return refreshBillingStrict("download a native kit").then(function () {
        var stripped = gatedNote(state);
        var files = Kit.generateKit(withPlan(state));
        triggerDownload(Zip.toBlob(files), (Kit.slugify(state.appName) || "nativize") + "-native-kit.zip");
        flashUpgrade(stripped);
      });
    },
    onDownloadArtifact: function (artifact, state) {
      var filename = artifactDownloadFilename(artifact, state);
      return refreshBillingStrict("download app files").then(function () {
        return Billing.downloadArtifact(supabaseAccess, state.token, artifact, filename);
      }).then(function (blob) {
        triggerDownload(blob, filename);
      });
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
