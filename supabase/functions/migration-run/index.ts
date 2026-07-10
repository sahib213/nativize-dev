// ============================================================================
// Nativize Migration — hosted transfer engine.
//
// Reads from the user's temporary migrate-helper (in their Lovable/source
// Supabase project) and writes into their TARGET Supabase project: database
// schema + rows, auth users (password hashes intact), and storage objects.
//
// Driven in resumable batches by the browser so each invocation stays well
// under the edge-function time limit and the UI shows real progress.
//
// SAFETY / PRIVACY:
//  - Source, target, and helper credentials are received per call over HTTPS,
//    used transiently, and NEVER stored or logged. Errors are redacted.
//  - Requires the Nativize user's JWT + ownership of a paid migration project
//    (Max subscription or a consumed single-migration credit).
//  - Non-destructive to the source. Target writes use INSERT ... ON CONFLICT
//    DO NOTHING and CREATE ... IF NOT EXISTS so re-runs are safe.
// ============================================================================
import postgres from "https://deno.land/x/postgresjs@v3.4.5/mod.js";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4?target=deno";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDENT_RE = /^[A-Za-z0-9_]{1,63}$/;
const DATA_BATCH = 500;
const AUTH_BATCH = 500;
const STORAGE_BATCH = 4;      // objects per call (each fetched + uploaded)
const MAX_OBJECT_BYTES = 25 * 1024 * 1024;

function env(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`Missing ${name}`);
  return v;
}
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
function ident(name: string): string {
  if (!IDENT_RE.test(name)) throw new Error("Unsafe identifier");
  return '"' + name + '"';
}
// Redact anything credential-shaped before it can reach a response or log.
function redact(msg: string): string {
  return String(msg || "")
    .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "postgresql://***")
    .replace(/eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, "***")
    .replace(/sb_(?:secret|publishable)_[A-Za-z0-9_-]+/g, "***")
    .replace(/nzmig_[a-f0-9]+/g, "***")
    .slice(0, 300);
}
function requestIp(req: Request): string {
  return (req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for") || "unknown")
    .split(",")[0].trim().replace(/[^a-zA-Z0-9._:-]/g, "-").slice(0, 80) || "unknown";
}

// A source helper endpoint the user controls. Restricted to https + Supabase
// functions hosts so this cannot be pointed at arbitrary internal services.
function safeHelperUrl(raw: unknown): string {
  const s = String(raw || "").trim();
  let u: URL;
  try { u = new URL(s); } catch { throw new Error("Invalid helper URL."); }
  if (u.protocol !== "https:") throw new Error("Helper URL must be https.");
  if (!/\.functions\.supabase\.co$|\.supabase\.co$/.test(u.hostname)) {
    throw new Error("Helper URL must be a Supabase edge function URL.");
  }
  return u.toString();
}
function safeTargetUrl(raw: unknown): string {
  const s = String(raw || "").trim().replace(/\/+$/, "");
  let u: URL;
  try { u = new URL(s); } catch { throw new Error("Invalid target project URL."); }
  if (u.protocol !== "https:" || !/\.supabase\.co$/.test(u.hostname)) throw new Error("Target must be a https Supabase URL.");
  return u.origin;
}
function assertConn(raw: unknown): string {
  const s = String(raw || "").trim();
  if (!/^postgres(?:ql)?:\/\/.+@.+\/.+/i.test(s)) throw new Error("Invalid Postgres connection string.");
  if (s.length > 600) throw new Error("Connection string too long.");
  return s;
}

async function callHelper(url: string, key: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-migrate-key": key },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let data: Record<string, unknown> = {};
  try { data = JSON.parse(text); } catch { data = { error: text.slice(0, 200) }; }
  if (!res.ok) throw new Error("Source helper: " + redact(String(data.error || res.status)));
  return data;
}

async function checkRateLimit(supabase: ReturnType<typeof createClient>, bucket: string) {
  const { error } = await supabase.rpc("nativize_check_rate_limit", { bucket, max_hits: 240, window_seconds: 900 });
  if (error && /too many requests/i.test(error.message || "")) {
    throw Object.assign(new Error("Too many migration requests. Wait a few minutes."), { status: 429 });
  }
}

// ---- Phase handlers -------------------------------------------------------
async function phaseTest(helperUrl: string, helperKey: string, conn: string) {
  const ping = await callHelper(helperUrl, helperKey, { action: "ping" });
  const sql = postgres(conn, { prepare: false, max: 1, idle_timeout: 5, connect_timeout: 10 });
  try {
    await sql`select 1`;
    const existing = await sql`select count(*)::int as n from information_schema.tables where table_schema='public' and table_type='BASE TABLE'`;
    return {
      ok: true,
      source: { tables: ping.tables || 0, users: ping.users || 0, buckets: ping.buckets || 0, objects: ping.objects || 0 },
      targetTables: existing[0].n,
      targetEmpty: existing[0].n === 0,
    };
  } finally { await sql.end({ timeout: 5 }).catch(() => {}); }
}

async function phaseSchema(helperUrl: string, helperKey: string, conn: string) {
  const schema = await callHelper(helperUrl, helperKey, { action: "schema" });
  const sql = postgres(conn, { prepare: false, max: 1, idle_timeout: 5, connect_timeout: 10 });
  const warnings: string[] = [];
  let applied = 0;
  async function run(stmt: string) {
    try { await sql.unsafe(stmt); applied++; }
    catch (e) { warnings.push(redact((e as Error).message)); }
  }
  try {
    for (const t of (schema.types as string[] || [])) await run(t);
    for (const t of (schema.tables as Array<{ ddl: string }> || [])) await run(t.ddl);
    return {
      ok: true, done: true, applied,
      tableNames: (schema.tableNames as string[] || []).filter((n) => IDENT_RE.test(n)),
      warnings: warnings.slice(0, 20),
    };
  } finally { await sql.end({ timeout: 5 }).catch(() => {}); }
}

async function phaseData(helperUrl: string, helperKey: string, conn: string, tables: string[], cursor: { i: number; offset: number }) {
  const i = Math.max(0, cursor.i | 0);
  const offset = Math.max(0, cursor.offset | 0);
  if (i >= tables.length) return { ok: true, done: true };
  const name = tables[i];
  if (!IDENT_RE.test(name)) return { ok: true, done: false, cursor: { i: i + 1, offset: 0 } };
  const batch = await callHelper(helperUrl, helperKey, { action: "table", name, offset, limit: DATA_BATCH });
  const rows = (batch.rows as Record<string, unknown>[]) || [];
  const sql = postgres(conn, { prepare: false, max: 1, idle_timeout: 5, connect_timeout: 10 });
  let inserted = 0; const warnings: string[] = [];
  try {
    if (rows.length) {
      try {
        await sql`insert into ${sql("public")}.${sql(name)} ${sql(rows)} on conflict do nothing`;
        inserted = rows.length;
      } catch (_e) {
        // Fall back to row-by-row so one bad row does not lose the batch.
        for (const r of rows) {
          try { await sql`insert into ${sql("public")}.${sql(name)} ${sql([r])} on conflict do nothing`; inserted++; }
          catch (e2) { warnings.push(name + ": " + redact((e2 as Error).message)); }
        }
      }
    }
    const advanced = rows.length < DATA_BATCH;
    return {
      ok: true,
      done: false,
      cursor: advanced ? { i: i + 1, offset: 0 } : { i, offset: offset + rows.length },
      table: name,
      inserted,
      warnings: warnings.slice(0, 10),
    };
  } finally { await sql.end({ timeout: 5 }).catch(() => {}); }
}

async function phaseAuth(helperUrl: string, helperKey: string, conn: string, cursor: { offset: number }) {
  const offset = Math.max(0, cursor.offset | 0);
  const batch = await callHelper(helperUrl, helperKey, { action: "auth_users", offset, limit: AUTH_BATCH });
  const rows = (batch.rows as Record<string, unknown>[]) || [];
  if (!rows.length) return { ok: true, done: true, inserted: 0 };
  const sql = postgres(conn, { prepare: false, max: 1, idle_timeout: 5, connect_timeout: 10 });
  let inserted = 0; const warnings: string[] = [];
  try {
    for (const r of rows) {
      try { await sql`insert into ${sql("auth")}.${sql("users")} ${sql([r])} on conflict (id) do nothing`; inserted++; }
      catch (e) { warnings.push("user " + redact((e as Error).message)); }
    }
    return { ok: true, done: rows.length < AUTH_BATCH, cursor: { offset: offset + rows.length }, inserted, warnings: warnings.slice(0, 10) };
  } finally { await sql.end({ timeout: 5 }).catch(() => {}); }
}

async function phaseStorage(helperUrl: string, helperKey: string, targetUrl: string, targetKey: string, cursor: { i: number }) {
  // Build the full object list once (cheap) and page through it by index.
  const list = await callHelper(helperUrl, helperKey, { action: "storage_list" });
  const buckets = (list.buckets as Array<{ id: string; name: string; public: boolean }>) || [];
  const objects = (list.objects as Array<{ bucket_id: string; name: string }>) || [];
  const i = Math.max(0, cursor.i | 0);
  const warnings: string[] = [];

  if (i === 0) {
    // Create buckets first (idempotent).
    for (const b of buckets) {
      const res = await fetch(targetUrl + "/storage/v1/bucket", {
        method: "POST",
        headers: { Authorization: "Bearer " + targetKey, "Content-Type": "application/json", apikey: targetKey },
        body: JSON.stringify({ id: b.id || b.name, name: b.name, public: !!b.public }),
      }).catch(() => null);
      if (res && !res.ok && res.status !== 409) warnings.push("bucket " + b.name + ": " + res.status);
    }
  }

  let uploaded = 0;
  const end = Math.min(objects.length, i + STORAGE_BATCH);
  for (let j = i; j < end; j++) {
    const o = objects[j];
    if (!o || !o.name) continue;
    try {
      const obj = await callHelper(helperUrl, helperKey, { action: "storage_object", bucket: o.bucket_id, name: o.name });
      const b64 = String(obj.base64 || "");
      if (!b64 || (obj.size as number) > MAX_OBJECT_BYTES) { warnings.push("skipped large/empty " + o.name); continue; }
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
      const up = await fetch(targetUrl + "/storage/v1/object/" + encodeURIComponent(o.bucket_id) + "/" + o.name.split("/").map(encodeURIComponent).join("/"), {
        method: "POST",
        headers: { Authorization: "Bearer " + targetKey, apikey: targetKey, "Content-Type": String(obj.contentType || "application/octet-stream"), "x-upsert": "true" },
        body: bytes,
      });
      if (up.ok) uploaded++; else warnings.push(o.name + ": " + up.status);
    } catch (e) { warnings.push(o.name + ": " + redact((e as Error).message)); }
  }
  return { ok: true, done: end >= objects.length, cursor: { i: end }, total: objects.length, processed: end, uploaded, warnings: warnings.slice(0, 10) };
}

async function phaseFinalize(helperUrl: string, helperKey: string, conn: string) {
  const schema = await callHelper(helperUrl, helperKey, { action: "schema" });
  const sql = postgres(conn, { prepare: false, max: 1, idle_timeout: 5, connect_timeout: 10 });
  const warnings: string[] = []; let applied = 0;
  async function run(stmt: string) {
    try { await sql.unsafe(stmt); applied++; }
    catch (e) { warnings.push(redact((e as Error).message)); }
  }
  try {
    for (const c of (schema.constraints as string[] || [])) await run(c);
    for (const ix of (schema.indexes as string[] || [])) await run(ix);
    for (const r of (schema.rls as string[] || [])) await run(r);
    for (const s of (schema.sequences as Array<{ name: string; value: number }> || [])) {
      if (IDENT_RE.test(s.name) && Number.isFinite(s.value)) {
        await run("select setval('public." + ident(s.name) + "', " + Math.max(1, Math.floor(s.value)) + ", true)");
      }
    }
    return { ok: true, done: true, applied, warnings: warnings.slice(0, 20) };
  } finally { await sql.end({ timeout: 5 }).catch(() => {}); }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const admin = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

    const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
    if (!jwt) { await checkRateLimit(admin, `migrun-anon:${requestIp(req)}`); return json({ error: "Sign in required." }, 401); }
    const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
    if (userErr || !userData.user) return json({ error: "Invalid session." }, 401);
    const userId = userData.user.id;
    await checkRateLimit(admin, `migrun:${userId}`);

    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const phase = String(body.phase || "");
    const projectId = String(body.projectId || "");

    // Entitlement: Max subscription or at least one unused single-migration credit.
    const { data: maxEnt } = await admin
      .from("billing_entitlements").select("status").eq("user_id", userId).eq("plan_id", "max").maybeSingle();
    const isMax = !!maxEnt && ["active", "trialing"].includes(String(maxEnt.status || "").toLowerCase());
    const { count: creditCount } = await admin
      .from("migration_credits").select("id", { count: "exact", head: true }).eq("user_id", userId).eq("status", "unused");
    const hasAccess = isMax || (creditCount || 0) > 0;

    if (phase === "test") {
      // Connection tests run before a project/credit is created — gate on entitlement only.
      if (!hasAccess) return json({ error: "Migration access required (Max or a single-migration credit)." }, 402);
    } else {
      // Every write phase requires an owned project. Creating it already
      // consumed a credit (or the user is on Max), so ownership = paid.
      if (!UUID_RE.test(projectId)) return json({ error: "Invalid project." }, 400);
      const { data: project } = await admin
        .from("migration_projects").select("id,user_id").eq("id", projectId).eq("user_id", userId).maybeSingle();
      if (!project) return json({ error: "Migration project not found for your account." }, 403);
    }
    const helperUrl = safeHelperUrl(body.helperUrl);
    const helperKey = String(body.helperKey || "");
    if (!/^nzmig_[a-f0-9]{8,}$/.test(helperKey)) return json({ error: "Invalid helper access key." }, 400);

    let result: Record<string, unknown>;
    if (phase === "test") {
      result = await phaseTest(helperUrl, helperKey, assertConn(body.targetConn));
    } else if (phase === "schema") {
      result = await phaseSchema(helperUrl, helperKey, assertConn(body.targetConn));
    } else if (phase === "data") {
      const tables = (Array.isArray(body.tables) ? body.tables : []).map(String).filter((n) => IDENT_RE.test(n)).slice(0, 2000);
      result = await phaseData(helperUrl, helperKey, assertConn(body.targetConn), tables, (body.cursor as { i: number; offset: number }) || { i: 0, offset: 0 });
    } else if (phase === "auth") {
      result = await phaseAuth(helperUrl, helperKey, assertConn(body.targetConn), (body.cursor as { offset: number }) || { offset: 0 });
    } else if (phase === "storage") {
      result = await phaseStorage(helperUrl, helperKey, safeTargetUrl(body.targetUrl), String(body.targetKey || ""), (body.cursor as { i: number }) || { i: 0 });
    } else if (phase === "finalize") {
      result = await phaseFinalize(helperUrl, helperKey, assertConn(body.targetConn));
    } else {
      return json({ error: "Unknown phase." }, 400);
    }

    // Best-effort audit breadcrumb (no credentials, no data).
    if (UUID_RE.test(projectId)) {
      await admin.from("migration_audit_logs").insert({
        project_id: projectId, user_id: userId, action: "run_" + phase,
        meta: { done: result.done === true, inserted: result.inserted || null, processed: result.processed || null },
      }).then(() => {}, () => {});
    }

    return json(result);
  } catch (err) {
    const status = typeof (err as { status?: unknown }).status === "number" ? (err as { status: number }).status : 500;
    return json({ error: redact(err instanceof Error ? err.message : "Migration step failed.") }, status);
  }
});
