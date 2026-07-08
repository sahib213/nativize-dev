#!/usr/bin/env node
/* ============================================================================
   Nativize admin portal — LOCAL ONLY (127.0.0.1 by default).

   • Multi-page work portal: Overview, Support, Feature requests, Orders,
     Visitors, Issues, Settings.
   • 6-digit PIN, set on first open, required EVERY time (even on this Mac).
     Brute-force lockout after repeated wrong PINs.
   • Reply to support messages by email (via your existing Resend setup).

   Reads Supabase with your service_role key from ~/nativize/.env.local, which
   never leaves this machine and is never deployed. Nothing here is public.

   Run:  npm run dashboard      (or: node tools/dashboard.js)
   Then: http://127.0.0.1:8787
   ============================================================================ */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
const SUPABASE_URL = process.env.SUPABASE_URL || "https://gaaxcbarmiwtojblkkyh.supabase.co";
const PORT = Number(process.env.DASHBOARD_PORT || 8787);
const HOST = process.env.DASHBOARD_HOST || "127.0.0.1";

/* ---- Load .env.local ---- */
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

if (!SERVICE_KEY) {
  console.error("\n  Missing SUPABASE_SERVICE_ROLE_KEY. Add it to ~/nativize/.env.local.\n");
  process.exit(1);
}

/* ---- Auth store (~/nativize/.dashboard-auth.json, gitignored, 0600) ---- */
const AUTH_FILE = process.env.DASHBOARD_AUTH_FILE || path.join(ROOT, ".dashboard-auth.json");
let AUTH = { pinHash: "", sessionSecret: "" };
(function loadAuth() {
  try { AUTH = JSON.parse(fs.readFileSync(AUTH_FILE, "utf8")); } catch (e) { /* first run */ }
  if (!AUTH.sessionSecret) {
    AUTH.sessionSecret = crypto.randomBytes(32).toString("hex");
    saveAuth();
  }
})();
function saveAuth() {
  fs.writeFileSync(AUTH_FILE, JSON.stringify(AUTH, null, 2));
  try { fs.chmodSync(AUTH_FILE, 0o600); } catch (e) {}
}
const hasPin = () => !!AUTH.pinHash;
function setPin(pin) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(pin), salt, 32).toString("hex");
  AUTH.pinHash = "scrypt$" + salt + "$" + hash;
  saveAuth();
}
function checkPin(pin) {
  if (!AUTH.pinHash) return false;
  const [, salt, hash] = AUTH.pinHash.split("$");
  const got = crypto.scryptSync(String(pin), salt, 32).toString("hex");
  const a = Buffer.from(got), b = Buffer.from(hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ---- Sessions (signed cookie) + brute-force lockout ---- */
function signSession() {
  const body = String(Date.now());
  const sig = crypto.createHmac("sha256", AUTH.sessionSecret).update(body).digest("hex");
  return body + "." + sig;
}
function validSession(tok) {
  if (!tok) return false;
  const i = tok.lastIndexOf(".");
  if (i < 0) return false;
  const body = tok.slice(0, i), sig = tok.slice(i + 1);
  const exp = crypto.createHmac("sha256", AUTH.sessionSecret).update(body).digest("hex");
  const a = Buffer.from(sig), b = Buffer.from(exp);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  const age = Date.now() - Number(body);
  return age >= 0 && age < 7 * 24 * 3600 * 1000; // 7 days
}
let fails = 0, lockUntil = 0;
function lockedFor() { return Math.max(0, Math.ceil((lockUntil - Date.now()) / 1000)); }
function noteFail() {
  fails++;
  if (fails >= 5) lockUntil = Date.now() + Math.min(15 * 60, 30 * Math.pow(2, fails - 5)) * 1000;
}

/* ---- Supabase REST (service role; local only) ---- */
async function sb(pathAndQuery) {
  const res = await fetch(SUPABASE_URL + "/rest/v1/" + pathAndQuery, {
    headers: { apikey: SERVICE_KEY, Authorization: "Bearer " + SERVICE_KEY, Accept: "application/json" }
  });
  if (!res.ok) throw new Error(pathAndQuery + " → " + res.status + " " + (await res.text()).slice(0, 200));
  return res.json();
}
async function safe(p, fb) { try { return await p; } catch (e) { return { __error: e.message, fallback: fb }; } }
async function githubIssues() {
  if (!GITHUB_TOKEN) return { __error: "No GITHUB_TOKEN set (optional).", fallback: [] };
  try {
    const res = await fetch("https://api.github.com/repos/" + GITHUB_REPO + "/issues?state=open&per_page=30", {
      headers: { Authorization: "Bearer " + GITHUB_TOKEN, Accept: "application/vnd.github+json", "User-Agent": "nativize-dashboard" }
    });
    if (!res.ok) throw new Error("GitHub " + res.status);
    return (await res.json()).filter((i) => !i.pull_request);
  } catch (e) { return { __error: e.message, fallback: [] }; }
}
async function sendReply(to, subject, text) {
  if (!RESEND_API_KEY || !SUPPORT_FROM_EMAIL) {
    return { ok: false, error: "Email not configured. Add RESEND_API_KEY and SUPPORT_FROM_EMAIL to .env.local." };
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: "Bearer " + RESEND_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ from: SUPPORT_FROM_EMAIL, to: [to], reply_to: SUPPORT_REPLY_TO, subject, text })
    });
    if (!res.ok) return { ok: false, error: (await res.text()).slice(0, 300) };
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

/* ---- helpers ---- */
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const num = (n) => (n == null ? "—" : Number(n).toLocaleString("en-US"));
const when = (s) => (s ? new Date(s).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");
const arr = (x) => (Array.isArray(x) ? x : (x && Array.isArray(x.fallback) ? x.fallback : []));
const getCookie = (req, name) => { const m = (req.headers.cookie || "").match(new RegExp("(?:^|; )" + name + "=([^;]*)")); return m ? decodeURIComponent(m[1]) : null; };
function readBody(req) { return new Promise((r) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => r(d)); }); }
const parseForm = (s) => { const o = {}; new URLSearchParams(s).forEach((v, k) => (o[k] = v)); return o; };

/* ============================ HTML shell ============================ */
const NAV = [
  ["/", "Overview", "M3 12l9-9 9 9M5 10v10h14V10"],
  ["/support", "Support", "M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"],
  ["/features", "Feature requests", "M12 2l2.4 7.4H22l-6 4.3 2.3 7.3-6-4.5-6 4.5L8.6 13.7 3 9.4h7.6z"],
  ["/orders", "Orders & plans", "M3 3h18v4H3zM3 10h18v11H3z"],
  ["/visitors", "Visitors", "M3 3v18h18M7 14l3-4 3 3 4-6"],
  ["/issues", "GitHub issues", "M12 2a10 10 0 100 20 10 10 0 000-20zM12 8v5M12 16h.01"],
  ["/settings", "Settings", "M12 15a3 3 0 100-6 3 3 0 000 6zM19 12a7 7 0 00-.1-1l2-1.6-2-3.4-2.4 1a7 7 0 00-1.7-1l-.4-2.5H9.6L9.2 6a7 7 0 00-1.7 1l-2.4-1-2 3.4 2 1.6a7 7 0 000 2l-2 1.6 2 3.4 2.4-1a7 7 0 001.7 1l.4 2.5h4.8l.4-2.5a7 7 0 001.7-1l2.4 1 2-3.4-2-1.6a7 7 0 00.1-1z"]
];

function layout(active, title, body, opts) {
  opts = opts || {};
  const nav = NAV.map(([href, label, d]) =>
    `<a class="nav-item${active === href ? " on" : ""}" href="${href}">
       <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>
       <span>${label}</span></a>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${esc(title)} · Nativize</title>
<style>
  :root{
    --bg:#f6f7fb; --panel:#ffffff; --ink:#171a21; --muted:#697086; --line:#e7e9f0;
    --brand:#6d3aed; --brand2:#2563eb; --accent:linear-gradient(135deg,#7c3aed,#2563eb);
    --good:#0f9d58; --bad:#e5484d; --chip:#f0f1f7;
  }
  @media (prefers-color-scheme: dark){
    :root{ --bg:#0b0c12; --panel:#14151d; --ink:#eceefb; --muted:#8b90a6; --line:#242636; --chip:#1c1e2a; }
  }
  *{box-sizing:border-box} html,body{margin:0}
  body{background:var(--bg);color:var(--ink);font:14.5px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Inter,sans-serif;display:flex;min-height:100vh}
  a{color:inherit;text-decoration:none}
  /* Sidebar */
  .side{width:236px;flex:none;background:var(--panel);border-right:1px solid var(--line);padding:18px 14px;display:flex;flex-direction:column;gap:4px;position:sticky;top:0;height:100vh}
  .brand{display:flex;align-items:center;gap:10px;padding:6px 8px 16px;font-weight:700;font-size:16px}
  .brand .mk{width:26px;height:26px;border-radius:8px;background:var(--accent)}
  .nav-item{display:flex;align-items:center;gap:11px;padding:9px 11px;border-radius:10px;color:var(--muted);font-weight:500}
  .nav-item svg{width:18px;height:18px}
  .nav-item:hover{background:var(--chip);color:var(--ink)}
  .nav-item.on{background:var(--accent);color:#fff}
  .side .sp{flex:1}
  .logout{color:var(--muted);font-size:13px;padding:9px 11px;border-radius:10px}
  .logout:hover{background:var(--chip);color:var(--bad)}
  /* Main */
  .main{flex:1;min-width:0;display:flex;flex-direction:column}
  .top{display:flex;align-items:center;justify-content:space-between;padding:20px 30px;border-bottom:1px solid var(--line);background:var(--panel)}
  .top h1{font-size:19px;margin:0;letter-spacing:-.01em}
  .top .sub{color:var(--muted);font-size:12.5px;margin-top:2px}
  .btn{border:1px solid var(--line);background:var(--panel);color:var(--ink);padding:8px 14px;border-radius:9px;font-weight:600;cursor:pointer;font-size:13.5px}
  .btn:hover{background:var(--chip)} .btn.pri{background:var(--accent);color:#fff;border:0}
  .wrap{padding:26px 30px;max-width:1100px;width:100%}
  /* Tiles */
  .tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:14px;margin-bottom:8px}
  .tile{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:16px 18px}
  .tile .v{font-size:26px;font-weight:700;letter-spacing:-.02em}
  .tile .l{color:var(--muted);font-size:12.5px;margin-top:3px}
  .tile .s{color:var(--good);font-size:12px;margin-top:5px}
  /* Cards + tables */
  .card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:4px 4px;margin-top:18px;overflow:hidden}
  .card h2{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:16px 18px 8px}
  table{width:100%;border-collapse:collapse;font-size:13.5px}
  th,td{text-align:left;padding:11px 18px;border-top:1px solid var(--line);vertical-align:top}
  thead th{border-top:0;color:var(--muted);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.04em}
  tbody tr:hover{background:var(--chip)}
  .muted{color:var(--muted)} .empty{padding:26px 18px;color:var(--muted)}
  .pill{display:inline-block;padding:2px 9px;border-radius:999px;font-size:12px;background:#e7f6ee;color:#0f9d58;font-weight:600}
  .pill.free{background:var(--chip);color:var(--muted)}
  .err{margin:10px 18px;color:var(--bad);font-size:13px}
  .msg{max-width:520px;color:var(--muted);white-space:pre-wrap}
  /* Chart */
  .chart{display:flex;align-items:flex-end;gap:5px;height:170px;padding:18px;overflow-x:auto}
  .bar{display:flex;flex-direction:column;align-items:center;gap:6px;min-width:22px}
  .bar span{width:16px;border-radius:5px 5px 0 0;background:var(--accent)}
  .bar em{font-size:9px;color:var(--muted);font-style:normal;transform:rotate(-45deg);white-space:nowrap}
  /* Reply */
  details.reply{margin-top:8px}
  details.reply summary{cursor:pointer;color:var(--brand);font-weight:600;font-size:13px;list-style:none}
  .reply textarea{width:100%;min-height:96px;margin-top:8px;border:1px solid var(--line);border-radius:10px;padding:10px;font:inherit;background:var(--bg);color:var(--ink);resize:vertical}
  .reply .row{display:flex;gap:8px;align-items:center;margin-top:8px;flex-wrap:wrap}
  .reply input[type=text]{flex:1;min-width:200px;border:1px solid var(--line);border-radius:9px;padding:9px 11px;font:inherit;background:var(--bg);color:var(--ink)}
  .flash{margin:0 30px;margin-top:18px;padding:11px 16px;border-radius:10px;font-size:13.5px}
  .flash.ok{background:#e7f6ee;color:#0f7a44;border:1px solid #b7e3c9}
  .flash.no{background:#fdecec;color:#b42318;border:1px solid #f4c4c4}
  @media(max-width:760px){ .side{display:none} .wrap,.top{padding-left:16px;padding-right:16px} }
</style></head><body>
  <nav class="side">
    <div class="brand"><span class="mk"></span> Nativize</div>
    ${nav}
    <div class="sp"></div>
    <form method="POST" action="/logout"><button class="logout" style="width:100%;text-align:left;border:0;background:none;cursor:pointer">Log out</button></form>
  </nav>
  <div class="main">
    <div class="top"><div><h1>${esc(title)}</h1>${opts.sub ? `<div class="sub">${esc(opts.sub)}</div>` : ""}</div>
      <a class="btn" href="${active}">↻ Refresh</a></div>
    ${opts.flash || ""}
    <div class="wrap">${body}</div>
  </div>
</body></html>`;
}

function tile(v, l, s) { return `<div class="tile"><div class="v">${v}</div><div class="l">${esc(l)}</div>${s ? `<div class="s">${esc(s)}</div>` : ""}</div>`; }
function tableEl(headers, rows, emptyMsg) {
  if (!rows.length) return `<div class="empty">${esc(emptyMsg || "Nothing here yet.")}</div>`;
  return `<table><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}
function chart(daily) {
  const rows = arr(daily).slice().reverse();
  if (!rows.length) return `<div class="empty">No visitor data yet — it fills in as people visit nativize.dev.</div>`;
  const max = Math.max(1, ...rows.map((r) => r.views));
  return `<div class="chart">${rows.map((r) => `<div class="bar" title="${esc(r.day)}: ${r.views} views"><span style="height:${Math.round(r.views / max * 130) + 3}px"></span><em>${esc(String(r.day).slice(5))}</em></div>`).join("")}</div>`;
}
const errline = (x) => (x && x.__error ? `<div class="err">⚠ ${esc(x.__error)}</div>` : "");

/* ============================ Pages ============================ */
async function pageOverview() {
  const [t, daily, support, feature] = await Promise.all([
    safe(sb("admin_pageviews_totals"), [{}]), safe(sb("admin_pageviews_daily?limit=30"), []),
    safe(sb("support_requests?select=*&order=created_at.desc&limit=5"), []),
    safe(sb("feature_requests?select=*&order=created_at.desc&limit=5"), [])
  ]);
  const T = (arr(t)[0]) || {};
  const tiles = `<div class="tiles">
    ${tile(num(T.views_today), "Views today", T.new_visitors_today != null ? num(T.new_visitors_today) + " new" : "")}
    ${tile(num(T.views_7d), "Views · 7 days")}
    ${tile(num(T.views_30d), "Views · 30 days")}
    ${tile(num(T.total_views), "Total views")}
    ${tile(num(T.total_new_visitors), "Unique visitors")}
  </div>`;
  const chartCard = `<div class="card"><h2>Visitors — last 30 days</h2>${chart(daily)}${errline(daily)}</div>`;
  const sup = `<div class="card"><h2>Latest support</h2>${tableEl(["When", "From", "Message"], arr(support).map((r) => [when(r.created_at), esc(r.email || "—"), `<span class="msg">${esc((r.message || r.body || "").slice(0, 160))}</span>`]), "No messages yet.")}</div>`;
  const feat = `<div class="card"><h2>Latest feature requests</h2>${tableEl(["When", "From", "Request"], arr(feature).map((r) => [when(r.created_at), esc(r.email || "—"), `<span class="msg">${esc((r.message || r.body || r.title || "").slice(0, 160))}</span>`]), "None yet.")}</div>`;
  return { title: "Overview", body: tiles + chartCard + sup + feat };
}

async function pageSupport() {
  const rows = arr(await safe(sb("support_requests?select=*&order=created_at.desc&limit=100"), []));
  const emailReady = !!(RESEND_API_KEY && SUPPORT_FROM_EMAIL);
  const banner = emailReady ? "" : `<div class="err">Reply-by-email isn't configured yet — add RESEND_API_KEY and SUPPORT_FROM_EMAIL to .env.local. Until then, use “Reply in Mail”.</div>`;
  const items = rows.map((r) => {
    const to = r.email || "";
    const subj = "Re: your message to Nativize";
    const quoted = (r.message || r.body || "").slice(0, 4000);
    const mailto = to ? `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subj)}` : "";
    const reply = to ? `
      <details class="reply">
        <summary>Reply</summary>
        <form method="POST" action="/api/reply">
          <input type="hidden" name="to" value="${esc(to)}"/>
          <div class="row"><input type="text" name="subject" value="${esc(subj)}"/></div>
          <textarea name="text" placeholder="Type your reply to ${esc(to)}…"></textarea>
          <div class="row">
            ${emailReady ? `<button class="btn pri" type="submit">Send email</button>` : `<button class="btn" type="submit" disabled>Send email (configure Resend)</button>`}
            <a class="btn" href="${mailto}">Reply in Mail app</a>
          </div>
        </form>
      </details>` : `<span class="muted">No email on file</span>`;
    return `<tr><td>${when(r.created_at)}</td><td>${esc(to || "—")}</td><td><span class="msg">${esc(quoted)}</span>${reply}</td></tr>`;
  });
  const body = banner + `<div class="card"><h2>${rows.length} message${rows.length === 1 ? "" : "s"}</h2>` +
    (rows.length ? `<table><thead><tr><th>When</th><th>From</th><th>Message &amp; reply</th></tr></thead><tbody>${items.join("")}</tbody></table>` : `<div class="empty">No support messages yet.</div>`) + `</div>`;
  return { title: "Support", body, sub: emailReady ? "Replies send from " + SUPPORT_FROM_EMAIL : "" };
}

async function pageFeatures() {
  const rows = arr(await safe(sb("feature_requests?select=*&order=created_at.desc&limit=200"), []));
  const body = `<div class="card"><h2>${rows.length} request${rows.length === 1 ? "" : "s"}</h2>${tableEl(["When", "From", "Request"], rows.map((r) => [when(r.created_at), esc(r.email || "—"), `<span class="msg">${esc(r.message || r.body || r.title || "")}</span>`]), "No feature requests yet.")}</div>`;
  return { title: "Feature requests", body };
}

async function pageOrders() {
  const [plans, acts, custs] = await Promise.all([
    safe(sb("admin_plan_breakdown"), []),
    safe(sb("app_activations?select=created_at,plan_id,repo&order=created_at.desc&limit=100"), []),
    safe(sb("billing_customers?select=email,created_at&order=created_at.desc&limit=100"), [])
  ]);
  const P = arr(plans);
  const paid = P.filter((p) => p.plan_id !== "free").reduce((a, p) => a + (p.customers || 0), 0);
  const free = P.filter((p) => p.plan_id === "free").reduce((a, p) => a + (p.customers || 0), 0);
  const tiles = `<div class="tiles">${tile(num(paid), "Paid customers")}${tile(num(free), "Free")}${tile(num(arr(custs).length), "Total customers")}</div>`;
  const planCard = `<div class="card"><h2>Plans</h2>${tableEl(["Plan", "Billing", "Status", "Customers"], P.map((p) => [`<span class="pill ${p.plan_id === "free" ? "free" : ""}">${esc(p.plan_id)}</span>`, esc(p.billing), esc(p.status), num(p.customers)]), "No plan data.")}${errline(plans)}</div>`;
  const actCard = `<div class="card"><h2>Recent app activations</h2>${tableEl(["When", "Plan", "Repo"], arr(acts).map((r) => [when(r.created_at), `<span class="pill ${r.plan_id === "free" ? "free" : ""}">${esc(r.plan_id)}</span>`, esc(r.repo)]), "No activations yet.")}</div>`;
  const custCard = `<div class="card"><h2>Customers</h2>${tableEl(["Email", "Since"], arr(custs).map((r) => [esc(r.email || "—"), when(r.created_at)]), "No customers yet.")}</div>`;
  return { title: "Orders & plans", body: tiles + planCard + actCard + custCard };
}

async function pageVisitors() {
  const [t, daily, pages, refs] = await Promise.all([
    safe(sb("admin_pageviews_totals"), [{}]), safe(sb("admin_pageviews_daily?limit=30"), []),
    safe(sb("admin_top_pages?limit=25"), []), safe(sb("admin_top_referrers?limit=25"), [])
  ]);
  const T = (arr(t)[0]) || {};
  const tiles = `<div class="tiles">${tile(num(T.views_today), "Views today", num(T.new_visitors_today) + " new")}${tile(num(T.views_7d), "7 days")}${tile(num(T.views_30d), "30 days")}${tile(num(T.total_views), "Total views")}${tile(num(T.total_new_visitors), "Unique visitors")}</div>`;
  const chartCard = `<div class="card"><h2>Last 30 days</h2>${chart(daily)}</div>`;
  const pagesCard = `<div class="card"><h2>Top pages</h2>${tableEl(["Page", "Views"], arr(pages).map((r) => [esc(r.path), num(r.views)]), "—")}</div>`;
  const refCard = `<div class="card"><h2>Top referrers</h2>${tableEl(["Referrer", "Views"], arr(refs).map((r) => [esc(r.referrer_host), num(r.views)]), "No referrers yet.")}</div>`;
  return { title: "Visitors", body: tiles + chartCard + pagesCard + refCard };
}

async function pageIssues() {
  const issues = await githubIssues();
  const list = arr(issues);
  const body = `<div class="card"><h2>${list.length} open issue${list.length === 1 ? "" : "s"}</h2>${tableEl(["#", "Title", "Opened"], list.map((i) => [`<a href="${esc(i.html_url)}" target="_blank" rel="noopener">#${i.number}</a>`, esc(i.title), when(i.created_at)]), GITHUB_TOKEN ? "No open issues." : "Add a GITHUB_TOKEN to .env.local to show issues.")}${errline(issues)}</div>`;
  return { title: "GitHub issues", body };
}

function pageSettings() {
  const emailReady = !!(RESEND_API_KEY && SUPPORT_FROM_EMAIL);
  const body = `
    <div class="card"><h2>Security</h2>
      <div style="padding:14px 18px">
        <form method="POST" action="/settings/pin" style="max-width:320px">
          <div class="muted" style="margin-bottom:8px">Change your 6-digit PIN</div>
          <input type="text" name="current" inputmode="numeric" placeholder="Current PIN" style="width:100%;padding:9px 11px;border:1px solid var(--line);border-radius:9px;background:var(--bg);color:var(--ink);margin-bottom:8px"/>
          <input type="text" name="next" inputmode="numeric" placeholder="New 6-digit PIN" maxlength="6" style="width:100%;padding:9px 11px;border:1px solid var(--line);border-radius:9px;background:var(--bg);color:var(--ink);margin-bottom:10px"/>
          <button class="btn pri" type="submit">Update PIN</button>
        </form>
      </div>
    </div>
    <div class="card"><h2>Email replies</h2>
      <div style="padding:14px 18px" class="muted">
        Reply-by-email: <b style="color:${emailReady ? 'var(--good)' : 'var(--bad)'}">${emailReady ? "ON — sending from " + esc(SUPPORT_FROM_EMAIL) : "OFF"}</b>.<br>
        ${emailReady ? "" : "To turn on, add <code>RESEND_API_KEY</code> and <code>SUPPORT_FROM_EMAIL</code> to <code>~/nativize/.env.local</code> and restart."}
      </div>
    </div>
    <div class="card"><h2>About</h2>
      <div style="padding:14px 18px" class="muted">Local admin portal · reads Supabase with your service key on this Mac only · nothing here is public.</div>
    </div>`;
  return { title: "Settings", body };
}

/* ---- Login / first-run setup page ---- */
function loginPage(mode, msg) {
  const setup = mode === "setup";
  const flash = msg ? `<div class="lf">${esc(msg)}</div>` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${setup ? "Set your PIN" : "Enter PIN"} · Nativize</title>
<style>
  :root{--bg:#0b0c12;--panel:#14151d;--ink:#eceefb;--muted:#8b90a6;--line:#242636;--accent:linear-gradient(135deg,#7c3aed,#2563eb);--bad:#e5484d}
  *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--ink);font:15px -apple-system,Segoe UI,Roboto,sans-serif;display:grid;place-items:center;height:100vh}
  .box{background:var(--panel);border:1px solid var(--line);border-radius:18px;padding:34px 30px;width:340px;text-align:center}
  .mk{width:44px;height:44px;border-radius:12px;background:var(--accent);margin:0 auto 16px}
  h1{font-size:19px;margin:0 0 6px} p{color:var(--muted);font-size:13.5px;margin:0 0 20px}
  input{width:100%;text-align:center;letter-spacing:12px;font-size:26px;padding:14px;border:1px solid var(--line);border-radius:12px;background:var(--bg);color:var(--ink);margin-bottom:14px}
  button{width:100%;padding:13px;border:0;border-radius:12px;background:var(--accent);color:#fff;font-weight:700;font-size:15px;cursor:pointer}
  .lf{color:var(--bad);font-size:13px;margin-bottom:14px}
</style></head><body>
  <form class="box" method="POST" action="/login">
    <div class="mk"></div>
    <h1>${setup ? "Create your PIN" : "Enter your PIN"}</h1>
    <p>${setup ? "Pick a 6-digit PIN. You'll enter it every time you open the portal." : "This portal is locked. Enter your 6-digit PIN."}</p>
    ${flash}
    <input name="pin" inputmode="numeric" autocomplete="off" maxlength="6" pattern="[0-9]{6}" placeholder="••••••" autofocus/>
    ${setup ? `<input name="pin2" inputmode="numeric" autocomplete="off" maxlength="6" pattern="[0-9]{6}" placeholder="repeat"/>` : ""}
    <button type="submit">${setup ? "Set PIN & open" : "Unlock"}</button>
  </form>
</body></html>`;
}

/* ============================ Router ============================ */
const PAGES = {
  "/": pageOverview, "/support": pageSupport, "/features": pageFeatures,
  "/orders": pageOrders, "/visitors": pageVisitors, "/issues": pageIssues,
  "/settings": async () => pageSettings()
};

function send(res, code, html, headers) {
  res.writeHead(code, Object.assign({ "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer" }, headers || {}));
  res.end(html);
}
function redirect(res, to, cookie) {
  const h = { Location: to };
  if (cookie) h["Set-Cookie"] = cookie;
  res.writeHead(302, h); res.end();
}
const sessionCookie = (tok) => `nzs=${tok}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  if (p === "/favicon.ico") { res.writeHead(204).end(); return; }

  const authed = validSession(getCookie(req, "nzs"));

  /* ---- Auth endpoints (open) ---- */
  if (p === "/login" && req.method === "POST") {
    if (lockedFor() > 0) return send(res, 429, loginPage(hasPin() ? "unlock" : "setup", `Too many tries. Wait ${lockedFor()}s.`));
    const f = parseForm(await readBody(req));
    const pin = (f.pin || "").trim();
    if (!hasPin()) { // first-run setup
      if (!/^\d{6}$/.test(pin)) return send(res, 400, loginPage("setup", "PIN must be exactly 6 digits."));
      if (pin !== (f.pin2 || "").trim()) return send(res, 400, loginPage("setup", "The two PINs don't match."));
      setPin(pin);
      return redirect(res, "/", sessionCookie(signSession()));
    }
    if (checkPin(pin)) { fails = 0; return redirect(res, "/", sessionCookie(signSession())); }
    noteFail();
    return send(res, 401, loginPage("unlock", "Wrong PIN." + (lockedFor() > 0 ? ` Locked ${lockedFor()}s.` : "")));
  }
  if (p === "/logout") { return redirect(res, "/login", "nzs=; Path=/; Max-Age=0"); }

  /* ---- Everything else requires a session ---- */
  if (!authed) {
    if (p === "/login") return send(res, 200, loginPage(hasPin() ? "unlock" : "setup"));
    return redirect(res, "/login");
  }
  if (p === "/login") return redirect(res, "/");

  /* ---- Authed POST actions ---- */
  if (p === "/api/reply" && req.method === "POST") {
    const f = parseForm(await readBody(req));
    const to = (f.to || "").trim(), text = (f.text || "").trim(), subject = (f.subject || "Re: your message to Nativize").trim();
    let flash;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) flash = `<div class="flash no">Invalid recipient email.</div>`;
    else if (!text) flash = `<div class="flash no">Reply was empty.</div>`;
    else {
      const r = await sendReply(to, subject, text);
      flash = r.ok ? `<div class="flash ok">✓ Reply sent to ${esc(to)}.</div>` : `<div class="flash no">Could not send: ${esc(r.error)}</div>`;
    }
    const pg = await pageSupport();
    return send(res, 200, layout("/support", pg.title, pg.body, { sub: pg.sub, flash }));
  }
  if (p === "/settings/pin" && req.method === "POST") {
    const f = parseForm(await readBody(req));
    let flash;
    if (!checkPin((f.current || "").trim())) flash = `<div class="flash no">Current PIN is wrong.</div>`;
    else if (!/^\d{6}$/.test((f.next || "").trim())) flash = `<div class="flash no">New PIN must be 6 digits.</div>`;
    else { setPin((f.next || "").trim()); flash = `<div class="flash ok">✓ PIN updated.</div>`; }
    const pg = pageSettings();
    return send(res, 200, layout("/settings", pg.title, pg.body, { flash }));
  }

  /* ---- Authed pages ---- */
  const handler = PAGES[p];
  if (!handler) return send(res, 404, layout("/", "Not found", `<div class="card"><div class="empty">Page not found. <a href="/">Go to Overview</a></div></div>`));
  try {
    const pg = await handler();
    return send(res, 200, layout(p, pg.title, pg.body, { sub: pg.sub }));
  } catch (e) {
    return send(res, 500, layout(p, "Error", `<div class="card"><div class="err">⚠ ${esc(e.message)}</div></div>`));
  }
});

server.listen(PORT, HOST, () => {
  const net = HOST === "127.0.0.1" || HOST === "localhost" || HOST === "::1";
  console.log(`\n  Nativize portal → http://${net ? "127.0.0.1" : (HOST === "0.0.0.0" ? "<your-Mac-IP>" : HOST)}:${PORT}`);
  console.log(`  PIN: ${hasPin() ? "set" : "will be created on first open"} · access ${net ? "this Mac" : "WiFi"}\n`);
});
