-- Nativize billing backbone.
-- Run this in the Supabase project before deploying the Stripe edge functions.

create extension if not exists pgcrypto;

create table if not exists public.billing_customers (
  user_id uuid primary key references auth.users(id) on delete cascade,
  stripe_customer_id text not null unique,
  email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.billing_entitlements (
  user_id uuid primary key references auth.users(id) on delete cascade,
  plan_id text not null check (plan_id in ('free', 'starter', 'pro', 'max')),
  billing text not null check (billing in ('free', 'one-time', 'subscription')),
  status text not null default 'active',
  stripe_customer_id text,
  stripe_subscription_id text unique,
  stripe_price_id text,
  checkout_session_id text,
  current_period_end timestamptz,
  apps_limit integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.app_activations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  repo text not null,
  plan_id text not null check (plan_id in ('free', 'starter', 'pro', 'max')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, repo)
);

create index if not exists billing_entitlements_customer_idx
  on public.billing_entitlements (stripe_customer_id);

create index if not exists app_activations_user_idx
  on public.app_activations (user_id);

create table if not exists public.nativize_rate_limits (
  bucket text primary key check (char_length(bucket) between 1 and 180),
  window_start timestamptz not null default now(),
  hits integer not null default 0 check (hits >= 0),
  updated_at timestamptz not null default now()
);

alter table public.nativize_rate_limits enable row level security;

create or replace function public.nativize_check_rate_limit(
  bucket text,
  max_hits integer default 5,
  window_seconds integer default 900
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_bucket text := lower(trim(bucket));
  current_row public.nativize_rate_limits%rowtype;
begin
  if normalized_bucket is null
    or char_length(normalized_bucket) < 3
    or char_length(normalized_bucket) > 180
    or normalized_bucket !~ '^[a-z0-9:_./@-]+$' then
    raise exception 'Invalid rate-limit bucket' using errcode = '22023';
  end if;

  if max_hits < 1 or max_hits > 500 or window_seconds < 60 or window_seconds > 86400 then
    raise exception 'Invalid rate-limit settings' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtext('nativize_rate_limit'), hashtext(normalized_bucket));

  select *
    into current_row
    from public.nativize_rate_limits rl
   where rl.bucket = normalized_bucket
   for update;

  if current_row.bucket is null then
    insert into public.nativize_rate_limits (bucket, window_start, hits, updated_at)
    values (normalized_bucket, now(), 1, now());
    return;
  end if;

  if current_row.window_start <= now() - make_interval(secs => window_seconds) then
    update public.nativize_rate_limits
       set window_start = now(), hits = 1, updated_at = now()
     where bucket = normalized_bucket;
    return;
  end if;

  if current_row.hits >= max_hits then
    raise exception 'Too many requests. Please try again later.' using errcode = 'P0001';
  end if;

  update public.nativize_rate_limits
     set hits = hits + 1, updated_at = now()
   where bucket = normalized_bucket;
end;
$$;

create or replace function public.nativize_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists billing_customers_touch_updated_at on public.billing_customers;
create trigger billing_customers_touch_updated_at
before update on public.billing_customers
for each row execute function public.nativize_touch_updated_at();

drop trigger if exists billing_entitlements_touch_updated_at on public.billing_entitlements;
create trigger billing_entitlements_touch_updated_at
before update on public.billing_entitlements
for each row execute function public.nativize_touch_updated_at();

drop trigger if exists app_activations_touch_updated_at on public.app_activations;
create trigger app_activations_touch_updated_at
before update on public.app_activations
for each row execute function public.nativize_touch_updated_at();

alter table public.billing_customers enable row level security;
alter table public.billing_entitlements enable row level security;
alter table public.app_activations enable row level security;

drop policy if exists "Users can read their Stripe customer mapping" on public.billing_customers;
create policy "Users can read their Stripe customer mapping"
on public.billing_customers
for select
using (auth.uid() = user_id);

drop policy if exists "Users can read their own entitlement" on public.billing_entitlements;
create policy "Users can read their own entitlement"
on public.billing_entitlements
for select
using (auth.uid() = user_id);

drop policy if exists "Users can read their own activations" on public.app_activations;
create policy "Users can read their own activations"
on public.app_activations
for select
using (auth.uid() = user_id);

create or replace function public.nativize_plan_limit(plan_id text)
returns integer
language sql
immutable
as $$
  select case plan_id
    when 'max' then 10
    when 'pro' then 3
    when 'starter' then 1
    else 1
  end;
$$;

create or replace function public.get_billing_status()
returns table (
  user_id uuid,
  plan_id text,
  billing text,
  status text,
  current_period_end timestamptz,
  apps_limit integer,
  apps_used integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  entitlement public.billing_entitlements%rowtype;
  used_count integer := 0;
begin
  if current_user_id is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  perform public.nativize_check_rate_limit('billing-status:' || current_user_id::text, 60, 900);

  select count(*)::integer
    into used_count
    from public.app_activations aa
   where aa.user_id = current_user_id;

  select *
    into entitlement
    from public.billing_entitlements be
   where be.user_id = current_user_id
     and be.status in ('active', 'trialing')
     and (be.current_period_end is null or be.current_period_end > now())
   order by be.updated_at desc
   limit 1;

  if entitlement.user_id is null then
    return query select
      current_user_id,
      'free'::text,
      'free'::text,
      'active'::text,
      null::timestamptz,
      public.nativize_plan_limit('free'),
      used_count;
  else
    return query select
      current_user_id,
      entitlement.plan_id,
      entitlement.billing,
      entitlement.status,
      entitlement.current_period_end,
      entitlement.apps_limit,
      used_count;
  end if;
end;
$$;

create or replace function public.activate_app(repo text)
returns table (
  plan_id text,
  billing text,
  status text,
  apps_limit integer,
  apps_used integer,
  activated boolean,
  already_activated boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  repo_name text := lower(trim(repo));
  current_status record;
  used_count integer := 0;
begin
  if current_user_id is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  if repo is null or char_length(repo) > 140 then
    raise exception 'Use a GitHub repo in owner/name format' using errcode = '22023';
  end if;

  if repo_name is null or repo_name !~ '^[a-z0-9][a-z0-9_.-]{0,38}/[a-z0-9][a-z0-9_.-]{0,99}$' then
    raise exception 'Use a GitHub repo in owner/name format' using errcode = '22023';
  end if;

  perform public.nativize_check_rate_limit('activate-app:' || current_user_id::text, 5, 900);

  -- Serialize count-then-insert for each user so concurrent activations cannot
  -- exceed the plan's app limit.
  perform pg_advisory_xact_lock(hashtext('nativize_activate_app'), hashtext(current_user_id::text));

  select * into current_status from public.get_billing_status();

  if exists (
    select 1 from public.app_activations aa
     where aa.user_id = current_user_id and aa.repo = repo_name
  ) then
    return query select
      current_status.plan_id::text,
      current_status.billing::text,
      current_status.status::text,
      current_status.apps_limit::integer,
      current_status.apps_used::integer,
      true,
      true;
    return;
  end if;

  if current_status.apps_used >= current_status.apps_limit then
    raise exception 'App limit reached for the % plan. Upgrade to add another app.', current_status.plan_id
      using errcode = 'P0001';
  end if;

  insert into public.app_activations (user_id, repo, plan_id)
  values (current_user_id, repo_name, current_status.plan_id);

  select count(*)::integer
    into used_count
    from public.app_activations aa
   where aa.user_id = current_user_id;

  return query select
    current_status.plan_id::text,
    current_status.billing::text,
    current_status.status::text,
    current_status.apps_limit::integer,
    used_count,
    true,
    false;
end;
$$;

revoke all on function public.get_billing_status() from public;
revoke all on function public.activate_app(text) from public;
revoke all on function public.nativize_check_rate_limit(text, integer, integer) from public;
grant execute on function public.get_billing_status() to authenticated;
grant execute on function public.activate_app(text) to authenticated;
grant execute on function public.nativize_check_rate_limit(text, integer, integer) to service_role;
