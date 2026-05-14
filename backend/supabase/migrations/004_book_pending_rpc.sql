-- Atomic pending-booking RPC that holds an advisory lock per (photographer, date)
-- to prevent two clients from booking the same slot simultaneously.
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
begin
  perform pg_advisory_xact_lock(hashtext(p_photographer_id::text || p_booking_date::text));

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
$$ language plpgsql security definer;
