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

function isConfigured() {
  return !SUPABASE_URL.includes("YOUR-PROJECT") && !SUPABASE_ANON_KEY.includes("YOUR-");
}

function authorizeUrl() {
  const redirect = chrome.identity.getRedirectURL(); // https://<extid>.chromiumapp.org/
  const p = new URLSearchParams({
    provider: "github",
    scopes: GITHUB_SCOPES,
    redirect_to: redirect,
    apikey: SUPABASE_ANON_KEY
  });
  return `${SUPABASE_URL}/auth/v1/authorize?${p.toString()}`;
}

// Supabase returns tokens in the redirect URL fragment.
function parseTokens(redirectedTo) {
  const hash = redirectedTo.includes("#") ? redirectedTo.split("#")[1] : "";
  const query = redirectedTo.includes("?") ? redirectedTo.split("?")[1].split("#")[0] : "";
  const params = new URLSearchParams(hash || query);
  return {
    githubToken: params.get("provider_token"), // the GitHub access token we use
    supabaseAccess: params.get("access_token"),
    error: params.get("error_description") || params.get("error")
  };
}

async function signInWithGitHub() {
  if (!isConfigured()) {
    throw new Error("Supabase isn't configured yet — set SUPABASE_URL / SUPABASE_ANON_KEY in src/background.js.");
  }
  const redirectedTo = await chrome.identity.launchWebAuthFlow({ url: authorizeUrl(), interactive: true });
  const t = parseTokens(redirectedTo || "");
  if (t.error) throw new Error("GitHub sign-in failed: " + t.error);
  if (!t.githubToken) {
    throw new Error("Signed in, but GitHub didn't return a token. In Supabase → Auth → Providers → GitHub, ensure scopes include 'repo workflow'.");
  }
  await chrome.storage.local.set({ "nativize:githubToken": t.githubToken, "nativize:signedIn": true });
  return t.githubToken;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  if (msg.type === "nativize-signin") {
    signInWithGitHub()
      .then((token) => sendResponse({ ok: true, token }))
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
    chrome.storage.local.remove(["nativize:githubToken", "nativize:signedIn"]).then(() => sendResponse({ ok: true }));
    return true;
  }
});
