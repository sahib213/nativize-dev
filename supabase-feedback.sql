-- Supabase setup for the website support and feature-request forms.
-- Run this in the Supabase SQL editor for the project used by website/script.js.

create extension if not exists pgcrypto;

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
