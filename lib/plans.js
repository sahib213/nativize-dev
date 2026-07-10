/*
 * Nativize plans — PURE, dependency-free (Node + browser, like kit-generator).
 *
 * Single source of truth for what each tier can do. `gateConfig()` is the one
 * enforcement point: the kit generator runs every config through it, so the
 * extension AND the website are gated identically and can't drift.
 *
 * Tiers (prices are editable placeholders — set them to your real prices):
 *   free    — iOS only, Nativize watermark, no permissions / push / sign-in / store upload, 1 app
 *   starter — low-cost one-time launch pass, all platforms + features, 1 app
 *   pro     — monthly, all platforms + features, keep updating, up to 3 apps
 *   max     — monthly, all platforms + features, keep updating, up to 10 apps
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.NativizePlans = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var ALL_PLATFORMS = ["ios", "android", "mac", "windows"];

  // Order matters: used for the pricing table + "upgrade" comparisons.
  var PLANS = [
    {
      id: "free", name: "Free", tagline: "Try it on iOS",
      price: "$0", priceNote: "forever", billing: "free",
      apps: 1, platforms: ["ios"],
      push: false, social: false, storeUpload: false, updates: false,
      permissions: false, customIcon: false, iosHeader: false,
      watermark: true,
      highlights: ["1 watermarked iOS app", "iOS cloud build", "Paid unlocks permissions + every platform"]
    },
    {
      id: "starter", name: "Starter", tagline: "One app launch pass",
      price: "$12 CAD", priceNote: "one-time", billing: "one-time",
      apps: 1, platforms: ALL_PLATFORMS,
      push: true, social: true, storeUpload: true, updates: false,
      permissions: true, customIcon: true, iosHeader: true,
      watermark: false,
      highlights: ["1 app, all platforms", "App permissions", "Custom app icon", "Push + social sign-in", "Store auto-upload", "No watermark"]
    },
    {
      id: "pro", name: "Pro", tagline: "Keep shipping", popular: true,
      price: "$29 CAD", priceNote: "per month", billing: "monthly",
      apps: 3, platforms: ALL_PLATFORMS,
      push: true, social: true, storeUpload: true, updates: true,
      permissions: true, customIcon: true, iosHeader: true,
      watermark: false,
      highlights: ["Up to 3 apps", "Permissions + custom branding", "Everything in Starter", "Unlimited updates & rebuilds"]
    },
    {
      id: "max", name: "Max", tagline: "For agencies",
      price: "$79 CAD", priceNote: "per month", billing: "monthly",
      apps: 10, platforms: ALL_PLATFORMS,
      push: true, social: true, storeUpload: true, updates: true,
      permissions: true, customIcon: true, iosHeader: true,
      watermark: false,
      highlights: ["Up to 10 apps", "Everything in Pro", "Unlimited updates & rebuilds", "App migration included"]
    }
  ];

  function planById(id) {
    for (var i = 0; i < PLANS.length; i++) if (PLANS[i].id === id) return PLANS[i];
    return PLANS[0]; // default to free
  }

  // Which advanced features a plan does NOT allow (drives lock badges in the UI).
  function lockedFeatures(planId) {
    var p = planById(planId);
    var locked = [];
    if (!p.push) locked.push("push");
    if (!p.permissions) locked.push("permissions");
    if (!p.social) locked.push("social");
    if (!p.storeUpload) locked.push("storeUpload");
    if (!p.customIcon) locked.push("customIcon");
    if (!p.iosHeader) locked.push("iosHeader");
    p.platforms.length < ALL_PLATFORMS.length && locked.push("platforms");
    if (!p.updates) locked.push("updates");
    return locked;
  }

  /**
   * THE enforcement point. Returns a shallow-cloned config with anything the
   * plan disallows stripped out, the watermark flag set, and platforms limited.
   * Always called by the kit generator, so gating can't be skipped.
   */
  function gateConfig(input, planId) {
    var p = planById(planId || (input && input.plan) || "free");
    var cfg = Object.assign({}, input || {});
    cfg.plan = p.id;
    cfg.platforms = p.platforms.slice();
    cfg.watermark = p.watermark === true;
    if (!p.push) cfg.enablePush = false;
    if (!p.permissions) cfg.permissions = [];
    if (!p.social) cfg.socialAuth = {};
    if (!p.storeUpload) { cfg.iosUpload = false; cfg.androidUpload = false; }
    // Premium-only: a custom uploaded logo/icon and the iOS Dynamic Island header.
    if (!p.customIcon) { cfg.appIcon = null; cfg.appSplash = null; }
    if (!p.iosHeader) cfg.iosHeader = false;
    return cfg;
  }

  // Can this plan add another app, given how many are already activated?
  function canAddApp(planId, appsUsed) {
    return Number(appsUsed || 0) < planById(planId).apps;
  }

  return {
    PLANS: PLANS,
    ALL_PLATFORMS: ALL_PLATFORMS,
    planById: planById,
    lockedFeatures: lockedFeatures,
    gateConfig: gateConfig,
    canAddApp: canAddApp
  };
});
