-- Add 'pending' to bookings status and change default so new bookings
-- require photographer approval before becoming confirmed.
alter table public.bookings
  drop constraint if exists bookings_status_check;

alter table public.bookings
  add constraint bookings_status_check
  check (status in ('pending', 'confirmed', 'cancelled', 'completed'));

alter table public.bookings
  alter column status set default 'pending';
