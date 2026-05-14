-- Make (photographer_id, day_of_week) unique so the setWorkingHours upsert works.
alter table public.working_hours
  add constraint working_hours_photographer_day_unique
  unique (photographer_id, day_of_week);
