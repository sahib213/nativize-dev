/*
 * Nativize background service worker.
 *
 * Handles "Sign in with GitHub" via the user's Supabase project. Supabase Auth
 * holds the GitHub OAuth secret and returns a GitHub provider_token (with the
 * repo + workflow scopes we need to push and run the build). chrome.identity is
 * not available in content scripts, so the panel messages us to run the flow.
 *
 * ── ONE-TIME SETUP (so the button works) ───────────────────────────────────
 *  1. Fill SUPABASE_URL + SUPABASE_ANON_KEY below (Supabase → Settings → API).
 *  2. Supabase → Authentication → Providers → GitHub: enable it, paste a GitHub
 *     OAuth App's Client ID + Secret. In that GitHub OAuth App set the callback
 *     to:  <SUPABASE_URL>/auth/v1/callback
 *  3. Supabase → Authentication → URL Configuration → add this extension's
 *     redirect URL (printed in the panel, looks like
 *     https://<extension-id>.chromiumapp.org/) to the allowed redirect URLs.
 * ────────────────────────────────────────────────────────────────────────────
 */

// ---- CONFIG ---------------------------------------------------------------
const SUPABASE_URL = "https://gaaxcbarmiwtojblkkyh.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_mAA5LXz9HFHlwVzkA1SCEg_ybxHh_X7";
const GITHUB_SCOPES = "repo workflow"; // required to push files + dispatch the build
const LOGIN_THROTTLE_KEY = "nativize:loginAttempts";

function isConfigured() {
  return !SUPABASE_URL.includes("YOUR-PROJECT") && !SUPABASE_ANON_KEY.includes("YOUR-");
}

async function enforceLoginThrottle() {
  const now = Date.now();
  const res = await chrome.storage.local.get([LOGIN_THROTTLE_KEY]);
  const recent = Array.isArray(res[LOGIN_THROTTLE_KEY])
    ? res[LOGIN_THROTTLE_KEY].filter((t) => now - Number(t) < 15 * 60 * 1000)
    : [];
  if (recent.length >= 5) {
    throw new Error("Too many sign-in attempts. Please wait 15 minutes and try again.");
  }
  recent.push(now);
  await chrome.storage.local.set({ [LOGIN_THROTTLE_KEY]: recent });
}

function base64Url(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function createPkce() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const codeVerifier = base64Url(bytes);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier));
  return {
    codeVerifier,
    codeChallenge: base64Url(new Uint8Array(digest))
  };
}

function authorizeUrl(codeChallenge) {
  const redirect = chrome.identity.getRedirectURL(); // https://<extid>.chromiumapp.org/
  const p = new URLSearchParams({
    provider: "github",
    scopes: GITHUB_SCOPES,
    redirect_to: redirect,
    apikey: SUPABASE_ANON_KEY,
    code_challenge: codeChallenge,
    code_challenge_method: "S256"
  });
  return `${SUPABASE_URL}/auth/v1/authorize?${p.toString()}`;
}

function parseAuthCallback(redirectedTo) {
  const hash = redirectedTo.includes("#") ? redirectedTo.split("#")[1] : "";
  const query = redirectedTo.includes("?") ? redirectedTo.split("?")[1].split("#")[0] : "";
  const params = new URLSearchParams(hash || query);
  return {
    code: params.get("code") || "",
    hasTokenFragment: params.has("access_token") || params.has("refresh_token") || params.has("provider_token"),
    error: params.get("error_description") || params.get("error")
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
  const text = await res.text().catch(() => "");
  if (!text) return {};
  try { return JSON.parse(text); } catch (e) { return { message: text }; }
}

function normalizeSession(data) {
  data = data || {};
  const session = data.session || {};
  return {
    githubToken: data.provider_token || data.providerToken || session.provider_token || session.providerToken || "",
    supabaseAccess: data.access_token || session.access_token || "",
    supabaseRefresh: data.refresh_token || session.refresh_token || "",
    expiresAt: data.expires_at || session.expires_at || "",
    expiresIn: data.expires_in || session.expires_in || ""
  };
}

function safeDownloadFilename(name) {
  let out = String(name || "nativize-artifact.zip")
    .trim()
    .replace(/[<>:"\\|?*\u0000-\u001f]/g, "-")
    .replace(/^[/\\]+/, "")
    .replace(/\.\.+/g, ".");
  if (!out || out === "." || out === "..") out = "nativize-artifact.zip";
  if (!/\.zip$/i.test(out)) out += ".zip";
  return out.slice(0, 180);
}

async function exchangeCodeForSession(code, codeVerifier) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=pkce`, {
    method: "POST",
    headers: anonHeaders(),
    body: JSON.stringify({ auth_code: code, code_verifier: codeVerifier })
  });
  const data = await readJson(res);
  if (!res.ok) throw new Error(data.message || data.error || "Could not finish Supabase sign-in.");
  return normalizeSession(data);
}

async function signInWithGitHub() {
  if (!isConfigured()) {
    throw new Error("Supabase isn't configured yet — set SUPABASE_URL / SUPABASE_ANON_KEY in src/background.js.");
  }
  await enforceLoginThrottle();
  const pkce = await createPkce();
  const redirectedTo = await chrome.identity.launchWebAuthFlow({ url: authorizeUrl(pkce.codeChallenge), interactive: true });
  const callback = parseAuthCallback(redirectedTo || "");
  if (callback.error) throw new Error("GitHub sign-in failed: " + callback.error);
  if (callback.hasTokenFragment) throw new Error("GitHub sign-in failed a security check. Please start again.");
  if (!callback.code) throw new Error("GitHub sign-in did not return an auth code. Check the Supabase Auth redirect settings and try again.");
  const t = await exchangeCodeForSession(callback.code, pkce.codeVerifier);
  if (!t.githubToken) {
    throw new Error("Signed in, but GitHub didn't return a token. In Supabase → Auth → Providers → GitHub, ensure scopes include 'repo workflow'.");
  }
  if (!t.supabaseAccess) {
    throw new Error("Signed in, but Supabase did not return a session. Check the Supabase Auth redirect settings and try again.");
  }
  await chrome.storage.local.set({
    "nativize:githubToken": t.githubToken,
    "nativize:supabaseAccess": t.supabaseAccess || "",
    "nativize:supabaseRefresh": t.supabaseRefresh || "",
    "nativize:supabaseExpiresAt": t.expiresAt || "",
    "nativize:signedIn": true
  });
  return t;
}

async function downloadArtifact(msg) {
  const url = String((msg && msg.artifactUrl) || "").trim();
  const token = String((msg && msg.token) || "").trim();
  if (!/^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/actions\/artifacts\/\d+\/zip$/i.test(url)) {
    throw new Error("Artifact download URL is invalid.");
  }
  if (!token || token.length > 5000) throw new Error("GitHub access is missing. Sign in again.");
  const id = await chrome.downloads.download({
    url,
    filename: safeDownloadFilename(msg.filename),
    conflictAction: "uniquify",
    saveAs: false,
    headers: [
      { name: "Authorization", value: "Bearer " + token },
      { name: "Accept", value: "application/vnd.github+json" },
      { name: "X-GitHub-Api-Version", value: "2022-11-28" }
    ]
  });
  return { downloadId: id };
}

// Clicking the toolbar icon opens/closes the Nativize panel on the current page.
// There is no default_popup, so onClicked fires. Normally the content script is
// already present (it runs on every page); if it isn't (a tab opened before the
// extension loaded, etc.), inject the bundle on demand, then toggle.
const CONTENT_FILES = [
  "src/plans.js", "src/billing.js", "src/kit-generator.js", "src/zip.js",
  "src/vendor/tweetnacl.js", "src/vendor/blake2b.js", "src/sealedbox.js",
  "src/github.js", "src/panel.js", "src/content.js"
];

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || !tab.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "nativize-toggle" });
  } catch (e) {
    // No receiver yet — inject the content bundle, then toggle.
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: CONTENT_FILES });
      await chrome.tabs.sendMessage(tab.id, { type: "nativize-toggle" });
    } catch (e2) {
      // Restricted page (chrome://, Chrome Web Store, PDF viewer, etc.) — can't run here.
    }
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  if (msg.type === "nativize-signin") {
    signInWithGitHub()
      .then((tokens) => sendResponse({
        ok: true,
        token: tokens.githubToken,
        supabaseAccess: tokens.supabaseAccess || "",
        supabaseRefresh: tokens.supabaseRefresh || "",
        supabaseExpiresAt: tokens.expiresAt || ""
      }))
      .catch((e) => sendResponse({ ok: false, error: (e && e.message) || String(e) }));
    return true; // keep the channel open for the async response
  }
  if (msg.type === "nativize-redirect-url") {
    let url = "";
    try { url = chrome.identity.getRedirectURL(); } catch (e) { /* ignore */ }
    sendResponse({ url, configured: isConfigured() });
    return true;
  }
  if (msg.type === "nativize-signout") {
    chrome.storage.local.remove([
      "nativize:githubToken",
      "nativize:supabaseAccess",
      "nativize:supabaseRefresh",
      "nativize:supabaseExpiresAt",
      "nativize:billing",
      "nativize:signedIn"
    ]).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === "nativize-download-artifact") {
    downloadArtifact(msg)
      .then((result) => sendResponse({ ok: true, downloadId: result.downloadId }))
      .catch((e) => sendResponse({ ok: false, error: (e && e.message) || String(e) }));
    return true;
  }
});
