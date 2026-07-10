#!/usr/bin/env node
/* ============================================================================
   Nativize admin portal — polished multi-page dashboard (local, WiFi-visible).
   Design fuses two references: clean KPI cards + "Ask" AI box + quick actions,
   and a grouped sidebar with sparklines, a contribution heatmap, and a donut.

   Data is live from Supabase (service_role key, this machine only). Free local
   AI via Ollama. No login (open on your LAN). Run: npm run dashboard
   ============================================================================ */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");

const ROOT = path.join(__dirname, "..");
const SUPABASE_URL = process.env.SUPABASE_URL || "https://gaaxcbarmiwtojblkkyh.supabase.co";
const PORT = Number(process.env.DASHBOARD_PORT || 8787);
const HOST = process.env.DASHBOARD_HOST || "0.0.0.0";

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
const OWNER = process.env.DASHBOARD_OWNER || "Sahib";
if (!SERVICE_KEY) { console.error("\n  Missing SUPABASE_SERVICE_ROLE_KEY in ~/nativize/.env.local.\n"); process.exit(1); }

/* ---- Persistent settings + worker logs (~/nativize/.dashboard-state.json, gitignored) ---- */
const STATE_FILE = process.env.DASHBOARD_STATE_FILE || path.join(ROOT, ".dashboard-state.json");
let state = { autoReply: true, logs: [], lastRun: {} };
try { state = Object.assign(state, JSON.parse(fs.readFileSync(STATE_FILE, "utf8"))) } catch (e) { /* first run */ }
function saveState() { try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); fs.chmodSync(STATE_FILE, 0o600); } catch (e) { console.error("state save:", e.message); } }
function log(worker, msg, ok) {
  state.logs.unshift({ t: new Date().toISOString(), worker, msg: String(msg).slice(0, 400), ok: ok !== false });
  state.logs = state.logs.slice(0, 80);
  saveState();
  console.log(`[${worker}] ${msg}`);
}

/* ---- data (2.5s micro-cache so 1-second live refresh doesn't hammer Supabase) ---- */
const sbCache = new Map();
async function sb(q) {
  const hit = sbCache.get(q);
  if (hit && Date.now() - hit.t < 2500) return hit.v;
  const res = await fetch(SUPABASE_URL + "/rest/v1/" + q, { headers: { apikey: SERVICE_KEY, Authorization: "Bearer " + SERVICE_KEY, Accept: "application/json" } });
  if (!res.ok) throw new Error(q.split("?")[0] + " → " + res.status + " " + (await res.text()).slice(0, 140));
  const v = await res.json();
  if (sbCache.size > 300) sbCache.clear();
  sbCache.set(q, { t: Date.now(), v });
  return v;
}
async function safe(p, fb) { try { return await p; } catch (e) { return { __error: e.message, fallback: fb }; } }
async function githubIssues() {
  if (!GITHUB_TOKEN) return { __error: "No GITHUB_TOKEN set (optional).", fallback: [] };
  try {
    const res = await fetch("https://api.github.com/repos/" + GITHUB_REPO + "/issues?state=open&per_page=30", { headers: { Authorization: "Bearer " + GITHUB_TOKEN, Accept: "application/vnd.github+json", "User-Agent": "nativize" } });
    if (!res.ok) throw new Error("GitHub " + res.status);
    return (await res.json()).filter((i) => !i.pull_request);
  } catch (e) { return { __error: e.message, fallback: [] }; }
}
async function sendReply(to, subject, text) {
  if (!RESEND_API_KEY || !SUPPORT_FROM_EMAIL) return { ok: false, error: "Email not configured. Add RESEND_API_KEY and SUPPORT_FROM_EMAIL to .env.local." };
  try {
    const res = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: "Bearer " + RESEND_API_KEY, "Content-Type": "application/json" }, body: JSON.stringify({ from: SUPPORT_FROM_EMAIL, to: [to], reply_to: SUPPORT_REPLY_TO, subject, text }) });
    if (!res.ok) return { ok: false, error: (await res.text()).slice(0, 300) };
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}
const AI_SYSTEM = `You are the support agent for Nativize (nativize.dev): a tool that turns Lovable, Vite, React and GitHub web apps into real native iOS/Android/Mac/Windows apps — it generates a standard Capacitor 8 project into the user's own GitHub repo and builds installable apps with GitHub Actions (iOS builds in the cloud, no Mac needed). Reply concisely and warmly, give clear next steps, ask for specifics only if needed, never invent refund/pricing policies or request secrets. Email body only, sign "— Sahib, Nativize".`;
async function ollama(prompt, sys) {
  const res = await fetch(OLLAMA_URL + "/api/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: OLLAMA_MODEL, prompt: (sys ? sys + "\n\n" : "") + prompt, stream: false, options: { temperature: 0.4 } }) });
  if (!res.ok) throw new Error("Local AI error " + res.status + " — is Ollama running? (open the Ollama app or run `ollama serve`)");
  return ((await res.json()).response || "").trim();
}
const aiDraft = (m, e) => ollama(`Customer email: ${e || "unknown"}\nCustomer message:\n"""${(m || "").slice(0, 4000)}"""\n\nReply:`, AI_SYSTEM);

/* ---- Supabase writes (service role, local only) ---- */
async function sbWrite(q, method, body, prefer) {
  const res = await fetch(SUPABASE_URL + "/rest/v1/" + q, {
    method,
    headers: { apikey: SERVICE_KEY, Authorization: "Bearer " + SERVICE_KEY, "Content-Type": "application/json", Prefer: prefer || "return=minimal" },
    body: body == null ? undefined : JSON.stringify(body)
  });
  sbCache.clear(); // any write invalidates the read micro-cache so the live refresh shows it immediately
  if (!res.ok) throw new Error(q.split("?")[0] + " " + method + " → " + res.status + " " + (await res.text()).slice(0, 200));
  const txt = await res.text();
  return txt ? JSON.parse(txt) : null;
}

/* ============================================================
   AI Support Worker — auto-replies to new support requests.
   Guardrails: never promises refunds/timelines, never invents
   features, honest sign-off, one reply per ticket, and Sahib
   always gets the thread (reply_to routes back to him).
   ============================================================ */
const AI_AUTO_SYSTEM = `You are the automated first-response support assistant for Nativize (nativize.dev). Nativize turns Lovable, Vite, React, and GitHub web apps into real native iOS/Android/Mac/Windows apps: it generates a standard Capacitor 8 project into the user's own GitHub repo and builds installable apps with GitHub Actions (iOS builds run in the cloud, no Mac needed). Facts you may use: generation runs in the browser; the user owns the generated code; App Store needs an Apple Developer account (US$99/yr) and Google Play a one-time US$25 account; build artifacts download from GitHub Actions.
STRICT RULES:
- NEVER promise refunds, discounts, cancellations, fixes, or timelines.
- NEVER invent features or capabilities. If you are not sure, say Sahib (the founder) will follow up personally.
- Never ask for passwords, API keys, or payment details.
- Be warm, concise (under 170 words), plain text, no markdown.
- End EXACTLY with:
— Nativize Support
(This is an automated first reply — Sahib will follow up personally if needed. Just reply to this email.)`;

let workerBusy = false;
async function runSupportWorker(trigger) {
  if (workerBusy) return { skipped: "already running" };
  if (!state.autoReply && trigger !== "manual") return { skipped: "auto-reply disabled" };
  workerBusy = true;
  const out = { replied: 0, skipped: 0, errors: 0 };
  try {
    const openRes = await safe(sb("support_requests?select=*&status=eq.open&order=created_at.asc&limit=5"), []);
    if (openRes && openRes.__error) {
      if (!state.migrationWarned) {
        log("support-worker", "waiting for DB migration 202607090001 — run it in the Supabase SQL editor to unlock AI auto-replies", false);
        state.migrationWarned = true; saveState();
      }
      workerBusy = false;
      return { skipped: "migration pending" };
    }
    state.migrationWarned = false;
    const open = arr(openRes);
    for (const r of open) {
      try {
        if (!r.email) { out.skipped++; log("support-worker", `#${String(r.id).slice(0, 8)} has no email — left open for manual handling`, true); continue; }
        const draft = await ollama(`Customer name: ${r.name || "unknown"}\nCustomer email: ${r.email}\nTopic: ${r.topic || "other"}\nMessage:\n"""${(r.message || "").slice(0, 4000)}"""\n\nWrite the reply now:`, AI_AUTO_SYSTEM);
        if (!draft || draft.length < 30) throw new Error("AI draft too short — not sending");
        const sent = await sendReply(r.email, "Re: your message to Nativize", draft);
        await sbWrite("support_replies", "POST", { request_id: r.id, author: "ai", body: draft, email_sent: !!sent.ok, email_error: sent.ok ? null : String(sent.error).slice(0, 400) });
        await sbWrite(`support_requests?id=eq.${r.id}`, "PATCH", { status: "replied", replied_at: new Date().toISOString(), updated_at: new Date().toISOString() });
        out.replied++;
        log("support-worker", `AI replied to ${r.email}${sent.ok ? " (email sent)" : " (email FAILED: " + sent.error + " — reply saved in-app)"}`, sent.ok);
      } catch (e) { out.errors++; log("support-worker", `error on ticket: ${e.message}`, false); }
    }
    if (!open.length && trigger === "manual") log("support-worker", "no open tickets — inbox clear", true);
  } finally {
    workerBusy = false;
    state.lastRun.support = new Date().toISOString();
    saveState();
  }
  return out;
}

/* ---- Daily Brief Worker ---- */
async function runDailyBrief() {
  const [t, plansEnts, sup, replies, acts, feats] = await Promise.all([
    safe(sb("admin_pageviews_totals"), [{}]),
    safe(sb("billing_entitlements?select=plan_id,billing"), []),
    safe(sb("support_requests?select=id,email,message,status,created_at&order=created_at.desc&limit=30"), []),
    safe(sb("support_replies?select=author,email_sent,created_at&order=created_at.desc&limit=50"), []),
    safe(sb("app_activations?select=created_at,plan_id&order=created_at.desc&limit=50"), []),
    safe(sb("feature_requests?select=created_at,message&order=created_at.desc&limit=20"), [])
  ]);
  const day = 864e5, now = Date.now();
  const T = arr(t)[0] || {};
  const supArr = arr(sup);
  const data = {
    views_today: T.views_today || 0, views_7d: T.views_7d || 0, unique_visitors: T.total_new_visitors || 0,
    support_open: supArr.filter((r) => r.status === "open").length,
    support_new_24h: supArr.filter((r) => now - new Date(r.created_at) < day).length,
    ai_replies_24h: arr(replies).filter((r) => r.author === "ai" && now - new Date(r.created_at) < day).length,
    email_failures: arr(replies).filter((r) => !r.email_sent).length,
    paid: arr(plansEnts).filter((e) => e.plan_id !== "free").length,
    mrr_cad: arr(plansEnts).filter((e) => e.plan_id === "pro").length * 29 + arr(plansEnts).filter((e) => e.plan_id === "max").length * 79,
    builds_24h: arr(acts).filter((a) => now - new Date(a.created_at) < day).length,
    feature_requests_7d: arr(feats).filter((f) => now - new Date(f.created_at) < 7 * day).length,
    newest_support: supArr.slice(0, 5).map((r) => ({ status: r.status, msg: (r.message || "").slice(0, 120) }))
  };
  const brief = await ollama(
    `DATA:\n${JSON.stringify(data, null, 1)}\n\nWrite the daily brief now:`,
    `You write a short daily business brief for Sahib, founder of Nativize. Use ONLY the DATA. Structure it as plain text: 1) one-line health summary, 2) "Needs attention:" bullet list (unanswered support, email failures, anything at 0 that shouldn't be), 3) "Numbers:" one compact line, 4) "Do next:" exactly 3 concrete recommended actions. No markdown symbols besides the dashes, under 200 words, no invented facts.`
  );
  await sbWrite("daily_briefs", "POST", { brief, data });
  state.lastRun.brief = new Date().toISOString();
  saveState();
  log("brief-worker", "daily brief generated (" + brief.length + " chars)", true);
  return brief;
}

/* ---- helpers ---- */
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const num = (n) => (n == null ? "—" : Number(n).toLocaleString("en-US"));
const when = (s) => (s ? new Date(s).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");
const arr = (x) => (Array.isArray(x) ? x : (x && Array.isArray(x.fallback) ? x.fallback : []));
const shortId = (u) => (u ? String(u).slice(0, 8) + "…" : "—");
function readBody(req) { return new Promise((r) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => r(d)); }); }
const parseForm = (s) => { const o = {}; new URLSearchParams(s).forEach((v, k) => (o[k] = v)); return o; };

/* ---- svg widgets (no libs) ---- */
function sparkline(vals, stroke) {
  vals = (vals || []).map(Number); if (vals.length < 2) vals = [0, 0];
  const w = 108, h = 34, max = Math.max(1, ...vals), min = Math.min(...vals);
  const rng = max - min || 1;
  const pts = vals.map((v, i) => `${(i / (vals.length - 1) * w).toFixed(1)},${(h - 3 - (v - min) / rng * (h - 6)).toFixed(1)}`).join(" ");
  const area = `0,${h} ${pts} ${w},${h}`;
  const id = "sg" + Math.random().toString(36).slice(2, 7);
  return `<svg viewBox="0 0 ${w} ${h}" class="spark" preserveAspectRatio="none"><defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${stroke}" stop-opacity=".28"/><stop offset="1" stop-color="${stroke}" stop-opacity="0"/></linearGradient></defs><polygon points="${area}" fill="url(#${id})"/><polyline points="${pts}" fill="none" stroke="${stroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}
function donut(paid, free) {
  const total = paid + free || 1, r = 52, c = 2 * Math.PI * r;
  const pPaid = paid / total, dashPaid = (c * pPaid).toFixed(1);
  return `<div class="donut-wrap"><svg viewBox="0 0 140 140" class="donut">
    <circle cx="70" cy="70" r="${r}" fill="none" stroke="var(--line)" stroke-width="16"/>
    <circle cx="70" cy="70" r="${r}" fill="none" stroke="url(#dg)" stroke-width="16" stroke-linecap="round" stroke-dasharray="${dashPaid} ${(c - dashPaid).toFixed(1)}" transform="rotate(-90 70 70)"/>
    <defs><linearGradient id="dg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7c3aed"/><stop offset="1" stop-color="#2563eb"/></linearGradient></defs>
    <text x="70" y="66" text-anchor="middle" class="donut-n">${num(paid + free)}</text><text x="70" y="86" text-anchor="middle" class="donut-l">customers</text></svg>
    <div class="donut-key"><span><i style="background:linear-gradient(135deg,#7c3aed,#2563eb)"></i>Paid ${num(paid)}</span><span><i style="background:var(--line)"></i>Testers ${num(free)}</span></div></div>`;
}
function heatmap(dayViews) {
  // 12 weeks × 7 days ending today (GitHub-style)
  const days = 84, today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const cells = [];
  let max = 1;
  for (let i = days - 1; i >= 0; i--) { const d = new Date(today); d.setUTCDate(d.getUTCDate() - i); const k = d.toISOString().slice(0, 10); const v = dayViews[k] || 0; if (v > max) max = v; cells.push({ k, v }); }
  const lvl = (v) => v === 0 ? 0 : Math.min(4, Math.ceil(v / max * 4));
  const cols = [];
  for (let w = 0; w < 12; w++) { const col = cells.slice(w * 7, w * 7 + 7).map((c) => `<i class="hc l${lvl(c.v)}" title="${c.k}: ${c.v} views"></i>`).join(""); cols.push(`<div class="hcol">${col}</div>`); }
  return `<div class="heat">${cols.join("")}</div><div class="heat-key">Less <i class="hc l0"></i><i class="hc l1"></i><i class="hc l2"></i><i class="hc l3"></i><i class="hc l4"></i> More</div>`;
}

/* ---- layout ---- */
const NAV = [
  ["", [["/", "Overview", "grid"], ["/jarvis", "Jarvis", "spark"]]],
  ["Analytics", [["/visitors", "Visitors", "chart"], ["/features", "Feature requests", "star"]]],
  ["Engagement", [["/support", "Support", "chat"]]],
  ["Customers", [["/paid", "Paid customers", "card"], ["/testers", "Testers", "beaker"]]],
  ["AI", [["/workers", "AI Workers", "bolt"], ["/brief", "Daily Brief", "doc"]]],
  ["Dev", [["/issues", "GitHub issues", "bug"]]],
  ["", [["/settings", "Settings", "gear"]]]
];
const ICO = {
  grid: "M3 3h8v8H3zM13 3h8v8h-8zM3 13h8v8H3zM13 13h8v8h-8z",
  bolt: "M13 2L3 14h7l-1 8 10-12h-7l1-8z",
  spark: "M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z",
  doc: "M6 2h9l5 5v15H6zM14 2v6h6M9 13h8M9 17h6",
  chart: "M3 3v18h18M7 14l3-4 3 3 4-6", star: "M12 3l2.5 6H21l-5 4 2 7-6-4.3L6 20l2-7-5-4h6.5z",
  chat: "M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z", card: "M3 5h18v14H3zM3 10h18",
  beaker: "M9 3h6M10 3v6l-5 9a2 2 0 002 3h10a2 2 0 002-3l-5-9V3", bug: "M12 2a10 10 0 100 20 10 10 0 000-20zM12 8v5M12 16h.01",
  gear: "M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 13a7.5 7.5 0 000-2l2-1.5-2-3.5-2.4 1a7 7 0 00-1.7-1L14 3h-4l-.3 2a7 7 0 00-1.7 1l-2.4-1-2 3.5L3.6 11a7.5 7.5 0 000 2l-2 1.5 2 3.5 2.4-1a7 7 0 001.7 1l.3 2h4l.3-2a7 7 0 001.7-1l2.4 1 2-3.5z"
};
function icon(n) { return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="${ICO[n] || ICO.grid}"/></svg>`; }

function layout(active, title, body, opts) {
  opts = opts || {};
  const groups = NAV.map(([g, items]) => `${g ? `<div class="nav-group">${esc(g)}</div>` : ""}${items.map(([h, l, ic]) => `<a class="nav-item${active === h ? " on" : ""}" href="${h}">${icon(ic)}<span>${l}</span></a>`).join("")}`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${esc(title)} · Nativize</title><style>
:root{--bg:#f4f5fa;--panel:#fff;--soft:#fafbff;--ink:#141824;--muted:#6b7386;--faint:#9aa1b4;--line:#e9ebf2;--brand:#7c3aed;--brand2:#2563eb;--accent:linear-gradient(135deg,#7c3aed,#2563eb);--green:#0f9d58;--greenb:#e7f6ee;--red:#e5484d;--redb:#fdeef0;--blue:#2f6bff;--blueb:#e9f0ff;--purple:#8b5cf6;--purpleb:#f1ecff;--chip:#f1f2f8;--shadow:0 1px 2px rgba(20,24,36,.04),0 8px 24px rgba(20,24,36,.05)}
@media(prefers-color-scheme:dark){:root{--bg:#0a0b11;--panel:#14161f;--soft:#171a24;--ink:#eef0fb;--muted:#8b90a6;--faint:#666c82;--line:#242737;--greenb:#12271c;--redb:#2a1418;--blueb:#0f1b34;--purpleb:#1d1633;--chip:#1b1e2a;--shadow:0 1px 2px rgba(0,0,0,.3),0 8px 24px rgba(0,0,0,.28)}}
*{box-sizing:border-box}html,body{margin:0}body{background:var(--bg);color:var(--ink);font:14.5px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Inter,system-ui,sans-serif;display:flex;min-height:100vh}
a{color:inherit;text-decoration:none}
.side{width:230px;flex:none;background:var(--panel);border-right:1px solid var(--line);padding:16px 12px;position:sticky;top:0;height:100vh;display:flex;flex-direction:column;gap:2px;overflow:auto}
.brand{display:flex;align-items:center;gap:10px;padding:8px 10px 14px;font-weight:750;font-size:16.5px;letter-spacing:-.02em}.brand .mk{width:28px;height:28px;border-radius:9px;background:var(--accent);box-shadow:0 4px 12px rgba(124,58,237,.4)}
.nav-group{font-size:10.5px;font-weight:700;letter-spacing:.12em;color:var(--faint);text-transform:uppercase;padding:14px 12px 5px}
.nav-item{display:flex;align-items:center;gap:11px;padding:8.5px 12px;border-radius:10px;color:var(--muted);font-weight:500}
.nav-item svg{width:18px;height:18px;flex:none}.nav-item:hover{background:var(--chip);color:var(--ink)}.nav-item.on{background:var(--accent);color:#fff;box-shadow:0 6px 16px rgba(124,58,237,.28)}
.user{margin-top:auto;display:flex;align-items:center;gap:10px;padding:11px 10px;border-top:1px solid var(--line)}
.user .av{width:34px;height:34px;border-radius:50%;background:var(--accent);color:#fff;display:grid;place-items:center;font-weight:700;font-size:13px}.user .nm{font-weight:600;font-size:13.5px}.user .rl{color:var(--muted);font-size:11.5px}
.main{flex:1;min-width:0;display:flex;flex-direction:column}
.top{display:flex;align-items:flex-end;justify-content:space-between;padding:22px 32px 18px;flex-wrap:wrap;gap:12px}
.top h1{font-size:23px;margin:0;letter-spacing:-.025em}.top .sub{color:var(--muted);font-size:13.5px;margin-top:3px}
.btn{border:1px solid var(--line);background:var(--panel);color:var(--ink);padding:8px 14px;border-radius:10px;font-weight:600;cursor:pointer;font-size:13.5px;display:inline-flex;align-items:center;gap:7px}.btn:hover{background:var(--chip)}.btn.pri{background:var(--accent);color:#fff;border:0;box-shadow:0 6px 16px rgba(124,58,237,.28)}.btn[disabled]{opacity:.5;cursor:default}
.live{display:inline-flex;align-items:center;gap:7px;font-size:12.5px;font-weight:600;color:var(--muted)}
.live i{width:9px;height:9px;border-radius:50%;background:var(--green);display:inline-block;opacity:.4;transition:opacity .2s;box-shadow:0 0 6px rgba(15,157,88,.6)}
.wrap{padding:2px 32px 34px;max-width:1180px;width:100%}
/* KPI cards */
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px}
.kpi{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:17px 18px;box-shadow:var(--shadow);position:relative;overflow:hidden}
.kpi .row1{display:flex;align-items:center;justify-content:space-between;gap:8px}
.kpi .lab{display:flex;align-items:center;gap:9px;font-weight:600;font-size:13.5px;color:var(--ink)}
.kpi .ic{width:30px;height:30px;border-radius:9px;display:grid;place-items:center}.kpi .ic svg{width:17px;height:17px}
.kpi .big{font-size:34px;font-weight:770;letter-spacing:-.03em;line-height:1}
.kpi .foot{display:flex;align-items:center;justify-content:space-between;margin-top:12px;gap:8px}
.kpi .trend{font-size:12.5px;font-weight:600}.up{color:var(--green)}.down{color:var(--red)}.flat{color:var(--muted)}
.kpi .spark{width:108px;height:34px}
.k-green .ic{background:var(--greenb);color:var(--green)}.k-red .ic{background:var(--redb);color:var(--red)}.k-blue .ic{background:var(--blueb);color:var(--blue)}.k-purple .ic{background:var(--purpleb);color:var(--purple)}
/* Ask box */
.ask{margin-top:22px;background:linear-gradient(135deg,rgba(124,58,237,.07),rgba(37,99,235,.06));border:1px solid var(--line);border-radius:18px;padding:18px}
.ask h3{margin:0 0 12px;font-size:15px;display:flex;align-items:center;gap:8px}
.ask .field{display:flex;gap:10px;background:var(--panel);border:1px solid var(--line);border-radius:13px;padding:6px 6px 6px 14px;align-items:center}
.ask input{flex:1;border:0;background:none;color:var(--ink);font:inherit;font-size:14.5px;outline:none;padding:10px 0}
.ask .send{background:var(--accent);color:#fff;border:0;border-radius:10px;width:40px;height:40px;cursor:pointer;font-size:17px}
.chips{display:flex;gap:9px;flex-wrap:wrap;margin-top:12px}.chip{background:var(--panel);border:1px solid var(--line);border-radius:999px;padding:8px 14px;font-size:13px;font-weight:500;cursor:pointer;color:var(--muted)}.chip:hover{color:var(--ink);border-color:var(--brand)}
.answer{margin-top:14px;background:var(--panel);border:1px solid var(--line);border-radius:13px;padding:15px 16px;white-space:pre-wrap;font-size:14px;display:none}
.answer.show{display:block}.answer.load{color:var(--muted)}
/* Jarvis control center */
.jvwrap{display:grid;grid-template-columns:minmax(0,1fr) 350px;gap:20px;align-items:start}
@media(max-width:1080px){.jvwrap{grid-template-columns:1fr}.jvside{order:2}}
.jvside{display:flex;flex-direction:column;gap:16px;position:sticky;top:16px;max-height:calc(100vh - 32px);overflow-y:auto}
@media(max-width:1080px){.jvside{position:static;max-height:none}}
.jvside .card{margin-top:0}
.jvside .bd{padding:6px 18px 16px}
.jvside .brief-txt{white-space:pre-wrap;font-size:13px;line-height:1.6;max-height:220px;overflow-y:auto;color:var(--ink)}
.jvside .mini{font-size:12.5px;color:var(--muted)}
.jvside .row{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;align-items:center}
.jvside .tick{display:flex;gap:9px;padding:8px 0;border-top:1px solid var(--line);font-size:13px;align-items:baseline}
.jvside .tick:first-of-type{border-top:0}
.jvside .tick .who{font-weight:600;white-space:nowrap;max-width:130px;overflow:hidden;text-overflow:ellipsis}
.jvside .tick .what{color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.jvside .logline{display:flex;gap:8px;padding:6px 0;border-top:1px solid var(--line);font-size:12.5px;align-items:baseline}
.jvside .logline:first-of-type{border-top:0}
.jvside .logline .t{color:var(--faint);white-space:nowrap}
.jvside .logline .m{color:var(--muted);overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
/* Jarvis chat */
.jv{display:flex;flex-direction:column;height:calc(100vh - 150px);max-width:860px}
.jvwrap .jv{max-width:none;min-width:0}
@media(max-width:1080px){.jvwrap .jv{height:auto;min-height:480px;max-height:calc(100vh - 150px)}}
.jv-log{flex:1;overflow-y:auto;padding:6px 2px 16px;display:flex;flex-direction:column;gap:14px}
.bubble{max-width:82%;padding:13px 16px;border-radius:16px;font-size:14.5px;line-height:1.55;white-space:pre-wrap;word-wrap:break-word}
.bubble.me{align-self:flex-end;background:var(--accent);color:#fff;border-bottom-right-radius:5px}
.bubble.ai{align-self:flex-start;background:var(--panel);border:1px solid var(--line);border-bottom-left-radius:5px;box-shadow:var(--shadow)}
.bubble.ai.load{color:var(--muted)}
.bubble .act{margin-top:12px;display:flex;gap:8px;flex-wrap:wrap}
.bubble .act button{border:0;border-radius:9px;padding:8px 14px;font-weight:600;font-size:13px;cursor:pointer}
.bubble .act .go{background:var(--accent);color:#fff}.bubble .act .no{background:var(--chip);color:var(--muted)}
.jv-hint{align-self:center;color:var(--faint);font-size:13px;text-align:center;margin:auto 0}
.jv-hint b{color:var(--ink)}
.jv-chips{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0}
.jv-bar{display:flex;gap:10px;background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:7px 7px 7px 16px;align-items:flex-end;box-shadow:var(--shadow)}
.jv-bar textarea{flex:1;border:0;background:none;color:var(--ink);font:inherit;font-size:14.5px;outline:none;resize:none;max-height:120px;padding:8px 0;line-height:1.4}
.jv-bar .send{background:var(--accent);color:#fff;border:0;border-radius:11px;width:44px;height:44px;flex:none;cursor:pointer;font-size:18px}
.jv-bar .send:disabled{opacity:.5}
/* Quick actions */
.qa{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px;margin-top:22px}
.qa a{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:16px;display:flex;align-items:center;gap:12px;font-weight:600;box-shadow:var(--shadow)}.qa a:hover{border-color:var(--brand)}
.qa .ic{width:34px;height:34px;border-radius:10px;background:var(--accent);color:#fff;display:grid;place-items:center}.qa .ic svg{width:18px;height:18px}
/* cards & tables */
.grid2{display:grid;grid-template-columns:1.3fr 1fr;gap:18px;margin-top:22px}@media(max-width:900px){.grid2{grid-template-columns:1fr}}
.card{background:var(--panel);border:1px solid var(--line);border-radius:16px;margin-top:22px;overflow:hidden;box-shadow:var(--shadow)}
.grid2 .card{margin-top:0}
.card .hd{display:flex;align-items:center;justify-content:space-between;padding:15px 18px 4px}
.card .hd h2{font-size:13px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin:0}
.card .hd a{font-size:12.5px;color:var(--brand);font-weight:600}
table{width:100%;border-collapse:collapse;font-size:13.5px}th,td{text-align:left;padding:11px 18px;border-top:1px solid var(--line);vertical-align:top}thead th{border-top:0;color:var(--faint);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.04em}tbody tr:hover{background:var(--soft)}
.muted{color:var(--muted)}.empty{padding:26px 18px;color:var(--muted)}
.pill{display:inline-block;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:600}.pill.ok{background:var(--greenb);color:var(--green)}.pill.warn{background:var(--redb);color:var(--red)}.pill.info{background:var(--blueb);color:var(--blue)}.pill.free{background:var(--chip);color:var(--muted)}.pill.hot{background:#fdeede;color:#b5641a}
.err{margin:10px 18px;color:var(--red);font-size:13px}.msg{max-width:520px;color:var(--muted);white-space:pre-wrap}
/* donut + heatmap */
.donut-wrap{padding:12px 18px 20px;text-align:center}.donut{width:150px;height:150px}.donut-n{fill:var(--ink);font-size:26px;font-weight:750}.donut-l{fill:var(--muted);font-size:11px}
.donut-key{display:flex;justify-content:center;gap:18px;margin-top:6px;font-size:12.5px;color:var(--muted)}.donut-key i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:6px;vertical-align:middle}
.heat{display:flex;gap:4px;padding:16px 18px 6px}.hcol{display:flex;flex-direction:column;gap:4px}.hc{width:13px;height:13px;border-radius:3px;background:var(--chip)}.hc.l1{background:#bfe3cd}.hc.l2{background:#7fd0a3}.hc.l3{background:#39b06f}.hc.l4{background:#0f9d58}
@media(prefers-color-scheme:dark){.hc.l1{background:#183a29}.hc.l2{background:#1f6640}.hc.l3{background:#2a935c}.hc.l4{background:#39d07f}}
.heat-key{display:flex;align-items:center;gap:4px;padding:0 18px 16px;font-size:11.5px;color:var(--muted)}.heat-key .hc{width:11px;height:11px}
/* reply */
details.reply{margin-top:8px}details.reply summary{cursor:pointer;color:var(--brand);font-weight:600;font-size:13px}
.reply textarea{width:100%;min-height:120px;margin-top:8px;border:1px solid var(--line);border-radius:11px;padding:11px;font:inherit;background:var(--soft);color:var(--ink);resize:vertical}
.reply input[type=text]{width:100%;border:1px solid var(--line);border-radius:10px;padding:9px 11px;font:inherit;background:var(--soft);color:var(--ink);margin-top:8px}
.reply .row{display:flex;gap:8px;align-items:center;margin-top:8px;flex-wrap:wrap}
.flash{margin:14px 32px 0;padding:11px 16px;border-radius:11px;font-size:13.5px}.flash.ok{background:var(--greenb);color:var(--green)}.flash.no{background:var(--redb);color:var(--red)}
@media(max-width:760px){.side{display:none}.wrap,.top{padding-left:16px;padding-right:16px}}
</style></head><body>
<nav class="side"><div class="brand"><span class="mk"></span> Nativize</div>${groups}
  <div class="user"><span class="av">${esc(OWNER.slice(0, 1).toUpperCase())}</span><div><div class="nm">${esc(OWNER)}</div><div class="rl">Admin · Nativize</div></div></div>
</nav>
<div class="main"><div class="top"><div><h1>${esc(title)}</h1>${opts.sub ? `<div class="sub">${esc(opts.sub)}</div>` : ""}</div><div style="display:flex;align-items:center;gap:12px"><span class="live" title="Live — updates every second"><i id="livedot"></i>Live</span><a class="btn" href="${active}">↻ Refresh</a></div></div>${opts.flash || ""}<div class="wrap">${body}</div></div>
<script>
async function aiDraft(btn){var f=btn.closest('form');var box=f.querySelector('textarea');btn.disabled=true;var t=btn.textContent;btn.textContent='✨ Drafting…';try{var r=await fetch('/api/ai-draft',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:f.querySelector('[name=srcmsg]').value,email:f.querySelector('[name=to]').value})});var j=await r.json();if(j.draft){box.value=j.draft;box.focus();}else{alert(j.error||'AI error');}}catch(e){alert('AI error: '+e.message);}btn.disabled=false;btn.textContent=t;}
function askChip(t){document.getElementById('askq').value=t;askSend();}
async function askSend(){var q=document.getElementById('askq').value.trim();if(!q)return;var a=document.getElementById('answer');a.className='answer show load';a.textContent='✨ Thinking…';try{var r=await fetch('/api/ask',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({question:q})});var j=await r.json();a.className='answer show';a.textContent=j.answer||j.error||'No answer.';}catch(e){a.className='answer show';a.textContent='AI error: '+e.message;}}
/* ---- Jarvis chat ---- */
var jvHist=[];
function jvEsc(s){return (s||'').replace(/[&<>]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;'}[c];});}
function jvAdd(role,text,action){var log=document.getElementById('jvlog');var hint=document.getElementById('jvhint');if(hint)hint.remove();var b=document.createElement('div');b.className='bubble '+(role==='me'?'me':'ai');b.innerHTML=jvEsc(text);if(action){var box=document.createElement('div');box.className='act';var go=document.createElement('button');go.className='go';go.textContent=action.label;go.onclick=function(){if(action.confirm&&!confirm(action.confirm))return;go.disabled=true;go.textContent='Working…';fetch(action.endpoint,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:action.body||''}).then(function(){go.textContent='✓ Done';jvSay('Done — '+action.label+'.');}).catch(function(e){go.textContent='Failed';});};box.appendChild(go);b.appendChild(box);}log.appendChild(b);log.scrollTop=log.scrollHeight;return b;}
function jvSay(t){var log=document.getElementById('jvlog');var b=document.createElement('div');b.className='bubble ai';b.innerHTML=jvEsc(t);log.appendChild(b);log.scrollTop=log.scrollHeight;}
function jvChip(t){var ta=document.getElementById('jvq');ta.value=t;jvSendMsg();}
async function jvSendMsg(){var ta=document.getElementById('jvq');var q=(ta.value||'').trim();if(!q)return;ta.value='';ta.style.height='auto';jvAdd('me',q);jvHist.push({role:'user',content:q});var load=jvAdd('ai','✨ Thinking…');load.classList.add('load');var btn=document.getElementById('jvsend');btn.disabled=true;
try{var r=await fetch('/api/jarvis',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:q,history:jvHist.slice(-8)})});var j=await r.json();load.remove();var ans=j.answer||j.error||'No answer.';jvAdd('ai',ans,j.action);jvHist.push({role:'assistant',content:ans});}
catch(e){load.remove();jvAdd('ai','⚠ '+e.message);}
btn.disabled=false;ta.focus();}
function jvKey(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();jvSendMsg();}var ta=e.target;ta.style.height='auto';ta.style.height=Math.min(120,ta.scrollHeight)+'px';}
/* Live refresh: refetches this page every second and repaints only when the data
   changed. Pauses while you're typing, have a reply open, or the Ask box is busy. */
(function(){
  var busy=false;
  setInterval(async function(){
    if(busy||document.hidden)return;
    if(document.querySelector('details[open]'))return;
    var ae=document.activeElement;
    if(ae&&(ae.tagName==='INPUT'||ae.tagName==='TEXTAREA'))return;
    var ans=document.getElementById('answer');
    if(ans&&ans.className.indexOf('show')>-1)return; /* keep AI answer on screen */
    /* On Jarvis, only the side cards refresh — the chat itself is never repainted. */
    var jvSide=document.querySelector('.jv')?document.getElementById('jvside'):null;
    if(document.querySelector('.jv')&&!jvSide)return;
    busy=true;
    try{
      var r=await fetch(location.pathname+location.search,{cache:'no-store'});
      if(r.ok){
        var d=new DOMParser().parseFromString(await r.text(),'text/html');
        if(jvSide){
          var ns=d.getElementById('jvside');
          if(ns&&ns.innerHTML!==jvSide.innerHTML)jvSide.innerHTML=ns.innerHTML;
        }else{
          var nw=d.querySelector('.wrap'),cur=document.querySelector('.wrap');
          if(nw&&cur&&nw.innerHTML!==cur.innerHTML)cur.innerHTML=nw.innerHTML;
        }
        var dot=document.getElementById('livedot');
        if(dot){dot.style.opacity='1';setTimeout(function(){dot.style.opacity='.4'},250);}
      }
    }catch(e){/* offline blip — try again next second */}
    busy=false;
  },1000);
})();
</script>
</body></html>`;
}
function kpi(tone, ic, label, value, foot, spark) {
  return `<div class="kpi k-${tone}"><div class="row1"><span class="lab"><span class="ic">${icon(ic)}</span>${esc(label)}</span><span class="big">${value}</span></div><div class="foot"><span class="trend ${foot.cls || "flat"}">${foot.text || ""}</span>${spark || ""}</div></div>`;
}
function tableEl(headers, rows, empty) {
  if (!rows.length) return `<div class="empty">${esc(empty || "Nothing here yet.")}</div>`;
  return `<table><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}
const errline = (x) => (x && x.__error ? `<div class="err">⚠ ${esc(x.__error)}</div>` : "");
function card(title, inner, link) { return `<div class="card"><div class="hd"><h2>${esc(title)}</h2>${link ? `<a href="${link[1]}">${esc(link[0])}</a>` : ""}</div>${inner}</div>`; }

async function activationMap() {
  const acts = arr(await safe(sb("app_activations?select=user_id,repo,plan_id,created_at&order=created_at.desc&limit=2000"), []));
  const m = new Map();
  for (const a of acts) { const e = m.get(a.user_id) || { count: 0, repos: new Set(), last: null, plan: a.plan_id }; e.count++; e.repos.add(a.repo); if (!e.last) e.last = a.created_at; e.plan = a.plan_id; m.set(a.user_id, e); }
  return m;
}

/* ============================ Pages ============================ */
async function pageOverview() {
  const [t, daily, support, ents, actMap, feats, recentActs] = await Promise.all([
    safe(sb("admin_pageviews_totals"), [{}]), safe(sb("admin_pageviews_daily?limit=120"), []),
    safe(sb("support_requests?select=*&order=created_at.desc&limit=6"), []),
    safe(sb("billing_entitlements?select=user_id,plan_id,billing&limit=1000"), []), activationMap(),
    safe(sb("feature_requests?select=created_at&limit=1000"), []),
    safe(sb("app_activations?select=created_at,plan_id,repo&order=created_at.desc&limit=8"), [])
  ]);
  const T = arr(t)[0] || {};
  const dayMap = {}; arr(daily).forEach((d) => (dayMap[d.day] = d.views));
  // last 14 days series for sparkline (oldest→newest)
  const series = []; const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  for (let i = 13; i >= 0; i--) { const d = new Date(today); d.setUTCDate(d.getUTCDate() - i); series.push(dayMap[d.toISOString().slice(0, 10)] || 0); }
  const yday = series[series.length - 2] || 0, tdy = series[series.length - 1] || 0;
  const pct = yday ? Math.round((tdy - yday) / yday * 100) : (tdy ? 100 : 0);
  const trendCls = pct > 0 ? "up" : pct < 0 ? "down" : "flat";
  const trendTxt = (pct > 0 ? "↑" : pct < 0 ? "↓" : "→") + " " + Math.abs(pct) + "% vs yesterday";
  // Consistent with Paid & Testers pages: paid from entitlements, testers from activity.
  const paid = arr(ents).filter((e) => e.plan_id !== "free").length;
  const testerIds = new Set();
  for (const [uid, e] of actMap) if (e.plan === "free") testerIds.add(uid);
  for (const e of arr(ents)) if (e.plan_id === "free") testerIds.add(e.user_id);
  const free = testerIds.size;
  const sup = arr(support);
  const supWeek = sup.filter((r) => Date.now() - new Date(r.created_at).getTime() < 7 * 864e5).length;
  // Revenue (CAD): pro $29/mo, max $79/mo, starter $12 one-time.
  const tier = { starter: 0, pro: 0, max: 0 };
  for (const e of arr(ents)) if (tier[e.plan_id] != null) tier[e.plan_id]++;
  const mrr = tier.pro * 29 + tier.max * 79;
  const oneTime = tier.starter * 12;
  const featCount = arr(feats).length;
  const views30 = T.views_30d || 0;

  const kpis = `<div class="kpis">
    ${kpi("green", "chart", "Views today", num(T.views_today), { cls: trendCls, text: trendTxt }, sparkline(series, "#0f9d58"))}
    ${kpi("red", "chat", "Support inbox", num(sup.length), { cls: supWeek ? "down" : "flat", text: supWeek ? supWeek + " new this week" : "all caught up" }, "")}
    ${kpi("blue", "beaker", "Testers", num(free), { cls: "flat", text: "free-plan builders" }, "")}
    ${kpi("purple", "card", "Paid customers", num(paid), { cls: "up", text: "$" + num(mrr) + " CAD/mo" }, "")}
    ${kpi("green", "star", "Feature requests", num(featCount), { text: "ideas from users" }, "")}
  </div>`;

  const ask = `<div class="ask"><h3>✨ Ask Nativize</h3>
    <div class="field"><input id="askq" placeholder="Ask about your support, testers, traffic, or draft a reply…" onkeydown="if(event.key==='Enter')askSend()"/><button class="send" onclick="askSend()">➤</button></div>
    <div class="chips">
      <span class="chip" onclick="askChip('Summarize my support inbox and what needs a reply')">🧾 Summarize support</span>
      <span class="chip" onclick="askChip('Who are my most active testers and what should I do about them?')">🔥 Top testers</span>
      <span class="chip" onclick="askChip('How is my website traffic trending?')">📈 Traffic trend</span>
      <span class="chip" onclick="askChip('Draft a friendly reply to my most recent support message')">✍️ Draft a reply</span>
    </div><div id="answer" class="answer"></div></div>`;

  const qa = `<div class="qa">
    <a href="/support"><span class="ic">${icon("chat")}</span>Answer support</a>
    <a href="/testers"><span class="ic">${icon("beaker")}</span>See frequent testers</a>
    <a href="/visitors"><span class="ic">${icon("chart")}</span>Traffic report</a>
    <a href="/paid"><span class="ic">${icon("card")}</span>Paid customers</a>
  </div>`;

  // Revenue + conversion funnel row
  const revCard = card("Revenue", `<div style="padding:18px">
    <div style="font-size:32px;font-weight:770;letter-spacing:-.02em">$${num(mrr)} <span style="font-size:14px;color:var(--muted);font-weight:500">CAD / month</span></div>
    <div style="color:var(--muted);margin-top:5px">recurring (Pro + Max) &nbsp;·&nbsp; + $${num(oneTime)} one-time</div>
    <div style="display:flex;gap:10px;margin-top:14px;flex-wrap:wrap">
      <span class="pill info">Pro × ${tier.pro}</span><span class="pill" style="background:var(--purpleb);color:var(--purple)">Max × ${tier.max}</span><span class="pill free">Starter × ${tier.starter}</span></div></div>`);
  const fnSteps = [["Visitors (30d)", views30, "#2f6bff"], ["Testers", free, "#7c3aed"], ["Paid customers", paid, "#0f9d58"]];
  const fnMax = Math.max(1, ...fnSteps.map((s) => s[1]));
  const fnRows = fnSteps.map(([l, v, c]) => `<div style="display:flex;align-items:center;gap:12px;margin:10px 0"><div style="width:112px;color:var(--muted);font-size:13px">${esc(l)}</div><div style="flex:1;height:22px;background:var(--chip);border-radius:7px;overflow:hidden"><div style="height:100%;width:${Math.max(4, v / fnMax * 100).toFixed(0)}%;background:${c};border-radius:7px"></div></div><div style="width:46px;text-align:right;font-weight:650">${num(v)}</div></div>`).join("");
  const conv = views30 ? (paid / views30 * 100).toFixed(1) : "0";
  const funnelCard = card("Conversion funnel", `<div style="padding:14px 18px 18px">${fnRows}<div style="color:var(--muted);font-size:12.5px;margin-top:6px">${conv}% of visitors became paying customers</div></div>`);
  const revRow = `<div class="grid2">${funnelCard}${revCard}</div>`;

  const activityCard = card("Recent activity", tableEl(["When", "Event", "Repo"], arr(recentActs).map((a) => [when(a.created_at), `<span class="pill ${a.plan_id === "free" ? "free" : "ok"}">${esc(a.plan_id)} build</span>`, esc(a.repo)]), "No app builds yet."));

  const left = card("Visitor activity", heatmap(dayMap) + errline(daily));
  const right = card("Plan distribution", donut(paid, free));
  const grid = `<div class="grid2">${left}${right}</div>`;

  const recent = card("Recent support", tableEl(["When", "From", "Message", "Status"],
    sup.slice(0, 6).map((r) => {
      const fresh = Date.now() - new Date(r.created_at).getTime() < 2 * 864e5;
      return [when(r.created_at), esc(r.email || "—"), `<span class="msg">${esc((r.message || r.body || "").slice(0, 90))}</span>`, `<span class="pill ${fresh ? "warn" : "info"}">${fresh ? "New" : "Seen"}</span>`];
    }), "No support messages yet."), ["Open support →", "/support"]);

  return { title: "Dashboard Overview", sub: "Welcome back, " + OWNER + " — here's what's happening.", body: kpis + ask + qa + revRow + grid + recent + activityCard };
}

async function pageSupport(qs) {
  const filter = (qs && qs.get("f")) || "all";
  const rows = arr(await safe(sb("support_requests?select=*&order=created_at.desc&limit=100"), []));
  const probe = await safe(sb("support_replies?select=id&limit=1"), []);
  const migrated = !(probe && probe.__error);
  const migBanner = migrated ? "" : `<div class="err" style="margin:0 0 14px;padding:12px 16px;border:1px solid var(--red);border-radius:12px">⚠ <b>One step pending:</b> run migration <code>202607090001</code> in the Supabase SQL editor to unlock AI auto-replies, ticket statuses, and reply threads. Until then you can read messages and reply manually via “Reply in Mail”.</div>`;
  // Fetch reply threads for the listed tickets.
  let replyMap = new Map();
  if (rows.length && rows[0].id !== undefined) {
    const ids = rows.map((r) => r.id).filter(Boolean).slice(0, 100);
    const reps = arr(await safe(sb(`support_replies?select=*&order=created_at.asc&request_id=in.(${ids.join(",")})`), []));
    for (const rep of reps) { const l = replyMap.get(rep.request_id) || []; l.push(rep); replyMap.set(rep.request_id, l); }
  }
  const counts = { all: rows.length, open: 0, pending: 0, replied: 0, closed: 0 };
  rows.forEach((r) => { const s = r.status || "open"; if (counts[s] != null) counts[s]++; });
  const shown = filter === "all" ? rows : rows.filter((r) => (r.status || "open") === filter);
  const emailReady = !!(RESEND_API_KEY && SUPPORT_FROM_EMAIL);
  const banner = emailReady ? "" : `<div class="err">In-portal “Send email” needs RESEND_API_KEY + SUPPORT_FROM_EMAIL in .env.local. “Reply in Mail” + AI drafting work now.</div>`;
  const filters = `<div class="chips" style="margin:0 0 16px">${["all", "open", "pending", "replied", "closed"].map((f) =>
    `<a class="chip" style="${f === filter ? "border-color:var(--brand);color:var(--ink)" : ""}" href="/support${f === "all" ? "" : "?f=" + f}">${f[0].toUpperCase() + f.slice(1)} (${counts[f]})</a>`).join("")}
    <span class="chip" style="margin-left:auto;border-style:dashed">AI auto-reply: <b style="color:${state.autoReply ? "var(--green)" : "var(--red)"};margin-left:4px">${state.autoReply ? "ON" : "OFF"}</b>&nbsp;· manage in AI Workers</span></div>`;
  const pillCls = { open: "warn", pending: "warn", replied: "info", closed: "ok" };
  const items = shown.map((r) => {
    const to = r.email || "", subj = "Re: your message to Nativize", body = (r.message || r.body || "");
    const st = r.status || "open";
    const mailto = to ? `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subj)}` : "";
    const thread = (replyMap.get(r.id) || []).map((rep) =>
      `<div style="margin-top:10px;padding:11px 13px;border-left:3px solid ${rep.author === "ai" ? "var(--purple)" : "var(--blue)"};background:var(--soft);border-radius:0 10px 10px 0">
        <div style="font-size:11.5px;color:var(--muted);margin-bottom:5px">${rep.author === "ai" ? "🤖 AI reply" : "👤 " + esc(OWNER)} · ${when(rep.created_at)} · ${rep.email_sent ? `<span class="pill ok">emailed</span>` : `<span class="pill warn" title="${esc(rep.email_error || "")}">email not sent</span>`}</div>
        <div class="msg" style="max-width:none">${esc(rep.body)}</div></div>`).join("");
    const statusBtns = st === "closed"
      ? `<form method="POST" action="/api/status" style="display:inline"><input type="hidden" name="id" value="${esc(r.id)}"/><input type="hidden" name="status" value="open"/><button class="btn" type="submit">Reopen</button></form>`
      : `<form method="POST" action="/api/status" style="display:inline" onsubmit="return confirm('Mark this support ticket resolved?')"><input type="hidden" name="id" value="${esc(r.id)}"/><input type="hidden" name="status" value="closed"/><button class="btn" type="submit">Mark resolved</button></form>`;
    const reply = to ? `<details class="reply"><summary>Reply</summary><form method="POST" action="/api/reply"><input type="hidden" name="to" value="${esc(to)}"/><input type="hidden" name="request_id" value="${esc(r.id)}"/><input type="hidden" name="srcmsg" value="${esc(body)}"/><input type="text" name="subject" value="${esc(subj)}"/><textarea name="text" placeholder="Write a reply… or click Draft with AI"></textarea><div class="row"><button class="btn" type="button" onclick="aiDraft(this)">✨ Draft with AI</button>${emailReady ? `<button class="btn pri" type="submit">Send email</button>` : `<button class="btn" type="submit" disabled>Send email (set up Resend)</button>`}<a class="btn" href="${mailto}">Reply in Mail</a></div></form></details>` : `<span class="muted">No email on file — cannot reply</span>`;
    return `<tr><td style="white-space:nowrap">${when(r.created_at)}<div style="margin-top:6px"><span class="pill ${pillCls[st] || "free"}">${esc(st)}</span></div></td><td>${esc(to || "—")}<div class="muted" style="font-size:12px">${esc(r.topic || "")}</div></td><td><span class="msg">${esc(body)}</span>${thread}<div class="row" style="display:flex;gap:8px;margin-top:10px;align-items:center;flex-wrap:wrap">${reply}${statusBtns}</div></td></tr>`;
  });
  const inner = shown.length ? `<table><thead><tr><th>When / status</th><th>From</th><th>Conversation</th></tr></thead><tbody>${items.join("")}</tbody></table>` : `<div class="empty">${filter === "all" ? "No support messages yet." : "No " + filter + " tickets."}</div>`;
  return { title: "Support", sub: (state.autoReply ? "AI auto-reply ON · " : "AI auto-reply OFF · ") + (emailReady ? "sending from " + SUPPORT_FROM_EMAIL : "email sending off"), body: migBanner + banner + filters + card(shown.length + " of " + rows.length + " tickets", inner) };
}

/* ---- AI Workers page ---- */
function pageWorkers() {
  const logRows = state.logs.slice(0, 30).map((l) => [when(l.t), `<span class="pill ${l.ok ? "info" : "warn"}">${esc(l.worker)}</span>`, `<span class="msg" style="max-width:none">${esc(l.msg)}</span>`]);
  const workerCard = (name, desc, enabled, lastRun, actions) => `<div class="card" style="margin-top:18px"><div class="hd"><h2>${esc(name)}</h2>${enabled}</div>
    <div style="padding:4px 18px 16px"><div class="muted">${esc(desc)}</div>
    <div class="muted" style="font-size:12.5px;margin-top:8px">Last run: ${lastRun ? when(lastRun) : "never"}</div>
    <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">${actions}</div></div></div>`;
  const supportToggle = `<form method="POST" action="/workers/toggle" style="display:inline" onsubmit="return confirm('${state.autoReply ? "Disable the support auto-reply worker?" : "Enable auto-reply? It can email real customers every 2 minutes while this portal runs."}')"><button class="btn" type="submit">${state.autoReply ? "✅ Enabled — click to disable" : "⛔ Disabled — click to enable"}</button></form>`;
  const body =
    workerCard("🤖 Support Worker", "Watches for new support tickets, writes a guard-railed reply with the free local AI, emails the customer, and records the reply on the ticket. Never promises refunds or timelines; flags anything uncertain for you.", supportToggle, state.lastRun.support,
      `<form method="POST" action="/workers/run" onsubmit="return confirm('Run now? This can email AI-written replies to real customers with open tickets.')"><input type="hidden" name="w" value="support"/><button class="btn pri" type="submit">▶ Run now</button></form><a class="btn" href="/support">Open support inbox</a>`) +
    workerCard("📋 Daily Brief Worker", "Summarizes the last 24h — support, replies, revenue, builds, traffic — and recommends 3 next actions. Stored in the database with full history.", `<span class="pill info">manual + on-demand</span>`, state.lastRun.brief,
      `<form method="POST" action="/workers/run"><input type="hidden" name="w" value="brief"/><button class="btn pri" type="submit">▶ Generate brief</button></form><a class="btn" href="/brief">View briefs</a>`) +
    card("Worker activity log", logRows.length ? tableEl(["When", "Worker", "Event"], logRows, "") : `<div class="empty">No worker runs yet — click “Run now” above.</div>`) +
    card("Integrations (honest status)", `<div style="padding:8px 18px 16px" class="muted">
      <div>✅ Local AI (Ollama · ${esc(OLLAMA_MODEL)}) — connected, free, private</div>
      <div>✅ Email (Resend) — ${RESEND_API_KEY && SUPPORT_FROM_EMAIL ? "connected, sending from " + esc(SUPPORT_FROM_EMAIL) : "<b style='color:var(--red)'>not configured</b>"}</div>
      <div>✅ Supabase — connected (server-side key, never in the browser)</div>
      <div>${GITHUB_TOKEN ? "✅" : "⚪"} GitHub issues — ${GITHUB_TOKEN ? "connected" : "add GITHUB_TOKEN to enable"}</div>
      <div>⚪ Stripe actions (cancel/refund) — not wired; billing changes stay manual in Stripe dashboard by design</div>
      <div>⚪ YouTube / desktop automation — not possible from this dashboard alone; needs OAuth or a helper app (ask me when you want it)</div></div>`);
  return { title: "AI Workers", sub: "Your automated team — every action is logged below.", body };
}

/* ---- Daily Brief page ---- */
async function pageBrief() {
  const briefs = arr(await safe(sb("daily_briefs?select=*&order=created_at.desc&limit=15"), []));
  const latest = briefs[0];
  const gen = `<form method="POST" action="/brief/run" style="margin-bottom:18px"><button class="btn pri" type="submit">✨ Generate today's brief</button>${latest ? `<span class="muted" style="margin-left:12px;font-size:13px">Last generated: ${when(latest.created_at)}</span>` : ""}</form>`;
  const latestCard = latest ? card("Latest brief · " + when(latest.created_at), `<div style="padding:6px 18px 18px;white-space:pre-wrap;line-height:1.65">${esc(latest.brief)}</div>`) : card("No briefs yet", `<div class="empty">Click “Generate today's brief” — the AI reads your live data and writes a summary with recommended actions.</div>`);
  const history = briefs.slice(1).map((b) => `<details style="border-top:1px solid var(--line);padding:12px 18px"><summary style="cursor:pointer;color:var(--muted)">${when(b.created_at)}</summary><div style="white-space:pre-wrap;margin-top:10px;line-height:1.6">${esc(b.brief)}</div></details>`).join("");
  const historyCard = briefs.length > 1 ? card("History", history) : "";
  return { title: "Daily Brief", sub: "AI summary of your business — stored with full history.", body: gen + latestCard + historyCard };
}
async function pageFeatures() {
  const rows = arr(await safe(sb("feature_requests?select=*&order=created_at.desc&limit=200"), []));
  return { title: "Feature requests", body: card(rows.length + " requests", tableEl(["When", "From", "Request"], rows.map((r) => [when(r.created_at), esc(r.email || "—"), `<span class="msg">${esc(r.message || r.body || r.title || "")}</span>`]), "No feature requests yet.")) };
}
async function pagePaid() {
  const [ents, custs, actMap] = await Promise.all([safe(sb("billing_entitlements?select=*&order=updated_at.desc&limit=500"), []), safe(sb("billing_customers?select=user_id,email"), []), activationMap()]);
  const emailBy = new Map(arr(custs).map((c) => [c.user_id, c.email]));
  const paid = arr(ents).filter((e) => e.plan_id !== "free");
  const kpis = `<div class="kpis">${kpi("purple", "card", "Paid customers", num(paid.length), { cls: "up", text: "total" }, "")}${kpi("blue", "chart", "Subscriptions", num(paid.filter((e) => e.billing === "subscription").length), { text: "recurring" }, "")}${kpi("green", "star", "One-time", num(paid.filter((e) => e.billing === "one-time").length), { text: "lifetime" }, "")}</div>`;
  const rows = paid.map((e) => { const a = actMap.get(e.user_id); return [esc(emailBy.get(e.user_id) || shortId(e.user_id)), `<span class="pill ok">${esc(e.plan_id)}</span>`, esc(e.billing), `<span class="pill ${e.status === "active" ? "ok" : "free"}">${esc(e.status)}</span>`, e.current_period_end ? when(e.current_period_end) : "—", a ? num(a.count) : "0"]; });
  return { title: "Paid customers", body: kpis + card("Paying customers", tableEl(["Customer", "Plan", "Billing", "Status", "Renews", "Apps built"], rows, "No paid customers yet.") + errline(ents)) };
}
async function pageTesters() {
  const [ents, custs, actMap] = await Promise.all([safe(sb("billing_entitlements?select=*&limit=1000"), []), safe(sb("billing_customers?select=user_id,email"), []), activationMap()]);
  const emailBy = new Map(arr(custs).map((c) => [c.user_id, c.email]));
  const ids = new Set(); for (const [uid, e] of actMap) if (e.plan === "free") ids.add(uid); for (const e of arr(ents)) if (e.plan_id === "free") ids.add(e.user_id);
  const testers = [...ids].map((uid) => { const a = actMap.get(uid) || { count: 0, repos: new Set(), last: null }; return { uid, email: emailBy.get(uid), count: a.count, repos: a.repos.size, last: a.last }; }).sort((x, y) => y.count - x.count);
  const frequent = testers.filter((t) => t.count >= 3);
  const kpis = `<div class="kpis">${kpi("blue", "beaker", "Total testers", num(testers.length), { text: "free plan" }, "")}${kpi("red", "star", "Frequent testers", num(frequent.length), { cls: frequent.length ? "up" : "flat", text: "3+ builds" }, "")}${kpi("green", "chart", "Test builds", num(testers.reduce((s, t) => s + t.count, 0)), { text: "all time" }, "")}</div>`;
  const row = (t) => [esc(t.email || shortId(t.uid)), t.count >= 3 ? `<span class="pill hot">${num(t.count)} builds</span>` : num(t.count), num(t.repos), when(t.last)];
  const note = `<div class="err" style="color:var(--muted)">Free-tester emails show only if they also have a billing record; an iOS-vs-Android split needs a platform field on app_activations — say the word and I'll add it.</div>`;
  return { title: "Testers", body: kpis + card("🔥 Frequent testers (most active)", tableEl(["Tester", "Test builds", "Apps", "Last active"], frequent.map(row), "No frequent testers yet.")) + card("All testers", tableEl(["Tester", "Test builds", "Apps", "Last active"], testers.map(row), "No testers yet.")) + note };
}
async function pageVisitors() {
  const [t, daily, pages, refs] = await Promise.all([safe(sb("admin_pageviews_totals"), [{}]), safe(sb("admin_pageviews_daily?limit=120"), []), safe(sb("admin_top_pages?limit=25"), []), safe(sb("admin_top_referrers?limit=25"), [])]);
  const T = arr(t)[0] || {}; const dayMap = {}; arr(daily).forEach((d) => (dayMap[d.day] = d.views));
  const kpis = `<div class="kpis">${kpi("green", "chart", "Views today", num(T.views_today), { text: num(T.new_visitors_today) + " new" }, "")}${kpi("blue", "chart", "7 days", num(T.views_7d), {}, "")}${kpi("purple", "chart", "30 days", num(T.views_30d), {}, "")}${kpi("red", "star", "Unique", num(T.total_new_visitors), { text: "visitors" }, "")}</div>`;
  return { title: "Visitors", body: kpis + card("Visitor activity — last 12 weeks", heatmap(dayMap)) + `<div class="grid2">${card("Top pages", tableEl(["Page", "Views"], arr(pages).map((r) => [esc(r.path), num(r.views)]), "—"))}${card("Top referrers", tableEl(["Referrer", "Views"], arr(refs).map((r) => [esc(r.referrer_host), num(r.views)]), "No referrers yet."))}</div>` };
}
async function pageIssues() {
  const issues = await githubIssues(); const list = arr(issues);
  return { title: "GitHub issues", body: card(list.length + " open", tableEl(["#", "Title", "Opened"], list.map((i) => [`<a href="${esc(i.html_url)}" target="_blank" rel="noopener">#${i.number}</a>`, esc(i.title), when(i.created_at)]), GITHUB_TOKEN ? "No open issues." : "Add GITHUB_TOKEN to .env.local to show issues.") + errline(issues)) };
}
function pageSettings() {
  const emailReady = !!(RESEND_API_KEY && SUPPORT_FROM_EMAIL);
  return { title: "Settings", body:
    card("Access", `<div class="empty">No login (open on your WiFi). Anyone on your WiFi can view this. Ask me to add a lock anytime.</div>`) +
    card("AI", `<div class="empty">Free local AI via Ollama · model <b style="color:var(--ink)">${esc(OLLAMA_MODEL)}</b>. Nothing goes to a paid API. Powers the Ask box and reply drafts.</div>`) +
    card("Email sending", `<div class="empty">Reply-by-email: <b style="color:${emailReady ? "var(--green)" : "var(--red)"}">${emailReady ? "ON — " + esc(SUPPORT_FROM_EMAIL) : "OFF"}</b>. ${emailReady ? "" : "Add RESEND_API_KEY + SUPPORT_FROM_EMAIL to .env.local to enable in-portal sending."}</div>`) };
}

/* ---- Ask AI context ---- */
async function askAI(question) {
  const [t, support, plans, actMap] = await Promise.all([safe(sb("admin_pageviews_totals"), [{}]), safe(sb("support_requests?select=email,message,created_at&order=created_at.desc&limit=8"), []), safe(sb("admin_plan_breakdown"), []), activationMap()]);
  const T = arr(t)[0] || {}; const P = arr(plans);
  const paid = P.filter((p) => p.plan_id !== "free").reduce((a, p) => a + (p.customers || 0), 0);
  const free = P.filter((p) => p.plan_id === "free").reduce((a, p) => a + (p.customers || 0), 0);
  const testers = [...actMap.values()].filter((e) => e.plan === "free").sort((a, b) => b.count - a.count);
  const ctx = `DATA (Nativize admin):
- Views: today ${T.views_today || 0}, 7d ${T.views_7d || 0}, 30d ${T.views_30d || 0}, unique visitors ${T.total_new_visitors || 0}.
- Customers: ${paid} paid, ${free} free testers.
- Frequent testers (3+ builds): ${testers.filter((t) => t.count >= 3).length}. Top tester build counts: ${testers.slice(0, 5).map((t) => t.count).join(", ") || "none"}.
- Recent support messages (newest first):
${arr(support).map((s, i) => `  ${i + 1}. [${new Date(s.created_at).toLocaleDateString()}] ${s.email || "?"}: ${(s.message || "").slice(0, 220)}`).join("\n") || "  none"}`;
  const sys = "You are the analytics + support assistant inside the Nativize admin dashboard. Answer the owner's question briefly and practically using ONLY the DATA provided. If asked to draft a support reply, write a warm concise email body signed '— Sahib, Nativize'. Use plain text.";
  return ollama(ctx + "\n\nQuestion: " + question + "\n\nAnswer:", sys);
}

/* ============================ Jarvis ============================ */
async function jarvisContext() {
  const [t, ents, openTickets, recentSup, feats, acts, briefs] = await Promise.all([
    safe(sb("admin_pageviews_totals"), [{}]),
    safe(sb("billing_entitlements?select=plan_id,billing,status"), []),
    safe(sb("support_requests?select=id,email,message,status,created_at&order=created_at.desc&limit=25"), []),
    safe(sb("support_requests?select=email,message,status,created_at&order=created_at.desc&limit=6"), []),
    safe(sb("feature_requests?select=message,created_at&order=created_at.desc&limit=8"), []),
    safe(sb("app_activations?select=plan_id,created_at&order=created_at.desc&limit=60"), []),
    safe(sb("daily_briefs?select=brief,created_at&order=created_at.desc&limit=1"), [])
  ]);
  const T = arr(t)[0] || {}; const E = arr(ents);
  const paid = E.filter((e) => e.plan_id !== "free").length;
  const mrr = E.filter((e) => e.plan_id === "pro").length * 29 + E.filter((e) => e.plan_id === "max").length * 79;
  const open = arr(openTickets).filter((r) => (r.status || "open") === "open");
  const day = 864e5, now = Date.now();
  const latestBrief = arr(briefs)[0];
  return {
    open, openCount: open.length,
    text: `LIVE DATA (Nativize admin, ${new Date().toLocaleString()}):
- Traffic: ${T.views_today || 0} views today, ${T.views_7d || 0} in 7d, ${T.total_new_visitors || 0} unique visitors all-time.
- Customers: ${paid} paid, MRR ~$${mrr} CAD/mo. App builds in last 24h: ${arr(acts).filter((a) => now - new Date(a.created_at) < day).length}.
- Support: ${open.length} OPEN tickets, ${arr(openTickets).length} total recent.
- Newest support (newest first):
${arr(recentSup).map((s, i) => `  ${i + 1}. [${s.status || "open"}] ${s.email || "?"}: ${(s.message || "").slice(0, 160)}`).join("\n") || "  none"}
- Recent feature requests: ${arr(feats).map((f) => (f.message || "").slice(0, 60)).filter(Boolean).join(" | ") || "none"}
- Latest daily brief${latestBrief ? ` (${new Date(latestBrief.created_at).toLocaleString()}):\n${(latestBrief.brief || "").slice(0, 900)}` : ": none generated yet — offer to generate one."}`
  };
}
const JARVIS_SYS = `You are Jarvis, the AI operations assistant inside Sahib's Nativize admin dashboard (nativize.dev — a tool that turns Lovable/Vite/React/GitHub web apps into native iOS/Android/Mac/Windows apps via Capacitor + GitHub Actions). You help Sahib run the business. Use ONLY the LIVE DATA provided — never invent numbers, users, refunds, or capabilities. Be concise, direct, and practical (usually under 160 words), plain text, no markdown symbols. When asked to draft something (reply, push notification, marketing, checklist), write it cleanly, label it as a draft, and never promise refunds, delivery timelines, or guarantees without a stated business policy. If asked to do something you cannot verify or that would message/charge users, say it needs Sahib's explicit approval and explain the safe way to do it. If you don't have the data, say so.`;

async function jarvisRespond(message, history) {
  const m = (message || "").toLowerCase();
  const ctx = await jarvisContext();
  // Action intent: generate the daily brief (safe: read + store).
  if (/\b(daily brief|today'?s brief|generate.*brief|make.*brief|run.*brief)\b/.test(m)) {
    const b = await runDailyBrief();
    return { answer: "Done — I generated today's brief and saved it:\n\n" + b };
  }
  // Drafting is read-only. It must never fall through to the send-replies action.
  if (/\bdraft\b.*\b(reply|response|email)\b|\b(reply|response|email)\b.*\bdraft\b/.test(m)) {
    const ticket = ctx.open[0];
    if (!ticket) return { answer: "Your support inbox is clear — there is no open ticket to draft a reply for." };
    const answer = await ollama(
      ctx.text + `\n\nWrite a concise support reply DRAFT for this ticket only:\nCustomer: ${ticket.email || "unknown"}\nIssue: ${(ticket.message || "").slice(0, 1200)}\n\nDo not send it. Label it DRAFT. Do not promise a refund, timeline, or guarantee.`,
      JARVIS_SYS
    );
    return { answer };
  }
  // Sensitive intent: send AI replies to open tickets (emails customers) → require a confirm button.
  if (/\b(reply|answer|respond|auto.?reply|clear).*(ticket|support|inbox)\b|\brun.*support\b|\breply to (them|everyone|all)\b/.test(m)) {
    if (!ctx.openCount) return { answer: "Your support inbox is clear — there are no open tickets to reply to right now." };
    return {
      answer: `You have ${ctx.openCount} open ticket${ctx.openCount === 1 ? "" : "s"}. I can have the AI write and email a reply to each one. That sends real emails to customers, so it needs your go-ahead.`,
      action: { label: `Send AI replies to ${ctx.openCount} ticket${ctx.openCount === 1 ? "" : "s"}`, endpoint: "/workers/run", body: "w=support", confirm: `Send AI-written replies (real emails) to ${ctx.openCount} customer${ctx.openCount === 1 ? "" : "s"}?` }
    };
  }
  // Everything else: conversational answer grounded in live data.
  const hist = arr(history).map((h) => `${h.role === "user" ? "Sahib" : "Jarvis"}: ${h.content}`).join("\n");
  const answer = await ollama(ctx.text + (hist ? "\n\nConversation so far:\n" + hist : "") + "\n\nSahib: " + message + "\nJarvis:", JARVIS_SYS);
  return { answer };
}

async function pageJarvis() {
  const [briefsRes, supRes] = await Promise.all([
    safe(sb("daily_briefs?select=brief,created_at&order=created_at.desc&limit=5"), []),
    safe(sb("support_requests?select=id,email,message,status,created_at&order=created_at.desc&limit=20"), [])
  ]);
  const briefs = arr(briefsRes);
  const latest = briefs[0];
  const sup = arr(supRes);
  const open = sup.filter((r) => (r.status || "open") === "open");

  const chips = [
    "What changed today?",
    "What should I focus on?",
    "Summarize support issues",
    "What should I fix next?",
    "Draft a reply to my newest ticket"
  ];
  const chat = `<div class="jv">
    <div class="jv-chips">${chips.map((c) => `<span class="chip" onclick="jvChip('${c.replace(/'/g, "\\'")}')">${esc(c)}</span>`).join("")}</div>
    <div class="jv-log" id="jvlog">
      <div class="jv-hint" id="jvhint">👋 Hi ${esc(OWNER)}, I'm <b>Jarvis</b> — your AI control center.<br>Ask about support, customers, traffic, revenue, or the daily brief — or tell me to draft replies, notifications, and plans.<br><span style="font-size:12px">Free &amp; private · runs on your Mac with Ollama · I ask before anything that emails or charges people.</span></div>
    </div>
    <div class="jv-bar"><textarea id="jvq" rows="1" placeholder="Message Jarvis…  (Enter to send, Shift+Enter for newline)" onkeydown="jvKey(event)"></textarea><button class="send" id="jvsend" onclick="jvSendMsg()">➤</button></div>
  </div>`;

  /* --- Today's Brief card --- */
  const briefBody = latest
    ? `<div class="mini" style="margin-bottom:8px">Latest: ${when(latest.created_at)}</div><div class="brief-txt">${esc(latest.brief)}</div>`
    : `<div class="mini">No brief yet today — generate one and Jarvis can answer “what changed today?”.</div>`;
  const briefHistory = briefs.length > 1
    ? `<div class="mini" style="margin-top:10px">History: ${briefs.slice(1, 4).map((b) => `<a href="/brief" style="color:var(--brand);font-weight:600">${when(b.created_at)}</a>`).join(" · ")}</div>` : "";
  const briefCard = `<div class="card"><div class="hd"><h2>📋 Today's Brief</h2><a href="/brief">All briefs →</a></div><div class="bd">
    ${briefBody}${briefHistory}
    <div class="row"><form method="POST" action="/brief/run"><input type="hidden" name="back" value="/jarvis"/><button class="btn pri" type="submit">✨ Generate today's brief</button></form>
    <span class="chip" onclick="jvChip('What should I focus on based on the latest brief?')">Ask Jarvis about it</span></div></div></div>`;

  /* --- AI Workers card (one real worker — no fakes) --- */
  const lastWorkerLog = state.logs.find((l) => l.worker === "support-worker");
  const workerErr = lastWorkerLog && lastWorkerLog.ok === false;
  const wStatus = workerBusy ? ["running…", "info"] : workerErr ? ["error", "warn"] : state.autoReply ? ["enabled", "ok"] : ["disabled", "free"];
  const workerLogs = state.logs.filter((l) => l.worker === "support-worker").slice(0, 3);
  const workersCard = `<div class="card"><div class="hd"><h2>🤖 AI Workers</h2><a href="/workers">Details →</a></div><div class="bd">
    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px"><b style="font-size:13.5px">Support Auto-Reply</b><span class="pill ${wStatus[1]}">${wStatus[0]}</span></div>
    <div class="mini" style="margin-top:6px">Emails a guard-railed AI first reply to new support tickets. Auto-checks every 2 minutes while the portal runs.</div>
    <div class="mini" style="margin-top:6px">Last run: ${state.lastRun.support ? when(state.lastRun.support) : "never"}${state.autoReply ? " · next: within 2 min" : ""}</div>
    ${workerLogs.length ? `<div style="margin-top:8px">${workerLogs.map((l) => `<div class="logline"><span class="t">${when(l.t)}</span><span class="m">${l.ok ? "" : "⚠ "}${esc(l.msg)}</span></div>`).join("")}</div>` : ""}
    <div class="row">
      <form method="POST" action="/workers/run" onsubmit="return confirm('Run the support worker now? It emails real customers with AI replies to every open ticket.')"><input type="hidden" name="w" value="support"/><input type="hidden" name="back" value="/jarvis"/><button class="btn" type="submit">▶ Run now</button></form>
      <form method="POST" action="/workers/toggle" onsubmit="return confirm('${state.autoReply ? "Disable the support auto-reply worker?" : "Enable auto-reply? It can email real customers every 2 minutes while this portal runs."}')"><input type="hidden" name="back" value="/jarvis"/><button class="btn" type="submit">${state.autoReply ? "Disable" : "Enable"}</button></form>
    </div>
    <div class="mini" style="margin-top:10px;color:var(--faint)">More workers (marketing, churn-watch) — coming soon, not active.</div></div></div>`;

  /* --- Support Queue card --- */
  const queueRows = open.slice(0, 3).map((r) => `<div class="tick"><span class="who">${esc(r.email || "no email")}</span><span class="what">${esc((r.message || "").slice(0, 70))}</span></div>`).join("");
  const supportCard = `<div class="card"><div class="hd"><h2>💬 Support Queue</h2><a href="/support">Inbox →</a></div><div class="bd">
    <div style="font-size:26px;font-weight:770;letter-spacing:-.02em">${num(open.length)} <span style="font-size:13px;color:var(--muted);font-weight:500">open ticket${open.length === 1 ? "" : "s"}</span></div>
    ${queueRows || `<div class="mini" style="margin-top:6px">Inbox clear — nothing waiting. 🎉</div>`}
    <div class="row"><span class="chip" onclick="jvChip('Summarize my open support tickets and what each customer needs')">Summarize</span><span class="chip" onclick="jvChip('Draft a reply to my newest open ticket')">Draft reply</span></div></div></div>`;

  /* --- Recent Actions card --- */
  const recent = state.logs.slice(0, 6);
  const actionsCard = `<div class="card"><div class="hd"><h2>🕒 Recent Actions</h2><a href="/workers">Full log →</a></div><div class="bd">
    ${recent.length ? recent.map((l) => `<div class="logline"><span class="t">${when(l.t)}</span><span class="m">${l.ok ? "" : "⚠ "}<b>${esc(l.worker)}</b> — ${esc(l.msg)}</span></div>`).join("") : `<div class="mini">No actions yet — everything Jarvis and the workers do shows up here.</div>`}</div></div>`;

  const body = `<div class="jvwrap">${chat}<aside class="jvside" id="jvside">${briefCard}${workersCard}${supportCard}${actionsCard}</aside></div>`;
  return { title: "Jarvis", sub: "Your AI control center — chat, daily brief, workers, and support in one place. Sensitive actions always ask first.", body };
}

/* ============================ Router ============================ */
const PAGES = { "/": pageOverview, "/jarvis": async () => pageJarvis(), "/support": pageSupport, "/features": pageFeatures, "/paid": pagePaid, "/testers": pageTesters, "/visitors": pageVisitors, "/issues": pageIssues, "/workers": async () => pageWorkers(), "/brief": pageBrief, "/settings": async () => pageSettings() };
function send(res, code, html) { res.writeHead(code, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Frame-Options": "DENY" }); res.end(html); }
function json(res, obj) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); }
function redirect(res, to) { res.writeHead(302, { Location: to }); res.end(); }

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  const p = u.pathname;
  if (p === "/favicon.ico") { res.writeHead(204).end(); return; }
  if (p === "/api/ai-draft" && req.method === "POST") { try { const b = JSON.parse(await readBody(req) || "{}"); json(res, { draft: await aiDraft(b.message || "", b.email || "") }); } catch (e) { json(res, { error: e.message }); } return; }
  if (p === "/api/ask" && req.method === "POST") { try { const b = JSON.parse(await readBody(req) || "{}"); json(res, { answer: await askAI((b.question || "").slice(0, 500)) }); } catch (e) { json(res, { error: e.message }); } return; }
  if (p === "/api/jarvis" && req.method === "POST") { try { const b = JSON.parse(await readBody(req) || "{}"); json(res, await jarvisRespond((b.message || "").slice(0, 1000), b.history)); } catch (e) { json(res, { error: e.message }); } return; }

  if (p === "/api/reply" && req.method === "POST") {
    const f = parseForm(await readBody(req));
    const to = (f.to || "").trim(), text = (f.text || "").trim(), subject = (f.subject || "Re: your message to Nativize").trim();
    let flash;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) flash = `<div class="flash no">Invalid recipient email.</div>`;
    else if (!text) flash = `<div class="flash no">Reply was empty.</div>`;
    else {
      const r = await sendReply(to, subject, text);
      flash = r.ok ? `<div class="flash ok">✓ Reply sent to ${esc(to)}.</div>` : `<div class="flash no">Could not send: ${esc(r.error)}</div>`;
      // Record the manual reply on the ticket thread (best-effort — email already went out).
      if (f.request_id) {
        try {
          await sbWrite("support_replies", "POST", { request_id: f.request_id, author: "admin", body: text, email_sent: !!r.ok, email_error: r.ok ? null : String(r.error).slice(0, 400) });
          await sbWrite(`support_requests?id=eq.${f.request_id}`, "PATCH", { status: "replied", replied_at: new Date().toISOString(), updated_at: new Date().toISOString() });
          log("admin", `manual reply to ${to}${r.ok ? " (emailed)" : " (email failed)"}`, r.ok);
        } catch (e) { flash += `<div class="flash no">Reply sent but not recorded on the ticket: ${esc(e.message)} — run the new DB migration.</div>`; }
      }
    }
    const pg = await pageSupport(u.searchParams); return send(res, 200, layout("/support", pg.title, pg.body, { sub: pg.sub, flash }));
  }

  if (p === "/api/status" && req.method === "POST") {
    const f = parseForm(await readBody(req));
    const status = (f.status || "").trim();
    if (f.id && ["open", "pending", "replied", "closed"].includes(status)) {
      try {
        await sbWrite(`support_requests?id=eq.${encodeURIComponent(f.id)}`, "PATCH", { status, updated_at: new Date().toISOString() });
        log("admin", `ticket ${String(f.id).slice(0, 8)} → ${status}`, true);
      } catch (e) { log("admin", `status change failed: ${e.message}`, false); }
    }
    return redirect(res, "/support");
  }

  const safeBack = (f, fb) => (["/jarvis", "/workers", "/brief", "/support", "/"].includes(f.back) ? f.back : fb);
  if (p === "/workers/toggle" && req.method === "POST") {
    const f = parseForm(await readBody(req));
    state.autoReply = !state.autoReply; saveState();
    log("support-worker", "auto-reply turned " + (state.autoReply ? "ON" : "OFF") + " by " + OWNER, true);
    return redirect(res, safeBack(f, "/workers"));
  }
  if ((p === "/workers/run" || p === "/brief/run") && req.method === "POST") {
    const f = parseForm(await readBody(req));
    const which = p === "/brief/run" ? "brief" : (f.w || "support");
    try {
      if (which === "brief") await runDailyBrief();
      else { const r = await runSupportWorker("manual"); log("support-worker", `manual run: ${r.replied || 0} replied, ${r.skipped || 0} skipped, ${r.errors || 0} errors`, !r.errors); }
    } catch (e) { log(which === "brief" ? "brief-worker" : "support-worker", "run failed: " + e.message, false); }
    return redirect(res, safeBack(f, which === "brief" ? "/brief" : "/workers"));
  }

  const handler = PAGES[p];
  if (!handler) return send(res, 404, layout("/", "Not found", card("", `<div class="empty">Page not found. <a href="/">Overview</a></div>`)));
  try { const pg = await handler(u.searchParams); return send(res, 200, layout(p, pg.title, pg.body, { sub: pg.sub })); }
  catch (e) { return send(res, 500, layout(p, "Error", card("", `<div class="err">⚠ ${esc(e.message)}</div>`))); }
});

/* ---- Background loop: check for new support tickets every 2 minutes ---- */
setTimeout(() => runSupportWorker("interval").catch((e) => log("support-worker", "startup run failed: " + e.message, false)), 15000);
setInterval(() => runSupportWorker("interval").catch((e) => log("support-worker", "interval run failed: " + e.message, false)), 120000);
server.listen(PORT, HOST, () => {
  const ips = []; const ni = os.networkInterfaces();
  for (const k of Object.keys(ni)) for (const a of ni[k]) if (a.family === "IPv4" && !a.internal) ips.push(a.address);
  console.log(`\n  Nativize portal running.`);
  console.log(`  • This Mac:  http://127.0.0.1:${PORT}`);
  ips.forEach((ip) => console.log(`  • WiFi:      http://${ip}:${PORT}`));
  console.log("");
});
