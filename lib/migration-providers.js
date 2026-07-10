/*
 * Nativize Migration Hub — provider registry (sources + targets).
 *
 * Modular adapter system. Every provider declares an honest support status:
 *   "full"   — Fully supported: the scanner + command generator handle it end-to-end.
 *   "guided" — Guided mode: real checklists + commands, but you run them yourself.
 *   "soon"   — Coming soon: shown for transparency, cannot be selected.
 *
 * Pure data + small helpers. No network, no secrets. Shared by the landing
 * page, the wizard, and the project dashboard so statuses can never drift.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.NativizeMigrationProviders = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var STATUS = {
    full: { id: "full", label: "Fully supported", cls: "st-full" },
    guided: { id: "guided", label: "Guided mode", cls: "st-guided" },
    soon: { id: "soon", label: "Coming soon", cls: "st-soon" }
  };

  /* ---------------- Source providers ---------------- */
  var SOURCES = [
    {
      id: "lovable",
      name: "Lovable Cloud",
      icon: "💜",
      status: "full",
      blurb: "Lovable apps with a Supabase backend. The scanner knows the exact project layout.",
      inputs: ["Project ZIP export or connected GitHub repo"],
      detects: ["supabase/migrations", "supabase/functions", "supabase/config.toml", "Supabase client files", "old project refs", "Deno.env secrets", "storage buckets", "payment/webhook code"],
      risks: ["Old Lovable project refs left in code", ".env files accidentally exported", "Edge function secrets that must be re-set on the target"],
      targets: ["supabase", "neon", "postgres", "docker", "nativize"]
    },
    {
      id: "zip",
      name: "Uploaded ZIP",
      icon: "🗜️",
      status: "full",
      blurb: "Any project exported as a ZIP. Scanned entirely in your browser — nothing is uploaded.",
      inputs: ["Project ZIP file"],
      detects: ["Same full scan as Lovable"],
      risks: [".env files inside the ZIP", "node_modules bloating the archive"],
      targets: ["supabase", "neon", "postgres", "docker", "aws", "firebase", "vercel", "nativize"]
    },
    {
      id: "github",
      name: "GitHub repo",
      icon: "🐙",
      status: "guided",
      blurb: "Scan a repo you own. Sign in with GitHub in Nativize Studio first, or download the repo as ZIP and upload it here.",
      inputs: ["owner/repo (signed in) or repo ZIP"],
      detects: ["Same full scan as Lovable"],
      risks: [".env files tracked by Git", "secrets in commit history"],
      targets: ["supabase", "neon", "postgres", "docker", "aws", "firebase", "vercel", "nativize"]
    },
    {
      id: "bolt",
      name: "Bolt",
      icon: "⚡",
      status: "guided",
      blurb: "Bolt projects export as standard Vite apps — download the ZIP and upload it here for a full scan.",
      inputs: ["Project ZIP export"],
      detects: ["Vite/React structure", "Supabase usage if present", "env var names"],
      risks: ["Backend pieces that live only inside Bolt"],
      targets: ["supabase", "vercel", "docker", "nativize"]
    },
    {
      id: "base44",
      name: "Base44",
      icon: "🅱️",
      status: "guided",
      blurb: "Export your Base44 code and upload the ZIP. Built-in Base44 data APIs need manual mapping.",
      inputs: ["Project ZIP export"],
      detects: ["Frontend structure", "API/e-env references"],
      risks: ["Base44 platform APIs have no direct equivalent — plan replacements"],
      targets: ["supabase", "vercel", "nativize"]
    },
    {
      id: "replit",
      name: "Replit",
      icon: "🌀",
      status: "guided",
      blurb: "Download your Repl as ZIP and upload it. Replit DB / secrets need manual re-creation.",
      inputs: ["Repl ZIP export"],
      detects: ["Project structure", "env var names", "database usage"],
      risks: ["Replit-specific services (Replit DB, Auth) need replacements"],
      targets: ["supabase", "docker", "postgres", "nativize"]
    },
    {
      id: "cursor",
      name: "Cursor / Codex project",
      icon: "🖱️",
      status: "guided",
      blurb: "AI-built GitHub projects. Scan via ZIP upload; the plan flags anything the AI left half-wired.",
      inputs: ["GitHub repo ZIP"],
      detects: ["Same full scan as GitHub repo"],
      risks: ["Half-configured services from AI generations"],
      targets: ["supabase", "vercel", "docker", "nativize"]
    },
    {
      id: "vercel-src",
      name: "Vercel project",
      icon: "▲",
      status: "guided",
      blurb: "Vercel-hosted projects are usually a GitHub repo — scan that repo's ZIP. Env vars must be copied from the Vercel dashboard by name.",
      inputs: ["Linked repo ZIP", "env var names from Vercel dashboard"],
      detects: ["Framework, API routes, env names"],
      risks: ["Serverless functions tied to Vercel runtime"],
      targets: ["supabase", "docker", "aws", "nativize"]
    },
    {
      id: "firebase-src",
      name: "Firebase project",
      icon: "🔥",
      status: "soon",
      blurb: "Firestore → Postgres data migration needs a dedicated converter. On the roadmap.",
      inputs: [],
      detects: [],
      risks: ["Firestore's document model does not map 1:1 to SQL"],
      targets: ["supabase"]
    },
    {
      id: "supabase-src",
      name: "Supabase project",
      icon: "🟩",
      status: "guided",
      blurb: "Move between Supabase projects (e.g. Lovable-managed → your own). Same scanner, plus db dump/restore commands.",
      inputs: ["Project repo ZIP", "source project ref"],
      detects: ["Same full scan as Lovable"],
      risks: ["Auth users need supabase db dump with auth flags or CSV export"],
      targets: ["supabase", "neon", "postgres", "docker"]
    }
  ];

  /* ---------------- Target providers ---------------- */
  var TARGETS = [
    {
      id: "supabase",
      name: "Supabase",
      icon: "🟩",
      status: "full",
      blurb: "First-class target. Safe copyable commands for db push, function deploys, and secrets — placeholders only.",
      inputs: [
        { key: "projectUrl", label: "Target Supabase project URL", placeholder: "https://YOUR-REF.supabase.co", required: true },
        { key: "projectRef", label: "Target project ref", placeholder: "20-char ref from the dashboard URL", required: true },
        { key: "anonKey", label: "Publishable / anon key", placeholder: "sb_publishable_… (never the service role key)", required: false }
      ],
      warnings: [
        "Use a clean, empty target project — never point commands at a live production project.",
        "Never paste your service role key anywhere in this wizard. It is not needed.",
        "Back up (git branch + supabase db dump) before pushing anything."
      ],
      secretsSetup: "supabase secrets set NAME=<value> per detected secret — run locally, values never touch Nativize.",
      testing: ["Supabase connection", "Auth providers re-configured", "Edge functions respond", "Storage buckets recreated", "Webhooks point at the new project"]
    },
    {
      id: "aws",
      name: "AWS",
      icon: "🟧",
      status: "guided",
      blurb: "Guided mode: architecture, S3, RDS, Lambda, env, DNS, cost and security checklists. No automated deploys.",
      inputs: [{ key: "region", label: "AWS region", placeholder: "us-east-1", required: false }],
      warnings: [
        "AWS costs are usage-based — set a billing alarm before you deploy anything.",
        "Lock down IAM: create a scoped deploy user, never use root credentials."
      ],
      secretsSetup: "AWS Systems Manager Parameter Store or Secrets Manager; reference from Lambda env config.",
      testing: ["RDS reachable from app", "S3 uploads/reads", "Lambda endpoints", "CloudWatch logs clean", "Domain + SSL"]
    },
    {
      id: "firebase",
      name: "Firebase",
      icon: "🔥",
      status: "guided",
      blurb: "Guided mode: Firestore/Auth, Storage, Functions, env and deploy checklists.",
      inputs: [{ key: "fbProject", label: "Firebase project id", placeholder: "my-app-12345", required: false }],
      warnings: ["SQL schemas need remodeling for Firestore documents — plan data shape first."],
      secretsSetup: "firebase functions:config:set or .env files with the Firebase CLI (never commit them).",
      testing: ["Auth sign-in", "Firestore reads/writes", "Storage rules", "Functions deploy", "Hosting domain"]
    },
    {
      id: "vercel",
      name: "Vercel",
      icon: "▲",
      status: "guided",
      blurb: "Guided mode for frontend hosting: build settings, env vars, domains. Pairs with a Supabase/Neon backend.",
      inputs: [],
      warnings: ["Vercel hosts the frontend — your database/functions still need a backend target."],
      secretsSetup: "Vercel dashboard → Settings → Environment Variables (names from the scan).",
      testing: ["Production build", "Env vars present", "Domain + redirects"]
    },
    {
      id: "railway",
      name: "Railway",
      icon: "🚄",
      status: "soon",
      blurb: "Deployment automation not built yet — shown for transparency.",
      inputs: [], warnings: [], secretsSetup: "", testing: []
    },
    {
      id: "render",
      name: "Render",
      icon: "🎨",
      status: "soon",
      blurb: "Deployment automation not built yet — shown for transparency.",
      inputs: [], warnings: [], secretsSetup: "", testing: []
    },
    {
      id: "neon",
      name: "Neon Postgres",
      icon: "🌊",
      status: "guided",
      blurb: "Guided mode: pg_dump/pg_restore commands with placeholder connection strings.",
      inputs: [{ key: "neonHost", label: "Neon host", placeholder: "ep-….neon.tech", required: false }],
      warnings: ["Neon is Postgres only — auth, storage and edge functions need another home (e.g. Supabase or your app server)."],
      secretsSetup: "Connection string as DATABASE_URL in your app host's secret store.",
      testing: ["Connection string works", "Schema restored", "App queries succeed"]
    },
    {
      id: "docker",
      name: "Docker / self-hosted VPS",
      icon: "🐳",
      status: "guided",
      blurb: "Guided mode: docker compose with Postgres, env checklist, reverse proxy + SSL steps.",
      inputs: [],
      warnings: ["You own uptime, backups, and security patches on a VPS.", "Never expose Postgres directly to the internet."],
      secretsSetup: ".env file on the server (chmod 600) or Docker secrets — never committed.",
      testing: ["Containers healthy", "DB restored", "HTTPS works", "Backups scheduled"]
    },
    {
      id: "postgres",
      name: "Generic PostgreSQL",
      icon: "🐘",
      status: "guided",
      blurb: "Guided mode: pg_dump/pg_restore with placeholders for any Postgres 14+ server.",
      inputs: [{ key: "pgHost", label: "Postgres host", placeholder: "db.example.com", required: false }],
      warnings: ["Match major Postgres versions between source and target where possible."],
      secretsSetup: "DATABASE_URL in your app's secret store.",
      testing: ["Schema + data restored", "Roles/permissions recreated", "App connects"]
    },
    {
      id: "github-export",
      name: "GitHub repo export",
      icon: "🐙",
      status: "guided",
      blurb: "Push your cleaned project to a fresh repo you own — with .env safety checks first.",
      inputs: [{ key: "repo", label: "New repo (owner/name)", placeholder: "you/my-app", required: false }],
      warnings: ["Verify .env files are ignored BEFORE the first push — history is forever."],
      secretsSetup: "GitHub Actions secrets (Settings → Secrets and variables) for CI needs.",
      testing: ["Repo pushed", "No secrets in history", "CI builds green"]
    },
    {
      id: "nativize",
      name: "Native app (Nativize)",
      icon: "📱",
      status: "guided",
      blurb: "Guided handoff to the existing Nativize Studio flow for iOS, Android, Mac, and Windows builds.",
      inputs: [],
      warnings: [],
      secretsSetup: "Store credentials become encrypted GitHub Actions secrets via Studio.",
      testing: ["Native build succeeds", "Deep links open the app", "Store upload workflow runs"]
    }
  ];

  function byId(list, id) {
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  return {
    STATUS: STATUS,
    SOURCES: SOURCES,
    TARGETS: TARGETS,
    source: function (id) { return byId(SOURCES, id); },
    target: function (id) { return byId(TARGETS, id); },
    statusOf: function (provider) { return STATUS[provider && provider.status] || STATUS.soon; },
    selectableSources: function () { return SOURCES.filter(function (s) { return s.status !== "soon"; }); },
    selectableTargets: function () { return TARGETS.filter(function (t) { return t.status !== "soon"; }); }
  };
});
