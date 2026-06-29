-- Support automation metadata and private inbox views.
-- Run after website/supabase-feedback.sql.

grant execute on function public.nativize_check_rate_limit(text, integer, integer) to service_role;

alter table public.support_requests
  add column if not exists status text not null default 'new',
  add column if not exists bot_needs_human boolean not null default false,
  add column if not exists bot_summary text,
  add column if not exists bot_reply_subject text,
  add column if not exists bot_reply_body text,
  add column if not exists auto_reply_sent_at timestamptz,
  add column if not exists owner_notified_at timestamptz,
  add column if not exists automation_error text;

alter table public.feature_requests
  add column if not exists status text not null default 'new',
  add column if not exists bot_needs_human boolean not null default false,
  add column if not exists bot_summary text,
  add column if not exists bot_reply_subject text,
  add column if not exists bot_reply_body text,
  add column if not exists auto_reply_sent_at timestamptz,
  add column if not exists owner_notified_at timestamptz,
  add column if not exists automation_error text;

do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conrelid = 'public.support_requests'::regclass
       and conname = 'support_requests_automation_status_check'
  ) then
    alter table public.support_requests
      add constraint support_requests_automation_status_check
      check (status in ('new', 'auto_replied', 'needs_human', 'closed'));
  end if;

  if not exists (
    select 1
      from pg_constraint
     where conrelid = 'public.feature_requests'::regclass
       and conname = 'feature_requests_automation_status_check'
  ) then
    alter table public.feature_requests
      add constraint feature_requests_automation_status_check
      check (status in ('new', 'acknowledged', 'needs_review', 'closed'));
  end if;

  if not exists (
    select 1
      from pg_constraint
     where conrelid = 'public.support_requests'::regclass
       and conname = 'support_requests_automation_text_size_check'
  ) then
    alter table public.support_requests
      add constraint support_requests_automation_text_size_check
      check (
        (bot_summary is null or char_length(bot_summary) <= 500)
        and (bot_reply_subject is null or char_length(bot_reply_subject) <= 240)
        and (bot_reply_body is null or char_length(bot_reply_body) <= 5000)
        and (automation_error is null or char_length(automation_error) <= 2000)
      );
  end if;

  if not exists (
    select 1
      from pg_constraint
     where conrelid = 'public.feature_requests'::regclass
       and conname = 'feature_requests_automation_text_size_check'
  ) then
    alter table public.feature_requests
      add constraint feature_requests_automation_text_size_check
      check (
        (bot_summary is null or char_length(bot_summary) <= 500)
        and (bot_reply_subject is null or char_length(bot_reply_subject) <= 240)
        and (bot_reply_body is null or char_length(bot_reply_body) <= 5000)
        and (automation_error is null or char_length(automation_error) <= 2000)
      );
  end if;
end;
$$;

create or replace function public.nativize_url_component(value text)
returns text
language sql
immutable
as $$
  select replace(
    replace(
      replace(
        replace(
          replace(
            replace(
              replace(
                replace(coalesce(value, ''), '%', '%25'),
                E'\r', ''
              ),
              E'\n', '%0A'
            ),
            ' ', '%20'
          ),
          '#', '%23'
        ),
        '&', '%26'
      ),
      '?', '%3F'
    ),
    '+', '%2B'
  );
$$;

revoke all on function public.nativize_url_component(text) from public;
grant execute on function public.nativize_url_component(text) to service_role;

create or replace view public.support_inbox
with (security_invoker = true)
as
select
  id,
  created_at,
  status,
  bot_needs_human as needs_human,
  topic,
  name,
  email,
  page_path,
  message,
  bot_summary,
  bot_reply_subject,
  bot_reply_body,
  auto_reply_sent_at,
  owner_notified_at,
  automation_error,
  'mailto:' || public.nativize_url_component(email)
    || '?subject=' || public.nativize_url_component(coalesce(bot_reply_subject, 'Nativize support reply'))
    || '&body=' || public.nativize_url_component(coalesce(bot_reply_body, 'Hi,'))
    as reply_link
from public.support_requests;

create or replace view public.feature_inbox
with (security_invoker = true)
as
select
  id,
  created_at,
  status,
  bot_needs_human as needs_human,
  priority,
  title,
  email,
  page_path,
  description,
  bot_summary,
  bot_reply_subject,
  bot_reply_body,
  auto_reply_sent_at,
  owner_notified_at,
  automation_error,
  case
    when email is null then null
    else 'mailto:' || public.nativize_url_component(email)
      || '?subject=' || public.nativize_url_component(coalesce(bot_reply_subject, 'Nativize feature request'))
      || '&body=' || public.nativize_url_component(coalesce(bot_reply_body, 'Hi,'))
  end as reply_link
from public.feature_requests;

revoke all on public.support_inbox from public;
revoke all on public.feature_inbox from public;
grant select on public.support_inbox to service_role;
grant select on public.feature_inbox to service_role;
