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

/* ---- data ---- */
async function sb(q) {
  const res = await fetch(SUPABASE_URL + "/rest/v1/" + q, { headers: { apikey: SERVICE_KEY, Authorization: "Bearer " + SERVICE_KEY, Accept: "application/json" } });
  if (!res.ok) throw new Error(q.split("?")[0] + " → " + res.status + " " + (await res.text()).slice(0, 140));
  return res.json();
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
  ["", [["/", "Overview", "grid"]]],
  ["Analytics", [["/visitors", "Visitors", "chart"], ["/features", "Feature requests", "star"]]],
  ["Engagement", [["/support", "Support", "chat"]]],
  ["Customers", [["/paid", "Paid customers", "card"], ["/testers", "Testers", "beaker"]]],
  ["Dev", [["/issues", "GitHub issues", "bug"]]],
  ["", [["/settings", "Settings", "gear"]]]
];
const ICO = {
  grid: "M3 3h8v8H3zM13 3h8v8h-8zM3 13h8v8H3zM13 13h8v8h-8z",
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
<div class="main"><div class="top"><div><h1>${esc(title)}</h1>${opts.sub ? `<div class="sub">${esc(opts.sub)}</div>` : ""}</div><div><a class="btn" href="${active}">↻ Refresh</a></div></div>${opts.flash || ""}<div class="wrap">${body}</div></div>
<script>
async function aiDraft(btn){var f=btn.closest('form');var box=f.querySelector('textarea');btn.disabled=true;var t=btn.textContent;btn.textContent='✨ Drafting…';try{var r=await fetch('/api/ai-draft',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:f.querySelector('[name=srcmsg]').value,email:f.querySelector('[name=to]').value})});var j=await r.json();if(j.draft){box.value=j.draft;box.focus();}else{alert(j.error||'AI error');}}catch(e){alert('AI error: '+e.message);}btn.disabled=false;btn.textContent=t;}
function askChip(t){document.getElementById('askq').value=t;askSend();}
async function askSend(){var q=document.getElementById('askq').value.trim();if(!q)return;var a=document.getElementById('answer');a.className='answer show load';a.textContent='✨ Thinking…';try{var r=await fetch('/api/ask',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({question:q})});var j=await r.json();a.className='answer show';a.textContent=j.answer||j.error||'No answer.';}catch(e){a.className='answer show';a.textContent='AI error: '+e.message;}}
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

async function pageSupport() {
  const rows = arr(await safe(sb("support_requests?select=*&order=created_at.desc&limit=100"), []));
  const emailReady = !!(RESEND_API_KEY && SUPPORT_FROM_EMAIL);
  const banner = emailReady ? "" : `<div class="err">In-portal “Send email” needs RESEND_API_KEY + SUPPORT_FROM_EMAIL in .env.local. “Reply in Mail” + AI drafting work now.</div>`;
  const items = rows.map((r) => {
    const to = r.email || "", subj = "Re: your message to Nativize", body = (r.message || r.body || "");
    const mailto = to ? `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subj)}` : "";
    const reply = to ? `<details class="reply"><summary>Reply</summary><form method="POST" action="/api/reply"><input type="hidden" name="to" value="${esc(to)}"/><input type="hidden" name="srcmsg" value="${esc(body)}"/><input type="text" name="subject" value="${esc(subj)}"/><textarea name="text" placeholder="Write a reply… or click Draft with AI"></textarea><div class="row"><button class="btn" type="button" onclick="aiDraft(this)">✨ Draft with AI</button>${emailReady ? `<button class="btn pri" type="submit">Send email</button>` : `<button class="btn" type="submit" disabled>Send email (set up Resend)</button>`}<a class="btn" href="${mailto}">Reply in Mail</a></div></form></details>` : `<span class="muted">No email on file</span>`;
    return `<tr><td>${when(r.created_at)}</td><td>${esc(to || "—")}</td><td><span class="msg">${esc(body)}</span>${reply}</td></tr>`;
  });
  const inner = rows.length ? `<table><thead><tr><th>When</th><th>From</th><th>Message &amp; reply</th></tr></thead><tbody>${items.join("")}</tbody></table>` : `<div class="empty">No support messages yet.</div>`;
  return { title: "Support", sub: "Free local AI drafts replies · " + (emailReady ? "sending from " + SUPPORT_FROM_EMAIL : "email sending off"), body: banner + card(rows.length + " messages", inner) };
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

/* ============================ Router ============================ */
const PAGES = { "/": pageOverview, "/support": pageSupport, "/features": pageFeatures, "/paid": pagePaid, "/testers": pageTesters, "/visitors": pageVisitors, "/issues": pageIssues, "/settings": async () => pageSettings() };
function send(res, code, html) { res.writeHead(code, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Frame-Options": "DENY" }); res.end(html); }
function json(res, obj) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); }

const server = http.createServer(async (req, res) => {
  const p = new URL(req.url, "http://x").pathname;
  if (p === "/favicon.ico") { res.writeHead(204).end(); return; }
  if (p === "/api/ai-draft" && req.method === "POST") { try { const b = JSON.parse(await readBody(req) || "{}"); json(res, { draft: await aiDraft(b.message || "", b.email || "") }); } catch (e) { json(res, { error: e.message }); } return; }
  if (p === "/api/ask" && req.method === "POST") { try { const b = JSON.parse(await readBody(req) || "{}"); json(res, { answer: await askAI((b.question || "").slice(0, 500)) }); } catch (e) { json(res, { error: e.message }); } return; }
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
  if (!handler) return send(res, 404, layout("/", "Not found", card("", `<div class="empty">Page not found. <a href="/">Overview</a></div>`)));
  try { const pg = await handler(); return send(res, 200, layout(p, pg.title, pg.body, { sub: pg.sub })); }
  catch (e) { return send(res, 500, layout(p, "Error", card("", `<div class="err">⚠ ${esc(e.message)}</div>`))); }
});
server.listen(PORT, HOST, () => {
  const ips = []; const ni = os.networkInterfaces();
  for (const k of Object.keys(ni)) for (const a of ni[k]) if (a.family === "IPv4" && !a.internal) ips.push(a.address);
  console.log(`\n  Nativize portal running.`);
  console.log(`  • This Mac:  http://127.0.0.1:${PORT}`);
  ips.forEach((ip) => console.log(`  • WiFi:      http://${ip}:${PORT}`));
  console.log("");
});
