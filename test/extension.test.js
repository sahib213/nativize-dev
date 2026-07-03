"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Billing = require("../src/billing.js");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("Manifest V3 runs on every page, functional toolbar icon, GitHub + Supabase billing, local storage only", () => {
  const manifest = JSON.parse(read("manifest.json"));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.name, "Nativize - Lovable to Native Apps");
  assert.ok(manifest.description.includes("native iOS"));
  assert.ok(manifest.description.includes("build in the cloud"));
  assert.ok(manifest.description.length <= 132); // Chrome Web Store short-description limit
  assert.doesNotMatch(manifest.description, /Capacitor|GitHub|Apple|Google|Microsoft/);
  // 'identity' for GitHub sign-in; 'scripting'+'activeTab' let the toolbar icon
  // inject + open the panel on any tab (fixes the "icon not working" rejection).
  assert.deepEqual(manifest.permissions, ["storage", "identity", "downloads", "scripting", "activeTab"]);
  // GitHub API + Supabase Auth/RPC/Edge Functions for billing.
  assert.ok(manifest.host_permissions.includes("https://api.github.com/*"));
  assert.ok(manifest.host_permissions.includes("https://gaaxcbarmiwtojblkkyh.supabase.co/*"));
  const legacyHost = "https://api." + "lemonsqueezy.com/*";
  assert.ok(!manifest.host_permissions.includes(legacyHost));
  // Runs on every page — not just Lovable.
  assert.deepEqual(manifest.content_scripts[0].matches, ["<all_urls>"]);
  // plans + billing load before the generator so gating + unlocking are available.
  const js = manifest.content_scripts[0].js;
  assert.ok(js.indexOf("src/plans.js") < js.indexOf("src/kit-generator.js"));
  assert.ok(js.includes("src/billing.js"));
  assert.ok(!js.includes("src/" + "license.js"));
  assert.equal(manifest.background.service_worker, "src/background.js");
  // No popup: the icon click is handled by the background worker so it actually
  // opens the tool (a static popup was what the review flagged as non-functional).
  assert.equal(manifest.action.default_popup, undefined);
  assert.ok(manifest.action.default_title && manifest.action.default_title.length > 0);
  assert.deepEqual(Object.keys(manifest.icons).sort(), ["128", "16", "48"]);
});

test("toolbar icon opens the panel: background dispatches toggle, content script handles it", () => {
  const background = read("src/background.js");
  const content = read("src/content.js");
  assert.match(background, /chrome\.action\.onClicked\.addListener/);
  assert.match(background, /type: "nativize-toggle"/);
  assert.match(background, /chrome\.scripting\.executeScript/); // inject-on-demand fallback
  assert.match(content, /msg\.type === "nativize-toggle"/);
  assert.match(content, /panelToggleRef/);
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

test("artifact and source downloads use the Supabase relay with server-side plan checks", async () => {
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
  assert.match(content, /Billing\.downloadArtifact\(supabaseAccess, state\.token, artifact, filename\)/);
  assert.match(content, /Billing\.downloadProject\(supabaseAccess, state\.token, state\.githubRepo, filename\)/);
  assert.doesNotMatch(content, /type: "nativize-download-artifact"/);
  assert.doesNotMatch(content, /GitHub\.downloadArtifact\(artifact, state\.token\)/);

  assert.match(web, /Billing\.downloadArtifact\(supabaseAccess, state\.token, artifact, filename\)/);
  assert.match(web, /Billing\.downloadProject\(supabaseAccess, state\.token, state\.githubRepo, filename\)/);
  assert.doesNotMatch(web, /GitHub\.downloadArtifact\(artifact, state\.token\)/);
  assert.match(panel, /ios-unsigned-app/);
  assert.match(panel, /ios-simulator-app/);
  assert.match(panel, /Rebuild required/);
  assert.match(panel, /ios-simulator-preview/);
  assert.match(panel, /Nativized iOS Preview/);
  assert.match(panel, /Download Full Source Code/);
  assert.match(panel, /Full Source Code Available on Paid Plans/);
  assert.doesNotMatch(panel, /id="nz-projectBtn"/);
  assert.match(panel, /install-in-simulator\.txt/);
  assert.doesNotMatch(panel, /install-in-simulator\.sh/);
  assert.match(panel, /setStatus\("✓ Downloaded "/);
  assert.match(panel, /ios-xcode-project/);
  assert.match(billing, /\/functions\/v1\/artifact-download/);
  assert.match(billing, /downloadProject: downloadProject/);
  assert.match(edge, /GITHUB_ARTIFACT_RE/);
  assert.match(edge, /fetchGithubArtifactMetadata/);
  assert.match(edge, /artifactRequiresPaid/);
  assert.match(edge, /billing_entitlements/);
  assert.match(edge, /kind === "project"/);
  assert.match(edge, /A paid Nativize plan is required to download Full Source Code/);
  assert.match(edge, /Content-Disposition/);
  assert.match(edge, /redirect: "manual"/);
  assert.match(edge, /arrayBuffer\(\)/);
  assert.doesNotMatch(edge, /new Response\(artifact\.body/);
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

  const projectBlob = await Billing.downloadProject(
    "supabase-jwt",
    "github-token",
    "octo/demo",
    "Nativized Source Code.zip"
  );
  assert.deepEqual(body, {
    kind: "project",
    repo: "octo/demo",
    githubToken: "github-token",
    filename: "Nativized Source Code.zip"
  });
  assert.ok(projectBlob.size >= 4);
});

test("panel uses a shadow root and keeps the GitHub token internal", () => {
  const source = read("src/panel.js");
  assert.match(source, /attachShadow\(\{ mode: "open" \}\)/);
  assert.match(source, /var githubToken = String\(initial\.token \|\| ""\)/);
  assert.match(source, /token: githubToken\.trim\(\)/);
  assert.doesNotMatch(source, /id="nz-token"/);
});

test("panel copy does not present a manual GitHub token path", () => {
  const source = read("src/panel.js");
  assert.match(source, /Free builds a watermarked/);
  assert.doesNotMatch(source, /skip Sign in/);
  assert.doesNotMatch(source, /manual token/i);
  assert.doesNotMatch(source, /GitHub token/i);
});

test("panel separates app settings, push, and store upload controls", () => {
  const source = read("src/panel.js");
  assert.match(source, /id="nz-optToggle"/);
  assert.match(source, /<b>App settings<\/b><small>Bundle ID and web build folder<\/small>/);
  assert.match(source, /id="nz-pushToggle"/);
  assert.match(source, /<b>Push notifications<\/b><small>Firebase messaging setup<\/small>/);
  assert.match(source, /id="nz-storeToggle"/);
  assert.match(source, /<b>Store upload<\/b><small>TestFlight and Play internal testing<\/small>/);
  assert.doesNotMatch(source, /Options — app ID, push, store upload/);
});

test("build-ready download screen is scrollable", () => {
  const panel = read("src/panel.js");
  const webPanel = read("website/lib/panel.js");

  assert.match(panel, /\.nz-success \{/);
  assert.match(panel, /max-height: calc\(80vh - 126px\); overflow-y: auto/);
  assert.match(panel, /overscroll-behavior: contain/);
  assert.match(panel, /\$\("nz-success"\)\.scrollTop = 0/);
  assert.match(webPanel, /max-height: calc\(80vh - 126px\); overflow-y: auto/);
});

test("Lovable repo detection reads GitHub metadata instead of guessing from app name", () => {
  const content = read("src/content.js");
  const panel = read("src/panel.js");

  assert.match(content, /function normalizeGithubRepoCandidate/);
  assert.match(content, /githubRepo\|github_repo\|githubRepository\|github_repository\|repositoryFullName\|repoFullName\|full_name\|repo/);
  assert.match(content, /script:not\(\[src\]\)/);
  assert.match(content, /\[localStorage, sessionStorage\]/);
  assert.match(content, /new MutationObserver/);
  assert.match(content, /startRepoAutodetect\(panelApi\)/);
  assert.match(content, /panelApi\.setRepo\(repo\)/);
  assert.doesNotMatch(content, /githubRepo:\s*saved\.githubRepo \|\| detectAppName/);
  assert.match(panel, /function setRepo\(repo\)/);
  assert.match(panel, /setRepo: setRepo/);
});

test("build progress uses five numbered steps and does not warn about expected platform limits", () => {
  const panel = read("src/panel.js");
  const webPanel = read("website/lib/panel.js");
  const web = read("website/app.js");

  [
    "Preparing project files",
    "Checking app configuration",
    "Installing required dependencies",
    "Building and validating iOS",
    "Preparing final download",
    "Step 1 of 5",
    "Build complete"
  ].forEach((message) => assert.match(panel, new RegExp(message)));
  assert.match(panel, /class="nz-step-num">'\s*\+\s*\(i \+ 1\)/);
  assert.match(panel, /id="nz-progStepText"/);
  assert.match(panel, /label\.textContent = "Step " \+ \(stepIndex \+ 1\) \+ " of " \+ BUILD_STEPS\.length/);
  assert.match(panel, /id="nz-progFill"/);
  assert.match(panel, /five honest steps/);
  assert.match(panel, /until the run actually completes/);
  assert.doesNotMatch(panel, /id="nz-progPct"/);
  assert.match(webPanel, /Step 1 of 5/);
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
  assert.match(panel, /id="nz-webDir" maxlength="120"/);
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
  assert.match(site, /Log in with GitHub/);
  assert.match(site, /\/app\/\?login=github/);
  assert.match(site, /btn-github-login/);
  assert.doesNotMatch(site, /function feedbackFallbackUrl\(type, payload\)/);
  assert.doesNotMatch(site, /Open a GitHub support draft/);
  assert.doesNotMatch(site, /Name and email are omitted/);
  assert.doesNotMatch(site, /sahib213\/nativize-dev/);
  assert.doesNotMatch(site, /GITHUB_URL/);
  const app = read("website/app.js");
  assert.match(app, /consumeGitHubLoginIntent/);
  assert.match(app, /url\.searchParams\.get\("login"\) !== "github"/);
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
