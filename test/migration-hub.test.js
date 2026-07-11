const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const Scanner = require("../website/lib/migration-scanner.js");
const Plan = require("../website/lib/migration-plan.js");
const Providers = require("../website/lib/migration-providers.js");
const Billing = require("../src/billing.js");

function source(file) {
  return fs.readFileSync(path.join(__dirname, "..", file), "utf8");
}

function sampleScan() {
  return Scanner.scan([
    { path: "supabase/config.toml", size: 20, text: 'site_url = "https://old.example"' },
    { path: "supabase/migrations/202601010000_init.sql", size: 80, text: "create table profiles(id uuid); select cron.schedule('daily', '* * * * *', 'select 1');" },
    { path: "supabase/functions/pay/index.ts", size: 200, text: 'const key = Deno.env.get("STRIPE_SECRET_KEY"); const admin = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"); fetch("https://api.stripe.com/v1/charges");' },
    { path: "src/supabase.js", size: 120, text: 'createClient("https://abcdefghijklmnopqrst.supabase.co", import.meta.env.VITE_SUPABASE_ANON_KEY); storage.from("avatars");' },
    { path: ".env.production", size: 80, text: "STRIPE_SECRET_KEY=sk_live_should_never_be_saved\n" },
    { path: ".gitignore", size: 20, text: "node_modules\n" }
  ]);
}

test("Migration scanner emits metadata only and detects Lovable/Supabase requirements", () => {
  const scan = sampleScan();
  assert.equal(Scanner.isSupabaseStyle(scan), true);
  assert.equal(scan.sqlMigrations.length, 1);
  assert.equal(scan.edgeFunctions.length, 1);
  assert.deepEqual(scan.storageBuckets, ["avatars"]);
  assert.ok(scan.secrets.some((s) => s.name === "STRIPE_SECRET_KEY"));
  assert.ok(scan.envFiles.some((f) => f.path === ".env.production"));
  assert.equal(JSON.stringify(scan).includes("sk_live_should_never_be_saved"), false);
  assert.equal(Scanner.riskOf(scan).level, "danger");
});

test("Migration redaction masks common credentials", () => {
  const input = "STRIPE_SECRET_KEY=sk_live_1234567890abcdef whsec_1234567890abcdef sb_secret_1234567890abcdef";
  const output = Scanner.redact(input);
  assert.doesNotMatch(output, /sk_live_1234567890abcdef/);
  assert.doesNotMatch(output, /whsec_1234567890abcdef/);
  assert.doesNotMatch(output, /sb_secret_1234567890abcdef/);
});

test("Scanner and command generator reject token-like paths and shell-unsafe names", () => {
  const scan = Scanner.scan([
    { path: "sk_live_1234567890abcdef/supabase/functions/bad;touch-pwn/index.ts", size: 10, text: "Deno.serve(() => {})" }
  ]);
  assert.doesNotMatch(JSON.stringify(scan), /sk_live_1234567890abcdef/);
  const malicious = Object.assign(sampleScan(), {
    edgeFunctions: [{ name: "safe-fn" }, { name: "bad;touch-pwn" }],
    projectRefs: ["abcdefghijklmnopqrst", 'bad" .; touch pwn']
  });
  const commands = Plan.commandGroups(malicious, {}).flatMap((g) => g.commands.map((c) => c.cmd)).join("\n");
  assert.match(commands, /functions deploy safe-fn/);
  assert.doesNotMatch(commands, /touch-pwn|touch pwn/);
});

test("Supabase plan generates safe ordered commands and four markdown files", () => {
  const scan = sampleScan();
  const groups = Plan.commandGroups(scan, { projectRef: "zyxwvutsrqponmlkjihg" });
  const commands = groups.flatMap((g) => g.commands.map((c) => c.cmd)).join("\n");
  assert.match(commands, /supabase link --project-ref zyxwvutsrqponmlkjihg/);
  assert.match(commands, /supabase db push/);
  assert.match(commands, /supabase functions deploy pay/);
  assert.match(commands, /STRIPE_SECRET_KEY=<value>/);
  assert.doesNotMatch(commands, /sk_live_/);
  assert.equal(Plan.FILES.length, 4);
  assert.match(Plan.testMarkdown(scan), /Stripe checkout \+ webhook/);
});

test("Provider registry is honest about full, guided, and coming-soon support", () => {
  assert.equal(Providers.source("lovable").status, "full");
  assert.equal(Providers.target("supabase").status, "full");
  assert.equal(Providers.target("aws").status, "guided");
  assert.equal(Providers.target("firebase").status, "guided");
  assert.equal(Providers.target("nativize").status, "guided");
  assert.equal(Providers.target("railway").status, "soon");
  assert.equal(Providers.target("render").status, "soon");
});

test("Billing client exposes server-enforced Migration Hub operations", async () => {
  const calls = [];
  const opts = {
    supabaseUrl: "https://example.supabase.co",
    fetch: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body || "{}") });
      return { ok: true, status: 200, text: async () => JSON.stringify({ access: "max" }) };
    }
  };
  await Billing.migrationAccess("jwt", opts);
  await Billing.createMigrationProject("jwt", { name: "App migration", source: "lovable", target: "supabase", targetProjectRef: "abcdefghijklmnopqrst" }, opts);
  assert.match(calls[0].url, /rpc\/get_migration_access$/);
  assert.match(calls[1].url, /rpc\/create_migration_project$/);
  assert.equal(calls[1].body.p_target_ref, "abcdefghijklmnopqrst");
  assert.equal(typeof Billing.updateMigrationStatus, "function");
});

test("Migration routes, entitlement SQL, and checkout credit flow are wired", () => {
  const sql = source("supabase/migrations/202607100001_migration_hub.sql");
  const webhook = source("supabase/functions/stripe-webhook/index.ts");
  const checkout = source("supabase/functions/create-checkout-session/index.ts");
  const runner = source("supabase/functions/migration-run/index.ts");
  const rateLimit = source("supabase/migrations/202607100002_raise_migration_rate_limit_ceiling.sql");
  const wizard = source("website/migration.js");
  assert.match(sql, /create_migration_project/);
  assert.match(sql, /for update skip locked/);
  assert.match(sql, /SECRET_VALUE_REJECTED/);
  assert.match(sql, /auth\.uid\(\) = user_id/);
  assert.match(webhook, /migration_credits/);
  assert.match(webhook, /onConflict: "stripe_checkout_session_id"/);
  assert.match(checkout, /STRIPE_PRICE_MIGRATION/);
  assert.match(wizard, /Use 1 credit/);            // credit consumption surfaced before start
  assert.match(wizard, /One will be used when you start/);
  assert.match(wizard, /Sign in with GitHub to migrate/);
  assert.match(wizard, /localStorage\.setItem\(key, value\)/);
  assert.match(wizard, /api\("migrationAccess"\).*launchAuthenticatedApp/);
  assert.match(wizard, /same Supabase user ID used by Stripe/);
  assert.match(runner, /const DATA_BATCH = 2_000/);
  assert.match(runner, /const AUTH_BATCH = 1_000/);
  assert.match(runner, /const MIGRATION_RATE_LIMIT_HITS = 5_000/);
  assert.match(runner, /class SourceHelperError/);
  assert.match(runner, /status === 546/);
  assert.match(runner, /function callHelperPage/);
  assert.match(runner, /action: "storage_download"/);
  assert.match(runner, /Could not copy rows from/);
  assert.match(runner, /Storage file/);
  assert.match(runner, /`migrun:\$\{userId\}:\$\{projectId\}`/);
  assert.match(rateLimit, /max_hits > 10000/);
  assert.match(source("website/lib/migration-helper-code.js"), /storage_download/);
  assert.match(wizard, /notes \/ items to review/);
  assert.match(wizard, /function freshRunState/);
  assert.match(wizard, /draft\.projectId \? Promise\.resolve\(\{ id: draft\.projectId \}\)/);
  assert.match(wizard, /function forgetCompletedMigrationInfo/);
  assert.match(wizard, /creds = \{ targetConn: "", targetKey: "" \}/);
  assert.match(wizard, /sessionStorage\.removeItem\(K\.draft\)/);
  assert.match(wizard, /updateMigrationStatus", \[draft\.projectId, "done"\]/);
  assert.match(wizard, /Temporary helper details and target credentials have been cleared/);
  assert.match(wizard, /cursors: \{ data: \{ i: 0, offset: 0 \}, auth: \{ offset: 0 \}, storage: \{ i: 0 \} \}/);
  assert.match(wizard, /runState\.cursors\.data = cursor/);
  assert.match(wizard, /Finish the switch/);       // post-migration test/switch checklist
  ["website/migration/index.html", "website/migration/new/index.html", "website/migration/project/index.html", "website/migration/providers/index.html"].forEach((file) => assert.equal(fs.existsSync(path.join(__dirname, "..", file)), true));
});

test("Web account surfaces share a persistent Supabase GitHub session", () => {
  const app = source("website/app.js");
  const cancel = source("website/cancel-subscription.js");
  assert.match(app, /loadPersistentText\(K\.supabaseAccess\)/);
  assert.match(app, /storePersistentText\(K\.supabaseRefresh/);
  assert.match(cancel, /loadPersistentText\(K\.supabaseAccess\)/);
  assert.match(cancel, /storePersistentText\(K\.supabaseRefresh/);
});

test("Admin portal exposes secured user, migration, and support operations", () => {
  const admin = source("tools/dashboard.js");
  assert.match(admin, /DASHBOARD_PASSWORD/);
  assert.match(admin, /isAuthorized\(req\)/);
  assert.match(admin, /"\/users": pageUsers/);
  assert.match(admin, /"\/migrations": pageMigrations/);
  assert.match(admin, /migration_credits\?select=/);
  assert.match(admin, /migration_projects\?select=/);
});

test("Migration marketing never advertises migration as free", () => {
  const pricing = source("website/pricing/index.html");
  const hub = source("website/migration/index.html");
  const seo = source("website/lovable-to-supabase/index.html");
  assert.doesNotMatch(pricing, /preview scan free/i);
  assert.doesNotMatch(hub, /"price"\s*:\s*"0"/);
  assert.doesNotMatch(seo, /"price"\s*:\s*"0"/);
  assert.match(pricing, /Migration access is paid/);
});
