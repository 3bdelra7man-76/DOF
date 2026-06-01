create table if not exists public.admin_audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references public.profiles(id) on delete set null,
  action text not null,
  entity_type text,
  entity_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.admin_notifications (
  id uuid primary key default gen_random_uuid(),
  type text not null default 'system',
  title text not null,
  message text not null,
  read_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.site_content (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now()
);

create table if not exists public.site_settings (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now()
);

create index if not exists idx_admin_audit_logs_created on public.admin_audit_logs(created_at desc);
create index if not exists idx_admin_notifications_created on public.admin_notifications(created_at desc);
create index if not exists idx_admin_notifications_unread on public.admin_notifications(read_at) where read_at is null;

alter table public.admin_audit_logs enable row level security;
alter table public.admin_notifications enable row level security;
alter table public.site_content enable row level security;
alter table public.site_settings enable row level security;

insert into public.site_content (key, value)
values (
  'public_copy',
  '{
    "heroTitle1Ar": "حيث يلتقي التصوير",
    "heroTitle2Ar": "بالفرصة",
    "heroTitle1En": "Where Photography",
    "heroTitle2En": "Meets Opportunity",
    "heroDescAr": "تواصل مع مصورين موهوبين واستكشف معارض مذهلة واحجز جلستك المثالية.",
    "heroDescEn": "Connect with talented photographers, explore stunning portfolios, and book your perfect session.",
    "footerAboutAr": "المنصة المتكاملة للمصورين والعملاء.",
    "footerAboutEn": "The complete platform for photographers and clients."
  }'::jsonb
)
on conflict (key) do nothing;

insert into public.site_settings (key, value)
values (
  'platform',
  '{
    "registrationOpen": true,
    "maintenanceMode": false,
    "trialDays": 7,
    "maxFreePortfolioPhotos": 10,
    "subscriptionPriceEgp": 200
  }'::jsonb
)
on conflict (key) do nothing;
