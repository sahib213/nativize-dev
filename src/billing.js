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
      cancelAt: null,
      cancelAtPeriodEnd: false,
      cancellationRequestedAt: null,
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
      cancelAt: data.cancel_at || data.cancelAt || null,
      cancelAtPeriodEnd: data.cancel_at_period_end === true || data.cancelAtPeriodEnd === true,
      cancellationRequestedAt: data.cancellation_requested_at || data.cancellationRequestedAt || null,
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

  function randomState() {
    var bytes = new Uint8Array(24);
    var c = (typeof crypto !== "undefined" && crypto.getRandomValues) ? crypto : null;
    if (c) c.getRandomValues(bytes);
    else {
      for (var i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    var out = "";
    for (var j = 0; j < bytes.length; j++) out += bytes[j].toString(16).padStart(2, "0");
    return out;
  }

  function base64Url(bytes) {
    var binary = "";
    for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    var b64;
    if (typeof btoa === "function") b64 = btoa(binary);
    else if (typeof Buffer !== "undefined") b64 = Buffer.from(bytes).toString("base64");
    else throw new Error("No base64 encoder available.");
    return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }

  async function sha256Bytes(text) {
    var data = new TextEncoder().encode(text);
    if (typeof crypto !== "undefined" && crypto.subtle && crypto.subtle.digest) {
      return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
    }
    if (typeof require === "function") {
      var nodeCrypto = require("node:crypto");
      return new Uint8Array(nodeCrypto.createHash("sha256").update(Buffer.from(data)).digest());
    }
    throw new Error("No SHA-256 implementation available.");
  }

  async function createPkce(verifier) {
    var codeVerifier = verifier || base64Url((function () {
      var bytes = new Uint8Array(32);
      var c = (typeof crypto !== "undefined" && crypto.getRandomValues) ? crypto : null;
      if (c) c.getRandomValues(bytes);
      else throw new Error("Secure browser crypto is required for sign-in.");
      return bytes;
    })());
    return {
      codeVerifier: codeVerifier,
      codeChallenge: base64Url(await sha256Bytes(codeVerifier)),
      codeChallengeMethod: "S256"
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

  function normalizeSession(data, fallbackRefreshToken) {
    data = data || {};
    var session = data.session || {};
    return {
      accessToken: data.access_token || session.access_token || "",
      refreshToken: data.refresh_token || session.refresh_token || fallbackRefreshToken || "",
      expiresAt: data.expires_at || session.expires_at || "",
      expiresIn: data.expires_in || session.expires_in || "",
      githubToken: data.provider_token || data.providerToken || session.provider_token || session.providerToken || ""
    };
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
    return normalizeSession(data, refreshToken);
  }

  async function exchangeCodeForSession(authCode, codeVerifier, opts) {
    authCode = String(authCode || "").trim();
    codeVerifier = String(codeVerifier || "").trim();
    if (!authCode || !codeVerifier) throw new Error("Missing OAuth code verifier.");
    var base = (opts && opts.supabaseUrl) || SUPABASE_URL;
    var res = await doFetch(opts)(base + "/auth/v1/token?grant_type=pkce", {
      method: "POST",
      headers: anonHeaders(),
      body: JSON.stringify({ auth_code: authCode, code_verifier: codeVerifier })
    });
    var data = await readJson(res);
    if (!res.ok) throw apiError(res, data, "Could not finish Supabase sign-in.");
    return normalizeSession(data);
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
    if (["starter", "pro", "max", "migration"].indexOf(planId) < 0) throw new Error("Choose Starter, Pro, Max, or a Single Migration.");
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

  /* ---------- Migration Hub (server-side entitlement checks) ---------- */
  async function migrationRpc(accessToken, name, payload, opts) {
    if (!accessToken) throw new Error("Sign in is required.");
    var base = (opts && opts.supabaseUrl) || SUPABASE_URL;
    var res = await doFetch(opts)(base + "/rest/v1/rpc/" + name, {
      method: "POST",
      headers: authHeaders(accessToken),
      body: JSON.stringify(payload || {})
    });
    var data = await readJson(res);
    if (!res.ok) throw apiError(res, data, "Migration request failed.");
    return data;
  }

  async function migrationRest(accessToken, query, opts) {
    if (!accessToken) throw new Error("Sign in is required.");
    var base = (opts && opts.supabaseUrl) || SUPABASE_URL;
    var res = await doFetch(opts)(base + "/rest/v1/" + query, {
      method: "GET",
      headers: authHeaders(accessToken)
    });
    var data = await readJson(res);
    if (!res.ok) throw apiError(res, data, "Could not load migration data.");
    return data;
  }

  // {access:'max'|'credit'|'none', is_max, credits_available, projects}
  function migrationAccess(accessToken, opts) {
    return migrationRpc(accessToken, "get_migration_access", {}, opts);
  }

  // Consumes one credit atomically unless the user is on Max. Server enforces.
  function createMigrationProject(accessToken, params, opts) {
    return migrationRpc(accessToken, "create_migration_project", {
      p_name: (params && params.name) || "My migration",
      p_source: (params && params.source) || "zip",
      p_target: (params && params.target) || "supabase",
      p_target_ref: (params && params.targetProjectRef) || null
    }, opts);
  }

  // Summary must be pre-redacted metadata (counts, paths, secret NAMES only).
  function saveMigrationScan(accessToken, projectId, summary, size, risk, opts) {
    return migrationRpc(accessToken, "save_migration_scan", {
      p_project: projectId, p_summary: summary || {}, p_size: size || null, p_risk: risk || null
    }, opts);
  }

  function saveMigrationFiles(accessToken, projectId, files, opts) {
    return migrationRpc(accessToken, "save_migration_files", {
      p_project: projectId, p_files: files || []
    }, opts);
  }

  // Calls the hosted migration-run edge function for one resumable batch.
  // Credentials (helper key, target connection string + service key) are sent
  // over HTTPS for transient use and are never stored server-side.
  async function runMigrationStep(accessToken, payload, opts) {
    if (!accessToken) throw new Error("Sign in is required.");
    var base = (opts && opts.supabaseUrl) || SUPABASE_URL;
    var res = await doFetch(opts)(base + "/functions/v1/migration-run", {
      method: "POST",
      headers: authHeaders(accessToken),
      body: JSON.stringify(payload || {})
    });
    var data = await readJson(res);
    if (!res.ok) throw apiError(res, data, "Migration step failed.");
    return data;
  }

  function logMigrationEvent(accessToken, projectId, action, meta, opts) {
    return migrationRpc(accessToken, "log_migration_event", {
      p_project: projectId, p_action: action, p_meta: meta || {}
    }, opts).catch(function () { /* audit is best-effort */ });
  }

  function updateMigrationStatus(accessToken, projectId, status, opts) {
    return migrationRpc(accessToken, "update_migration_project_status", {
      p_project: projectId,
      p_status: status
    }, opts);
  }

  function listMigrationProjects(accessToken, opts) {
    return migrationRest(accessToken, "migration_projects?select=*&order=created_at.desc&limit=50", opts);
  }

  function getMigrationProject(accessToken, id, opts) {
    id = String(id || "").trim();
    if (!/^[0-9a-f-]{36}$/i.test(id)) return Promise.reject(new Error("Invalid migration project id."));
    return Promise.all([
      migrationRest(accessToken, "migration_projects?select=*&id=eq." + id, opts),
      migrationRest(accessToken, "migration_scans?select=summary,created_at&project_id=eq." + id + "&order=created_at.desc&limit=1", opts),
      migrationRest(accessToken, "migration_generated_files?select=name,content,created_at&project_id=eq." + id, opts)
    ]).then(function (all) {
      var project = (all[0] || [])[0] || null;
      return { project: project, scan: (all[1] || [])[0] || null, files: all[2] || [] };
    });
  }

  async function subscriptionCancellationStatus(accessToken, opts) {
    if (!accessToken) throw new Error("Sign in is required before managing a subscription.");
    var base = (opts && opts.supabaseUrl) || SUPABASE_URL;
    var res = await doFetch(opts)(base + "/functions/v1/cancel-subscription", {
      method: "GET",
      headers: authHeaders(accessToken)
    });
    var data = await readJson(res);
    if (!res.ok) throw apiError(res, data, "Could not load subscription cancellation status.");
    return data;
  }

  async function cancelSubscription(accessToken, opts) {
    if (!accessToken) throw new Error("Sign in is required before managing a subscription.");
    var base = (opts && opts.supabaseUrl) || SUPABASE_URL;
    var res = await doFetch(opts)(base + "/functions/v1/cancel-subscription", {
      method: "POST",
      headers: authHeaders(accessToken),
      body: JSON.stringify({ schedule: "one_day_before_renewal" })
    });
    var data = await readJson(res);
    if (!res.ok) throw apiError(res, data, "Could not schedule subscription cancellation.");
    return data;
  }

  async function downloadArtifact(accessToken, githubToken, artifact, filename, opts) {
    if (!accessToken) throw new Error("Sign in is required before downloading this app.");
    githubToken = String(githubToken || "").trim();
    if (!githubToken) throw new Error("GitHub access is missing. Sign in again.");
    var artifactUrl = artifact && (artifact.apiUrl || artifact.downloadUrl);
    artifactUrl = String(artifactUrl || "").trim();
    if (!artifactUrl) throw new Error("Artifact download URL is missing.");
    var base = (opts && opts.supabaseUrl) || SUPABASE_URL;
    var res = await doFetch(opts)(base + "/functions/v1/artifact-download", {
      method: "POST",
      headers: authHeaders(accessToken),
      body: JSON.stringify({
        artifactUrl: artifactUrl,
        githubToken: githubToken,
        artifactName: artifact && artifact.name,
        filename: filename || (artifact && artifact.name) || "nativize-artifact.zip"
      })
    });
    if (!res.ok) {
      var data = await readJson(res);
      throw apiError(res, data, "Could not download this app.");
    }
    return res.blob();
  }

  async function downloadProject(accessToken, githubToken, repo, filename, opts) {
    if (!accessToken) throw new Error("Sign in is required before downloading Full Source Code.");
    githubToken = String(githubToken || "").trim();
    if (!githubToken) throw new Error("GitHub access is missing. Sign in again.");
    repo = String(repo || "").trim();
    if (!repo) throw new Error("GitHub repo is required.");
    var base = (opts && opts.supabaseUrl) || SUPABASE_URL;
    var res = await doFetch(opts)(base + "/functions/v1/artifact-download", {
      method: "POST",
      headers: authHeaders(accessToken),
      body: JSON.stringify({
        kind: "project",
        repo: repo,
        githubToken: githubToken,
        filename: filename || "Nativized Source Code.zip"
      })
    });
    if (!res.ok) {
      var data = await readJson(res);
      throw apiError(res, data, "Could not download Full Source Code.");
    }
    return res.blob();
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
    if (opts && opts.state) params.set("state", String(opts.state));
    if (opts && opts.codeChallenge) {
      params.set("code_challenge", String(opts.codeChallenge));
      params.set("code_challenge_method", String(opts.codeChallengeMethod || "S256"));
    }
    return base + "/auth/v1/authorize?" + params.toString();
  }

  function blankAuthTokens(error, state) {
    return {
      githubToken: "",
      accessToken: "",
      refreshToken: "",
      expiresAt: "",
      expiresIn: "",
      code: "",
      state: state || "",
      error: error || ""
    };
  }

  function parseAuthTokens(url, opts) {
    var raw = String(url || "");
    var hash = raw.indexOf("#") > -1 ? raw.split("#")[1] : "";
    var query = raw.indexOf("?") > -1 ? raw.split("?")[1].split("#")[0] : "";
    var params = new URLSearchParams(hash || query);
    var state = params.get("state") || "";
    var code = params.get("code") || "";
    var hasCallback = params.has("access_token") || params.has("refresh_token") ||
      params.has("provider_token") || params.has("code") || params.has("error") || params.has("error_description");
    if (opts && Object.prototype.hasOwnProperty.call(opts, "expectedState")) {
      var expected = String(opts.expectedState || "");
      if (hasCallback && (!expected || !state || state !== expected)) return blankAuthTokens("Invalid auth state.", state);
    }
    return {
      githubToken: params.get("provider_token") || "",
      accessToken: params.get("access_token") || "",
      refreshToken: params.get("refresh_token") || "",
      expiresAt: params.get("expires_at") || "",
      expiresIn: params.get("expires_in") || "",
      code: code,
      state: state,
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
    migrationAccess: migrationAccess,
    createMigrationProject: createMigrationProject,
    saveMigrationScan: saveMigrationScan,
    saveMigrationFiles: saveMigrationFiles,
    runMigrationStep: runMigrationStep,
    logMigrationEvent: logMigrationEvent,
    updateMigrationStatus: updateMigrationStatus,
    listMigrationProjects: listMigrationProjects,
    getMigrationProject: getMigrationProject,
    subscriptionCancellationStatus: subscriptionCancellationStatus,
    cancelSubscription: cancelSubscription,
    downloadArtifact: downloadArtifact,
    downloadProject: downloadProject,
    refreshSession: refreshSession,
    exchangeCodeForSession: exchangeCodeForSession,
    authorizeUrl: authorizeUrl,
    randomState: randomState,
    createPkce: createPkce,
    parseAuthTokens: parseAuthTokens
  };
});
