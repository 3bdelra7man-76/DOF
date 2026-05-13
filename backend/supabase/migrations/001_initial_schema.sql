create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text unique not null,
  role text not null check (role in ('client', 'photographer', 'admin')),
  display_name text not null,
  phone text,
  avatar_url text,
  preferred_language text not null default 'en' check (preferred_language in ('en', 'ar')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.photographer_profiles (
  profile_id uuid primary key references public.profiles(id) on delete cascade,
  specialty text not null,
  region text not null,
  custom_link text not null unique,
  bio text,
  cover_url text,
  social_links jsonb not null default '{}'::jsonb,
  is_published boolean not null default true,
  is_suspended boolean not null default false,
  subscription_status text not null default 'free' check (subscription_status in ('free', 'pending', 'active', 'overdue', 'cancelled')),
  subscription_due_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.portfolio_collections (
  id uuid primary key default gen_random_uuid(),
  photographer_id uuid not null references public.photographer_profiles(profile_id) on delete cascade,
  title text not null default 'Portfolio',
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.portfolio_photos (
  id uuid primary key default gen_random_uuid(),
  photographer_id uuid not null references public.photographer_profiles(profile_id) on delete cascade,
  collection_id uuid not null references public.portfolio_collections(id) on delete cascade,
  url text not null,
  storage_path text,
  title text,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.packages (
  id uuid primary key default gen_random_uuid(),
  photographer_id uuid not null references public.photographer_profiles(profile_id) on delete cascade,
  name text not null,
  description text,
  price_cents int not null check (price_cents >= 0),
  currency text not null default 'EGP',
  duration_minutes int not null check (duration_minutes > 0),
  features jsonb not null default '[]'::jsonb,
  attachments jsonb not null default '[]'::jsonb,
  status text not null default 'active' check (status in ('active', 'draft')),
  featured boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.working_hours (
  id uuid primary key default gen_random_uuid(),
  photographer_id uuid not null references public.photographer_profiles(profile_id) on delete cascade,
  day_of_week int not null check (day_of_week between 0 and 6),
  start_time time not null,
  end_time time not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  constraint working_hours_valid_range check (start_time < end_time)
);

create table if not exists public.availability_blocks (
  id uuid primary key default gen_random_uuid(),
  photographer_id uuid not null references public.photographer_profiles(profile_id) on delete cascade,
  block_date date not null,
  start_time time not null,
  end_time time not null,
  reason text,
  created_at timestamptz not null default now(),
  constraint availability_blocks_valid_range check (start_time < end_time)
);

create table if not exists public.bookings (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references public.profiles(id) on delete set null,
  photographer_id uuid not null references public.photographer_profiles(profile_id) on delete cascade,
  package_id uuid not null references public.packages(id) on delete restrict,
  booking_date date not null,
  start_time time not null,
  end_time time not null,
  status text not null default 'confirmed' check (status in ('confirmed', 'cancelled', 'completed')),
  price_cents int not null,
  currency text not null default 'EGP',
  client_name text not null,
  client_email text,
  client_phone text not null,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint bookings_valid_range check (start_time < end_time)
);

create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.profiles(id) on delete cascade,
  photographer_id uuid not null references public.photographer_profiles(profile_id) on delete cascade,
  last_message text,
  last_message_at timestamptz,
  blocked_by uuid references public.profiles(id) on delete set null,
  archived_by uuid[] not null default '{}'::uuid[],
  created_at timestamptz not null default now(),
  unique (client_id, photographer_id)
);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  sender_id uuid not null references public.profiles(id) on delete cascade,
  content text not null,
  is_deleted boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  photographer_id uuid not null references public.photographer_profiles(profile_id) on delete cascade,
  provider text not null default 'paymob',
  provider_order_id text,
  merchant_order_id text unique,
  amount_cents int not null,
  currency text not null default 'EGP',
  status text not null default 'pending' check (status in ('pending', 'active', 'failed', 'cancelled', 'overdue')),
  current_period_end timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.payment_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  payload jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists public.reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid references public.profiles(id) on delete set null,
  reported_profile_id uuid references public.profiles(id) on delete set null,
  conversation_id uuid references public.conversations(id) on delete set null,
  reason text not null,
  status text not null default 'open' check (status in ('open', 'reviewing', 'closed')),
  created_at timestamptz not null default now()
);

create index if not exists idx_photographer_profiles_custom_link on public.photographer_profiles(custom_link);
create index if not exists idx_photographer_profiles_region on public.photographer_profiles(region);
create index if not exists idx_packages_photographer_status on public.packages(photographer_id, status);
create index if not exists idx_portfolio_photos_photographer on public.portfolio_photos(photographer_id);
create index if not exists idx_working_hours_photographer_day on public.working_hours(photographer_id, day_of_week);
create index if not exists idx_bookings_photographer_date on public.bookings(photographer_id, booking_date, status);
create index if not exists idx_blocks_photographer_date on public.availability_blocks(photographer_id, block_date);
create index if not exists idx_messages_conversation_created on public.messages(conversation_id, created_at);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at before update on public.profiles
for each row execute function public.set_updated_at();

drop trigger if exists photographer_profiles_set_updated_at on public.photographer_profiles;
create trigger photographer_profiles_set_updated_at before update on public.photographer_profiles
for each row execute function public.set_updated_at();

drop trigger if exists packages_set_updated_at on public.packages;
create trigger packages_set_updated_at before update on public.packages
for each row execute function public.set_updated_at();

drop trigger if exists bookings_set_updated_at on public.bookings;
create trigger bookings_set_updated_at before update on public.bookings
for each row execute function public.set_updated_at();

drop trigger if exists subscriptions_set_updated_at on public.subscriptions;
create trigger subscriptions_set_updated_at before update on public.subscriptions
for each row execute function public.set_updated_at();

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

create or replace function public.create_instant_booking(
  p_client_id uuid,
  p_photographer_id uuid,
  p_package_id uuid,
  p_booking_date date,
  p_start_time time,
  p_end_time time,
  p_client_name text,
  p_client_email text,
  p_client_phone text,
  p_notes text
)
returns public.bookings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_package public.packages%rowtype;
  v_booking public.bookings%rowtype;
  v_day int;
begin
  perform pg_advisory_xact_lock(hashtext(p_photographer_id::text || ':' || p_booking_date::text));

  if p_start_time >= p_end_time then
    raise exception 'Invalid booking time range';
  end if;

  select * into v_package
  from public.packages
  where id = p_package_id
    and photographer_id = p_photographer_id
    and status = 'active';

  if not found then
    raise exception 'Package not found';
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
    from public.bookings b
    where b.photographer_id = p_photographer_id
      and b.booking_date = p_booking_date
      and b.status = 'confirmed'
      and p_start_time < b.end_time
      and b.start_time < p_end_time
  ) then
    raise exception 'Selected time is already booked';
  end if;

  insert into public.bookings (
    client_id,
    photographer_id,
    package_id,
    booking_date,
    start_time,
    end_time,
    price_cents,
    currency,
    client_name,
    client_email,
    client_phone,
    notes
  )
  values (
    p_client_id,
    p_photographer_id,
    p_package_id,
    p_booking_date,
    p_start_time,
    p_end_time,
    v_package.price_cents,
    v_package.currency,
    p_client_name,
    p_client_email,
    p_client_phone,
    p_notes
  )
  returning * into v_booking;

  return v_booking;
end;
$$;

alter table public.profiles enable row level security;
alter table public.photographer_profiles enable row level security;
alter table public.portfolio_collections enable row level security;
alter table public.portfolio_photos enable row level security;
alter table public.packages enable row level security;
alter table public.working_hours enable row level security;
alter table public.availability_blocks enable row level security;
alter table public.bookings enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.subscriptions enable row level security;
alter table public.reports enable row level security;

drop policy if exists "profiles own read" on public.profiles;
create policy "profiles own read" on public.profiles for select
using (auth.uid() = id);

drop policy if exists "profiles own update" on public.profiles;
create policy "profiles own update" on public.profiles for update
using (auth.uid() = id);

drop policy if exists "public photographer read" on public.photographer_profiles;
create policy "public photographer read" on public.photographer_profiles for select
using (is_published = true and is_suspended = false);

drop policy if exists "photographer own profile update" on public.photographer_profiles;
create policy "photographer own profile update" on public.photographer_profiles for update
using (auth.uid() = profile_id);

drop policy if exists "public active packages read" on public.packages;
create policy "public active packages read" on public.packages for select
using (status = 'active');

drop policy if exists "photographer own packages all" on public.packages;
create policy "photographer own packages all" on public.packages for all
using (auth.uid() = photographer_id)
with check (auth.uid() = photographer_id);

drop policy if exists "public portfolio collections read" on public.portfolio_collections;
create policy "public portfolio collections read" on public.portfolio_collections for select
using (true);

drop policy if exists "public portfolio photos read" on public.portfolio_photos;
create policy "public portfolio photos read" on public.portfolio_photos for select
using (true);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('portfolio', 'portfolio', true, 10485760, array['image/jpeg', 'image/png', 'image/webp']),
  ('package-attachments', 'package-attachments', true, 10485760, array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
on conflict (id) do nothing;
