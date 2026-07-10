-- Keep the support workflow status values aligned with feedback-submit and the
-- local admin dashboard. Older automation rows used auto_replied/needs_human.
update public.support_requests
   set status = case status
     when 'new' then 'open'
     when 'auto_replied' then 'replied'
     when 'needs_human' then 'pending'
     else status
   end
 where status in ('new', 'auto_replied', 'needs_human');

alter table public.support_requests
  drop constraint if exists support_requests_status_check;

alter table public.support_requests
  alter column status set default 'open';

alter table public.support_requests
  add constraint support_requests_status_check
  check (status in ('open', 'pending', 'replied', 'closed'));

-- Store scheduled Stripe cancellation dates without cancelling immediately.
alter table public.billing_entitlements
  add column if not exists cancel_at timestamptz,
  add column if not exists cancel_at_period_end boolean not null default false,
  add column if not exists cancellation_requested_at timestamptz,
  add column if not exists cancellation_effective_at timestamptz;

create table if not exists public.subscription_cancellation_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  stripe_subscription_id text not null,
  stripe_customer_id text,
  plan_id text not null check (plan_id in ('pro', 'max')),
  requested_at timestamptz not null default now(),
  cancel_at timestamptz not null,
  current_period_end timestamptz,
  status text not null default 'scheduled' check (status in ('scheduled', 'already_scheduled', 'failed')),
  provider text not null default 'stripe',
  created_at timestamptz not null default now()
);

create index if not exists subscription_cancellation_requests_user_idx
  on public.subscription_cancellation_requests (user_id, created_at desc);

create index if not exists subscription_cancellation_requests_subscription_idx
  on public.subscription_cancellation_requests (stripe_subscription_id, created_at desc);

alter table public.subscription_cancellation_requests enable row level security;

drop policy if exists "Users can read their own subscription cancellation requests"
  on public.subscription_cancellation_requests;

create policy "Users can read their own subscription cancellation requests"
on public.subscription_cancellation_requests
for select
using (auth.uid() = user_id);

revoke all on public.subscription_cancellation_requests from anon, authenticated, public;
grant select on public.subscription_cancellation_requests to authenticated;
grant select, insert, update on public.subscription_cancellation_requests to service_role;

drop function if exists public.get_billing_status();

create function public.get_billing_status()
returns table (
  user_id uuid,
  plan_id text,
  billing text,
  status text,
  current_period_end timestamptz,
  apps_limit integer,
  apps_used integer,
  cancel_at timestamptz,
  cancel_at_period_end boolean,
  cancellation_requested_at timestamptz
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
      used_count,
      null::timestamptz,
      false,
      null::timestamptz;
  else
    return query select
      current_user_id,
      entitlement.plan_id,
      entitlement.billing,
      entitlement.status,
      entitlement.current_period_end,
      entitlement.apps_limit,
      used_count,
      entitlement.cancel_at,
      entitlement.cancel_at_period_end,
      entitlement.cancellation_requested_at;
  end if;
end;
$$;

revoke all on function public.get_billing_status() from public;
grant execute on function public.get_billing_status() to authenticated;
