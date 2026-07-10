-- ============================================================================
-- Nativize Migration Hub — projects, scans, credits, entitlement RPCs.
--
-- Access model (server-side, never frontend-only):
--   • Max subscribers (billing_entitlements.plan_id='max', active/trialing)
--     create unlimited migration projects.
--   • A "Single Migration" purchase grants one row in migration_credits;
--     create_migration_project() consumes it atomically — if project creation
--     fails the transaction rolls back and the credit is NOT consumed.
--   • Everyone else gets a paywall. Scans store ONLY redacted metadata:
--     file paths, counts, and secret NAMES — never secret values.
-- ============================================================================

-- ---------- Tables ----------
create table if not exists public.migration_projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null default 'My migration',
  source_provider text not null default 'zip',
  target_provider text not null default 'supabase',
  status text not null default 'connect'
    check (status in ('connect','target','scan','run','test','done')),
  size text check (size in ('small','medium','large','complex')),
  risk text check (risk in ('safe','warn','danger')),
  target_project_ref text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.migration_scans (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.migration_projects (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  summary jsonb not null default '{}'::jsonb,  -- redacted: counts, paths, names only
  created_at timestamptz not null default now()
);

create table if not exists public.migration_detected_functions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.migration_projects (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  uses_service_role boolean not null default false,
  has_deno_json boolean not null default false,
  imports_shared boolean not null default false,
  secret_names text[] not null default '{}',
  external_apis text[] not null default '{}',
  created_at timestamptz not null default now()
);

create table if not exists public.migration_detected_secrets (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.migration_projects (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (name ~ '^[A-Z0-9_]{1,80}$'),  -- names only, never values
  scope text not null default 'server' check (scope in ('server','frontend','env-file')),
  suspicious boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.migration_detected_storage_buckets (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.migration_projects (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.migration_generated_files (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.migration_projects (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (name in (
    'MANUAL_SUPABASE_MIGRATION_PLAN.md',
    'SUPABASE_SECRETS_CHECKLIST.md',
    'SUPABASE_FUNCTION_DEPLOY_COMMANDS.md',
    'POST_MIGRATION_TEST_CHECKLIST.md'
  )),
  content text not null check (char_length(content) <= 400000),
  created_at timestamptz not null default now(),
  unique (project_id, name)
);

create table if not exists public.migration_audit_logs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.migration_projects (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  action text not null,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.migration_credits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  status text not null default 'unused' check (status in ('unused','used')),
  source text not null default 'purchase' check (source in ('purchase','grant')),
  stripe_checkout_session_id text unique,
  project_id uuid references public.migration_projects (id) on delete set null,
  created_at timestamptz not null default now(),
  used_at timestamptz
);

create table if not exists public.migration_purchases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  stripe_checkout_session_id text not null unique,
  stripe_price_id text,
  created_at timestamptz not null default now()
);

create table if not exists public.migration_provider_status (
  id text primary key,
  kind text not null check (kind in ('source','target')),
  name text not null,
  status text not null check (status in ('full','guided','soon')),
  updated_at timestamptz not null default now()
);

create index if not exists migration_projects_user_idx on public.migration_projects (user_id, created_at desc);
create index if not exists migration_scans_project_idx on public.migration_scans (project_id, created_at desc);
create index if not exists migration_credits_user_idx on public.migration_credits (user_id, status);
create index if not exists migration_audit_project_idx on public.migration_audit_logs (project_id, created_at desc);

-- ---------- updated_at touch ----------
drop trigger if exists migration_projects_touch on public.migration_projects;
create trigger migration_projects_touch
before update on public.migration_projects
for each row execute function public.nativize_touch_updated_at();

-- ---------- RLS: owners only; credits/purchases are read-only from the client ----------
alter table public.migration_projects enable row level security;
alter table public.migration_scans enable row level security;
alter table public.migration_detected_functions enable row level security;
alter table public.migration_detected_secrets enable row level security;
alter table public.migration_detected_storage_buckets enable row level security;
alter table public.migration_generated_files enable row level security;
alter table public.migration_audit_logs enable row level security;
alter table public.migration_credits enable row level security;
alter table public.migration_purchases enable row level security;
alter table public.migration_provider_status enable row level security;

drop policy if exists "own migration projects" on public.migration_projects;
create policy "own migration projects" on public.migration_projects
  for select using (auth.uid() = user_id);
drop policy if exists "update own migration projects" on public.migration_projects;
create policy "update own migration projects" on public.migration_projects
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own migration scans" on public.migration_scans;
create policy "own migration scans" on public.migration_scans
  for select using (auth.uid() = user_id);
drop policy if exists "own detected functions" on public.migration_detected_functions;
create policy "own detected functions" on public.migration_detected_functions
  for select using (auth.uid() = user_id);
drop policy if exists "own detected secrets" on public.migration_detected_secrets;
create policy "own detected secrets" on public.migration_detected_secrets
  for select using (auth.uid() = user_id);
drop policy if exists "own detected buckets" on public.migration_detected_storage_buckets;
create policy "own detected buckets" on public.migration_detected_storage_buckets
  for select using (auth.uid() = user_id);
drop policy if exists "own generated files" on public.migration_generated_files;
create policy "own generated files" on public.migration_generated_files
  for select using (auth.uid() = user_id);
drop policy if exists "own audit logs" on public.migration_audit_logs;
create policy "own audit logs" on public.migration_audit_logs
  for select using (auth.uid() = user_id);
drop policy if exists "own migration credits" on public.migration_credits;
create policy "own migration credits" on public.migration_credits
  for select using (auth.uid() = user_id);
drop policy if exists "own migration purchases" on public.migration_purchases;
create policy "own migration purchases" on public.migration_purchases
  for select using (auth.uid() = user_id);
drop policy if exists "provider status is public" on public.migration_provider_status;
create policy "provider status is public" on public.migration_provider_status
  for select using (true);
-- No client insert/update policies on scans/credits/etc: all writes go through
-- the SECURITY DEFINER RPCs below (or the service role in the Stripe webhook).

-- ---------- Seed provider statuses (honest) ----------
insert into public.migration_provider_status (id, kind, name, status) values
  ('lovable','source','Lovable Cloud','full'),
  ('zip','source','Uploaded ZIP','full'),
  ('github','source','GitHub repo','guided'),
  ('bolt','source','Bolt','guided'),
  ('base44','source','Base44','guided'),
  ('replit','source','Replit','guided'),
  ('cursor','source','Cursor / Codex project','guided'),
  ('vercel-src','source','Vercel project','guided'),
  ('firebase-src','source','Firebase project','soon'),
  ('supabase-src','source','Supabase project','guided'),
  ('supabase','target','Supabase','full'),
  ('aws','target','AWS','guided'),
  ('firebase','target','Firebase','guided'),
  ('vercel','target','Vercel','guided'),
  ('railway','target','Railway','soon'),
  ('render','target','Render','soon'),
  ('neon','target','Neon Postgres','guided'),
  ('docker','target','Docker / self-hosted','guided'),
  ('postgres','target','Generic PostgreSQL','guided'),
  ('github-export','target','GitHub repo export','guided'),
  ('nativize','target','Native app (Nativize)','guided')
on conflict (id) do update set name = excluded.name, status = excluded.status, updated_at = now();

-- ---------- Helper: does this user have an active Max subscription? ----------
create or replace function public.migration_user_is_max(p_user uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.billing_entitlements be
    where be.user_id = p_user
      and be.plan_id = 'max'
      and lower(be.status) in ('active','trialing')
  );
$$;
revoke all on function public.migration_user_is_max(uuid) from public;

-- ---------- Helper: reject recognizable raw credentials from every JSON write ----------
create or replace function public.migration_payload_has_secret(p_value jsonb)
returns boolean
language sql
immutable
strict
set search_path = public
as $$
  select p_value::text ~* '(sb_secret_|sk_(live|test)_[a-z0-9]{8,}|rk_(live|test)_[a-z0-9]{8,}|whsec_[a-z0-9]{8,}|github_pat_[a-z0-9_]{20,}|gh[opusr]_[a-z0-9]{20,}|xox[baprs]-[a-z0-9-]{10,}|postgres(ql)?://[^[:space:]"'']+:[^[:space:]"'']+@|eyJ[a-z0-9_-]{8,}\.[a-z0-9_-]{4,}\.[a-z0-9_-]{4,})';
$$;
revoke all on function public.migration_payload_has_secret(jsonb) from public;

-- ---------- RPC: access check (Max / credit / none) ----------
create or replace function public.get_migration_access()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_is_max boolean;
  v_credits int;
  v_projects int;
begin
  if v_user is null then
    return jsonb_build_object('access','none','is_max',false,'credits_available',0,'projects',0);
  end if;
  v_is_max := public.migration_user_is_max(v_user);
  select count(*) into v_credits from public.migration_credits
    where user_id = v_user and status = 'unused';
  select count(*) into v_projects from public.migration_projects
    where user_id = v_user;
  return jsonb_build_object(
    'access', case when v_is_max then 'max' when v_credits > 0 then 'credit' else 'none' end,
    'is_max', v_is_max,
    'credits_available', v_credits,
    'projects', v_projects
  );
end;
$$;
revoke all on function public.get_migration_access() from public;
grant execute on function public.get_migration_access() to authenticated;

-- ---------- RPC: create a project (consumes a credit atomically if not Max) ----------
drop function if exists public.create_migration_project(text, text, text);
create or replace function public.create_migration_project(
  p_name text,
  p_source text,
  p_target text,
  p_target_ref text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_is_max boolean;
  v_credit public.migration_credits%rowtype;
  v_project public.migration_projects%rowtype;
begin
  if v_user is null then
    raise exception 'AUTH_REQUIRED' using errcode = 'P0001';
  end if;
  if coalesce(trim(p_name), '') = '' or char_length(p_name) > 120 then
    raise exception 'INVALID_NAME' using errcode = 'P0001';
  end if;
  if p_source !~ '^[a-z0-9-]{2,30}$' or p_target !~ '^[a-z0-9-]{2,30}$' then
    raise exception 'INVALID_PROVIDER' using errcode = 'P0001';
  end if;
  if p_target_ref is not null and p_target_ref !~ '^[a-z0-9]{18,24}$' then
    raise exception 'INVALID_TARGET_REF' using errcode = 'P0001';
  end if;
  if not exists (
    select 1 from public.migration_provider_status
    where id = p_source and kind = 'source' and status <> 'soon'
  ) or not exists (
    select 1 from public.migration_provider_status
    where id = p_target and kind = 'target' and status <> 'soon'
  ) then
    raise exception 'UNSUPPORTED_PROVIDER' using errcode = 'P0001';
  end if;

  v_is_max := public.migration_user_is_max(v_user);

  if not v_is_max then
    -- Lock one unused credit; if the insert below fails, everything rolls back.
    select * into v_credit from public.migration_credits
      where user_id = v_user and status = 'unused'
      order by created_at asc
      limit 1
      for update skip locked;
    if v_credit.id is null then
      raise exception 'PAYMENT_REQUIRED' using errcode = 'P0001';
    end if;
  end if;

  insert into public.migration_projects (user_id, name, source_provider, target_provider, target_project_ref)
  values (v_user, trim(p_name), p_source, p_target, nullif(p_target_ref, ''))
  returning * into v_project;

  if not v_is_max then
    update public.migration_credits
      set status = 'used', used_at = now(), project_id = v_project.id
      where id = v_credit.id;
  end if;

  insert into public.migration_audit_logs (project_id, user_id, action, meta)
  values (v_project.id, v_user, 'project_created',
          jsonb_build_object('source', p_source, 'target', p_target, 'via', case when v_is_max then 'max' else 'credit' end));

  return jsonb_build_object('id', v_project.id, 'used_credit', not v_is_max);
end;
$$;
revoke all on function public.create_migration_project(text, text, text, text) from public;
grant execute on function public.create_migration_project(text, text, text, text) to authenticated;

-- ---------- RPC: save a scan summary (redacted metadata only) ----------
create or replace function public.save_migration_scan(
  p_project uuid,
  p_summary jsonb,
  p_size text,
  p_risk text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_scan_id uuid;
  v_fn jsonb;
  v_secret jsonb;
  v_bucket text;
begin
  if v_user is null then
    raise exception 'AUTH_REQUIRED' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.migration_projects where id = p_project and user_id = v_user) then
    raise exception 'NOT_FOUND' using errcode = 'P0001';
  end if;
  if char_length(p_summary::text) > 200000 then
    raise exception 'SUMMARY_TOO_LARGE' using errcode = 'P0001';
  end if;
  if p_summary is null or jsonb_typeof(p_summary) <> 'object' or
     (p_summary - array[
       'fileCount','sqlMigrations','edgeFunctions','hasConfigToml','clientFiles',
       'projectRefs','secrets','storageBuckets','authRedirects','deepLinks',
       'envFiles','envTracked','integrations','warnings'
     ]::text[]) <> '{}'::jsonb then
    raise exception 'INVALID_SUMMARY_SHAPE' using errcode = 'P0001';
  end if;
  -- Defense in depth: the browser scanner never emits values, and the server
  -- rejects recognizable private credentials even if a caller bypasses it.
  if public.migration_payload_has_secret(p_summary) then
    raise exception 'SECRET_VALUE_REJECTED' using errcode = 'P0001';
  end if;
  if p_size is not null and p_size not in ('small','medium','large','complex') then
    raise exception 'INVALID_SIZE' using errcode = 'P0001';
  end if;
  if p_risk is not null and p_risk not in ('safe','warn','danger') then
    raise exception 'INVALID_RISK' using errcode = 'P0001';
  end if;

  insert into public.migration_scans (project_id, user_id, summary)
  values (p_project, v_user, coalesce(p_summary, '{}'::jsonb))
  returning id into v_scan_id;

  -- Refresh normalized child rows from the summary.
  delete from public.migration_detected_functions where project_id = p_project;
  delete from public.migration_detected_secrets where project_id = p_project;
  delete from public.migration_detected_storage_buckets where project_id = p_project;

  for v_fn in select * from jsonb_array_elements(coalesce(p_summary->'edgeFunctions', '[]'::jsonb)) limit 200 loop
    insert into public.migration_detected_functions
      (project_id, user_id, name, uses_service_role, has_deno_json, imports_shared, secret_names, external_apis)
    values (
      p_project, v_user,
      left(coalesce(v_fn->>'name','?'), 120),
      coalesce((v_fn->>'usesServiceRole')::boolean, false),
      coalesce((v_fn->>'hasDenoJson')::boolean, false),
      coalesce((v_fn->>'importsShared')::boolean, false),
      coalesce((select array_agg(left(x, 80)) from jsonb_array_elements_text(coalesce(v_fn->'secrets','[]'::jsonb)) as t(x)), '{}'),
      coalesce((select array_agg(left(x, 120)) from jsonb_array_elements_text(coalesce(v_fn->'externalApis','[]'::jsonb)) as t(x)), '{}')
    );
  end loop;

  for v_secret in select * from jsonb_array_elements(coalesce(p_summary->'secrets', '[]'::jsonb)) limit 300 loop
    -- Store the NAME only; skip anything that does not look like an env var name.
    if coalesce(v_secret->>'name','') ~ '^[A-Z0-9_]{1,80}$' then
      insert into public.migration_detected_secrets (project_id, user_id, name, scope, suspicious)
      values (
        p_project, v_user,
        v_secret->>'name',
        case when v_secret->>'scope' in ('server','frontend','env-file') then v_secret->>'scope' else 'server' end,
        coalesce((v_secret->>'suspicious')::boolean, false)
      );
    end if;
  end loop;

  for v_bucket in select left(x, 120) from jsonb_array_elements_text(coalesce(p_summary->'storageBuckets', '[]'::jsonb)) as t(x) limit 100 loop
    insert into public.migration_detected_storage_buckets (project_id, user_id, name)
    values (p_project, v_user, v_bucket);
  end loop;

  update public.migration_projects
    set size = coalesce(p_size, size),
        risk = coalesce(p_risk, risk),
        status = case when status in ('connect','target') then 'scan' else status end,
        updated_at = now()
    where id = p_project;

  insert into public.migration_audit_logs (project_id, user_id, action, meta)
  values (p_project, v_user, 'scan_saved', jsonb_build_object('size', p_size, 'risk', p_risk));

  return jsonb_build_object('scan_id', v_scan_id);
end;
$$;
revoke all on function public.save_migration_scan(uuid, jsonb, text, text) from public;
grant execute on function public.save_migration_scan(uuid, jsonb, text, text) to authenticated;

-- ---------- RPC: save generated markdown files ----------
create or replace function public.save_migration_files(
  p_project uuid,
  p_files jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_file jsonb;
  v_count int := 0;
begin
  if v_user is null then
    raise exception 'AUTH_REQUIRED' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.migration_projects where id = p_project and user_id = v_user) then
    raise exception 'NOT_FOUND' using errcode = 'P0001';
  end if;
  if p_files is null or jsonb_typeof(p_files) <> 'array' or char_length(p_files::text) > 1600000 then
    raise exception 'INVALID_FILES' using errcode = 'P0001';
  end if;
  if public.migration_payload_has_secret(p_files) then
    raise exception 'SECRET_VALUE_REJECTED' using errcode = 'P0001';
  end if;

  for v_file in select * from jsonb_array_elements(coalesce(p_files, '[]'::jsonb)) limit 4 loop
    insert into public.migration_generated_files (project_id, user_id, name, content)
    values (p_project, v_user, v_file->>'name', left(coalesce(v_file->>'content',''), 400000))
    on conflict (project_id, name)
      do update set content = excluded.content, created_at = now();
    v_count := v_count + 1;
  end loop;

  return jsonb_build_object('saved', v_count);
end;
$$;
revoke all on function public.save_migration_files(uuid, jsonb) from public;
grant execute on function public.save_migration_files(uuid, jsonb) to authenticated;

-- ---------- RPC: advance the guided project status ----------
create or replace function public.update_migration_project_status(
  p_project uuid,
  p_status text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_current text;
  v_current_rank int;
  v_next_rank int;
begin
  if v_user is null then
    raise exception 'AUTH_REQUIRED' using errcode = 'P0001';
  end if;
  if p_status not in ('run','test','done') then
    raise exception 'INVALID_STATUS' using errcode = 'P0001';
  end if;
  select status into v_current from public.migration_projects
    where id = p_project and user_id = v_user for update;
  if v_current is null then
    raise exception 'NOT_FOUND' using errcode = 'P0001';
  end if;
  v_current_rank := case v_current when 'connect' then 0 when 'target' then 1 when 'scan' then 2 when 'run' then 3 when 'test' then 4 when 'done' then 5 end;
  v_next_rank := case p_status when 'run' then 3 when 'test' then 4 when 'done' then 5 end;
  if v_next_rank < v_current_rank then
    return jsonb_build_object('status', v_current);
  end if;
  if p_status = 'done' and v_current <> 'test' then
    raise exception 'TESTS_REQUIRED' using errcode = 'P0001';
  end if;
  update public.migration_projects set status = p_status, updated_at = now()
    where id = p_project and user_id = v_user;
  insert into public.migration_audit_logs (project_id, user_id, action, meta)
    values (p_project, v_user, 'status_changed', jsonb_build_object('from', v_current, 'to', p_status));
  return jsonb_build_object('status', p_status);
end;
$$;
revoke all on function public.update_migration_project_status(uuid, text) from public;
grant execute on function public.update_migration_project_status(uuid, text) to authenticated;

-- ---------- RPC: audit log from the client (non-sensitive breadcrumbs) ----------
create or replace function public.log_migration_event(
  p_project uuid,
  p_action text,
  p_meta jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then return; end if;
  if p_action !~ '^[a-z0-9_-]{2,60}$' then return; end if;
  if not exists (select 1 from public.migration_projects where id = p_project and user_id = v_user) then return; end if;
  if char_length(coalesce(p_meta, '{}'::jsonb)::text) > 4000 or public.migration_payload_has_secret(coalesce(p_meta, '{}'::jsonb)) then p_meta := '{}'::jsonb; end if;
  insert into public.migration_audit_logs (project_id, user_id, action, meta)
  values (p_project, v_user, p_action, coalesce(p_meta, '{}'::jsonb));
end;
$$;
revoke all on function public.log_migration_event(uuid, text, jsonb) from public;
grant execute on function public.log_migration_event(uuid, text, jsonb) to authenticated;
