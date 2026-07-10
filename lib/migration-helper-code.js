/*
 * Nativize Migration — migrate-helper generator.
 *
 * Produces the Deno source for a TEMPORARY, read-only edge function the user
 * pastes into their OWN Lovable/Supabase project. It is the "connector" to
 * Lovable: Lovable Cloud cannot be reached directly, so this helper (running
 * inside the source project, with the service role Supabase injects for it)
 * exposes the project's schema, table rows, auth users, and storage objects.
 *
 * SAFETY:
 *  - The helper is READ-ONLY. It never writes to or deletes from the source.
 *  - Every request must carry the caller's random access key (x-migrate-key).
 *  - The user removes the helper after the migration (cleanup checklist).
 *  - The access key is generated in the browser and embedded in the code the
 *    user copies; it is never sent to or stored by Nativize.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.NativizeMigrationHelper = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function randomKey() {
    var bytes = new Uint8Array(24);
    if (typeof crypto !== "undefined" && crypto.getRandomValues) crypto.getRandomValues(bytes);
    else for (var i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    var out = "";
    for (var j = 0; j < bytes.length; j++) out += bytes[j].toString(16).padStart(2, "0");
    return "nzmig_" + out;
  }

  // The helper source, as an array of lines. JS entries are double-quoted;
  // the Deno code uses backtick tagged templates (postgres.js) written
  // literally inside those JS strings. "__ACCESS_KEY__" is replaced per user.
  var LINES = [
    "// Nativize migrate-helper — TEMPORARY, read-only export endpoint.",
    "// Paste this into a Lovable edge function named \"migrate-helper\".",
    "// Deploy with verify_jwt = false. Remove it when your migration is done.",
    "import postgres from \"https://deno.land/x/postgresjs@v3.4.5/mod.js\";",
    "",
    "const ACCESS_KEY = \"__ACCESS_KEY__\";",
    "const DB_URL = Deno.env.get(\"SUPABASE_DB_URL\") || \"\";",
    "const SUPABASE_URL = Deno.env.get(\"SUPABASE_URL\") || \"\";",
    "const SERVICE_KEY = Deno.env.get(\"SUPABASE_SERVICE_ROLE_KEY\") || \"\";",
    "",
    "const cors = {",
    "  \"Access-Control-Allow-Origin\": \"*\",",
    "  \"Access-Control-Allow-Headers\": \"authorization, content-type, x-migrate-key\",",
    "  \"Access-Control-Allow-Methods\": \"POST, OPTIONS\",",
    "};",
    "function json(body, status) {",
    "  return new Response(JSON.stringify(body), { status: status || 200, headers: { ...cors, \"Content-Type\": \"application/json\" } });",
    "}",
    "function ident(name) { return '\"' + String(name).replace(/\"/g, '\"\"') + '\"'; }",
    "",
    "Deno.serve(async (req) => {",
    "  if (req.method === \"OPTIONS\") return new Response(\"ok\", { headers: cors });",
    "  if (req.method !== \"POST\") return json({ error: \"POST only\" }, 405);",
    "  const key = req.headers.get(\"x-migrate-key\") || \"\";",
    "  if (!ACCESS_KEY || key !== ACCESS_KEY) return json({ error: \"Bad access key\" }, 401);",
    "  if (!DB_URL) return json({ error: \"SUPABASE_DB_URL not available in this project\" }, 500);",
    "  let body = {};",
    "  try { body = await req.json(); } catch (_e) { body = {}; }",
    "  const action = String(body.action || \"\");",
    "  const sql = postgres(DB_URL, { prepare: false, max: 1, idle_timeout: 5 });",
    "  try {",
    "    if (action === \"ping\") {",
    "      const t = await sql`select count(*)::int as n from information_schema.tables where table_schema='public' and table_type='BASE TABLE'`;",
    "      const u = await sql`select count(*)::int as n from auth.users`;",
    "      const b = await sql`select count(*)::int as n from storage.buckets`;",
    "      const o = await sql`select count(*)::int as n from storage.objects`;",
    "      return json({ ok: true, tables: t[0].n, users: u[0].n, buckets: b[0].n, objects: o[0].n });",
    "    }",
    "    if (action === \"schema\") return json(await buildSchema(sql));",
    "    if (action === \"table\") {",
    "      const name = String(body.name || \"\");",
    "      if (!/^[A-Za-z0-9_]+$/.test(name)) return json({ error: \"bad table\" }, 400);",
    "      const limit = Math.min(2000, Math.max(1, Number(body.limit) || 500));",
    "      const offset = Math.max(0, Number(body.offset) || 0);",
    "      const rows = await sql.unsafe(\"select * from public.\" + ident(name) + \" order by 1 offset \" + offset + \" limit \" + limit);",
    "      return json({ rows: rows, count: rows.length });",
    "    }",
    "    if (action === \"auth_users\") {",
    "      const limit = Math.min(1000, Math.max(1, Number(body.limit) || 500));",
    "      const offset = Math.max(0, Number(body.offset) || 0);",
    "      const rows = await sql.unsafe(\"select id, aud, role, email, encrypted_password, email_confirmed_at, invited_at, confirmation_token, confirmation_sent_at, recovery_token, recovery_sent_at, email_change_token_new, email_change, email_change_sent_at, last_sign_in_at, raw_app_meta_data, raw_user_meta_data, is_super_admin, created_at, updated_at, phone, phone_confirmed_at, banned_until, is_sso_user, deleted_at, is_anonymous from auth.users order by created_at offset \" + offset + \" limit \" + limit);",
    "      return json({ rows: rows, count: rows.length });",
    "    }",
    "    if (action === \"storage_list\") {",
    "      const buckets = await sql`select id, name, public, file_size_limit, allowed_mime_types from storage.buckets order by name`;",
    "      const objects = await sql`select bucket_id, name, metadata from storage.objects order by bucket_id, name limit 20000`;",
    "      return json({ buckets: buckets, objects: objects });",
    "    }",
    "    if (action === \"storage_object\") {",
    "      const bucket = String(body.bucket || \"\");",
    "      const name = String(body.name || \"\");",
    "      if (!bucket || !name) return json({ error: \"bad object\" }, 400);",
    "      const url = SUPABASE_URL + \"/storage/v1/object/\" + encodeURIComponent(bucket) + \"/\" + name.split(\"/\").map(encodeURIComponent).join(\"/\");",
    "      const res = await fetch(url, { headers: { Authorization: \"Bearer \" + SERVICE_KEY } });",
    "      if (!res.ok) return json({ error: \"download failed \" + res.status }, 502);",
    "      const buf = new Uint8Array(await res.arrayBuffer());",
    "      let bin = \"\"; for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);",
    "      return json({ contentType: res.headers.get(\"content-type\") || \"application/octet-stream\", base64: btoa(bin), size: buf.length });",
    "    }",
    "    return json({ error: \"unknown action\" }, 400);",
    "  } catch (e) {",
    "    return json({ error: String(e && e.message || e) }, 500);",
    "  } finally {",
    "    try { await sql.end({ timeout: 5 }); } catch (_e) {}",
    "  }",
    "});",
    "",
    "async function buildSchema(sql) {",
    "  const enums = await sql`select t.typname, e.enumlabel from pg_type t join pg_enum e on e.enumtypid=t.oid join pg_namespace n on n.oid=t.typnamespace where n.nspname='public' order by t.typname, e.enumsortorder`;",
    "  const enumMap = {};",
    "  for (const r of enums) { (enumMap[r.typname] = enumMap[r.typname] || []).push(r.enumlabel); }",
    "  const types = Object.keys(enumMap).map((n) => \"create type public.\" + ident(n) + \" as enum (\" + enumMap[n].map((v) => \"'\" + String(v).replace(/'/g, \"''\") + \"'\").join(\", \") + \");\");",
    "  const cols = await sql`select table_name, column_name, data_type, udt_name, is_nullable, column_default, character_maximum_length from information_schema.columns where table_schema='public' order by table_name, ordinal_position`;",
    "  const pks = await sql`select tc.table_name, kcu.column_name, kcu.ordinal_position from information_schema.table_constraints tc join information_schema.key_column_usage kcu on tc.constraint_name=kcu.constraint_name and tc.table_schema=kcu.table_schema where tc.table_schema='public' and tc.constraint_type='PRIMARY KEY' order by kcu.ordinal_position`;",
    "  const pkMap = {}; for (const p of pks) { (pkMap[p.table_name] = pkMap[p.table_name] || []).push(p.column_name); }",
    "  const byTable = {};",
    "  for (const c of cols) { (byTable[c.table_name] = byTable[c.table_name] || []).push(c); }",
    "  function mapType(u) {",
    "    const m = { int2: \"smallint\", int4: \"integer\", int8: \"bigint\", float4: \"real\", float8: \"double precision\", bool: \"boolean\", varchar: \"varchar\", bpchar: \"char\", timestamptz: \"timestamptz\", timestamp: \"timestamp\", timetz: \"timetz\", numeric: \"numeric\", text: \"text\", uuid: \"uuid\", jsonb: \"jsonb\", json: \"json\", date: \"date\", time: \"time\", bytea: \"bytea\", inet: \"inet\" };",
    "    if (m[u]) return m[u]; if (enumMap[u]) return \"public.\" + ident(u); return u;",
    "  }",
    "  function colType(c) {",
    "    const u = c.udt_name;",
    "    if (u && u[0] === \"_\") return (mapType(u.slice(1)) || \"text\") + \"[]\";",
    "    return mapType(u) || c.data_type;",
    "  }",
    "  const tables = Object.keys(byTable).sort().map((t) => {",
    "    const lines = byTable[t].map((c) => {",
    "      let d = \"  \" + ident(c.column_name) + \" \" + colType(c);",
    "      if (c.column_default) d += \" default \" + c.column_default;",
    "      if (c.is_nullable === \"NO\") d += \" not null\";",
    "      return d;",
    "    });",
    "    if (pkMap[t] && pkMap[t].length) lines.push(\"  primary key (\" + pkMap[t].map(ident).join(\", \") + \")\");",
    "    return { name: t, ddl: \"create table if not exists public.\" + ident(t) + \" (\\n\" + lines.join(\",\\n\") + \"\\n);\" };",
    "  });",
    "  const fks = await sql`select tc.constraint_name, tc.table_name, kcu.column_name, ccu.table_name as ref_table, ccu.column_name as ref_column from information_schema.table_constraints tc join information_schema.key_column_usage kcu on tc.constraint_name=kcu.constraint_name join information_schema.constraint_column_usage ccu on ccu.constraint_name=tc.constraint_name where tc.table_schema='public' and tc.constraint_type='FOREIGN KEY'`;",
    "  const constraints = fks.map((f) => \"alter table public.\" + ident(f.table_name) + \" add constraint \" + ident(f.constraint_name) + \" foreign key (\" + ident(f.column_name) + \") references public.\" + ident(f.ref_table) + \" (\" + ident(f.ref_column) + \") on delete cascade;\");",
    "  const idx = await sql`select indexdef from pg_indexes where schemaname='public' and indexname not like '%_pkey'`;",
    "  const indexes = idx.map((i) => i.indexdef + \";\");",
    "  const rlsTables = await sql`select relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relrowsecurity=true`;",
    "  const rls = rlsTables.map((r) => \"alter table public.\" + ident(r.relname) + \" enable row level security;\");",
    "  const pols = await sql`select tablename, policyname, permissive, roles, cmd, qual, with_check from pg_policies where schemaname='public'`;",
    "  for (const p of pols) {",
    "    let stmt = \"create policy \" + ident(p.policyname) + \" on public.\" + ident(p.tablename);",
    "    stmt += \" as \" + (p.permissive === \"PERMISSIVE\" ? \"permissive\" : \"restrictive\");",
    "    stmt += \" for \" + (p.cmd || \"all\").toLowerCase();",
    "    const roles = Array.isArray(p.roles) ? p.roles.join(\", \") : String(p.roles || \"\").replace(/[{}]/g, \"\");",
    "    if (roles) stmt += \" to \" + roles;",
    "    if (p.qual) stmt += \" using (\" + p.qual + \")\";",
    "    if (p.with_check) stmt += \" with check (\" + p.with_check + \")\";",
    "    rls.push(stmt + \";\");",
    "  }",
    "  const seqs = await sql`select sequence_name from information_schema.sequences where sequence_schema='public'`;",
    "  const sequences = [];",
    "  for (const s of seqs) { try { const v = await sql.unsafe(\"select last_value from public.\" + ident(s.sequence_name)); sequences.push({ name: s.sequence_name, value: Number(v[0].last_value) }); } catch (_e) { sequences.push({ name: s.sequence_name, value: 1 }); } }",
    "  const tableNames = tables.map((t) => t.name);",
    "  return { types, tables, constraints, indexes, rls, sequences, tableNames };",
    "}",
    ""
  ];

  function helperCode(accessKey) {
    var key = String(accessKey || "").replace(/[^A-Za-z0-9_]/g, "");
    return LINES.join("\n").replace("__ACCESS_KEY__", key);
  }

  return { randomKey: randomKey, helperCode: helperCode };
});
