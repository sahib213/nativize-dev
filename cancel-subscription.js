(function () {
  "use strict";

  var Billing = window.NativizeBilling;
  var Plans = window.NativizePlans;
  var $ = function (id) { return document.getElementById(id); };

  var K = {
    token: "nz_web_token",
    billing: "nz_web_billing",
    supabaseAccess: "nz_web_supabase_access",
    supabaseRefresh: "nz_web_supabase_refresh",
    pkceVerifier: "nz_web_pkce_verifier",
    loginAttempts: "nz_web_login_attempts"
  };

  function load(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch (e) { return fallback; }
  }
  function store(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
  }
  function storeSession(key, val) {
    try { if (val == null) sessionStorage.removeItem(key); else sessionStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
  }
  function loadText(key) {
    try { return sessionStorage.getItem(key) || ""; } catch (e) { return ""; }
  }
  function storeText(key, val) {
    try { if (val) sessionStorage.setItem(key, val); else sessionStorage.removeItem(key); } catch (e) {}
  }
  function loadPersistentText(key) {
    try { return localStorage.getItem(key) || sessionStorage.getItem(key) || ""; } catch (e) { return ""; }
  }
  function storePersistentText(key, val) {
    try { if (val) localStorage.setItem(key, val); else localStorage.removeItem(key); sessionStorage.removeItem(key); } catch (e) {}
  }
  function throttleLocal(key, maxHits, windowMs, message) {
    var now = Date.now();
    var attempts = load(key, []);
    attempts = Array.isArray(attempts) ? attempts.filter(function (t) { return now - Number(t) < windowMs; }) : [];
    if (attempts.length >= maxHits) throw new Error(message);
    attempts.push(now);
    store(key, attempts);
  }

  var supabaseAccess = loadPersistentText(K.supabaseAccess);
  var supabaseRefresh = loadPersistentText(K.supabaseRefresh);
  if (supabaseAccess) storePersistentText(K.supabaseAccess, supabaseAccess);
  if (supabaseRefresh) storePersistentText(K.supabaseRefresh, supabaseRefresh);
  var loadedStatus = null;
  var cancellationState = null;

  function text(id, value) {
    var node = $(id);
    if (node) node.textContent = value == null || value === "" ? "-" : String(value);
  }

  function setStatus(message, cls) {
    var node = $("pageStatus");
    if (!node) return;
    node.textContent = message || "";
    node.className = "billing-status" + (cls ? " " + cls : "");
  }

  function formatDate(value) {
    if (!value) return "-";
    var date = new Date(value);
    if (Number.isNaN(date.getTime())) return "-";
    return date.toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit"
    });
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

  function storeSupabaseTokens(tokens) {
    supabaseAccess = tokens.accessToken || "";
    supabaseRefresh = tokens.refreshToken || supabaseRefresh || "";
    storePersistentText(K.supabaseAccess, supabaseAccess);
    storePersistentText(K.supabaseRefresh, supabaseRefresh);
    if (tokens.githubToken) storeText(K.token, tokens.githubToken);
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

  function cancellationStatusRequest() {
    return Billing.subscriptionCancellationStatus(supabaseAccess).catch(function (err) {
      if (!shouldRefresh(err)) throw err;
      return renewSession().then(function () { return Billing.subscriptionCancellationStatus(supabaseAccess); });
    });
  }

  function cancelRequest() {
    return Billing.cancelSubscription(supabaseAccess).catch(function (err) {
      if (!shouldRefresh(err)) throw err;
      return renewSession().then(function () { return Billing.cancelSubscription(supabaseAccess); });
    });
  }

  function render() {
    var signedIn = !!supabaseAccess;
    $("signInBtn").textContent = signedIn ? "Refresh billing" : "Sign in with GitHub";
    $("billingBadge").textContent = signedIn ? "Signed in" : "Not signed in";
    $("scheduleCancelBtn").disabled = true;

    if (!signedIn) {
      text("billingPlan", "-");
      text("billingStatus", "-");
      text("billingRenewal", "-");
      text("billingCancelAt", "-");
      $("billingLead").textContent = "Sign in with GitHub to load your subscription.";
      return;
    }

    var status = loadedStatus || Billing.freeStatus();
    var plan = Plans && Plans.planById ? Plans.planById(status.planId) : { name: status.planId || "Free" };
    var currentPeriodEnd = status.currentPeriodEnd || cancellationState && cancellationState.currentPeriodEnd;
    var cancelAtPeriodEnd = status.cancelAtPeriodEnd || cancellationState && cancellationState.cancelAtPeriodEnd;
    var cancelAt = status.cancelAt || cancellationState && cancellationState.cancelAt || (cancelAtPeriodEnd ? currentPeriodEnd : null);
    var isSubscription = status.billing === "subscription";

    $("billingBadge").textContent = plan.name;
    text("billingPlan", plan.name);
    text("billingStatus", status.status || cancellationState && cancellationState.status || "active");
    text("billingRenewal", formatDate(currentPeriodEnd));
    text("billingCancelAt", formatDate(cancelAt));

    if (!isSubscription) {
      $("billingLead").textContent = "This account does not have an active monthly subscription.";
      setStatus("Starter is a one-time plan, so there is no monthly subscription to cancel.", "warn");
      return;
    }
    if (cancelAt) {
      $("billingLead").textContent = "Your cancellation is already scheduled.";
      setStatus("Cancellation is scheduled for " + formatDate(cancelAt) + ".", "ok");
      return;
    }

    $("billingLead").textContent = "Review the renewal date, then schedule cancellation.";
    $("scheduleCancelBtn").disabled = false;
    setStatus("This action schedules cancellation 1 day before the next automatic payment.", "");
  }

  function signInWithGitHub() {
    try {
      throttleLocal(K.loginAttempts, 5, 15 * 60 * 1000, "Too many sign-in attempts. Please wait 15 minutes and try again.");
    } catch (err) {
      setStatus(err && err.message || String(err), "err");
      return Promise.reject(err);
    }
    setStatus("Opening GitHub sign-in...", "");
    return Billing.createPkce().then(function (pkce) {
      storeText(K.pkceVerifier, pkce.codeVerifier);
      window.location.href = Billing.authorizeUrl(window.location.href.split("#")[0], {
        codeChallenge: pkce.codeChallenge,
        codeChallengeMethod: pkce.codeChallengeMethod
      });
      return new Promise(function () {});
    });
  }

  function handleAuthRedirect() {
    var tokens = Billing.parseAuthTokens(window.location.href);
    if (tokens.error) {
      storeText(K.pkceVerifier, "");
      setStatus("Sign-in failed: " + tokens.error, "err");
      clearAuthCallback();
      return Promise.resolve(false);
    }
    if (tokens.accessToken || tokens.refreshToken || tokens.githubToken) {
      storeText(K.pkceVerifier, "");
      setStatus("Sign-in failed a security check. Please start again.", "err");
      clearAuthCallback();
      return Promise.resolve(false);
    }
    if (!tokens.code) return Promise.resolve(false);

    var verifier = loadText(K.pkceVerifier);
    if (!verifier) {
      setStatus("Sign-in failed a security check. Please start again.", "err");
      clearAuthCallback();
      return Promise.resolve(false);
    }
    setStatus("Finishing GitHub sign-in...", "");
    return Billing.exchangeCodeForSession(tokens.code, verifier)
      .then(function (session) {
        if (!session.accessToken) throw new Error("Supabase did not return a session.");
        storeText(K.pkceVerifier, "");
        storeSupabaseTokens(session);
        clearAuthCallback();
        return true;
      })
      .catch(function (err) {
        storeText(K.pkceVerifier, "");
        setStatus("Sign-in failed: " + (err && err.message || err), "err");
        clearAuthCallback();
        return false;
      });
  }

  function loadBilling() {
    render();
    if (!supabaseAccess) return Promise.resolve();
    setStatus("Loading billing...", "");
    return billingStatusRequest()
      .then(function (status) {
        loadedStatus = Billing.normalize(status);
        storeSession(K.billing, loadedStatus);
        render();
        if (loadedStatus.billing !== "subscription") return null;
        return cancellationStatusRequest()
          .then(function (state) {
            cancellationState = state;
            render();
            return state;
          })
          .catch(function (err) {
            if (err && err.status === 404) return null;
            throw err;
          });
      })
      .catch(function (err) {
        setStatus("Could not load billing: " + (err && err.message || err), "err");
        render();
      });
  }

  $("signInBtn").addEventListener("click", function () {
    if (!supabaseAccess) signInWithGitHub().catch(function () {});
    else loadBilling();
  });

  $("scheduleCancelBtn").addEventListener("click", function () {
    if (!supabaseAccess) {
      signInWithGitHub().catch(function () {});
      return;
    }
    $("scheduleCancelBtn").disabled = true;
    setStatus("Scheduling cancellation...", "");
    cancelRequest()
      .then(function (state) {
        cancellationState = state;
        if (loadedStatus) {
          loadedStatus.cancelAt = state.cancelAt || loadedStatus.cancelAt;
          loadedStatus.cancelAtPeriodEnd = state.cancelAtPeriodEnd === true;
          loadedStatus.cancellationRequestedAt = new Date().toISOString();
          storeSession(K.billing, loadedStatus);
        }
        render();
        setStatus((state.scheduleNote ? state.scheduleNote + " " : "") + "Cancellation scheduled for " + formatDate(state.cancelAt) + ".", "ok");
      })
      .catch(function (err) {
        setStatus("Could not schedule cancellation: " + (err && err.message || err), "err");
        $("scheduleCancelBtn").disabled = false;
      });
  });

  handleAuthRedirect().then(loadBilling);
})();
