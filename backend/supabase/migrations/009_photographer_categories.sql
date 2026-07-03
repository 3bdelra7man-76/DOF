create table if not exists public.photographer_categories (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name_en text not null,
  name_ar text not null,
  is_active boolean not null default true,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.photographer_profile_categories (
  photographer_id uuid not null references public.photographer_profiles(profile_id) on delete cascade,
  category_id uuid not null references public.photographer_categories(id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (photographer_id, category_id)
);

create index if not exists idx_photographer_categories_active_order on public.photographer_categories(is_active, sort_order);
create index if not exists idx_photographer_profile_categories_category on public.photographer_profile_categories(category_id);

alter table public.photographer_categories enable row level security;
alter table public.photographer_profile_categories enable row level security;

drop trigger if exists photographer_categories_set_updated_at on public.photographer_categories;
create trigger photographer_categories_set_updated_at before update on public.photographer_categories
for each row execute function public.set_updated_at();

insert into public.photographer_categories (slug, name_en, name_ar, sort_order)
values
  ('wedding', 'Wedding Photography', 'تصوير أعراس', 10),
  ('portrait', 'Portrait Photography', 'تصوير بورتريه', 20),
  ('event', 'Event Photography', 'تصوير فعاليات', 30),
  ('fashion', 'Fashion Photography', 'تصوير أزياء', 40),
  ('newborn', 'Newborn Photography', 'تصوير مواليد', 50),
  ('product', 'Product Photography', 'تصوير منتجات', 60),
  ('food', 'Food Photography', 'تصوير طعام', 70),
  ('realestate', 'Real Estate Photography', 'تصوير عقارات', 80),
  ('sports', 'Sports Photography', 'تصوير رياضي', 90),
  ('drone', 'Drone/Aerial Photography', 'تصوير جوي', 100),
  ('cinematic', 'Cinematic Video', 'تصوير سينمائي', 110),
  ('maternity', 'Maternity Photography', 'تصوير حمل', 120),
  ('boudoir', 'Boudoir Photography', 'تصوير بودوار', 130),
  ('corporate', 'Corporate Photography', 'تصوير شركات', 140),
  ('street', 'Street Photography', 'تصوير شوارع', 150)
on conflict (slug) do update
set name_en = excluded.name_en,
    name_ar = excluded.name_ar,
    sort_order = excluded.sort_order;

insert into public.photographer_profile_categories (photographer_id, category_id)
select pp.profile_id, pc.id
from public.photographer_profiles pp
join public.photographer_categories pc on
  lower(pp.specialty) like '%' || pc.slug || '%'
  or lower(pp.specialty) like '%' || lower(replace(pc.name_en, ' Photography', '')) || '%'
  or pp.specialty like '%' || replace(pc.name_ar, 'تصوير ', '') || '%'
on conflict do nothing;

insert into public.photographer_profile_categories (photographer_id, category_id)
select pp.profile_id, pc.id
from public.photographer_profiles pp
join public.photographer_categories pc on pc.is_active = true
where not exists (
  select 1
  from public.photographer_profile_categories ppc
  where ppc.photographer_id = pp.profile_id
)
and pc.slug = 'portrait'
on conflict do nothing;

create or replace view public.photographer_directory as
select
  p.id,
  p.display_name,
  p.phone,
  p.avatar_url,
  coalesce(
    nullif(string_agg(distinct pc.name_en, ', ' order by pc.name_en) filter (where pc.name_en is not null), ''),
    pp.specialty
  ) as specialty,
  coalesce(
    jsonb_agg(
      distinct jsonb_build_object(
        'id', pc.id,
        'slug', pc.slug,
        'name_en', pc.name_en,
        'name_ar', pc.name_ar,
        'is_active', pc.is_active,
        'sort_order', pc.sort_order
      )
    ) filter (where pc.id is not null),
    '[]'::jsonb
  ) as categories,
  coalesce(array_agg(distinct pc.slug) filter (where pc.slug is not null), '{}'::text[]) as category_slugs,
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
left join public.photographer_profile_categories ppc on ppc.photographer_id = p.id
left join public.photographer_categories pc on pc.id = ppc.category_id
left join public.bookings b on b.photographer_id = p.id
where p.role = 'photographer'
group by p.id, pp.profile_id;
