-- 1) FIX: support/feature form inserts were failing with SQL error 42702
--    ("column reference \"bucket\" is ambiguous") inside nativize_check_rate_limit:
--    the two UPDATE statements used `where bucket = normalized_bucket`, where
--    `bucket` is BOTH the function parameter and the table column. Qualify the
--    column. Signature unchanged, so CREATE OR REPLACE is safe.
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
     where nativize_rate_limits.bucket = normalized_bucket;
    return;
  end if;

  if current_row.hits >= max_hits then
    raise exception 'Too many requests. Please try again later.' using errcode = 'P0001';
  end if;

  update public.nativize_rate_limits
     set hits = hits + 1, updated_at = now()
   where nativize_rate_limits.bucket = normalized_bucket;
end;
$$;

-- 2) Ticket workflow columns on support_requests (safe, additive).
alter table public.support_requests add column if not exists status text not null default 'open';
alter table public.support_requests add column if not exists replied_at timestamptz;
alter table public.support_requests add column if not exists updated_at timestamptz not null default now();
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'support_requests_status_check'
  ) then
    alter table public.support_requests
      add constraint support_requests_status_check
      check (status in ('open', 'replied', 'closed'));
  end if;
end $$;

-- 3) Replies (AI + admin) to support requests. Server-side only: no anon access.
create table if not exists public.support_replies (
  id bigint generated always as identity primary key,
  request_id uuid not null references public.support_requests(id) on delete cascade,
  created_at timestamptz not null default now(),
  author text not null default 'ai' check (author in ('ai', 'admin')),
  body text not null check (char_length(body) between 1 and 8000),
  email_sent boolean not null default false,
  email_error text
);
create index if not exists support_replies_request_idx on public.support_replies (request_id);
alter table public.support_replies enable row level security;
revoke all on public.support_replies from anon, authenticated, public;
grant select, insert on public.support_replies to service_role;

-- 4) Daily AI briefs. Server-side only.
create table if not exists public.daily_briefs (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  brief text not null,
  data jsonb
);
alter table public.daily_briefs enable row level security;
revoke all on public.daily_briefs from anon, authenticated, public;
grant select, insert on public.daily_briefs to service_role;
