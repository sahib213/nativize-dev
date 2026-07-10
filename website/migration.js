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

  var accessToken = sessionStorage.getItem(SESSION.access) || "";
  var refreshToken = sessionStorage.getItem(SESSION.refresh) || "";

  // Non-secret wizard draft is persisted so a refresh keeps your place.
  var draft = load(K.draft, null) || { step: 0, accessKey: Helper.randomKey(), helperUrl: "", targetUrl: "", source: { tables: 0, users: 0, buckets: 0, objects: 0 }, targetEmpty: null, projectId: "" };
  // Secrets are kept in memory ONLY (never persisted).
  var creds = { targetConn: "", targetKey: "" };
  var access = null;         // { access:'max'|'credit'|'none', credits_available }
  var runState = null;       // live run progress
  var busy = false;

  function esc(v) { return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function load(key, fb) { try { return JSON.parse(sessionStorage.getItem(key)) || fb; } catch (_e) { return fb; } }
  function save() { try { sessionStorage.setItem(K.draft, JSON.stringify(draft)); } catch (_e) {} }
  function toast(msg) { var o = document.querySelector(".mig-toast"); if (o) o.remove(); var e = document.createElement("div"); e.className = "mig-toast"; e.textContent = msg; document.body.appendChild(e); setTimeout(function () { e.remove(); }, 2400); }
  function num(n) { return Number(n || 0).toLocaleString("en-US"); }

  /* ---------- auth ---------- */
  function saveTokens(t) { accessToken = t.accessToken || ""; refreshToken = t.refreshToken || refreshToken; if (accessToken) sessionStorage.setItem(SESSION.access, accessToken); if (refreshToken) sessionStorage.setItem(SESSION.refresh, refreshToken); }
  function renew() { return Billing.refreshSession(refreshToken).then(function (t) { saveTokens(t); return t; }); }
  function api(method, args) { args = args || []; return Billing[method].apply(Billing, [accessToken].concat(args)).catch(function (err) { if (!refreshToken || !err || (err.status !== 401 && err.status !== 403)) throw err; return renew().then(function () { return Billing[method].apply(Billing, [accessToken].concat(args)); }); }); }
  function signIn(pending) { if (pending) sessionStorage.setItem(K.pending, pending); return Billing.createPkce().then(function (p) { sessionStorage.setItem(K.verifier, p.codeVerifier); location.href = Billing.authorizeUrl(location.href.split("#")[0], { codeChallenge: p.codeChallenge, codeChallengeMethod: p.codeChallengeMethod }); }); }
  function clearAuthParams() { var u = new URL(location.href); var ch = !!u.hash; u.hash = ""; ["code", "access_token", "refresh_token", "provider_token", "expires_at", "expires_in", "token_type", "state", "error", "error_description"].forEach(function (k) { if (u.searchParams.has(k)) { u.searchParams.delete(k); ch = true; } }); if (ch) history.replaceState(null, "", u.pathname + (u.search || "")); }
  function handleAuth() { var t = Billing.parseAuthTokens(location.href); if (t.error) { clearAuthParams(); return Promise.reject(new Error(t.error)); } if (!t.code) return Promise.resolve(); var v = sessionStorage.getItem(K.verifier) || ""; if (!v) { clearAuthParams(); return Promise.reject(new Error("Sign-in check failed. Start again.")); } return Billing.exchangeCodeForSession(t.code, v).then(function (s) { sessionStorage.removeItem(K.verifier); if (!s.accessToken) throw new Error("Sign-in did not return a session."); saveTokens(s); clearAuthParams(); }); }
  function currentUrl(params) { var u = new URL(location.href); u.hash = ""; u.search = ""; Object.keys(params || {}).forEach(function (k) { u.searchParams.set(k, params[k]); }); return u.toString(); }
  function checkout(planId) { if (!accessToken) return signIn("checkout:" + planId); busy = true; render(); return api("checkout", [planId, { successUrl: currentUrl({ checkout: "success" }), cancelUrl: currentUrl({ checkout: "cancelled" }) }]).then(function (r) { location.href = r.url; }).catch(function (e) { busy = false; render(e.message); }); }

  /* ---------- shared chrome ---------- */
  var STEPS = ["Connect", "Supabase", "Review", "Migrate", "Done"];
  function head() {
    return '<div class="mig-head">' +
      '<span class="eyebrow">App migration · included with Max</span>' +
      '<h1>Move your app to <span class="grad-text">your own Supabase</span></h1>' +
      '<p>Connect your Lovable project and a fresh Supabase project. Nativize copies your database, users (passwords intact), and storage — no CSV exports, no manual table-by-table work.</p>' +
      '<div class="mig-trust"><span>🔒 No raw secrets stored</span><span>🧭 You stay in control</span><span>↩︎ Non-destructive to your source</span><span>🗝️ Passwords kept intact</span></div></div>';
  }
  function progress(active) {
    return '<div class="mig-progress">' + STEPS.map(function (s, i) {
      var cls = i < active ? "done" : i === active ? "active" : "";
      return '<div class="step ' + cls + '"><div class="dot">' + (i < active ? "✓" : (i + 1)) + '</div><b>' + esc(s) + '</b></div>';
    }).join("") + "</div>";
  }
  function note(cls, html) { return '<div class="mig-note ' + cls + '">' + html + "</div>"; }

  /* ---------- Step 0: Connect Lovable ---------- */
  function renderConnect(err) {
    var code = Helper.helperCode(draft.accessKey);
    var pinged = draft.source && (draft.source.tables || draft.source.users || draft.source.buckets);
    var body = '<div class="mig-panel card"><h2>1 · Connect your Lovable project</h2>' +
      '<p class="sub">Lovable Cloud can\'t be connected directly, so you\'ll add a tiny, temporary, <b>read-only</b> helper. You remove it when you\'re done.</p>' +
      (err ? note("err", esc(err)) : "") +
      '<div class="mig-steps">' +
        step("1", "Create an edge function in Lovable", 'Tell Lovable: <code class="inline">Create an empty edge function called migrate-helper</code>, then refresh so it appears.') +
        step("2", "Paste this helper code", 'Open <b>Cloud → Edge Functions → migrate-helper → View code</b>, replace everything with the code below, and Save. It\'s locked to your one-time access key and can only read.' +
          '<div class="mig-code"><button class="btn btn-glass copy" data-copy-code>Copy code</button><pre id="mhCode">' + esc(code) + '</pre></div>') +
        step("3", "Deploy it", 'Tell Lovable: <code class="inline">Deploy the migrate-helper edge function with verify_jwt = false in supabase/config.toml.</code>') +
        step("4", "Paste the function URL", 'Get it from <b>Cloud → Edge Functions → migrate-helper → Copy URL</b>.' +
          '<div class="mig-field"><input type="url" id="mhUrl" placeholder="https://YOUR-REF.functions.supabase.co/migrate-helper" value="' + esc(draft.helperUrl) + '"></div>') +
      '</div>' +
      (pinged ? note("ok", "✓ Connected to Lovable — found <b>" + num(draft.source.tables) + "</b> tables, <b>" + num(draft.source.users) + "</b> users, <b>" + num(draft.source.objects) + "</b> storage files.") : "") +
      '<div class="mig-actions"><a class="btn btn-ghost" href="/migration/">Cancel</a><span class="spacer"></span>' +
        '<button class="btn btn-glass" id="mhTest">Test connection</button>' +
        '<button class="btn btn-primary" id="mhNext" ' + (pinged ? "" : "disabled") + '>Next: Supabase →</button></div></div>';
    root.innerHTML = head() + progress(0) + body;
    document.querySelector("[data-copy-code]").onclick = function () { navigator.clipboard.writeText(code).then(function () { toast("Helper code copied"); }); };
    document.getElementById("mhUrl").oninput = function () { draft.helperUrl = this.value.trim(); save(); };
    document.getElementById("mhTest").onclick = testLovable;
    document.getElementById("mhNext").onclick = function () { if (draft.helperUrl) { draft.step = 1; save(); render(); } };
  }
  function step(n, title, body) { return '<div class="mig-step"><div class="n">' + n + '</div><div class="body"><h4>' + esc(title) + "</h4><p>" + body + "</p></div></div>"; }

  // Ping the helper directly from the browser (it is CORS-enabled + key-gated).
  function testLovable() {
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
    var body = '<div class="mig-panel card"><h2>2 · Connect your target Supabase</h2>' +
      '<p class="sub">Create a brand-new, empty Supabase project, click <b>Connect</b> at the top of its dashboard, and paste the connection string below. That\'s it — we read the project details from it automatically.</p>' +
      (err ? note("err", esc(err)) : "") +
      '<div class="mig-field"><label>Database connection string <span class="hint">Supabase dashboard → Connect → Direct connection (or Session pooler)</span></label>' +
        '<textarea id="tgConn" placeholder="postgresql://postgres:[YOUR-PASSWORD]@db.YOUR-REF.supabase.co:5432/postgres">' + esc(creds.targetConn) + '</textarea>' +
        (derived ? '<div class="mig-note ok" style="margin:8px 0 0">✓ Project detected: <b>' + esc(derived.ref) + '</b> — we\'ll fill in the rest.</div>' : '') + '</div>' +
      keyField +
      note("warn", "🔐 Your credentials stay in this browser tab and go directly to your own projects. Nativize never stores them." + (needsStorageKey() ? " Delete the temporary secret key when you\'re done." : "")) +
      '<label class="mig-check"><input type="checkbox" id="tgBlank"' + (draft.targetEmpty !== null ? " checked" : "") + '><span>I confirm this is a <b>fresh / empty</b> Supabase project.</span></label>' +
      (draft.targetEmpty === false ? note("warn", "⚠ The target already has tables in <code class=\"inline\">public</code>. You can continue, but existing rows/tables won\'t be overwritten (insert-if-absent).") : "") +
      (draft.targetEmpty === true ? note("ok", "✓ Target reachable and empty — ready to migrate.") : "") +
      '<div class="mig-actions"><button class="btn btn-ghost" id="tgBack">← Back</button><span class="spacer"></span>' +
        '<button class="btn btn-glass" id="tgTest">Test connection</button>' +
        '<button class="btn btn-primary" id="tgNext" ' + (draft.targetEmpty === null ? "disabled" : "") + '>Review migration →</button></div></div>';
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
    var body = '<div class="mig-panel card"><h2>3 · Review &amp; start</h2>' +
      '<p class="sub">Here\'s what will move from Lovable into your Supabase project.</p>' +
      (err ? note("err", esc(err)) : "") + stats +
      (draft.targetEmpty === false ? note("warn", "Target isn\'t empty — existing data is kept; only missing rows/tables are added.") : "") +
      note("ok", "Migrates: <b>database schema + rows</b>, <b>auth users with password hashes</b>, <b>storage files &amp; buckets</b>, plus row-level-security policies. Edge functions and auth-provider settings are covered by the checklist afterward.") +
      '<div style="margin-top:20px">' + gate + '</div>' +
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
  function startMigration() {
    if (!creds.targetConn || (needsStorageKey() && !creds.targetKey)) { draft.step = 1; save(); renderTarget("Re-enter your target connection string" + (needsStorageKey() ? " and secret key" : "") + " to start (not saved, for security)."); return; }
    var btn = document.getElementById("rvStart"); if (btn) { btn.disabled = true; btn.textContent = "Preparing…"; }
    api("createMigrationProject", [{ name: "Lovable → Supabase", source: "lovable", target: "supabase" }])
      .then(function (created) {
        var id = Array.isArray(created) ? (created[0] && created[0].id) : created.id;
        if (!id) throw new Error("Could not create the migration project.");
        draft.projectId = id; draft.step = 3; save();
        runState = { phase: 0, phases: RUN_PHASES.map(function (p) { return { id: p.id, label: p.label, hint: p.hint, status: "wait", detail: "" }; }), warnings: [], pct: 0, error: null };
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
    var tableNames = [];
    function fail(i, msg) { runState.phases[i].status = "err"; runState.error = msg; renderRun(); }

    function doSchema() {
      setPhase(0, "active", "Reading and applying schema…");
      return api("runMigrationStep", [step4Payload({ phase: "schema" })]).then(function (r) {
        if (r.error) throw new Error(r.error);
        tableNames = r.tableNames || []; addWarns(r.warnings);
        setPhase(0, "done", num(r.applied || 0) + " objects created" + (tableNames.length ? " · " + num(tableNames.length) + " tables" : ""));
      });
    }
    function doData() {
      setPhase(1, "active", "Copying rows…");
      var cursor = { i: 0, offset: 0 }, total = 0;
      function loop() {
        return api("runMigrationStep", [step4Payload({ phase: "data", tables: tableNames, cursor: cursor })]).then(function (r) {
          if (r.error) throw new Error(r.error);
          addWarns(r.warnings); total += (r.inserted || 0);
          if (r.done) { setPhase(1, "done", num(total) + " rows copied"); return; }
          cursor = r.cursor || cursor;
          runState.phases[1].detail = "Copying rows… " + num(total) + " so far" + (r.table ? " (" + esc(r.table) + ")" : ""); renderRun();
          return loop();
        });
      }
      return tableNames.length ? loop() : (setPhase(1, "done", "No tables"), Promise.resolve());
    }
    function doAuth() {
      setPhase(2, "active", "Copying user accounts…");
      var cursor = { offset: 0 }, total = 0;
      function loop() {
        return api("runMigrationStep", [step4Payload({ phase: "auth", cursor: cursor })]).then(function (r) {
          if (r.error) throw new Error(r.error);
          addWarns(r.warnings); total += (r.inserted || 0);
          if (r.done) { setPhase(2, "done", num(total) + " users copied (passwords intact)"); return; }
          cursor = r.cursor || cursor; runState.phases[2].detail = num(total) + " users so far…"; renderRun();
          return loop();
        });
      }
      return loop();
    }
    function doStorage() {
      setPhase(3, "active", "Copying storage files…");
      var cursor = { i: 0 }, uploaded = 0;
      function loop() {
        return api("runMigrationStep", [step4Payload({ phase: "storage", cursor: cursor })]).then(function (r) {
          if (r.error) throw new Error(r.error);
          addWarns(r.warnings); uploaded += (r.uploaded || 0);
          if (r.done) { setPhase(3, "done", num(uploaded) + " files copied"); return; }
          cursor = r.cursor || cursor; runState.phases[3].detail = "Copied " + num(r.processed || 0) + " / " + num(r.total || 0) + " files…"; renderRun();
          return loop();
        });
      }
      return loop();
    }
    function doFinalize() {
      setPhase(4, "active", "Applying keys, indexes and policies…");
      return api("runMigrationStep", [step4Payload({ phase: "finalize" })]).then(function (r) {
        if (r.error) throw new Error(r.error);
        addWarns(r.warnings); setPhase(4, "done", num(r.applied || 0) + " constraints/policies applied");
      });
    }

    doSchema().then(doData).then(doAuth).then(doStorage).then(doFinalize)
      .then(function () {
        runState.pct = 100; renderRun();
        return api("updateMigrationStatus", [draft.projectId, "test"]).catch(function () {});
      })
      .then(function () { draft.step = 4; save(); render(); })
      .catch(function (e) { fail(runState.phase, e.message); });
  }

  function renderRun() {
    if (root.dataset.rendered !== "run") { root.innerHTML = head() + progress(3) + '<div class="mig-panel card" id="runPanel"></div>'; root.dataset.rendered = "run"; }
    var active = -1; runState.phases.forEach(function (p, i) { if (p.status === "active" || p.status === "err") active = i; });
    runState.phase = active < 0 ? runState.phases.length : active;
    var panel = document.getElementById("runPanel");
    panel.innerHTML = '<h2>4 · Migrating your app</h2><p class="sub">Keep this tab open. You can watch progress live — it resumes safely if a step retries.</p>' +
      '<div class="mig-run-bar"><i style="width:' + runState.pct + '%"></i></div>' +
      runState.phases.map(function (p) {
        var ic = p.status === "done" ? "✓" : p.status === "err" ? "!" : p.status === "active" ? "•" : "";
        return '<div class="mig-phase ' + p.status + '"><div class="ic">' + ic + '</div><div class="txt"><b>' + esc(p.label) + '</b><span>' + esc(p.detail || p.hint) + '</span></div></div>';
      }).join("") +
      (runState.warnings.length ? '<details class="mig-warns"><summary>' + num(runState.warnings.length) + ' notes / skipped items</summary><ul>' + runState.warnings.slice(0, 60).map(function (w) { return "<li>" + esc(w) + "</li>"; }).join("") + "</ul></details>" : "") +
      (runState.error ? note("err", "<b>Stopped:</b> " + esc(runState.error)) + '<div class="mig-actions"><button class="btn btn-ghost" id="runBack">← Back</button><span class="spacer"></span><button class="btn btn-primary" id="runRetry">Retry this step</button></div>' : "");
    var rb = document.getElementById("runBack"); if (rb) rb.onclick = function () { draft.step = 2; runState = null; root.dataset.rendered = ""; save(); render(); };
    var rr = document.getElementById("runRetry"); if (rr) rr.onclick = function () { runState.error = null; renderRun(); runEngine(); };
  }

  /* ---------- Step 4: Done ---------- */
  function renderDone() {
    root.dataset.rendered = "";
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
    var body = '<div class="mig-panel card"><h2>🎉 Migration complete</h2>' +
      '<p class="sub">Your database, users, and storage are now in your own Supabase project. A few manual steps finish the move — you stay in control of the final switch.</p>' +
      note("ok", "Copied: <b>" + num(draft.source.tables) + "</b> tables · <b>" + num(draft.source.users) + "</b> users · <b>" + num(draft.source.objects) + "</b> storage files.") +
      '<h3 style="margin:22px 0 10px;font-size:16px">Clean up the temporary access</h3><div class="mig-list">' +
        cleanup.map(function (c, i) { return checkItem("cln" + i, c[0], c[1]); }).join("") + "</div>" +
      '<h3 style="margin:22px 0 10px;font-size:16px">Finish the switch</h3><div class="mig-list">' +
        next.map(function (c, i) { return checkItem("nxt" + i, c[0], c[1]); }).join("") + "</div>" +
      '<div class="mig-actions"><a class="btn btn-ghost" href="/migration/">Done</a><span class="spacer"></span><a class="btn btn-primary" href="/app/">Now build a native app →</a></div></div>';
    root.innerHTML = head() + progress(4) + body;
    root.querySelectorAll(".mig-list-check input").forEach(function (b) {
      var key = "nz_mig_done_" + draft.projectId + "_" + b.id;
      b.checked = localStorage.getItem(key) === "1";
      b.onchange = function () { try { localStorage.setItem(key, b.checked ? "1" : "0"); } catch (_e) {} };
    });
  }
  function checkItem(id, title, body) { return '<label class="mig-list-check"><input type="checkbox" id="' + id + '"><span><b>' + esc(title) + "</b><p>" + body + "</p></span></label>"; }

  /* ---------- Project view (/migration/:id) ---------- */
  function initProject() {
    if (!accessToken) { root.innerHTML = head() + '<div class="mig-panel card"><h2>Your migrations</h2><p class="sub">Sign in to see your private migration projects.</p><button class="btn btn-primary" id="pSignin">Sign in with GitHub</button></div>'; document.getElementById("pSignin").onclick = function () { signIn(); }; return; }
    var m = location.pathname.match(/^\/migration\/([0-9a-f-]{36})/i);
    if (!m) { return api("listMigrationProjects").then(function (list) {
      root.innerHTML = head() + '<div class="mig-panel card"><h2>Your migrations</h2><div class="mig-actions" style="margin:0 0 16px"><span class="spacer"></span><a class="btn btn-primary" href="/migration/new/">New migration</a></div>' +
        (list && list.length ? '<div class="mig-list">' + list.map(function (p) { return '<a class="mig-list-check" style="text-decoration:none;color:inherit" href="/migration/' + esc(p.id) + '"><span><b>' + esc(p.name) + '</b><p>' + esc(p.source_provider) + " → " + esc(p.target_provider) + " · " + esc(p.status) + "</p></span></a>"; }).join("") + "</div>" : '<div class="mig-note">No migrations yet. <a href="/migration/new/" style="color:#c4b5fd">Start one →</a></div>') + "</div>";
    }).catch(function (e) { root.innerHTML = head() + note("err", esc(e.message)); }); }
    api("getMigrationProject", [m[1]]).then(function (data) {
      if (!data.project) throw new Error("Project not found for your account.");
      var p = data.project;
      root.innerHTML = head() + '<div class="mig-panel card"><h2>' + esc(p.name) + '</h2><p class="sub">' + esc(p.source_provider) + " → " + esc(p.target_provider) + " · status: " + esc(p.status) + '</p>' +
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

  handleAuth().then(function () {
    var pending = sessionStorage.getItem(K.pending); sessionStorage.removeItem(K.pending);
    if (pending && pending.indexOf("checkout:") === 0) { checkout(pending.split(":")[1]); return; }
    if (root.dataset.view === "project") return initProject();
    var cs = new URLSearchParams(location.search).get("checkout");
    if (cs === "success" && draft.step < 2) draft.step = 2;
    if (draft.step === 3 && !runState) draft.step = 2; // don't resume a run without in-memory creds
    if (draft.step === 2) loadAccess();
    render(cs === "success" ? null : cs === "cancelled" ? "Checkout cancelled — your progress is saved." : null);
  }).catch(function (e) {
    if (root.dataset.view === "project") return initProject();
    render(e.message);
  });
})();
