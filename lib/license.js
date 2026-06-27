/*
 * Nativize licensing — PURE-ish (Node + browser). Backend-free.
 *
 * Uses Lemon Squeezy's License API, which is CORS-enabled, so the extension and
 * website can validate keys directly from the client — no server needed:
 *   - validate(key)            → is the key valid + which plan + apps used/limit
 *   - activate(key, appName)   → bind one "app" to the key (enforces the app cap)
 *
 * A Lemon Squeezy license key carries an `activation_limit` (= the plan's app
 * cap) and `activation_usage` (= apps already used). The purchased variant maps
 * to a Nativize plan via each plan's `variantId` (set those in plans.js).
 *
 * SETUP: sell Starter/Pro/Max as Lemon Squeezy products with "license keys"
 * enabled, set each variant's activation limit to the plan's app count, and put
 * the variant ids into plans.js. Until then, any valid key resolves to
 * DEFAULT_PAID_PLAN so you can test the flow.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.NativizeLicense = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var API = "https://api.lemonsqueezy.com/v1/licenses";
  var DEFAULT_PAID_PLAN = "pro"; // used when a valid key's variant isn't mapped yet

  function getPlans() {
    if (typeof module === "object" && module.exports) {
      try { return require("./plans.js"); } catch (e) { return null; }
    }
    var g = (typeof self !== "undefined" ? self : this);
    return g && g.NativizePlans ? g.NativizePlans : null;
  }

  function planForVariant(variantId) {
    var Plans = getPlans();
    if (!Plans) return DEFAULT_PAID_PLAN;
    var list = Plans.PLANS;
    for (var i = 0; i < list.length; i++) {
      if (list[i].variantId && String(list[i].variantId) === String(variantId)) return list[i].id;
    }
    return DEFAULT_PAID_PLAN;
  }

  function doFetch(opts) {
    var f = (opts && opts.fetch) || (typeof fetch !== "undefined" ? fetch : null);
    if (!f) throw new Error("No fetch available.");
    return f;
  }

  function form(obj) {
    return Object.keys(obj).map(function (k) {
      return encodeURIComponent(k) + "=" + encodeURIComponent(obj[k]);
    }).join("&");
  }

  // Normalize Lemon Squeezy's response into the shape the UI uses.
  function normalize(data) {
    data = data || {};
    var lk = data.license_key || {};
    var meta = data.meta || {};
    var status = lk.status || (data.valid ? "active" : "inactive");
    return {
      valid: data.valid === true && status !== "expired" && status !== "disabled",
      status: status,
      plan: data.valid ? planForVariant(meta.variant_id) : "free",
      appsLimit: lk.activation_limit != null ? lk.activation_limit : null,
      appsUsed: lk.activation_usage != null ? lk.activation_usage : null,
      variantId: meta.variant_id != null ? String(meta.variant_id) : null,
      raw: data
    };
  }

  /** Validate a license key. @returns normalized result (see normalize). */
  async function validate(key, opts) {
    key = String(key || "").trim();
    if (!key) return { valid: false, status: "empty", plan: "free" };
    var res = await doFetch(opts)(API + "/validate", {
      method: "POST",
      headers: { "Accept": "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: form({ license_key: key })
    });
    var data = await res.json().catch(function () { return {}; });
    return normalize(data);
  }

  /**
   * Activate one app against the key. Lemon Squeezy enforces the activation
   * limit, so this is the real per-plan app cap. @returns { activated, instanceId, ...normalized }
   */
  async function activate(key, appName, opts) {
    key = String(key || "").trim();
    var res = await doFetch(opts)(API + "/activate", {
      method: "POST",
      headers: { "Accept": "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: form({ license_key: key, instance_name: String(appName || "nativize-app") })
    });
    var data = await res.json().catch(function () { return {}; });
    var out = normalize(data);
    out.activated = data.activated === true;
    out.instanceId = data.instance && data.instance.id ? data.instance.id : null;
    out.error = data.error || null;
    return out;
  }

  // Resolve the effective plan id from a stored license object (or free).
  function planOf(stored) {
    if (stored && stored.valid && stored.plan) return stored.plan;
    return "free";
  }

  return {
    API: API,
    DEFAULT_PAID_PLAN: DEFAULT_PAID_PLAN,
    planForVariant: planForVariant,
    validate: validate,
    activate: activate,
    planOf: planOf,
    normalize: normalize
  };
});
