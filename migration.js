/* ============================================================================
   Nativize App Migration — connector wizard (Lovable Cloud → Supabase).

   Lovable Cloud cannot be connected directly, so the user deploys a tiny,
   temporary, read-only "migrate-helper" edge function we generate. Nativize's
   hosted migration-run function then reads from that helper and writes into
   the user's target Supabase project (schema + rows, auth users, storage).

   Secrets (target connection string + service key) live only in this tab's
   memory during a run and are sent over HTTPS for transient use — never
   stored by Nativize. Access is gated by Max or a single-migration credit.
   ============================================================================ */
(function () {
  "use strict";

  var root = document.getElementById("migrationApp");
  var Billing = window.NativizeBilling;
  var Helper = window.NativizeMigrationHelper;
  if (!root || !Billing || !Helper) { if (root) root.innerHTML = '<div class="mig-loading">Migration failed to load. Refresh the page.</div>'; return; }

  var SESSION = { access: "nz_web_supabase_access", refresh: "nz_web_supabase_refresh" };
  var K = { draft: "nz_migration_draft_v2", verifier: "nz_migration_pkce_verifier", pending: "nz_migration_pending" };

  function persistentGet(key) { try { return localStorage.getItem(key) || sessionStorage.getItem(key) || ""; } catch (_e) { return ""; } }
  function persistentSet(key, value) { try { if (value) localStorage.setItem(key, value); else localStorage.removeItem(key); sessionStorage.removeItem(key); } catch (_e) {} }
  var accessToken = persistentGet(SESSION.access);
  var refreshToken = persistentGet(SESSION.refresh);
  // Migrate older tab-only sessions so GitHub sign-in survives browser restarts.
  if (accessToken) persistentSet(SESSION.access, accessToken);
  if (refreshToken) persistentSet(SESSION.refresh, refreshToken);

  // Non-secret wizard draft is persisted so a refresh keeps your place.
  // accessKey starts empty — the user generates their unique key on the spot.
  var draft = load(K.draft, null) || { step: 0, accessKey: "", helperUrl: "", targetUrl: "", source: { tables: 0, users: 0, buckets: 0, objects: 0 }, targetEmpty: null, projectId: "" };
  // Secrets are kept in memory ONLY (never persisted).
  var creds = { targetConn: "", targetKey: "" };
  var completedMigration = null;
  var access = null;         // { access:'max'|'credit'|'none', credits_available }
  var runState = null;       // live run progress
  var busy = false;

  function esc(v) { return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function load(key, fb) { try { return JSON.parse(sessionStorage.getItem(key)) || fb; } catch (_e) { return fb; } }
  function save() { try { sessionStorage.setItem(K.draft, JSON.stringify(draft)); } catch (_e) {} }
  function forgetCompletedMigrationInfo() {
    completedMigration = { projectId: draft.projectId, source: draft.source || { tables: 0, users: 0, buckets: 0, objects: 0 } };
    creds = { targetConn: "", targetKey: "" };
    runState = null;
    draft = { step: 4, accessKey: "", helperUrl: "", targetUrl: "", source: completedMigration.source, targetEmpty: null, projectId: completedMigration.projectId };
    try { sessionStorage.removeItem(K.draft); } catch (_e) {}
  }
  function toast(msg) { var o = document.querySelector(".mig-toast"); if (o) o.remove(); var e = document.createElement("div"); e.className = "mig-toast"; e.textContent = msg; document.body.appendChild(e); setTimeout(function () { e.remove(); }, 2400); }
  function num(n) { return Number(n || 0).toLocaleString("en-US"); }

  /* ---------- auth ---------- */
  function saveTokens(t) { accessToken = t.accessToken || ""; refreshToken = t.refreshToken || refreshToken; persistentSet(SESSION.access, accessToken); persistentSet(SESSION.refresh, refreshToken); }
  function renew() { return Billing.refreshSession(refreshToken).then(function (t) { saveTokens(t); return t; }); }
  function api(method, args) { args = args || []; return Billing[method].apply(Billing, [accessToken].concat(args)).catch(function (err) { if (!refreshToken || !err || (err.status !== 401 && err.status !== 403)) throw err; return renew().then(function () { return Billing[method].apply(Billing, [accessToken].concat(args)); }); }); }
  function signIn(pending) { if (pending) sessionStorage.setItem(K.pending, pending); return Billing.createPkce().then(function (p) { sessionStorage.setItem(K.verifier, p.codeVerifier); location.href = Billing.authorizeUrl(location.href.split("#")[0], { codeChallenge: p.codeChallenge, codeChallengeMethod: p.codeChallengeMethod }); }); }
  function clearAuthParams() { var u = new URL(location.href); var ch = !!u.hash; u.hash = ""; ["code", "access_token", "refresh_token", "provider_token", "expires_at", "expires_in", "token_type", "state", "error", "error_description"].forEach(function (k) { if (u.searchParams.has(k)) { u.searchParams.delete(k); ch = true; } }); if (ch) history.replaceState(null, "", u.pathname + (u.search || "")); }
  function handleAuth() { var t = Billing.parseAuthTokens(location.href); if (t.error) { clearAuthParams(); return Promise.reject(new Error(t.error)); } if (!t.code) return Promise.resolve(); var v = sessionStorage.getItem(K.verifier) || ""; if (!v) { clearAuthParams(); return Promise.reject(new Error("Sign-in check failed. Start again.")); } return Billing.exchangeCodeForSession(t.code, v).then(function (s) { sessionStorage.removeItem(K.verifier); if (!s.accessToken) throw new Error("Sign-in did not return a session."); saveTokens(s); clearAuthParams(); }); }
  function currentUrl(params) { var u = new URL(location.href); u.hash = ""; u.search = ""; Object.keys(params || {}).forEach(function (k) { u.searchParams.set(k, params[k]); }); return u.toString(); }
  function checkout(planId) { if (!accessToken) return signIn("checkout:" + planId); busy = true; render(); return api("checkout", [planId, { successUrl: currentUrl({ checkout: "success" }), cancelUrl: currentUrl({ checkout: "cancelled" }) }]).then(function (r) { location.href = r.url; }).catch(function (e) { busy = false; render(e.message); }); }

  function renderSignIn(err) {
    root.innerHTML = head("Sign in once to securely load your migration access.") +
      '<div class="mig-sheet" style="max-width:620px;margin-left:auto;margin-right:auto;text-align:center">' +
      '<div class="eyebrow-sm">Secure account access</div><h2>Sign in with GitHub to migrate</h2>' +
      '<p class="lead">Your GitHub sign-in creates your Nativize identity in Supabase. That same account is used to find your Max subscription or paid single-migration credit, and you’ll stay signed in on this device.</p>' +
      (err ? note("err", esc(err)) : "") +
      '<button class="btn btn-primary" id="migSignin" style="width:100%;justify-content:center;margin-top:8px">Sign in with GitHub</button>' +
      '<p style="color:var(--muted);font-size:12.5px;margin:16px 0 0">Nativize never uses a different email or browser-only ID to decide migration access.</p></div>';
    document.getElementById("migSignin").onclick = function () { signIn("migration"); };
  }

  /* ---------- shared chrome ---------- */
  var STEPS = ["Connect", "Supabase", "Review", "Migrate", "Done"];
  function head(sub) {
    return '<div class="mig-top"><a class="mig-back" href="/migration/">App migration</a><div class="mig-title">' +
      '<h1>Lovable → your own Supabase</h1>' +
      '<p>' + (sub || "A secure, guided transfer you control.") + '</p></div></div>';
  }
  function progress(active) {
    return '<div class="mig-stepper">' + STEPS.map(function (s, i) {
      var cls = i < active ? "done" : i === active ? "active" : "wait";
      return '<div class="seg ' + cls + '"><div class="dot">' + (i < active ? "✓" : (i + 1)) + '</div><div class="lbl">' + esc(s) + '</div></div>';
    }).join("") + "</div>";
  }
  function note(cls, html) { return '<div class="mig-note ' + cls + '">' + html + "</div>"; }
  var LOGO = {
    supabase: '<img src="/assets/supabase-logo.svg" alt="" />',
    lovable: '<img src="/assets/lovable-logo.svg" alt="" />'
  };
  function connCard(kind, name, sub, connected) {
    return '<div class="mig-conn' + (connected ? " connected" : "") + '"><div class="tile ' + kind + '">' + (LOGO[kind] || "") + '</div>' +
      '<div class="meta"><b>' + esc(name) + '</b><span>' + esc(sub) + '</span></div>' +
      '<div class="pill">' + (connected ? "✓ Connected" : "Not connected") + '</div></div>';
  }
  // Reassurance panel — makes the (already real) safety properties visible.
  function safePanel(extra) {
    var rows = [
      ["01", "Your own private key", "This helper only answers requests carrying the random key baked into your copy of the code. Nobody else — not even Nativize — can call it."],
      ["02", "Read-only &amp; open", "The helper only reads. You can see every line before you deploy it, and it never writes to or deletes from your Lovable project."],
      ["03", "Keys never stored", "Your Supabase connection details stay in this browser tab and go straight to your own project. Nativize never saves or logs them."],
      ["04", "You remove it after", "When the migration is done, you delete the helper — the access closes with it."]
    ].concat(extra || []);
    return '<details class="mig-safe"><summary><span class="shield" aria-hidden="true"></span> Security and privacy <span class="chev">›</span></summary><div class="safe-body">' +
      rows.map(function (r) { return '<div class="safe-row"><div class="ic">' + r[0] + '</div><div><b>' + r[1] + '</b><p>' + r[2] + '</p></div></div>'; }).join("") + "</div></details>";
  }

  /* ---------- Step 0: Connect Lovable ---------- */
  function renderConnect(err) {
    var hasKey = !!draft.accessKey;
    var code = hasKey ? Helper.helperCode(draft.accessKey) : "";
    var pinged = draft.source && (draft.source.tables || draft.source.users || draft.source.buckets);
    // Step 2 content: generate the unique key on the spot, then reveal the code.
    var codeStep = hasKey
      ? '<p>Open <b>Cloud → Edge Functions → migrate-helper → View code</b>, replace everything, and save.</p>' +
        '<div class="mig-code-actions"><button class="btn btn-glass" data-copy-code>Copy helper code</button><button class="btn btn-ghost" id="mhRegen">New key</button></div>' +
        '<details class="mig-reveal"><summary>Preview helper code <span class="code-key">key ' + esc(draft.accessKey.slice(0, 12)) + '…</span><span class="chev">›</span></summary><div class="mig-code"><pre>' + esc(code) + '</pre></div></details>'
      : '<div class="mig-generate"><span>A private key is created in this browser only.</span><button class="btn btn-primary" id="mhGen">Generate helper code</button></div>';
    var nextAction = pinged
      ? '<button class="btn btn-primary" id="mhNext">Continue to Supabase</button>'
      : '<button class="btn btn-primary" id="mhTest"' + (hasKey ? "" : " disabled") + '>Test helper</button>';
    var body = '<div class="mig-sheet">' +
      '<div class="eyebrow-sm">Step 1 of 5</div><h2>Connect your Lovable project</h2>' +
      '<p class="lead">Add one temporary, read-only helper to your Lovable project. You’ll remove it after the transfer.</p>' +
      connCard("lovable", "Lovable Cloud", pinged ? num(draft.source.tables) + " tables · " + num(draft.source.users) + " users · " + num(draft.source.objects) + " files" : "Generate the helper below, then test", pinged) +
      (err ? note("err", esc(err)) : "") +
      '<div class="mig-steps">' +
        step("1", "Create the helper", 'Tell Lovable: <code class="inline">Create an empty edge function called migrate-helper</code>.') +
        step("2", "Add your helper code", codeStep) +
        step("3", "Deploy and connect", '<p>Tell Lovable: <code class="inline">Deploy migrate-helper with verify_jwt = false</code> Then copy its function URL.</p>' +
          '<div class="mig-field" style="margin-bottom:0"><input type="url" id="mhUrl" placeholder="https://YOUR-REF.functions.supabase.co/migrate-helper" value="' + esc(draft.helperUrl) + '"' + (hasKey ? "" : " disabled") + '></div>') +
      '</div>' +
      safePanel() +
      '<div class="mig-actions"><a class="btn btn-ghost" href="/migration/">Cancel</a><span class="spacer"></span>' + nextAction + '</div></div>';
    root.innerHTML = head() + progress(0) + body;
    var gen = document.getElementById("mhGen"); if (gen) gen.onclick = function () { draft.accessKey = Helper.randomKey(); save(); render(); toast("Your unique helper code is ready"); };
    var regen = document.getElementById("mhRegen"); if (regen) regen.onclick = function () { if (!confirm("Generate a new key? You'll need to paste and redeploy the helper code again.")) return; draft.accessKey = Helper.randomKey(); draft.source = { tables: 0, users: 0, buckets: 0, objects: 0 }; save(); render(); };
    var cp = document.querySelector("[data-copy-code]"); if (cp) cp.onclick = function () { navigator.clipboard.writeText(code).then(function () { toast("Helper code copied"); }); };
    var urlEl = document.getElementById("mhUrl"); if (urlEl) urlEl.oninput = function () { draft.helperUrl = this.value.trim(); save(); };
    var testEl = document.getElementById("mhTest"); if (testEl) testEl.onclick = testLovable;
    var nextEl = document.getElementById("mhNext"); if (nextEl) nextEl.onclick = function () { draft.step = 1; save(); render(); };
  }
  function step(n, title, body) { return '<div class="mig-step"><div class="n">' + n + '</div><div class="body"><h4>' + esc(title) + '</h4><div class="body-copy">' + body + "</div></div></div>"; }

  // Ping the helper directly from the browser (it is CORS-enabled + key-gated).
  function testLovable() {
    if (!draft.accessKey) { renderConnect("Generate your helper code first (Step 2)."); return; }
    var btn = document.getElementById("mhTest");
    var url = (document.getElementById("mhUrl").value || "").trim();
    if (!/^https:\/\/.+\.supabase\.co\/.*/.test(url)) { renderConnect("Enter your migrate-helper function URL (https://…supabase.co/…)."); return; }
    draft.helperUrl = url; save();
    btn.disabled = true; btn.textContent = "Testing…";
    fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "x-migrate-key": draft.accessKey }, body: JSON.stringify({ action: "ping" }) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (!res.ok || !res.j.ok) throw new Error(res.j && res.j.error ? res.j.error : "Helper did not respond. Check it's deployed with verify_jwt = false and the code was saved.");
        draft.source = { tables: res.j.tables || 0, users: res.j.users || 0, buckets: res.j.buckets || 0, objects: res.j.objects || 0 };
        save(); render();
      })
      .catch(function (e) { renderConnect("Could not reach the helper: " + e.message); });
  }

  /* ---------- Step 1: Connect Supabase ---------- */
  // Pull the project ref out of a Supabase connection string (direct OR pooler)
  // so we can auto-fill the project URL — one less thing for the user to paste.
  function deriveTarget(conn) {
    conn = String(conn || "");
    var m = conn.match(/@db\.([a-z0-9]{18,24})\.supabase\.co/i)      // direct connection
      || conn.match(/\/\/postgres\.([a-z0-9]{18,24})[:@]/i);         // session/transaction pooler
    return m ? { ref: m[1], url: "https://" + m[1] + ".supabase.co" } : null;
  }
  // The secret key is only used to upload storage files. Skip asking for it
  // when the source project has no storage.
  function needsStorageKey() { return (draft.source && (draft.source.objects || draft.source.buckets)) > 0; }

  function renderTarget(err) {
    var derived = deriveTarget(creds.targetConn);
    var keyField = needsStorageKey()
      ? '<div class="mig-field"><label>Secret key <span class="hint">Settings → API Keys → secret key · only used to copy your ' + num(draft.source.objects) + ' storage file' + (draft.source.objects === 1 ? "" : "s") + '</span></label>' +
          '<input type="password" id="tgKey" placeholder="sb_secret_… or service_role key" value="' + esc(creds.targetKey) + '"></div>'
      : "";
    var body = '<div class="mig-sheet">' +
      '<div class="eyebrow-sm">Step 2 of 5</div><h2>Connect your target Supabase</h2>' +
      '<p class="lead">Create a brand-new, empty Supabase project, click <b>Connect</b> at the top of its dashboard, and paste the connection string. We read the project details from it automatically.</p>' +
      connCard("supabase", "Supabase", draft.targetEmpty === true ? "Connected · empty and ready" : derived ? "Project " + esc(derived.ref) + " · test to continue" : "Paste your connection string", draft.targetEmpty === true) +
      (err ? note("err", esc(err)) : "") +
      '<div class="mig-field"><label>Database connection string <span class="hint">Supabase → Connect → Direct connection (or Session pooler)</span></label>' +
        '<textarea id="tgConn" placeholder="postgresql://postgres:[YOUR-PASSWORD]@db.YOUR-REF.supabase.co:5432/postgres">' + esc(creds.targetConn) + '</textarea>' +
        (derived ? '<div class="mig-note ok" style="margin:8px 0 0">✓ Project detected: <b>' + esc(derived.ref) + '</b></div>' : '') + '</div>' +
      keyField +
      '<label class="mig-check"><input type="checkbox" id="tgBlank"' + (draft.targetEmpty !== null ? " checked" : "") + '><span>I confirm this is a <b>fresh / empty</b> Supabase project.</span></label>' +
      (draft.targetEmpty === false ? note("warn", "⚠ The target already has tables in <code class=\"inline\">public</code>. You can continue — existing rows aren’t overwritten (insert-if-absent).") : "") +
      safePanel() +
      '<div class="mig-actions"><button class="btn btn-ghost" id="tgBack">← Back</button><span class="spacer"></span>' +
        '<button class="btn btn-glass" id="tgTest">Test connection</button>' +
        '<button class="btn btn-primary" id="tgNext" ' + (draft.targetEmpty === null ? "disabled" : "") + '>Continue</button></div></div>';
    root.innerHTML = head() + progress(1) + body;
    var connEl = document.getElementById("tgConn");
    connEl.oninput = function () {
      creds.targetConn = this.value.trim();
      // Live-update the "project detected" hint without a full re-render.
      var d = deriveTarget(creds.targetConn); var hint = connEl.parentNode.querySelector(".mig-note");
      if (d) { if (!hint) { hint = document.createElement("div"); hint.className = "mig-note ok"; hint.style.margin = "8px 0 0"; connEl.parentNode.appendChild(hint); } hint.innerHTML = "✓ Project detected: <b>" + esc(d.ref) + "</b> — we\'ll fill in the rest."; }
      else if (hint) hint.remove();
    };
    var keyEl = document.getElementById("tgKey"); if (keyEl) keyEl.oninput = function () { creds.targetKey = this.value.trim(); };
    document.getElementById("tgBack").onclick = function () { draft.step = 0; save(); render(); };
    document.getElementById("tgTest").onclick = testTarget;
    document.getElementById("tgNext").onclick = function () { if (draft.targetEmpty !== null) { draft.step = 2; save(); loadAccess(); render(); } };
  }
  function testTarget() {
    if (!accessToken) { signIn("target"); return; }
    var btn = document.getElementById("tgTest");
    var conn = (document.getElementById("tgConn").value || "").trim();
    var keyEl = document.getElementById("tgKey");
    if (!/^postgres(ql)?:\/\/.+@.+/.test(conn)) { renderTarget("Paste your Supabase Postgres connection string (from the Connect button in your dashboard)."); return; }
    var derived = deriveTarget(conn);
    if (!derived) { renderTarget("Couldn\'t read your project ref from that string. Copy the full connection string from Supabase → Connect."); return; }
    if (needsStorageKey() && !(keyEl && keyEl.value.trim())) { renderTarget("Add your secret key so we can copy your storage files, or it will be skipped."); return; }
    if (!document.getElementById("tgBlank").checked) { renderTarget("Please confirm the target project is fresh / empty."); return; }
    creds.targetConn = conn; if (keyEl) creds.targetKey = keyEl.value.trim(); draft.targetUrl = derived.url; save();
    btn.disabled = true; btn.textContent = "Testing…";
    api("runMigrationStep", [{ phase: "test", helperUrl: draft.helperUrl, helperKey: draft.accessKey, targetConn: conn, targetUrl: derived.url }])
      .then(function (r) {
        if (!r.ok) throw new Error(r.error || "Target test failed.");
        draft.source = r.source || draft.source;
        draft.targetEmpty = !!r.targetEmpty;
        save(); render();
      })
      .catch(function (e) { renderTarget("Target test failed: " + e.message); });
  }

  /* ---------- Step 2: Review + entitlement gate ---------- */
  function loadAccess() { if (!accessToken) { access = { access: "none" }; return Promise.resolve(); } return api("migrationAccess").then(function (a) { access = a; render(); }).catch(function () { access = { access: "none" }; render(); }); }
  function renderReview(err) {
    var s = draft.source || {};
    var stats = '<div class="mig-stats">' +
      stat(num(s.tables), "tables") + stat(num(s.users), "users") + stat(num(s.buckets), "buckets") + stat(num(s.objects), "storage files") + '</div>';
    var gate;
    if (!accessToken) {
      gate = '<div class="mig-note">Sign in to check your access.</div><button class="btn btn-primary" id="rvSignin">Sign in with GitHub</button>';
    } else if (!access) {
      gate = '<div class="mig-note">Checking your access…</div>';
    } else if (access.access === "max") {
      gate = note("ok", "✓ Included with your <b>Max</b> plan — no credit used.") + '<button class="btn btn-primary" id="rvStart">Start migration →</button>';
    } else if (access.access === "credit") {
      gate = note("ok", "✓ You have <b>" + num(access.credits_available) + "</b> single-migration credit" + (access.credits_available === 1 ? "" : "s") + ". One will be used when you start.") + '<button class="btn btn-primary" id="rvStart">Use 1 credit &amp; start →</button>';
    } else {
      gate = paywall();
    }
    var body = '<div class="mig-sheet">' +
      '<div class="eyebrow-sm">Step 3 of 5</div><h2>Review &amp; start</h2>' +
      '<p class="lead">Here’s exactly what will move from Lovable into your Supabase project.</p>' +
      (err ? note("err", esc(err)) : "") + stats +
      (draft.targetEmpty === false ? note("warn", "Target isn’t empty — existing data is kept; only missing rows and tables are added.") : "") +
      note("ok", "Copies your <b>database schema &amp; rows</b>, <b>auth users with password hashes</b>, <b>storage files &amp; buckets</b>, and row-level-security policies. Edge functions and auth-provider settings come with a checklist afterward.") +
      '<div style="margin-top:22px">' + gate + '</div>' +
      '<div class="mig-actions"><button class="btn btn-ghost" id="rvBack">← Back</button><span class="spacer"></span></div></div>';
    root.innerHTML = head() + progress(2) + body;
    document.getElementById("rvBack").onclick = function () { draft.step = 1; save(); render(); };
    var si = document.getElementById("rvSignin"); if (si) si.onclick = function () { signIn("review"); };
    var st = document.getElementById("rvStart"); if (st) st.onclick = startMigration;
    var bm = document.getElementById("rvBuyMax"); if (bm) bm.onclick = function () { checkout("max"); };
    var bo = document.getElementById("rvBuyOne"); if (bo) bo.onclick = function () { checkout("migration"); };
  }
  function stat(v, l) { return '<div class="mig-stat"><b>' + v + "</b><span>" + esc(l) + "</span></div>"; }
  function paywall() {
    return '<div class="mig-paywall"><p class="sub" style="text-align:center">Migration is included with Max, or buy a single migration.</p>' +
      '<div class="price-row">' +
        '<div class="mig-pay-card card"><h3>Max</h3><div class="amt">$79 <span style="font-size:14px;color:var(--muted)">CAD/mo</span></div><ul><li>Unlimited migrations</li><li>Up to 10 native apps</li><li>Everything in Pro</li></ul><button class="btn btn-primary" id="rvBuyMax" style="width:100%">Get Max</button></div>' +
        '<div class="mig-pay-card card"><h3>Single migration</h3><div class="amt" id="oneAmt">One-time</div><ul><li>One full migration run</li><li>Database + users + storage</li><li>No subscription</li></ul><button class="btn btn-glass" id="rvBuyOne" style="width:100%">Buy one migration</button></div>' +
      '</div><p style="color:var(--muted);font-size:12.5px">You stay in control · No raw secrets stored · Safe, resumable transfer</p></div>';
  }

  /* ---------- Step 3: Run ---------- */
  var RUN_PHASES = [
    { id: "schema", label: "Database schema", hint: "Creating tables, types and indexes" },
    { id: "data", label: "Table data", hint: "Copying rows" },
    { id: "auth", label: "Auth users", hint: "Copying accounts with password hashes" },
    { id: "storage", label: "Storage files", hint: "Copying buckets and objects" },
    { id: "finalize", label: "Keys, indexes & policies", hint: "Foreign keys, RLS and sequences" }
  ];
  function freshRunState() {
    return {
      phase: 0,
      phases: RUN_PHASES.map(function (p) { return { id: p.id, label: p.label, hint: p.hint, status: "wait", detail: "" }; }),
      tableNames: [],
      cursors: { data: { i: 0, offset: 0 }, auth: { offset: 0 }, storage: { i: 0 } },
      totals: { data: 0, auth: 0, storage: 0 },
      warnings: [],
      pct: 0,
      error: null,
      running: false
    };
  }
  function startMigration() {
    if (!creds.targetConn || (needsStorageKey() && !creds.targetKey)) { draft.step = 1; save(); renderTarget("Re-enter your target connection string" + (needsStorageKey() ? " and secret key" : "") + " to start (not saved, for security)."); return; }
    var btn = document.getElementById("rvStart"); if (btn) { btn.disabled = true; btn.textContent = "Preparing…"; }
    api("createMigrationProject", [{ name: "Lovable → Supabase", source: "lovable", target: "supabase" }])
      .then(function (created) {
        var id = Array.isArray(created) ? (created[0] && created[0].id) : created.id;
        if (!id) throw new Error("Could not create the migration project.");
        draft.projectId = id; draft.step = 3; save();
        runState = freshRunState();
        render();
        runEngine();
      })
      .catch(function (e) {
        var extra = /PAYMENT_REQUIRED/.test(e.message) ? " No credit was used." : "";
        renderReview((/(PAYMENT_REQUIRED|402)/.test(e.message) ? "Migration access required — buy Max or a single migration." : e.message) + extra);
      });
  }

  function step4Payload(extra) {
    return Object.assign({ projectId: draft.projectId, helperUrl: draft.helperUrl, helperKey: draft.accessKey, targetConn: creds.targetConn, targetKey: creds.targetKey, targetUrl: draft.targetUrl }, extra || {});
  }
  function setPhase(i, status, detail) { runState.phases[i].status = status; if (detail != null) runState.phases[i].detail = detail; runState.pct = Math.round(((i + (status === "done" ? 1 : 0.5)) / RUN_PHASES.length) * 100); renderRun(); }
  function addWarns(w) { if (w && w.length) runState.warnings = runState.warnings.concat(w).slice(0, 200); }

  function runEngine() {
    if (runState.running) return;
    runState.running = true;
    runState.error = null;
    runState.cursors = runState.cursors || { data: { i: 0, offset: 0 }, auth: { offset: 0 }, storage: { i: 0 } };
    runState.totals = runState.totals || { data: 0, auth: 0, storage: 0 };
    function fail(i, msg) { runState.phases[i].status = "err"; runState.error = msg; renderRun(); }
    function done(i) { return runState.phases[i] && runState.phases[i].status === "done"; }

    function doSchema() {
      if (done(0)) return Promise.resolve();
      setPhase(0, "active", "Reading and applying schema…");
      return api("runMigrationStep", [step4Payload({ phase: "schema" })]).then(function (r) {
        if (r.error) throw new Error(r.error);
        runState.tableNames = r.tableNames || []; addWarns(r.warnings);
        setPhase(0, "done", num(r.applied || 0) + " objects created" + (runState.tableNames.length ? " · " + num(runState.tableNames.length) + " tables" : ""));
      });
    }
    function doData() {
      if (done(1)) return Promise.resolve();
      setPhase(1, "active", "Copying rows…");
      var tableNames = runState.tableNames || [];
      var cursor = runState.cursors.data || { i: 0, offset: 0 };
      var total = runState.totals.data || 0;
      function loop() {
        return api("runMigrationStep", [step4Payload({ phase: "data", tables: tableNames, cursor: cursor })]).then(function (r) {
          if (r.error) throw new Error(r.error);
          addWarns(r.warnings); total += (r.inserted || 0); runState.totals.data = total;
          if (r.cursor) { cursor = r.cursor; runState.cursors.data = cursor; }
          if (r.done) { setPhase(1, "done", num(total) + " rows copied"); return; }
          runState.phases[1].detail = "Copying rows… " + num(total) + " so far" + (r.table ? " (" + esc(r.table) + ")" : ""); renderRun();
          return loop();
        });
      }
      return tableNames.length ? loop() : (setPhase(1, "done", "No tables"), Promise.resolve());
    }
    function doAuth() {
      if (done(2)) return Promise.resolve();
      setPhase(2, "active", "Copying user accounts…");
      var cursor = runState.cursors.auth || { offset: 0 };
      var total = runState.totals.auth || 0;
      function loop() {
        return api("runMigrationStep", [step4Payload({ phase: "auth", cursor: cursor })]).then(function (r) {
          if (r.error) throw new Error(r.error);
          addWarns(r.warnings); total += (r.inserted || 0); runState.totals.auth = total;
          if (r.cursor) { cursor = r.cursor; runState.cursors.auth = cursor; }
          if (r.done) { setPhase(2, "done", num(total) + " users copied (passwords intact)"); return; }
          runState.phases[2].detail = num(total) + " users so far…"; renderRun();
          return loop();
        });
      }
      return loop();
    }
    function doStorage() {
      if (done(3)) return Promise.resolve();
      setPhase(3, "active", "Copying storage files…");
      var cursor = runState.cursors.storage || { i: 0 };
      var uploaded = runState.totals.storage || 0;
      function loop() {
        return api("runMigrationStep", [step4Payload({ phase: "storage", cursor: cursor })]).then(function (r) {
          if (r.error) throw new Error(r.error);
          addWarns(r.warnings); uploaded += (r.uploaded || 0); runState.totals.storage = uploaded;
          if (r.cursor) { cursor = r.cursor; runState.cursors.storage = cursor; }
          if (r.done) { setPhase(3, "done", num(uploaded) + " files copied"); return; }
          runState.phases[3].detail = "Copied " + num(r.processed || 0) + " / " + num(r.total || 0) + " files…"; renderRun();
          return loop();
        });
      }
      return loop();
    }
    function doFinalize() {
      if (done(4)) return Promise.resolve();
      setPhase(4, "active", "Applying keys, indexes and policies…");
      return api("runMigrationStep", [step4Payload({ phase: "finalize" })]).then(function (r) {
        if (r.error) throw new Error(r.error);
        addWarns(r.warnings); setPhase(4, "done", num(r.applied || 0) + " constraints/policies applied");
      });
    }

    doSchema().then(doData).then(doAuth).then(doStorage).then(doFinalize)
      .then(function () {
        runState.running = false;
        runState.pct = 100; renderRun();
        return api("updateMigrationStatus", [draft.projectId, "test"])
          .then(function () { return api("updateMigrationStatus", [draft.projectId, "done"]); })
          .catch(function () {});
      })
      .then(function () { draft.step = 4; forgetCompletedMigrationInfo(); render(); })
      .catch(function (e) { runState.running = false; fail(runState.phase, e.message); });
  }

  function renderRun() {
    if (root.dataset.rendered !== "run") { root.innerHTML = head("Sit back — this runs automatically and resumes safely if a step retries.") + progress(3) + '<div class="mig-sheet" id="runPanel"></div>'; root.dataset.rendered = "run"; }
    var active = -1; runState.phases.forEach(function (p, i) { if (p.status === "active" || p.status === "err") active = i; });
    runState.phase = active < 0 ? runState.phases.length : active;
    var done = runState.pct >= 100;
    var panel = document.getElementById("runPanel");
    panel.innerHTML = '<div class="mig-run-head"><div class="mig-run-pct">' + runState.pct + '%</div><div class="mig-run-sub">' + (done ? "Wrapping up…" : runState.error ? "Paused" : "Migrating your app — keep this tab open") + '</div></div>' +
      '<div class="mig-bar"><i style="width:' + runState.pct + '%"></i></div>' +
      runState.phases.map(function (p) {
        var ic = p.status === "done" ? "✓" : p.status === "err" ? "!" : p.status === "active" ? "" : "";
        return '<div class="mig-phase ' + p.status + '"><div class="ic">' + ic + '</div><div class="txt"><b>' + esc(p.label) + '</b><span>' + esc(p.detail || p.hint) + '</span></div></div>';
      }).join("") +
      (runState.warnings.length ? '<details class="mig-warns"><summary>' + num(runState.warnings.length) + ' notes / skipped items</summary><ul>' + runState.warnings.slice(0, 60).map(function (w) { return "<li>" + esc(w) + "</li>"; }).join("") + "</ul></details>" : "") +
      (runState.error ? note("err", "<b>Paused:</b> " + esc(runState.error)) + '<div class="mig-actions"><button class="btn btn-ghost" id="runBack">← Back</button><span class="spacer"></span><button class="btn btn-primary" id="runRetry">Retry this step</button></div>' : "");
    var rb = document.getElementById("runBack"); if (rb) rb.onclick = function () { draft.step = 2; runState = null; root.dataset.rendered = ""; save(); render(); };
    var rr = document.getElementById("runRetry"); if (rr) rr.onclick = function () { runState.error = null; renderRun(); runEngine(); };
  }

  /* ---------- Step 4: Done ---------- */
  function renderDone() {
    root.dataset.rendered = "";
    var doneData = completedMigration || { projectId: draft.projectId, source: draft.source || { tables: 0, users: 0, buckets: 0, objects: 0 } };
    var doneSource = doneData.source || {};
    var cleanup = [
      ["Remove the migrate-helper function", "In Lovable: <code class=\"inline\">Remove the edge function \"migrate-helper\".</code> It was only for the export."],
      ["Delete the temporary secret key", "In Supabase → Settings → API Keys, delete the secret key you pasted here."],
      ["Reset your database password (optional)", "In Supabase → Database settings, rotate the postgres password used in the connection string."]
    ];
    var next = [
      ["Redeploy your edge functions", "The transfer moves data, not deployed function code. Bring your <code class=\"inline\">supabase/functions</code> source over and run <code class=\"inline\">supabase functions deploy</code>, then re-add their secrets."],
      ["Reconfigure auth providers", "Re-enable Google/Apple/GitHub sign-in and set Site URL + redirect URLs on the new project so logins keep working."],
      ["Point your app at the new project", "Update your Supabase URL + publishable (anon) key in your app, then run login, storage, and payment tests before switching for real."]
    ];
    var body = '<div class="mig-sheet" style="text-align:center">' +
      '<div style="font-size:44px;line-height:1">🎉</div>' +
      '<h2 style="margin-top:8px">Migration complete</h2>' +
      '<p class="lead" style="max-width:520px;margin-inline:auto">Your database, users, and storage are now in your own Supabase project. A few quick steps finish the move — you control the final switch.</p>' +
      note("ok", "Copied <b>" + num(doneSource.tables) + "</b> tables · <b>" + num(doneSource.users) + "</b> users · <b>" + num(doneSource.objects) + "</b> storage files. Temporary helper details and target credentials have been cleared from this browser.") +
      '<h3 style="margin:24px 0 12px;font-size:15px;text-align:left">Clean up the temporary access</h3>' +
        cleanup.map(function (c, i) { return checkItem("cln" + i, c[0], c[1]); }).join("") +
      '<h3 style="margin:24px 0 12px;font-size:15px;text-align:left">Finish the switch</h3>' +
        next.map(function (c, i) { return checkItem("nxt" + i, c[0], c[1]); }).join("") +
      '<div class="mig-actions"><a class="btn btn-ghost" href="/migration/">Done</a><span class="spacer"></span><a class="btn btn-primary" href="/app/">Build a native app →</a></div></div>';
    root.innerHTML = head() + progress(4) + body;
    root.querySelectorAll(".mig-check-item input").forEach(function (b) {
      var key = "nz_mig_done_" + doneData.projectId + "_" + b.id;
      b.checked = localStorage.getItem(key) === "1";
      b.onchange = function () { try { localStorage.setItem(key, b.checked ? "1" : "0"); } catch (_e) {} };
    });
  }
  function checkItem(id, title, body) { return '<label class="mig-check-item" style="text-align:left"><input type="checkbox" id="' + id + '"><span><b>' + esc(title) + "</b><p>" + body + "</p></span></label>"; }

  /* ---------- Project view (/migration/:id) ---------- */
  function initProject() {
    if (!accessToken) { root.innerHTML = head() + '<div class="mig-sheet"><h2>Your migrations</h2><p class="lead">Sign in to see your private migration projects.</p><button class="btn btn-primary" id="pSignin">Sign in with GitHub</button></div>'; document.getElementById("pSignin").onclick = function () { signIn(); }; return; }
    var m = location.pathname.match(/^\/migration\/([0-9a-f-]{36})/i);
    if (!m) { return api("listMigrationProjects").then(function (list) {
      root.innerHTML = head() + '<div class="mig-sheet"><h2>Your migrations</h2><div class="mig-actions" style="margin:0 0 18px"><span class="spacer"></span><a class="btn btn-primary" href="/migration/new/">New migration</a></div>' +
        (list && list.length ? list.map(function (p) { return '<a class="mig-check-item" style="text-decoration:none;color:inherit;text-align:left" href="/migration/' + esc(p.id) + '"><span><b>' + esc(p.name) + '</b><p>' + esc(p.source_provider) + " → " + esc(p.target_provider) + " · " + esc(p.status) + "</p></span></a>"; }).join("") : '<div class="mig-note">No migrations yet. <a href="/migration/new/" style="color:#c4b5fd">Start one →</a></div>') + "</div>";
    }).catch(function (e) { root.innerHTML = head() + note("err", esc(e.message)); }); }
    api("getMigrationProject", [m[1]]).then(function (data) {
      if (!data.project) throw new Error("Project not found for your account.");
      var p = data.project;
      root.innerHTML = head() + '<div class="mig-sheet"><h2>' + esc(p.name) + '</h2><p class="lead">' + esc(p.source_provider) + " → " + esc(p.target_provider) + " · status: " + esc(p.status) + '</p>' +
        note(p.status === "done" || p.status === "test" ? "ok" : "", "Created " + esc(new Date(p.created_at).toLocaleString())) +
        '<div class="mig-actions"><a class="btn btn-ghost" href="/migration/">All migrations</a><span class="spacer"></span><a class="btn btn-primary" href="/migration/new/">New migration</a></div></div>';
    }).catch(function (e) { root.innerHTML = head() + note("err", esc(e.message)); });
  }

  /* ---------- router ---------- */
  function render(err) {
    root.dataset.rendered = "";
    if (draft.step === 0) return renderConnect(err);
    if (draft.step === 1) return renderTarget(err);
    if (draft.step === 2) return renderReview(err);
    if (draft.step === 3) { if (!runState) { draft.step = 2; return renderReview(); } return renderRun(); }
    if (draft.step === 4) return renderDone();
    draft.step = 0; return renderConnect(err);
  }

  function launchAuthenticatedApp() {
    var pending = sessionStorage.getItem(K.pending); sessionStorage.removeItem(K.pending);
    if (pending && pending.indexOf("checkout:") === 0) { checkout(pending.split(":")[1]); return; }
    if (root.dataset.view === "project") return initProject();
    var cs = new URLSearchParams(location.search).get("checkout");
    if (cs === "success" && draft.step < 2) draft.step = 2;
    if (draft.step === 3 && !runState) draft.step = 2; // don't resume a run without in-memory creds
    if (draft.step === 2) loadAccess();
    render(cs === "success" ? null : cs === "cancelled" ? "Checkout cancelled — your progress is saved." : null);
  }

  handleAuth().then(function () {
    if (!accessToken && refreshToken) return renew();
  }).then(function () {
    if (!accessToken) { renderSignIn(); return; }
    // This authenticated RPC binds all migration access to auth.uid(): the
    // same Supabase user ID used by Stripe for Max and one-time purchases.
    return api("migrationAccess").then(function (a) { access = a; launchAuthenticatedApp(); });
  }).catch(function (e) { renderSignIn(e && e.message ? e.message : "Could not verify your GitHub session. Please sign in again."); });
})();
