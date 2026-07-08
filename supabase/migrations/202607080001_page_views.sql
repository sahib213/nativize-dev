-- First-party, privacy-friendly pageview logging for the local Nativize dashboard.
-- Mirrors the security model of feature_requests/support_requests:
--   * anon can ONLY insert (write), never read.
--   * no PII is stored (no IP, no cookies, no user id) — just path, referrer host, day.
--   * reads happen only via service_role (the local dashboard) or the Supabase console.

create table if not exists public.page_views (
  id             bigint generated always as identity primary key,
  created_at     timestamptz not null default now(),
  day            date not null default (now() at time zone 'utc')::date,
  path           text not null check (char_length(path) between 1 and 300),
  referrer_host  text check (referrer_host is null or char_length(referrer_host) <= 180),
  is_new_visitor boolean not null default false
);

create index if not exists page_views_day_idx on public.page_views (day);
create index if not exists page_views_created_idx on public.page_views (created_at);

alter table public.page_views enable row level security;

-- Anonymous visitors may log a view, but cannot read the table.
grant insert on public.page_views to anon, authenticated;

drop policy if exists "Anyone can log a page view" on public.page_views;
create policy "Anyone can log a page view"
  on public.page_views
  for insert
  to anon, authenticated
  with check (true);

-- Convenience aggregate views for the dashboard / Supabase console (service_role only).
create or replace view public.admin_pageviews_daily as
  select
    day,
    count(*)::int                                         as views,
    count(*) filter (where is_new_visitor)::int           as new_visitors
  from public.page_views
  group by day
  order by day desc;

create or replace view public.admin_pageviews_totals as
  select
    count(*)::int                                         as total_views,
    count(*) filter (where is_new_visitor)::int           as total_new_visitors,
    count(*) filter (where day = (now() at time zone 'utc')::date)::int as views_today,
    count(*) filter (where day = (now() at time zone 'utc')::date and is_new_visitor)::int as new_visitors_today,
    count(*) filter (where day >= (now() at time zone 'utc')::date - 6)::int as views_7d,
    count(*) filter (where day >= (now() at time zone 'utc')::date - 29)::int as views_30d
  from public.page_views;

create or replace view public.admin_top_pages as
  select path, count(*)::int as views
  from public.page_views
  group by path
  order by views desc
  limit 50;

create or replace view public.admin_top_referrers as
  select referrer_host, count(*)::int as views
  from public.page_views
  where referrer_host is not null
  group by referrer_host
  order by views desc
  limit 50;

-- Plan / order breakdown for the dashboard (free vs paid), service_role only.
create or replace view public.admin_plan_breakdown as
  select
    plan_id,
    billing,
    status,
    count(*)::int as customers
  from public.billing_entitlements
  group by plan_id, billing, status
  order by customers desc;

revoke all on public.admin_pageviews_daily    from anon, authenticated, public;
revoke all on public.admin_pageviews_totals   from anon, authenticated, public;
revoke all on public.admin_top_pages          from anon, authenticated, public;
revoke all on public.admin_top_referrers      from anon, authenticated, public;
revoke all on public.admin_plan_breakdown     from anon, authenticated, public;
grant select on public.admin_pageviews_daily  to service_role;
grant select on public.admin_pageviews_totals to service_role;
grant select on public.admin_top_pages        to service_role;
grant select on public.admin_top_referrers    to service_role;
grant select on public.admin_plan_breakdown   to service_role;
