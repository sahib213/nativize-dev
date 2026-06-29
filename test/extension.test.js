"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Billing = require("../src/billing.js");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("Manifest V3 runs on Lovable/local sites, talks to GitHub + Supabase billing, local storage only", () => {
  const manifest = JSON.parse(read("manifest.json"));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.name, "Nativize - Lovable to Native Apps");
  assert.ok(manifest.description.includes("Lovable apps"));
  assert.ok(manifest.description.includes("Capacitor 8"));
  assert.ok(manifest.description.length <= 132);
  // 'identity' is needed for one-click "Sign in with GitHub" via chrome.identity.
  assert.deepEqual(manifest.permissions, ["storage", "identity", "downloads"]);
  // GitHub API + Supabase Auth/RPC/Edge Functions for billing.
  assert.ok(manifest.host_permissions.includes("https://api.github.com/*"));
  assert.ok(manifest.host_permissions.includes("https://gaaxcbarmiwtojblkkyh.supabase.co/*"));
  const legacyHost = "https://api." + "lemonsqueezy.com/*";
  assert.ok(!manifest.host_permissions.includes(legacyHost));
  assert.deepEqual(manifest.content_scripts[0].matches, [
    "https://lovable.dev/*",
    "https://*.lovable.dev/*",
    "https://lovable.app/*",
    "https://*.lovable.app/*",
    "http://localhost/*",
    "http://127.0.0.1/*"
  ]);
  // plans + billing load before the generator so gating + unlocking are available.
  const js = manifest.content_scripts[0].js;
  assert.ok(js.indexOf("src/plans.js") < js.indexOf("src/kit-generator.js"));
  assert.ok(js.includes("src/billing.js"));
  assert.ok(!js.includes("src/" + "license.js"));
  assert.equal(manifest.background.service_worker, "src/background.js");
  assert.equal(manifest.action.default_popup, "src/popup.html");
  assert.deepEqual(Object.keys(manifest.icons).sort(), ["128", "16", "48"]);
});

test("content script stores config per Lovable project and token in local storage", () => {
  const source = read("src/content.js");
  assert.match(source, /location\.origin \+ location\.pathname/);
  assert.match(source, /nativize:githubToken/);
  assert.match(source, /nativize:supabaseAccess/);
  assert.match(source, /nativize:billing/);
  assert.match(source, /chrome\.storage\.local/);
});

test("extension downloads are paid and builds require live Supabase plan activation", () => {
  const source = read("src/content.js");
  assert.match(source, /function fetchBillingStrict\(\)/);
  assert.match(source, /function requirePaidSubscription\(action\)/);
  assert.match(source, /Billing\.status\(supabaseAccess\)/);
  assert.match(source, /\["starter", "pro", "max"\]\.indexOf\(planId\) > -1/);
  assert.match(source, /requirePaidSubscription\("download the full project"\)/);
  assert.match(source, /requirePaidSubscription\("download a native kit"\)/);
  assert.match(source, /fetchBillingStrict\(\)\s*\.then\(function \(\) \{ return activateRepo\(state\.githubRepo\); \}\)/);
  assert.doesNotMatch(source, /requirePaidSubscription\("build an app"\)/);
  assert.doesNotMatch(source, /if \(Billing && supabaseAccess\) return activateRepo/);
  assert.doesNotMatch(source, /return null;\s*\}\)\s*\.then\(function \(\) \{\s*var files = Kit\.generateKit/);
});

test("artifact downloads use Chrome downloads in the extension and Supabase relay on the web", async () => {
  const background = read("src/background.js");
  const content = read("src/content.js");
  const web = read("website/app.js");
  const panel = read("src/panel.js");
  const billing = read("src/billing.js");
  const edge = read("supabase/functions/artifact-download/index.ts");
  const readme = read("supabase/README.md");

  assert.match(background, /nativize-download-artifact/);
  assert.match(background, /chrome\.downloads\.download/);
  assert.match(background, /Authorization", value: "Bearer " \+ token/);
  assert.match(content, /function downloadArtifactFromExtension/);
  assert.match(content, /type: "nativize-download-artifact"/);
  assert.doesNotMatch(content, /GitHub\.downloadArtifact\(artifact, state\.token\)/);

  assert.match(web, /Billing\.downloadArtifact\(supabaseAccess, state\.token, artifact, filename\)/);
  assert.match(panel, /ios-unsigned-app/);
  assert.match(panel, /ios-simulator-app/);
  assert.match(panel, /Rebuild required/);
  assert.match(panel, /ios-simulator-preview/);
  assert.match(panel, /ios-xcode-project/);
  assert.match(billing, /\/functions\/v1\/artifact-download/);
  assert.match(edge, /GITHUB_ARTIFACT_RE/);
  assert.match(edge, /Content-Disposition/);
  assert.match(edge, /artifact-user:\$\{data\.user\.id\}/);
  assert.match(readme, /supabase functions deploy artifact-download/);

  let calledUrl = "";
  let body = null;
  let auth = "";
  global.fetch = async (url, opts) => {
    calledUrl = String(url);
    body = JSON.parse(opts.body);
    auth = opts.headers.Authorization;
    return { ok: true, status: 200, blob: async () => new Blob([new Uint8Array([80, 75, 3, 4])], { type: "application/zip" }) };
  };
  const blob = await Billing.downloadArtifact(
    "supabase-jwt",
    "github-token",
    { apiUrl: "https://api.github.com/repos/octo/demo/actions/artifacts/123/zip" },
    "ios-app.zip"
  );
  assert.match(calledUrl, /\/functions\/v1\/artifact-download$/);
  assert.equal(auth, "Bearer supabase-jwt");
  assert.deepEqual(body, {
    artifactUrl: "https://api.github.com/repos/octo/demo/actions/artifacts/123/zip",
    githubToken: "github-token",
    filename: "ios-app.zip"
  });
  assert.ok(blob.size >= 4);
});

test("panel uses a shadow root and masks the GitHub token", () => {
  const source = read("src/panel.js");
  assert.match(source, /attachShadow\(\{ mode: "open" \}\)/);
  assert.match(source, /type="password" id="nz-token"/);
});

test("panel copy does not present a manual GitHub token as a billing bypass", () => {
  const source = read("src/panel.js");
  assert.match(source, /plan still requires sign-in/);
  assert.match(source, /Free builds a watermarked/);
  assert.doesNotMatch(source, /skip Sign in/);
  assert.doesNotMatch(source, /or paste a token under Options/);
});

test("build progress uses distinct ten-percent milestones and does not warn about expected platform limits", () => {
  const panel = read("src/panel.js");
  const web = read("website/app.js");

  [
    "Preparing project files",
    "Checking app configuration",
    "Installing required dependencies",
    "Preparing iOS build settings",
    "Generating simulator-ready files",
    "Validating Xcode project",
    "Packaging download files",
    "Running final build checks",
    "Preparing the final download",
    "Build complete"
  ].forEach((message) => assert.match(panel, new RegExp(message)));
  assert.match(panel, /id="nz-progPct"/);
  assert.match(panel, /id="nz-progFill"/);
  assert.match(panel, /never reaches 100% until the run/);
  assert.doesNotMatch(web, /Android \/ Mac \/ Windows builds/);
});

test("extension and web studio require Supabase sign-in before builder actions", () => {
  const panel = read("src/panel.js");
  const content = read("src/content.js");
  const web = read("website/app.js");

  assert.match(panel, /authRequired/);
  assert.match(panel, /signedIn = initial\.signedIn === true/);
  assert.match(panel, /function setAuthLocked\(locked\)/);
  assert.match(panel, /function requireSignedInUi\(action\)/);
  assert.match(panel, /requireSignedInUi\("download a native kit"\)/);
  assert.match(panel, /requireSignedInUi\("download the full project"\)/);
  assert.match(panel, /requireSignedInUi\("build an app"\)/);

  assert.match(content, /signedIn: !!supabaseAccess/);
  assert.match(content, /authRequired: true/);
  assert.match(content, /Supabase can verify your paid Nativize plan/);

  assert.match(web, /function refreshBillingStrict\(action\)/);
  assert.match(web, /function requireSignedIn\(action\)/);
  assert.match(web, /signedIn: !!supabaseAccess/);
  assert.match(web, /authRequired: true/);
  assert.match(web, /refreshBillingStrict\("download the full project"\)/);
  assert.match(web, /refreshBillingStrict\("download a native kit"\)/);
  assert.match(web, /return ensureCanPush\(repo\)\.then\(function \(\) \{/);
  assert.match(web, /refreshBillingStrict\("rebuild an app"\)/);
  assert.doesNotMatch(web, /if \(nativizedRepos\.indexOf\(repo\) > -1\) return Promise\.resolve/);
});

test("OAuth uses PKCE and token-fragment callbacks can be rejected", async () => {
  const pkce = await Billing.createPkce("0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJK");
  const authUrl = Billing.authorizeUrl("https://nativize.dev/app.html", {
    codeChallenge: pkce.codeChallenge,
    codeChallengeMethod: pkce.codeChallengeMethod
  });
  const parsedAuth = new URL(authUrl);
  assert.equal(parsedAuth.searchParams.get("code_challenge"), pkce.codeChallenge);
  assert.equal(parsedAuth.searchParams.get("code_challenge_method"), "S256");

  const tokenFragment = Billing.parseAuthTokens(
    "https://nativize.dev/app.html#access_token=fake&refresh_token=fake&provider_token=fake"
  );
  assert.equal(tokenFragment.code, "");
  assert.equal(tokenFragment.accessToken, "fake");
  assert.equal(tokenFragment.githubToken, "fake");

  const codeCallback = Billing.parseAuthTokens("https://nativize.dev/app.html?code=auth-code");
  assert.equal(codeCallback.code, "auth-code");
  assert.equal(codeCallback.accessToken, "");
});

test("Supabase app activation serializes app-limit checks per user", () => {
  const sql = read("supabase/migrations/202606270001_billing.sql");
  assert.match(sql, /pg_advisory_xact_lock\(hashtext\('nativize_activate_app'\), hashtext\(current_user_id::text\)\)/);
  assert.match(sql, /nativize_check_rate_limit\('activate-app:' \|\| current_user_id::text, 5, 900\)/);
  assert.match(sql, /nativize_check_rate_limit\('billing-status:' \|\| current_user_id::text, 60, 900\)/);
  assert.match(sql, /current_status\.apps_used >= current_status\.apps_limit/);
  assert.match(sql, /insert into public\.app_activations/);
});

test("login routes are throttled and dynamic panel inputs are size-bounded", () => {
  const background = read("src/background.js");
  const web = read("website/app.js");
  const panel = read("src/panel.js");
  assert.match(background, /LOGIN_THROTTLE_KEY/);
  assert.match(background, /recent\.length >= 5/);
  assert.match(web, /throttleLocal\(K\.loginAttempts, 5, 15 \* 60 \* 1000/);
  assert.match(panel, /id="nz-appName" maxlength="80"/);
  assert.match(panel, /id="nz-token" maxlength="5000"/);
  assert.match(panel, /file\.size > 180000/);
});

test("checkout and feedback endpoints have rate limits and malformed-input guards", () => {
  const checkout = read("supabase/functions/create-checkout-session/index.ts");
  const webhook = read("supabase/functions/stripe-webhook/index.ts");
  const feedbackFn = read("supabase/functions/feedback-submit/index.ts");
  const feedback = read("website/supabase-feedback.sql");
  const site = read("website/script.js");
  assert.match(checkout, /MAX_BODY_BYTES = 4096/);
  assert.match(checkout, /checkout-user:\$\{data\.user\.id\}`,\s*5,\s*900/);
  assert.match(checkout, /return json\(\{ error: "Checkout failed\." \}, 500\)/);
  assert.match(webhook, /MAX_WEBHOOK_BODY_BYTES = 2 \* 1024 \* 1024/);
  assert.match(webhook, /return json\(\{ error: "Invalid signature" \}, 400\)/);
  assert.match(feedbackFn, /RESEND_API_KEY/);
  assert.match(feedbackFn, /SUPPORT_TO_EMAIL/);
  assert.match(feedbackFn, /feedback-edge:\$\{requestIp\(req\)\}`,\s*20,\s*900/);
  assert.match(feedbackFn, /supportReply\(row\)/);
  assert.match(feedback, /nativize_check_rate_limit\(bucket, 5, 900\)/);
  assert.match(feedback, /Invalid email address/);
  assert.match(feedback, /support_inbox/);
  assert.match(feedback, /bot_reply_body/);
  assert.match(site, /FEEDBACK_FUNCTION_URL/);
  assert.match(site, /submitFeedbackFunction\(type, payload\)/);
  assert.match(site, /insertFeedback\(table, payload\)/);
  assert.match(site, /function feedbackFallbackUrl\(type, payload\)/);
  assert.match(site, /Open a GitHub support draft/);
  assert.match(site, /Name and email are omitted/);
});

test("panel renders the social sign-in section and feeds it into getState", () => {
  const source = read("src/panel.js");
  // section + render/collect/validate wiring exists
  assert.match(source, /id="nz-socialToggle"/);
  assert.match(source, /function renderSocial\(/);
  assert.match(source, /KIT\.validateSocialAuth\(/);
  // the collected social config is part of the emitted state
  assert.match(source, /socialAuth: isPaidUi\(\) \? collectSocial\(\) : \{\}/);
});

test("panel locks paid-only feature controls on the free plan", () => {
  const source = read("src/panel.js");
  const content = read("src/content.js");
  const web = read("website/app.js");

  assert.match(source, /id="nz-pushLock"/);
  assert.match(source, /id="nz-permLock"/);
  assert.match(source, /id="nz-storeLock"/);
  assert.match(source, /id="nz-socialLock"/);
  assert.match(source, /function setPlan\(nextPlanId\)/);
  assert.ok(source.includes('var storeOn = isPaidUi() && $("nz-store").checked;'));
  assert.ok(source.includes('enablePush: isPaidUi() && $("nz-push").checked,'));
  assert.ok(source.includes('permissions: isPaidUi() ? collectPermissions() : [],'));

  assert.match(content, /planId: currentPlanId\(\)/);
  assert.match(content, /panelApi = Panel\.mount/);
  assert.match(content, /panelApi\.setPlan\(currentPlanId\(\)\)/);

  assert.match(web, /planId: currentPlanId\(\)/);
  assert.match(web, /panel\.setPlan\(currentPlanId\(\)\)/);
});
