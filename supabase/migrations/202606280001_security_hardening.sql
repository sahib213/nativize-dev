-- Security hardening for existing Nativize Supabase projects.
-- Safe to run after 202606270001_billing.sql and website/supabase-feedback.sql.

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

revoke all on function public.nativize_check_rate_limit(text, integer, integer) from public;
grant execute on function public.nativize_check_rate_limit(text, integer, integer) to service_role;

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

revoke all on function public.get_billing_status() from public;
grant execute on function public.get_billing_status() to authenticated;

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

revoke all on function public.activate_app(text) from public;
grant execute on function public.activate_app(text) to authenticated;

create or replace function public.nativize_limit_public_feedback()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  recent_count integer := 0;
  normalized_email text := lower(nullif(trim(new.email), ''));
  bucket text;
begin
  if new.source <> 'website' then
    raise exception 'Invalid source' using errcode = '22023';
  end if;

  new.email = normalized_email;
  new.page_path = nullif(trim(coalesce(new.page_path, '/')), '');
  if new.page_path is null then
    new.page_path = '/';
  end if;
  if char_length(new.page_path) > 300 or new.page_path !~ '^/[a-zA-Z0-9._~/?#=&%:+-]*$' then
    raise exception 'Invalid page path' using errcode = '22023';
  end if;
  if new.email is not null and (
    char_length(new.email) > 254
    or new.email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
  ) then
    raise exception 'Invalid email address' using errcode = '22023';
  end if;

  if tg_table_name = 'support_requests' then
    new.name = nullif(trim(coalesce(new.name, '')), '');
    if new.name is not null and char_length(new.name) > 100 then
      raise exception 'Name is too long' using errcode = '22023';
    end if;
    if new.email is null then
      raise exception 'Email is required' using errcode = '22023';
    end if;
    new.message = trim(coalesce(new.message, ''));
    if char_length(new.message) < 1 or char_length(new.message) > 1600 then
      raise exception 'Message is too long' using errcode = '22023';
    end if;
    bucket := 'feedback:support:' || new.email;
    perform public.nativize_check_rate_limit(bucket, 5, 900);
    select count(*)::integer
      into recent_count
      from public.support_requests sr
     where sr.created_at > now() - interval '15 minutes'
       and lower(sr.email) = normalized_email;
  else
    new.title = trim(coalesce(new.title, ''));
    new.description = trim(coalesce(new.description, ''));
    if char_length(new.title) < 1 or char_length(new.title) > 120 then
      raise exception 'Title is too long' using errcode = '22023';
    end if;
    if char_length(new.description) < 1 or char_length(new.description) > 1200 then
      raise exception 'Description is too long' using errcode = '22023';
    end if;
    bucket := 'feedback:feature:' || coalesce(new.email, regexp_replace(new.page_path, '[^a-zA-Z0-9._/-]', '-', 'g'));
    perform public.nativize_check_rate_limit(bucket, 5, 900);
    select count(*)::integer
      into recent_count
      from public.feature_requests fr
     where fr.created_at > now() - interval '15 minutes'
       and (
         (normalized_email is not null and lower(fr.email) = normalized_email)
         or (normalized_email is null and coalesce(fr.page_path, '') = coalesce(new.page_path, ''))
       );
  end if;

  if recent_count >= 5 then
    raise exception 'Too many submissions. Please try again later.' using errcode = 'P0001';
  end if;

  return new;
end;
$$;

do $$
begin
  if to_regclass('public.feature_requests') is not null then
    execute 'drop trigger if exists feature_requests_public_rate_limit on public.feature_requests';
    execute 'create trigger feature_requests_public_rate_limit before insert on public.feature_requests for each row execute function public.nativize_limit_public_feedback()';
  end if;

  if to_regclass('public.support_requests') is not null then
    execute 'drop trigger if exists support_requests_public_rate_limit on public.support_requests';
    execute 'create trigger support_requests_public_rate_limit before insert on public.support_requests for each row execute function public.nativize_limit_public_feedback()';
  end if;
end;
$$;
