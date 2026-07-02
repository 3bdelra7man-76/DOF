-- Allow photographers to create confirmed custom bookings that still block
-- availability, even when no package matches the agreed session.

alter table public.bookings
  alter column package_id drop not null;

alter table public.bookings
  add column if not exists manual_service_name text,
  add column if not exists manual_duration_minutes int,
  add column if not exists created_by_photographer boolean not null default false;

alter table public.bookings
  drop constraint if exists bookings_service_source_check;

alter table public.bookings
  add constraint bookings_service_source_check
  check (
    package_id is not null
    or (
      nullif(trim(coalesce(manual_service_name, '')), '') is not null
      and coalesce(manual_duration_minutes, 0) > 0
    )
  );

notify pgrst, 'reload schema';
