/*
 * Nativize billing — shared by the Chrome extension and the web Studio.
 *
 * Public client module only. It talks to Supabase RPCs and edge functions with
 * the user's Supabase access token. Stripe secret keys live in Supabase only.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.NativizeBilling = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var SUPABASE_URL = "https://gaaxcbarmiwtojblkkyh.supabase.co";
  var SUPABASE_ANON_KEY = "sb_publishable_mAA5LXz9HFHlwVzkA1SCEg_ybxHh_X7";
  var GITHUB_SCOPES = "repo workflow";
  var ACTIVE_STATUSES = ["active", "trialing"];

  function getPlans() {
    if (typeof module === "object" && module.exports) {
      try { return require("./plans.js"); } catch (e) { return null; }
    }
    var g = (typeof self !== "undefined" ? self : this);
    return g && g.NativizePlans ? g.NativizePlans : null;
  }

  function planById(id) {
    var Plans = getPlans();
    return Plans && Plans.planById ? Plans.planById(id) : { id: "free", billing: "free", apps: 1 };
  }

  function isActiveStatus(status) {
    return ACTIVE_STATUSES.indexOf(String(status || "").toLowerCase()) > -1;
  }

  function toInt(value, fallback) {
    var n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function freeStatus(raw) {
    return {
      valid: true,
      plan: "free",
      planId: "free",
      billing: "free",
      status: "active",
      appsLimit: 1,
      appsUsed: raw && raw.apps_used != null ? toInt(raw.apps_used, 0) : 0,
      currentPeriodEnd: null,
      raw: raw || null
    };
  }

  function normalize(data) {
    if (Array.isArray(data)) data = data[0] || {};
    data = data || {};

    var rawPlan = data.plan_id || data.planId || data.plan || "free";
    var rawStatus = data.status || (rawPlan === "free" ? "active" : "inactive");
    var active = rawPlan === "free" || isActiveStatus(rawStatus);
    var planId = active ? rawPlan : "free";
    var plan = planById(planId);

    return {
      valid: active,
      plan: planId,
      planId: planId,
      billing: active ? (data.billing || plan.billing || "free") : "free",
      status: active ? rawStatus : "active",
      appsLimit: toInt(data.apps_limit != null ? data.apps_limit : data.appsLimit, plan.apps || 1),
      appsUsed: toInt(data.apps_used != null ? data.apps_used : data.appsUsed, 0),
      currentPeriodEnd: data.current_period_end || data.currentPeriodEnd || null,
      raw: data
    };
  }

  function doFetch(opts) {
    var f = (opts && opts.fetch) || (typeof fetch !== "undefined" ? fetch : null);
    if (!f) throw new Error("No fetch available.");
    return f;
  }

  function authHeaders(accessToken) {
    return {
      "apikey": SUPABASE_ANON_KEY,
      "Authorization": "Bearer " + accessToken,
      "Accept": "application/json",
      "Content-Type": "application/json"
    };
  }

  function anonHeaders() {
    return {
      "apikey": SUPABASE_ANON_KEY,
      "Accept": "application/json",
      "Content-Type": "application/json"
    };
  }

  async function readJson(res) {
    var text = await res.text().catch(function () { return ""; });
    if (!text) return {};
    try { return JSON.parse(text); } catch (e) { return { message: text }; }
  }

  function errorMessage(data, fallback) {
    return data && (data.message || data.error || data.msg || data.details) || fallback;
  }

  function apiError(res, data, fallback) {
    var err = new Error(errorMessage(data, fallback));
    err.status = res && res.status;
    err.data = data;
    return err;
  }

  async function refreshSession(refreshToken, opts) {
    refreshToken = String(refreshToken || "").trim();
    if (!refreshToken) throw new Error("No Supabase refresh token available.");
    var base = (opts && opts.supabaseUrl) || SUPABASE_URL;
    var res = await doFetch(opts)(base + "/auth/v1/token?grant_type=refresh_token", {
      method: "POST",
      headers: anonHeaders(),
      body: JSON.stringify({ refresh_token: refreshToken })
    });
    var data = await readJson(res);
    if (!res.ok) throw apiError(res, data, "Could not refresh Supabase session.");
    return {
      accessToken: data.access_token || "",
      refreshToken: data.refresh_token || refreshToken,
      expiresAt: data.expires_at || "",
      expiresIn: data.expires_in || "",
      githubToken: data.provider_token || ""
    };
  }

  async function status(accessToken, opts) {
    if (!accessToken) return freeStatus();
    var base = (opts && opts.supabaseUrl) || SUPABASE_URL;
    var res = await doFetch(opts)(base + "/rest/v1/rpc/get_billing_status", {
      method: "POST",
      headers: authHeaders(accessToken),
      body: "{}"
    });
    var data = await readJson(res);
    if (!res.ok) throw apiError(res, data, "Could not load billing status.");
    return normalize(data);
  }

  async function activate(accessToken, repo, opts) {
    if (!accessToken) throw new Error("Sign in is required before activating an app.");
    repo = String(repo || "").trim();
    if (!repo) throw new Error("GitHub repo is required.");
    var base = (opts && opts.supabaseUrl) || SUPABASE_URL;
    var res = await doFetch(opts)(base + "/rest/v1/rpc/activate_app", {
      method: "POST",
      headers: authHeaders(accessToken),
      body: JSON.stringify({ repo: repo })
    });
    var data = await readJson(res);
    if (!res.ok) throw apiError(res, data, "Could not activate this app.");
    var out = normalize(data);
    var row = Array.isArray(data) ? data[0] || {} : data || {};
    out.activated = row.activated === true;
    out.alreadyActivated = row.already_activated === true || row.alreadyActivated === true;
    return out;
  }

  async function checkout(accessToken, planId, opts) {
    if (!accessToken) throw new Error("Sign in is required before checkout.");
    planId = String(planId || "").trim();
    if (["starter", "pro", "max"].indexOf(planId) < 0) throw new Error("Choose Starter, Pro, or Max.");
    var base = (opts && opts.supabaseUrl) || SUPABASE_URL;
    var payload = { planId: planId };
    if (opts && opts.successUrl) payload.successUrl = opts.successUrl;
    if (opts && opts.cancelUrl) payload.cancelUrl = opts.cancelUrl;
    var res = await doFetch(opts)(base + "/functions/v1/create-checkout-session", {
      method: "POST",
      headers: authHeaders(accessToken),
      body: JSON.stringify(payload)
    });
    var data = await readJson(res);
    if (!res.ok) throw apiError(res, data, "Could not start checkout.");
    if (!data.url) throw new Error("Checkout did not return a URL.");
    return data;
  }

  function authorizeUrl(redirectTo, opts) {
    var base = (opts && opts.supabaseUrl) || SUPABASE_URL;
    var anon = (opts && opts.supabaseAnonKey) || SUPABASE_ANON_KEY;
    var params = new URLSearchParams({
      provider: "github",
      scopes: GITHUB_SCOPES,
      redirect_to: redirectTo,
      apikey: anon
    });
    return base + "/auth/v1/authorize?" + params.toString();
  }

  function parseAuthTokens(url) {
    var raw = String(url || "");
    var hash = raw.indexOf("#") > -1 ? raw.split("#")[1] : "";
    var query = raw.indexOf("?") > -1 ? raw.split("?")[1].split("#")[0] : "";
    var params = new URLSearchParams(hash || query);
    return {
      githubToken: params.get("provider_token") || "",
      accessToken: params.get("access_token") || "",
      refreshToken: params.get("refresh_token") || "",
      expiresAt: params.get("expires_at") || "",
      expiresIn: params.get("expires_in") || "",
      error: params.get("error_description") || params.get("error") || ""
    };
  }

  return {
    SUPABASE_URL: SUPABASE_URL,
    SUPABASE_ANON_KEY: SUPABASE_ANON_KEY,
    GITHUB_SCOPES: GITHUB_SCOPES,
    normalize: normalize,
    freeStatus: freeStatus,
    isActiveStatus: isActiveStatus,
    planOf: function (stored) { return normalize(stored).planId; },
    status: status,
    activate: activate,
    checkout: checkout,
    refreshSession: refreshSession,
    authorizeUrl: authorizeUrl,
    parseAuthTokens: parseAuthTokens
  };
});
