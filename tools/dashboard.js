#!/usr/bin/env node
/* ============================================================================
   Nativize local admin dashboard.

   Runs ONLY on your machine (127.0.0.1). Reads Supabase with your service_role
   key, which stays in Node and is NEVER sent to the browser or deployed.
   There is no public /admin page — nothing here is exposed to the internet.

   Setup (once):
     1. Create ~/nativize/.env.local (gitignored) with:
          SUPABASE_SERVICE_ROLE_KEY=eyJ...   # Supabase → Project Settings → API → service_role
          # optional, to show GitHub issues:
          GITHUB_TOKEN=ghp_...               # a token with repo:read
          GITHUB_REPO=sahib213/nativize-dev
     2. Run:  npm run dashboard   (or: node tools/dashboard.js)
     3. Open the printed http://127.0.0.1:8787 URL.
   ============================================================================ */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");

const SUPABASE_URL = process.env.SUPABASE_URL || "https://gaaxcbarmiwtojblkkyh.supabase.co";
const PORT = Number(process.env.DASHBOARD_PORT || 8787);

/* ---- Load .env.local (simple KEY=VALUE parser, no dependencies) ---- */
function loadEnv() {
  const p = path.join(__dirname, "..", ".env.local");
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
loadEnv();

const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const GITHUB_REPO = process.env.GITHUB_REPO || "sahib213/nativize-dev";

if (!SERVICE_KEY) {
  console.error("\n  Missing SUPABASE_SERVICE_ROLE_KEY.");
  console.error("  Create ~/nativize/.env.local with your service_role key (see top of tools/dashboard.js).\n");
  process.exit(1);
}

/* ---- Supabase REST helper (service role bypasses RLS; local only) ---- */
async function sb(pathAndQuery) {
  const res = await fetch(SUPABASE_URL + "/rest/v1/" + pathAndQuery, {
    headers: {
      apikey: SERVICE_KEY,
      Authorization: "Bearer " + SERVICE_KEY,
      Accept: "application/json"
    }
  });
  if (!res.ok) throw new Error(pathAndQuery + " → " + res.status + " " + (await res.text()).slice(0, 200));
  return res.json();
}
async function safe(promise, fallback) {
  try { return await promise; } catch (e) { return { __error: e.message, fallback }; }
}

async function githubIssues() {
  if (!GITHUB_TOKEN) return { __error: "No GITHUB_TOKEN set", fallback: [] };
  try {
    const res = await fetch("https://api.github.com/repos/" + GITHUB_REPO + "/issues?state=open&per_page=20", {
      headers: { Authorization: "Bearer " + GITHUB_TOKEN, Accept: "application/vnd.github+json", "User-Agent": "nativize-dashboard" }
    });
    if (!res.ok) throw new Error("GitHub " + res.status);
    return (await res.json()).filter((i) => !i.pull_request);
  } catch (e) { return { __error: e.message, fallback: [] }; }
}

/* ---- HTML rendering (self-contained, brand-dark theme) ---- */
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const num = (n) => (n == null ? "—" : Number(n).toLocaleString("en-US"));
const when = (s) => (s ? new Date(s).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");
const arr = (x) => (Array.isArray(x) ? x : []);

function barChart(daily) {
  const rows = arr(daily).slice().reverse(); // oldest → newest
  if (!rows.length) return '<p class="muted">No visitor data yet — deploy the site and wait for traffic.</p>';
  const max = Math.max(1, ...rows.map((r) => r.views));
  const bars = rows.map((r) => {
    const h = Math.round((r.views / max) * 130) + 2;
    return `<div class="bar" title="${esc(r.day)}: ${r.views} views, ${r.new_visitors} new"><span style="height:${h}px"></span><em>${esc(String(r.day).slice(5))}</em></div>`;
  }).join("");
  return `<div class="chart">${bars}</div>`;
}

function tile(label, value, sub) {
  return `<div class="tile"><div class="tval">${value}</div><div class="tlabel">${esc(label)}</div>${sub ? `<div class="tsub">${esc(sub)}</div>` : ""}</div>`;
}

function table(headers, rows) {
  if (!rows.length) return '<p class="muted">Nothing here yet.</p>';
  return `<div class="tbl-wrap"><table><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}

function errNote(x) {
  return x && x.__error ? `<p class="err">⚠ ${esc(x.__error)}</p>` : "";
}

function render(d) {
  const totals = (d.totals && d.totals[0]) || {};
  const plans = arr(d.plans && d.plans.fallback ? [] : d.plans);
  const paid = plans.filter((p) => p.plan_id !== "free").reduce((a, p) => a + (p.customers || 0), 0);
  const free = plans.filter((p) => p.plan_id === "free").reduce((a, p) => a + (p.customers || 0), 0);
  const issues = arr(d.issues && d.issues.fallback ? d.issues.fallback : d.issues);

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Nativize · Dashboard</title>
<style>
  :root{--bg:#0a0a12;--card:#141420;--line:#23233a;--text:#eef;--muted:#8a8fb0;--grad:linear-gradient(135deg,#7c3aed,#2563eb);}
  *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;padding:28px}
  h1{font-size:22px;margin:0 0 2px;display:flex;align-items:center;gap:10px} h2{font-size:15px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:34px 0 12px}
  .mark{width:26px;height:26px;border-radius:7px;background:var(--grad);display:inline-block}
  .top{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px}
  .muted{color:var(--muted)} .err{color:#f9a; font-size:13px;margin:6px 0}
  .tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:14px;margin-top:8px}
  .tile{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px}
  .tval{font-size:28px;font-weight:700} .tlabel{color:var(--muted);font-size:13px;margin-top:2px} .tsub{color:#6ee7b7;font-size:12px;margin-top:4px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:18px}
  .grid2{display:grid;grid-template-columns:1fr 1fr;gap:18px} @media(max-width:820px){.grid2{grid-template-columns:1fr}}
  .chart{display:flex;align-items:flex-end;gap:4px;height:160px;overflow-x:auto;padding-top:8px}
  .bar{display:flex;flex-direction:column;align-items:center;gap:6px;min-width:20px} .bar span{width:16px;border-radius:4px 4px 0 0;background:var(--grad)} .bar em{font-size:9px;color:var(--muted);font-style:normal;transform:rotate(-45deg);white-space:nowrap}
  table{width:100%;border-collapse:collapse;font-size:13.5px} th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}
  th{color:var(--muted);font-weight:600} .tbl-wrap{overflow-x:auto} td.msg{max-width:420px;color:var(--muted)}
  .pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;background:#1e2a1e;color:#6ee7b7} .pill.free{background:#26263a;color:#9aa}
  a{color:#8ab4ff;text-decoration:none} .refresh{background:var(--grad);color:#fff;border:0;padding:8px 14px;border-radius:9px;cursor:pointer;font-weight:600}
  .foot{color:var(--muted);font-size:12px;margin-top:30px}
</style></head><body>
<div class="top"><h1><span class="mark"></span> Nativize Dashboard</h1>
<div class="muted">Local · ${esc(new Date().toLocaleString("en-US"))} <button class="refresh" onclick="location.reload()">↻ Refresh</button></div></div>

<div class="tiles">
  ${tile("Views today", num(totals.views_today), totals.new_visitors_today != null ? num(totals.new_visitors_today) + " new" : "")}
  ${tile("Views (7 days)", num(totals.views_7d))}
  ${tile("Views (30 days)", num(totals.views_30d))}
  ${tile("Total views", num(totals.total_views))}
  ${tile("Unique visitors", num(totals.total_new_visitors))}
  ${tile("Paid customers", num(paid), free != null ? num(free) + " free" : "")}
  ${tile("Open issues", num(issues.length))}
</div>
${errNote(d.totals && d.totals.__error ? d.totals : null)}

<h2>Visitors — last 30 days</h2>
<div class="card">${barChart(d.daily && d.daily.fallback ? [] : d.daily)}${errNote(d.daily)}</div>

<div class="grid2">
  <div><h2>Support messages</h2><div class="card">${table(["When", "From", "Message"],
    arr(d.support && d.support.fallback ? [] : d.support).map((r) => [when(r.created_at), esc(r.email || r.name || "—"), `<span class="msg">${esc((r.message || r.body || "").slice(0, 300))}</span>`]))}${errNote(d.support)}</div></div>
  <div><h2>Feature requests</h2><div class="card">${table(["When", "From", "Request"],
    arr(d.feature && d.feature.fallback ? [] : d.feature).map((r) => [when(r.created_at), esc(r.email || r.name || "—"), `<span class="msg">${esc((r.message || r.body || r.title || "").slice(0, 300))}</span>`]))}${errNote(d.feature)}</div></div>
</div>

<div class="grid2">
  <div><h2>Plans / orders (free vs paid)</h2><div class="card">${table(["Plan", "Billing", "Status", "Customers"],
    plans.map((p) => [`<span class="pill ${p.plan_id === "free" ? "free" : ""}">${esc(p.plan_id)}</span>`, esc(p.billing), esc(p.status), num(p.customers)]))}${errNote(d.plans)}</div></div>
  <div><h2>Recent app activations</h2><div class="card">${table(["When", "Plan", "Repo"],
    arr(d.activations && d.activations.fallback ? [] : d.activations).map((r) => [when(r.created_at), `<span class="pill ${r.plan_id === "free" ? "free" : ""}">${esc(r.plan_id)}</span>`, esc(r.repo)]))}${errNote(d.activations)}</div></div>
</div>

<h2>Top pages &amp; referrers</h2>
<div class="grid2">
  <div class="card">${table(["Page", "Views"], arr(d.topPages && d.topPages.fallback ? [] : d.topPages).map((r) => [esc(r.path), num(r.views)]))}</div>
  <div class="card">${table(["Referrer", "Views"], arr(d.topRef && d.topRef.fallback ? [] : d.topRef).map((r) => [esc(r.referrer_host), num(r.views)]))}</div>
</div>

<h2>Open GitHub issues</h2>
<div class="card">${table(["#", "Title", "Opened"],
  issues.map((i) => [`<a href="${esc(i.html_url)}" target="_blank">#${i.number}</a>`, esc(i.title), when(i.created_at)]))}${errNote(d.issues)}</div>

<p class="foot">Reads Supabase with your service_role key (local only). No admin page is deployed to nativize.dev.</p>
</body></html>`;
}

/* ---- Server (127.0.0.1 only) ---- */
const server = http.createServer(async (req, res) => {
  if (req.url === "/favicon.ico") { res.writeHead(204).end(); return; }
  try {
    const [totals, daily, support, feature, plans, activations, topPages, topRef, issues] = await Promise.all([
      safe(sb("admin_pageviews_totals"), [{}]),
      safe(sb("admin_pageviews_daily?limit=30"), []),
      safe(sb("support_requests?select=*&order=created_at.desc&limit=25"), []),
      safe(sb("feature_requests?select=*&order=created_at.desc&limit=25"), []),
      safe(sb("admin_plan_breakdown"), []),
      safe(sb("app_activations?select=created_at,plan_id,repo&order=created_at.desc&limit=25"), []),
      safe(sb("admin_top_pages?limit=15"), []),
      safe(sb("admin_top_referrers?limit=15"), []),
      githubIssues()
    ]);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(render({ totals, daily, support, feature, plans, activations, topPages, topRef, issues }));
  } catch (e) {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Dashboard error: " + e.message);
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`\n  Nativize dashboard → http://127.0.0.1:${PORT}\n  (local only — Ctrl+C to stop)\n`);
});
