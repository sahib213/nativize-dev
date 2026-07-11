-- Paid app migrations run many small, resumable calls by design. Keep the
-- shared guard, but allow authenticated paid migration jobs to request a
-- larger per-window ceiling than lightweight public forms.
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

  if max_hits < 1 or max_hits > 10000 or window_seconds < 60 or window_seconds > 86400 then
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
