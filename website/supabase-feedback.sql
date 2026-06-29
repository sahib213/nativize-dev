-- Supabase setup for the website support and feature-request forms.
-- Run this in the Supabase SQL editor for the project used by website/script.js.

create extension if not exists pgcrypto;

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

create table if not exists public.feature_requests (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  email text,
  priority text not null default 'nice-to-have'
    check (priority in ('nice-to-have', 'important', 'blocking')),
  title text not null check (char_length(title) between 1 and 120),
  description text not null check (char_length(description) between 1 and 1200),
  source text not null default 'website',
  page_path text
);

create table if not exists public.support_requests (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  name text,
  email text not null,
  topic text not null
    check (topic in ('github-auth', 'generated-project', 'github-actions-build', 'store-upload', 'billing', 'other')),
  message text not null check (char_length(message) between 1 and 1600),
  source text not null default 'website',
  page_path text
);

alter table public.feature_requests enable row level security;
alter table public.support_requests enable row level security;

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
    bucket := 'feedback:support:' || md5(new.email);
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
    bucket := 'feedback:feature:' || md5(coalesce(new.email, new.page_path));
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

drop trigger if exists feature_requests_public_rate_limit on public.feature_requests;
create trigger feature_requests_public_rate_limit
before insert on public.feature_requests
for each row execute function public.nativize_limit_public_feedback();

drop trigger if exists support_requests_public_rate_limit on public.support_requests;
create trigger support_requests_public_rate_limit
before insert on public.support_requests
for each row execute function public.nativize_limit_public_feedback();

grant insert on public.feature_requests to anon, authenticated;
grant insert on public.support_requests to anon, authenticated;

drop policy if exists "Anyone can submit feature requests" on public.feature_requests;
create policy "Anyone can submit feature requests"
  on public.feature_requests
  for insert
  to anon, authenticated
  with check (source = 'website');

drop policy if exists "Anyone can submit support requests" on public.support_requests;
create policy "Anyone can submit support requests"
  on public.support_requests
  for insert
  to anon, authenticated
  with check (source = 'website');

create index if not exists feature_requests_created_at_idx
  on public.feature_requests (created_at desc);

create index if not exists support_requests_created_at_idx
  on public.support_requests (created_at desc);
