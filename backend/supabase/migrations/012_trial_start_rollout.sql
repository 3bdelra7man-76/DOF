alter table public.photographer_profiles
  add column if not exists trial_started_at timestamptz not null default now();

update public.photographer_profiles
set trial_started_at = now()
where subscription_status <> 'active'
  and subscription_plan = 'free';

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
  pp.subscription_plan,
  pp.trial_started_at,
  pp.created_at,
  coalesce(count(distinct b.id) filter (where b.status in ('confirmed', 'completed')), 0) as booking_count
from public.profiles p
join public.photographer_profiles pp on pp.profile_id = p.id
left join public.photographer_profile_categories ppc on ppc.photographer_id = p.id
left join public.photographer_categories pc on pc.id = ppc.category_id
left join public.bookings b on b.photographer_id = p.id
where p.role = 'photographer'
group by p.id, pp.profile_id;

notify pgrst, 'reload schema';
