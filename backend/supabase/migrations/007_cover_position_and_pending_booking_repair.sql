-- Persist banner focal-point choices and repair the pending-booking RPC in
-- deployed databases that missed the previous migration or still have stale
-- PostgREST schema cache metadata.

alter table public.photographer_profiles
  add column if not exists cover_position text not null default '50% 50%';

create or replace view public.photographer_directory as
select
  p.id,
  p.display_name,
  p.phone,
  p.avatar_url,
  pp.specialty,
  pp.region,
  pp.custom_link,
  pp.bio,
  pp.cover_url,
  pp.cover_position,
  pp.social_links,
  pp.is_published,
  pp.is_suspended,
  pp.subscription_status,
  pp.created_at,
  coalesce(count(distinct b.id) filter (where b.status in ('confirmed', 'completed')), 0) as booking_count
from public.profiles p
join public.photographer_profiles pp on pp.profile_id = p.id
left join public.bookings b on b.photographer_id = p.id
where p.role = 'photographer'
group by p.id, pp.profile_id;

create or replace function public.create_pending_booking(
  p_client_id uuid,
  p_photographer_id uuid,
  p_package_id uuid,
  p_booking_date date,
  p_start_time time,
  p_end_time time,
  p_client_name text,
  p_client_email text,
  p_client_phone text,
  p_notes text,
  p_price_cents int
) returns public.bookings as $$
declare
  v_booking public.bookings;
  v_day int;
begin
  perform pg_advisory_xact_lock(hashtext(p_photographer_id::text || p_booking_date::text));

  if p_start_time >= p_end_time then
    raise exception 'Invalid booking time range';
  end if;

  v_day := extract(dow from p_booking_date)::int;

  if not exists (
    select 1
    from public.working_hours wh
    where wh.photographer_id = p_photographer_id
      and wh.day_of_week = v_day
      and wh.enabled = true
      and p_start_time >= wh.start_time
      and p_end_time <= wh.end_time
  ) then
    raise exception 'Selected time is outside photographer working hours';
  end if;

  if exists (
    select 1
    from public.availability_blocks ab
    where ab.photographer_id = p_photographer_id
      and ab.block_date = p_booking_date
      and p_start_time < ab.end_time
      and ab.start_time < p_end_time
  ) then
    raise exception 'Selected time is unavailable';
  end if;

  if exists (
    select 1
    from public.bookings
    where photographer_id = p_photographer_id
      and booking_date = p_booking_date
      and status in ('confirmed', 'pending')
      and start_time < p_end_time
      and end_time > p_start_time
  ) then
    raise exception 'Time slot is no longer available' using errcode = '23505';
  end if;

  insert into public.bookings (
    client_id, photographer_id, package_id, booking_date,
    start_time, end_time, client_name, client_email, client_phone,
    notes, price_cents, status
  ) values (
    p_client_id, p_photographer_id, p_package_id, p_booking_date,
    p_start_time, p_end_time, p_client_name, p_client_email, p_client_phone,
    p_notes, p_price_cents, 'pending'
  )
  returning * into v_booking;

  return v_booking;
end;
$$ language plpgsql security definer set search_path = public;

notify pgrst, 'reload schema';
