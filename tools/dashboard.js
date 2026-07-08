#!/usr/bin/env node
/* ============================================================================
   Nativize admin portal — runs on your machine, viewable across your WiFi.

   • Multi-page work portal: Overview, Support, Feature requests, Paid,
     Testers, Visitors, GitHub issues, Settings.
   • Reply to support messages by email (via your Resend setup), with a free,
     local, private AI ("Draft with AI") that writes a suggested reply using
     Ollama on this Mac — nothing sent to any paid API.
   • No login (by request). Bind to WiFi with DASHBOARD_HOST=0.0.0.0.

   Reads Supabase with your service_role key from ~/nativize/.env.local.
   Run:  npm run dashboard        Then open the printed URL.
   ============================================================================ */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");

const ROOT = path.join(__dirname, "..");
const SUPABASE_URL = process.env.SUPABASE_URL || "https://gaaxcbarmiwtojblkkyh.supabase.co";
const PORT = Number(process.env.DASHBOARD_PORT || 8787);
const HOST = process.env.DASHBOARD_HOST || "0.0.0.0"; // WiFi-visible by default (requested)

(function loadEnv() {
  const p = path.join(ROOT, ".env.local");
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
})();

const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const GITHUB_REPO = process.env.GITHUB_REPO || "sahib213/nativize-dev";
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const SUPPORT_FROM_EMAIL = process.env.SUPPORT_FROM_EMAIL || "";
const SUPPORT_REPLY_TO = process.env.SUPPORT_REPLY_TO_EMAIL || SUPPORT_FROM_EMAIL;
const OLLAMA_URL = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "llama3.2:3b";

if (!SERVICE_KEY) { console.error("\n  Missing SUPABASE_SERVICE_ROLE_KEY in ~/nativize/.env.local.\n"); process.exit(1); }

/* ---- Supabase REST (service role; this machine only) ---- */
async function sb(q) {
  const res = await fetch(SUPABASE_URL + "/rest/v1/" + q, {
    headers: { apikey: SERVICE_KEY, Authorization: "Bearer " + SERVICE_KEY, Accept: "application/json" }
  });
  if (!res.ok) throw new Error(q.split("?")[0] + " → " + res.status + " " + (await res.text()).slice(0, 160));
  return res.json();
}
async function safe(p, fb) { try { return await p; } catch (e) { return { __error: e.message, fallback: fb }; } }
async function githubIssues() {
  if (!GITHUB_TOKEN) return { __error: "No GITHUB_TOKEN set (optional).", fallback: [] };
  try {
    const res = await fetch("https://api.github.com/repos/" + GITHUB_REPO + "/issues?state=open&per_page=30",
      { headers: { Authorization: "Bearer " + GITHUB_TOKEN, Accept: "application/vnd.github+json", "User-Agent": "nativize-dashboard" } });
    if (!res.ok) throw new Error("GitHub " + res.status);
    return (await res.json()).filter((i) => !i.pull_request);
  } catch (e) { return { __error: e.message, fallback: [] }; }
}
async function sendReply(to, subject, text) {
  if (!RESEND_API_KEY || !SUPPORT_FROM_EMAIL) return { ok: false, error: "Email not configured. Add RESEND_API_KEY and SUPPORT_FROM_EMAIL to .env.local." };
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST", headers: { Authorization: "Bearer " + RESEND_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ from: SUPPORT_FROM_EMAIL, to: [to], reply_to: SUPPORT_REPLY_TO, subject, text })
    });
    if (!res.ok) return { ok: false, error: (await res.text()).slice(0, 300) };
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}
/* ---- Free local AI draft (Ollama) ---- */
const AI_SYSTEM = `You are the friendly customer-support agent for Nativize (nativize.dev), a tool that turns Lovable, Vite, React, and GitHub web apps into real native iOS, Android, Mac, and Windows apps. It generates a standard Capacitor 8 project into the user's own GitHub repo and builds installable apps with GitHub Actions (iOS builds run in the cloud, no Mac needed). Write a concise, warm, helpful reply to the customer's message that they can send as-is. Address their issue directly, give clear next steps, and ask for specifics only if truly needed. Do NOT invent refund or pricing policies, do not promise timelines you can't keep, and never ask for or include passwords, API keys, or payment secrets. Write only the email body (no subject line). Sign off as "— Sahib, Nativize".`;
async function aiDraft(message, email) {
  const prompt = `${AI_SYSTEM}\n\nCustomer email: ${email || "unknown"}\nCustomer message:\n"""${(message || "").slice(0, 4000)}"""\n\nReply:`;
  const res = await fetch(OLLAMA_URL + "/api/generate", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: OLLAMA_MODEL, prompt, stream: false, options: { temperature: 0.4 } })
  });
  if (!res.ok) throw new Error("Local AI error " + res.status + " — is Ollama running? (run `ollama serve`)");
  const j = await res.json();
  return (j.response || "").trim();
}

/* ---- helpers ---- */
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const num = (n) => (n == null ? "—" : Number(n).toLocaleString("en-US"));
const when = (s) => (s ? new Date(s).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");
const arr = (x) => (Array.isArray(x) ? x : (x && Array.isArray(x.fallback) ? x.fallback : []));
const shortId = (u) => (u ? String(u).slice(0, 8) + "…" : "—");
function readBody(req) { return new Promise((r) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => r(d)); }); }
const parseForm = (s) => { const o = {}; new URLSearchParams(s).forEach((v, k) => (o[k] = v)); return o; };

/* ---- layout ---- */
const NAV = [
  ["/", "Overview"], ["/support", "Support"], ["/features", "Feature requests"],
  ["/paid", "Paid customers"], ["/testers", "Testers"], ["/visitors", "Visitors"],
  ["/issues", "GitHub issues"], ["/settings", "Settings"]
];
function layout(active, title, body, opts) {
  opts = opts || {};
  const nav = NAV.map(([h, l]) => `<a class="nav-item${active === h ? " on" : ""}" href="${h}">${l}</a>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${esc(title)} · Nativize</title><style>
:root{--bg:#f6f7fb;--panel:#fff;--ink:#171a21;--muted:#697086;--line:#e7e9f0;--accent:linear-gradient(135deg,#7c3aed,#2563eb);--good:#0f9d58;--bad:#e5484d;--chip:#f0f1f7}
@media(prefers-color-scheme:dark){:root{--bg:#0b0c12;--panel:#14151d;--ink:#eceefb;--muted:#8b90a6;--line:#242636;--chip:#1c1e2a}}
*{box-sizing:border-box}html,body{margin:0}body{background:var(--bg);color:var(--ink);font:14.5px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Inter,sans-serif;display:flex;min-height:100vh}
a{color:inherit;text-decoration:none}
.side{width:214px;flex:none;background:var(--panel);border-right:1px solid var(--line);padding:18px 12px;position:sticky;top:0;height:100vh;display:flex;flex-direction:column;gap:3px}
.brand{display:flex;align-items:center;gap:10px;padding:6px 8px 16px;font-weight:700;font-size:16px}.brand .mk{width:26px;height:26px;border-radius:8px;background:var(--accent)}
.nav-item{padding:9px 12px;border-radius:10px;color:var(--muted);font-weight:500}.nav-item:hover{background:var(--chip);color:var(--ink)}.nav-item.on{background:var(--accent);color:#fff}
.main{flex:1;min-width:0;display:flex;flex-direction:column}
.top{display:flex;align-items:center;justify-content:space-between;padding:18px 30px;border-bottom:1px solid var(--line);background:var(--panel)}
.top h1{font-size:19px;margin:0}.top .sub{color:var(--muted);font-size:12.5px;margin-top:2px}
.btn{border:1px solid var(--line);background:var(--panel);color:var(--ink);padding:8px 14px;border-radius:9px;font-weight:600;cursor:pointer;font-size:13.5px}.btn:hover{background:var(--chip)}.btn.pri{background:var(--accent);color:#fff;border:0}.btn[disabled]{opacity:.5;cursor:default}
.wrap{padding:24px 30px;max-width:1080px;width:100%}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:13px}
.tile{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:15px 17px}.tile .v{font-size:25px;font-weight:700}.tile .l{color:var(--muted);font-size:12.5px;margin-top:3px}.tile .s{color:var(--good);font-size:12px;margin-top:4px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;margin-top:18px;overflow:hidden}
.card h2{font-size:12.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:15px 18px 6px}
table{width:100%;border-collapse:collapse;font-size:13.5px}th,td{text-align:left;padding:11px 18px;border-top:1px solid var(--line);vertical-align:top}thead th{border-top:0;color:var(--muted);font-weight:600;font-size:11.5px;text-transform:uppercase;letter-spacing:.04em}tbody tr:hover{background:var(--chip)}
.muted{color:var(--muted)}.empty{padding:24px 18px;color:var(--muted)}
.pill{display:inline-block;padding:2px 9px;border-radius:999px;font-size:12px;font-weight:600;background:#e7f6ee;color:#0f9d58}.pill.free{background:var(--chip);color:var(--muted)}.pill.hot{background:#fdeede;color:#b5641a}
.err{margin:10px 18px;color:var(--bad);font-size:13px}.msg{max-width:520px;color:var(--muted);white-space:pre-wrap}
.chart{display:flex;align-items:flex-end;gap:5px;height:170px;padding:18px;overflow-x:auto}.bar{display:flex;flex-direction:column;align-items:center;gap:6px;min-width:22px}.bar span{width:16px;border-radius:5px 5px 0 0;background:var(--accent)}.bar em{font-size:9px;color:var(--muted);font-style:normal;transform:rotate(-45deg);white-space:nowrap}
details.reply{margin-top:8px}details.reply summary{cursor:pointer;color:#7c3aed;font-weight:600;font-size:13px}
.reply textarea{width:100%;min-height:120px;margin-top:8px;border:1px solid var(--line);border-radius:10px;padding:10px;font:inherit;background:var(--bg);color:var(--ink);resize:vertical}
.reply input[type=text]{width:100%;border:1px solid var(--line);border-radius:9px;padding:9px 11px;font:inherit;background:var(--bg);color:var(--ink);margin-top:8px}
.reply .row{display:flex;gap:8px;align-items:center;margin-top:8px;flex-wrap:wrap}
.flash{margin:18px 30px 0;padding:11px 16px;border-radius:10px;font-size:13.5px}.flash.ok{background:#e7f6ee;color:#0f7a44;border:1px solid #b7e3c9}.flash.no{background:#fdecec;color:#b42318;border:1px solid #f4c4c4}
@media(max-width:760px){.side{display:none}.wrap,.top{padding-left:16px;padding-right:16px}}
</style></head><body>
<nav class="side"><div class="brand"><span class="mk"></span> Nativize</div>${nav}</nav>
<div class="main"><div class="top"><div><h1>${esc(title)}</h1>${opts.sub ? `<div class="sub">${esc(opts.sub)}</div>` : ""}</div><a class="btn" href="${active}">↻ Refresh</a></div>${opts.flash || ""}<div class="wrap">${body}</div></div>
<script>
async function aiDraft(btn){var f=btn.closest('form');var box=f.querySelector('textarea');btn.disabled=true;var t=btn.textContent;btn.textContent='✨ Drafting…';
try{var r=await fetch('/api/ai-draft',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:f.querySelector('[name=srcmsg]').value,email:f.querySelector('[name=to]').value})});var j=await r.json();if(j.draft){box.value=j.draft;box.focus();}else{alert(j.error||'AI error');}}catch(e){alert('AI error: '+e.message);}
btn.disabled=false;btn.textContent=t;}
</script>
</body></html>`;
}
function tile(v, l, s) { return `<div class="tile"><div class="v">${v}</div><div class="l">${esc(l)}</div>${s ? `<div class="s">${esc(s)}</div>` : ""}</div>`; }
function tableEl(headers, rows, empty) {
  if (!rows.length) return `<div class="empty">${esc(empty || "Nothing here yet.")}</div>`;
  return `<table><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}
function chart(daily) {
  const rows = arr(daily).slice().reverse();
  if (!rows.length) return `<div class="empty">No visitor data yet — fills in as people visit nativize.dev.</div>`;
  const max = Math.max(1, ...rows.map((r) => r.views));
  return `<div class="chart">${rows.map((r) => `<div class="bar" title="${esc(r.day)}: ${r.views}"><span style="height:${Math.round(r.views / max * 130) + 3}px"></span><em>${esc(String(r.day).slice(5))}</em></div>`).join("")}</div>`;
}
const errline = (x) => (x && x.__error ? `<div class="err">⚠ ${esc(x.__error)}</div>` : "");

/* ---- shared: activation counts per user ---- */
async function activationMap() {
  const acts = arr(await safe(sb("app_activations?select=user_id,repo,plan_id,created_at&order=created_at.desc&limit=2000"), []));
  const m = new Map();
  for (const a of acts) {
    const e = m.get(a.user_id) || { count: 0, repos: new Set(), last: null, plan: a.plan_id };
    e.count++; e.repos.add(a.repo); if (!e.last) e.last = a.created_at; e.plan = a.plan_id;
    m.set(a.user_id, e);
  }
  return m;
}

/* ============================ Pages ============================ */
async function pageOverview() {
  const [t, daily, support, feature, plans] = await Promise.all([
    safe(sb("admin_pageviews_totals"), [{}]), safe(sb("admin_pageviews_daily?limit=30"), []),
    safe(sb("support_requests?select=*&order=created_at.desc&limit=5"), []),
    safe(sb("feature_requests?select=*&order=created_at.desc&limit=5"), []),
    safe(sb("admin_plan_breakdown"), [])
  ]);
  const T = arr(t)[0] || {};
  const P = arr(plans);
  const paid = P.filter((p) => p.plan_id !== "free").reduce((a, p) => a + (p.customers || 0), 0);
  const free = P.filter((p) => p.plan_id === "free").reduce((a, p) => a + (p.customers || 0), 0);
  const tiles = `<div class="tiles">
    ${tile(num(T.views_today), "Views today", T.new_visitors_today != null ? num(T.new_visitors_today) + " new" : "")}
    ${tile(num(T.views_7d), "Views · 7 days")}${tile(num(T.total_views), "Total views")}
    ${tile(num(paid), "Paid customers")}${tile(num(free), "Testers (free)")}</div>`;
  const c = `<div class="card"><h2>Visitors — last 30 days</h2>${chart(daily)}${errline(daily)}</div>`;
  const sup = `<div class="card"><h2>Latest support</h2>${tableEl(["When", "From", "Message"], arr(support).map((r) => [when(r.created_at), esc(r.email || "—"), `<span class="msg">${esc((r.message || r.body || "").slice(0, 140))}</span>`]), "No messages yet.")}</div>`;
  const feat = `<div class="card"><h2>Latest feature requests</h2>${tableEl(["When", "From", "Request"], arr(feature).map((r) => [when(r.created_at), esc(r.email || "—"), `<span class="msg">${esc((r.message || r.body || r.title || "").slice(0, 140))}</span>`]), "None yet.")}</div>`;
  return { title: "Overview", body: tiles + c + sup + feat };
}

async function pageSupport() {
  const rows = arr(await safe(sb("support_requests?select=*&order=created_at.desc&limit=100"), []));
  const emailReady = !!(RESEND_API_KEY && SUPPORT_FROM_EMAIL);
  const banner = emailReady ? "" : `<div class="err">In-portal “Send email” needs RESEND_API_KEY + SUPPORT_FROM_EMAIL in .env.local. “Reply in Mail” works now. AI drafting works either way.</div>`;
  const items = rows.map((r) => {
    const to = r.email || ""; const subj = "Re: your message to Nativize"; const body = (r.message || r.body || "");
    const mailto = to ? `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subj)}` : "";
    const reply = to ? `<details class="reply"><summary>Reply</summary>
      <form method="POST" action="/api/reply">
        <input type="hidden" name="to" value="${esc(to)}"/>
        <input type="hidden" name="srcmsg" value="${esc(body)}"/>
        <input type="text" name="subject" value="${esc(subj)}"/>
        <textarea name="text" placeholder="Write a reply to ${esc(to)}… or click Draft with AI"></textarea>
        <div class="row">
          <button class="btn" type="button" onclick="aiDraft(this)">✨ Draft with AI</button>
          ${emailReady ? `<button class="btn pri" type="submit">Send email</button>` : `<button class="btn" type="submit" disabled>Send email (set up Resend)</button>`}
          <a class="btn" href="${mailto}">Reply in Mail</a>
        </div></form></details>` : `<span class="muted">No email on file</span>`;
    return `<tr><td>${when(r.created_at)}</td><td>${esc(to || "—")}</td><td><span class="msg">${esc(body)}</span>${reply}</td></tr>`;
  });
  const body = banner + `<div class="card"><h2>${rows.length} message${rows.length === 1 ? "" : "s"}</h2>` +
    (rows.length ? `<table><thead><tr><th>When</th><th>From</th><th>Message &amp; reply</th></tr></thead><tbody>${items.join("")}</tbody></table>` : `<div class="empty">No support messages yet.</div>`) + `</div>`;
  return { title: "Support", body, sub: "Free local AI drafts replies · " + (emailReady ? "sending from " + SUPPORT_FROM_EMAIL : "email sending off") };
}

async function pageFeatures() {
  const rows = arr(await safe(sb("feature_requests?select=*&order=created_at.desc&limit=200"), []));
  return { title: "Feature requests", body: `<div class="card"><h2>${rows.length} request${rows.length === 1 ? "" : "s"}</h2>${tableEl(["When", "From", "Request"], rows.map((r) => [when(r.created_at), esc(r.email || "—"), `<span class="msg">${esc(r.message || r.body || r.title || "")}</span>`]), "No feature requests yet.")}</div>` };
}

async function pagePaid() {
  const [ents, custs, actMap] = await Promise.all([
    safe(sb("billing_entitlements?select=*&order=updated_at.desc&limit=500"), []),
    safe(sb("billing_customers?select=user_id,email"), []),
    activationMap()
  ]);
  const emailByUser = new Map(arr(custs).map((c) => [c.user_id, c.email]));
  const paid = arr(ents).filter((e) => e.plan_id !== "free");
  const tiles = `<div class="tiles">${tile(num(paid.length), "Paid customers")}
    ${tile(num(paid.filter((e) => e.billing === "subscription").length), "Subscriptions")}
    ${tile(num(paid.filter((e) => e.billing === "one-time").length), "One-time")}</div>`;
  const rows = paid.map((e) => {
    const a = actMap.get(e.user_id);
    return [esc(emailByUser.get(e.user_id) || shortId(e.user_id)),
      `<span class="pill">${esc(e.plan_id)}</span>`, esc(e.billing), esc(e.status),
      e.current_period_end ? when(e.current_period_end) : "—", a ? num(a.count) : "0"];
  });
  return { title: "Paid customers", body: tiles + `<div class="card"><h2>Paying customers</h2>${tableEl(["Customer", "Plan", "Billing", "Status", "Renews", "Apps built"], rows, "No paid customers yet.")}${errline(ents)}</div>` };
}

async function pageTesters() {
  const [ents, custs, actMap] = await Promise.all([
    safe(sb("billing_entitlements?select=*&limit=1000"), []),
    safe(sb("billing_customers?select=user_id,email"), []),
    activationMap()
  ]);
  const emailByUser = new Map(arr(custs).map((c) => [c.user_id, c.email]));
  // Testers = everyone active on the free plan (from activations), plus free entitlement rows.
  const testerIds = new Set();
  for (const [uid, e] of actMap) if (e.plan === "free") testerIds.add(uid);
  for (const e of arr(ents)) if (e.plan_id === "free") testerIds.add(e.user_id);
  const testers = [...testerIds].map((uid) => {
    const a = actMap.get(uid) || { count: 0, repos: new Set(), last: null };
    return { uid, email: emailByUser.get(uid), count: a.count, repos: a.repos.size, last: a.last };
  }).sort((x, y) => y.count - x.count);
  const frequent = testers.filter((t) => t.count >= 3);
  const tiles = `<div class="tiles">${tile(num(testers.length), "Total testers")}
    ${tile(num(frequent.length), "Frequent testers", "3+ builds")}
    ${tile(num(testers.reduce((s, t) => s + t.count, 0)), "Total test builds")}</div>`;
  const row = (t) => [esc(t.email || shortId(t.uid)),
    t.count >= 3 ? `<span class="pill hot">${num(t.count)} builds</span>` : num(t.count),
    num(t.repos), when(t.last)];
  const freqCard = `<div class="card"><h2>🔥 Frequent testers (most active)</h2>${tableEl(["Tester", "Test builds", "Apps", "Last active"], frequent.map(row), "No frequent testers yet.")}</div>`;
  const allCard = `<div class="card"><h2>All testers</h2>${tableEl(["Tester", "Test builds", "Apps", "Last active"], testers.map(row), "No testers yet.")}</div>`;
  const note = `<div class="err" style="color:var(--muted)">Note: free-tester emails show only if they also have a billing record; and iOS-vs-Android split needs a platform field on app_activations — say the word and I'll add it.</div>`;
  return { title: "Testers", body: tiles + freqCard + allCard + note };
}

async function pageVisitors() {
  const [t, daily, pages, refs] = await Promise.all([
    safe(sb("admin_pageviews_totals"), [{}]), safe(sb("admin_pageviews_daily?limit=30"), []),
    safe(sb("admin_top_pages?limit=25"), []), safe(sb("admin_top_referrers?limit=25"), [])
  ]);
  const T = arr(t)[0] || {};
  const tiles = `<div class="tiles">${tile(num(T.views_today), "Views today", num(T.new_visitors_today) + " new")}${tile(num(T.views_7d), "7 days")}${tile(num(T.views_30d), "30 days")}${tile(num(T.total_views), "Total views")}${tile(num(T.total_new_visitors), "Unique visitors")}</div>`;
  return { title: "Visitors", body: tiles +
    `<div class="card"><h2>Last 30 days</h2>${chart(daily)}</div>` +
    `<div class="card"><h2>Top pages</h2>${tableEl(["Page", "Views"], arr(pages).map((r) => [esc(r.path), num(r.views)]), "—")}</div>` +
    `<div class="card"><h2>Top referrers</h2>${tableEl(["Referrer", "Views"], arr(refs).map((r) => [esc(r.referrer_host), num(r.views)]), "No referrers yet.")}</div>` };
}

async function pageIssues() {
  const issues = await githubIssues(); const list = arr(issues);
  return { title: "GitHub issues", body: `<div class="card"><h2>${list.length} open</h2>${tableEl(["#", "Title", "Opened"], list.map((i) => [`<a href="${esc(i.html_url)}" target="_blank" rel="noopener">#${i.number}</a>`, esc(i.title), when(i.created_at)]), GITHUB_TOKEN ? "No open issues." : "Add GITHUB_TOKEN to .env.local to show issues.")}${errline(issues)}</div>` };
}

function pageSettings() {
  const emailReady = !!(RESEND_API_KEY && SUPPORT_FROM_EMAIL);
  return { title: "Settings", body:
    `<div class="card"><h2>Access</h2><div style="padding:14px 18px" class="muted">No login (open on your WiFi). Anyone on your WiFi can view this. To lock it again later, just ask.</div></div>
     <div class="card"><h2>AI replies</h2><div style="padding:14px 18px" class="muted">Free local AI via Ollama · model <b style="color:var(--ink)">${esc(OLLAMA_MODEL)}</b>. Nothing is sent to a paid API. Drafts appear for you to review before sending.</div></div>
     <div class="card"><h2>Email sending</h2><div style="padding:14px 18px" class="muted">Reply-by-email: <b style="color:${emailReady ? "var(--good)" : "var(--bad)"}">${emailReady ? "ON — " + esc(SUPPORT_FROM_EMAIL) : "OFF"}</b>. ${emailReady ? "" : "Add RESEND_API_KEY + SUPPORT_FROM_EMAIL to .env.local to enable."}</div></div>` };
}

/* ============================ Router ============================ */
const PAGES = { "/": pageOverview, "/support": pageSupport, "/features": pageFeatures, "/paid": pagePaid, "/testers": pageTesters, "/visitors": pageVisitors, "/issues": pageIssues, "/settings": async () => pageSettings() };
function send(res, code, html) { res.writeHead(code, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Frame-Options": "DENY" }); res.end(html); }

const server = http.createServer(async (req, res) => {
  const p = new URL(req.url, "http://x").pathname;
  if (p === "/favicon.ico") { res.writeHead(204).end(); return; }

  if (p === "/api/ai-draft" && req.method === "POST") {
    try {
      const b = JSON.parse(await readBody(req) || "{}");
      const draft = await aiDraft(b.message || "", b.email || "");
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ draft }));
    } catch (e) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: e.message })); }
    return;
  }
  if (p === "/api/reply" && req.method === "POST") {
    const f = parseForm(await readBody(req));
    const to = (f.to || "").trim(), text = (f.text || "").trim(), subject = (f.subject || "Re: your message to Nativize").trim();
    let flash;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) flash = `<div class="flash no">Invalid recipient email.</div>`;
    else if (!text) flash = `<div class="flash no">Reply was empty.</div>`;
    else { const r = await sendReply(to, subject, text); flash = r.ok ? `<div class="flash ok">✓ Reply sent to ${esc(to)}.</div>` : `<div class="flash no">Could not send: ${esc(r.error)}</div>`; }
    const pg = await pageSupport(); return send(res, 200, layout("/support", pg.title, pg.body, { sub: pg.sub, flash }));
  }

  const handler = PAGES[p];
  if (!handler) return send(res, 404, layout("/", "Not found", `<div class="card"><div class="empty">Page not found. <a href="/">Overview</a></div></div>`));
  try { const pg = await handler(); return send(res, 200, layout(p, pg.title, pg.body, { sub: pg.sub })); }
  catch (e) { return send(res, 500, layout(p, "Error", `<div class="card"><div class="err">⚠ ${esc(e.message)}</div></div>`)); }
});

server.listen(PORT, HOST, () => {
  const ips = [];
  const ni = os.networkInterfaces();
  for (const k of Object.keys(ni)) for (const a of ni[k]) if (a.family === "IPv4" && !a.internal) ips.push(a.address);
  console.log(`\n  Nativize portal running.`);
  console.log(`  • On this Mac:  http://127.0.0.1:${PORT}`);
  ips.forEach((ip) => console.log(`  • On your WiFi: http://${ip}:${PORT}  (open this on your phone/other devices)`));
  console.log("");
});
