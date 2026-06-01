-- Keep the pending-booking RPC aligned with the slot generator and the older
-- instant-booking RPC: requests outside working hours or inside availability
-- blocks must fail even when called directly through the API.
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
