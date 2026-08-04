-- Migration 016: Remote schema repair rollup
-- Use this on deployed databases that only have the early core schema and
-- missed the admin/category/subscription/manual-payment migrations.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Booking/schema safety from migrations 002, 003, 006, 007, and 008.
ALTER TABLE public.bookings
  DROP CONSTRAINT IF EXISTS bookings_status_check;

ALTER TABLE public.bookings
  ADD CONSTRAINT bookings_status_check
  CHECK (status IN ('pending', 'confirmed', 'cancelled', 'completed'));

ALTER TABLE public.bookings
  ALTER COLUMN status SET DEFAULT 'pending',
  ALTER COLUMN package_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS manual_service_name text,
  ADD COLUMN IF NOT EXISTS manual_duration_minutes int,
  ADD COLUMN IF NOT EXISTS created_by_photographer boolean NOT NULL DEFAULT false;

ALTER TABLE public.bookings
  DROP CONSTRAINT IF EXISTS bookings_service_source_check;

ALTER TABLE public.bookings
  ADD CONSTRAINT bookings_service_source_check
  CHECK (
    package_id IS NOT NULL
    OR (
      NULLIF(TRIM(COALESCE(manual_service_name, '')), '') IS NOT NULL
      AND COALESCE(manual_duration_minutes, 0) > 0
    )
  );

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'working_hours_photographer_day_unique'
      AND conrelid = 'public.working_hours'::regclass
  ) THEN
    IF EXISTS (
      SELECT 1
      FROM public.working_hours
      GROUP BY photographer_id, day_of_week
      HAVING COUNT(*) > 1
    ) THEN
      RAISE NOTICE 'Skipped working_hours_photographer_day_unique because duplicate rows exist.';
    ELSE
      ALTER TABLE public.working_hours
        ADD CONSTRAINT working_hours_photographer_day_unique
        UNIQUE (photographer_id, day_of_week);
    END IF;
  END IF;
END $$;

ALTER TABLE public.photographer_profiles
  ADD COLUMN IF NOT EXISTS cover_position text NOT NULL DEFAULT '50% 50%',
  ADD COLUMN IF NOT EXISTS subscription_plan text NOT NULL DEFAULT 'free',
  ADD COLUMN IF NOT EXISTS trial_started_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS subscription_starts_at timestamptz,
  ADD COLUMN IF NOT EXISTS subscription_ends_at timestamptz,
  ADD COLUMN IF NOT EXISTS previous_plan text;

ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS plan_code text NOT NULL DEFAULT 'basic';

UPDATE public.photographer_profiles
SET subscription_plan = 'free'
WHERE subscription_plan IS NULL
   OR subscription_plan NOT IN ('free', 'trial', 'basic', 'premium');

UPDATE public.photographer_profiles
SET subscription_plan = 'basic'
WHERE subscription_status = 'active'
  AND subscription_plan = 'free';

UPDATE public.photographer_profiles
SET
  subscription_starts_at = COALESCE(subscription_starts_at, trial_started_at),
  subscription_ends_at = COALESCE(subscription_ends_at, trial_started_at + INTERVAL '3 days')
WHERE subscription_plan = 'trial';

UPDATE public.photographer_profiles
SET
  subscription_starts_at = COALESCE(subscription_starts_at, now()),
  subscription_ends_at = COALESCE(subscription_ends_at, subscription_due_at, now() + INTERVAL '30 days'),
  subscription_due_at = COALESCE(subscription_due_at, subscription_ends_at, now() + INTERVAL '30 days')
WHERE subscription_status = 'active'
  AND subscription_plan IN ('basic', 'premium');

UPDATE public.subscriptions
SET plan_code = 'basic'
WHERE plan_code IS NULL
   OR plan_code NOT IN ('basic', 'premium');

ALTER TABLE public.photographer_profiles
  DROP CONSTRAINT IF EXISTS photographer_profiles_subscription_plan_check;

ALTER TABLE public.photographer_profiles
  ADD CONSTRAINT photographer_profiles_subscription_plan_check
  CHECK (subscription_plan IN ('free', 'trial', 'basic', 'premium'));

ALTER TABLE public.subscriptions
  DROP CONSTRAINT IF EXISTS subscriptions_plan_code_check;

ALTER TABLE public.subscriptions
  ADD CONSTRAINT subscriptions_plan_code_check
  CHECK (plan_code IN ('basic', 'premium'));

-- Admin/content tables from migration 005.
CREATE TABLE IF NOT EXISTS public.admin_audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  action text NOT NULL,
  entity_type text,
  entity_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.admin_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type text NOT NULL DEFAULT 'system',
  title text NOT NULL,
  message text NOT NULL,
  read_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.site_content (
  key text PRIMARY KEY,
  value jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.site_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_created
  ON public.admin_audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_notifications_created
  ON public.admin_notifications(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_notifications_unread
  ON public.admin_notifications(read_at)
  WHERE read_at IS NULL;

ALTER TABLE public.admin_audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.site_content ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.site_settings ENABLE ROW LEVEL SECURITY;

INSERT INTO public.site_content (key, value)
VALUES (
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
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.site_settings (key, value)
VALUES (
  'platform',
  '{
    "registrationOpen": true,
    "maintenanceMode": false,
    "trialDays": 3,
    "maxFreePortfolioPhotos": 6,
    "basicPlanPriceEgp": 400,
    "premiumPlanPriceEgp": 600,
    "subscriptionPriceEgp": 400
  }'::jsonb
)
ON CONFLICT (key) DO UPDATE SET
  value = public.site_settings.value || EXCLUDED.value;

-- Photographer categories from migration 009.
CREATE TABLE IF NOT EXISTS public.photographer_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name_en text NOT NULL,
  name_ar text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  sort_order int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.photographer_profile_categories (
  photographer_id uuid NOT NULL REFERENCES public.photographer_profiles(profile_id) ON DELETE CASCADE,
  category_id uuid NOT NULL REFERENCES public.photographer_categories(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (photographer_id, category_id)
);

CREATE INDEX IF NOT EXISTS idx_photographer_categories_active_order
  ON public.photographer_categories(is_active, sort_order);
CREATE INDEX IF NOT EXISTS idx_photographer_profile_categories_category
  ON public.photographer_profile_categories(category_id);

ALTER TABLE public.photographer_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.photographer_profile_categories ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS photographer_categories_set_updated_at ON public.photographer_categories;
CREATE TRIGGER photographer_categories_set_updated_at
BEFORE UPDATE ON public.photographer_categories
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

INSERT INTO public.photographer_categories (slug, name_en, name_ar, sort_order)
VALUES
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
ON CONFLICT (slug) DO UPDATE SET
  name_en = EXCLUDED.name_en,
  name_ar = EXCLUDED.name_ar,
  sort_order = EXCLUDED.sort_order,
  is_active = true;

INSERT INTO public.photographer_profile_categories (photographer_id, category_id)
SELECT pp.profile_id, pc.id
FROM public.photographer_profiles pp
JOIN public.photographer_categories pc ON
  lower(pp.specialty) LIKE '%' || pc.slug || '%'
  OR lower(pp.specialty) LIKE '%' || lower(replace(pc.name_en, ' Photography', '')) || '%'
  OR pp.specialty LIKE '%' || replace(pc.name_ar, 'تصوير ', '') || '%'
ON CONFLICT DO NOTHING;

INSERT INTO public.photographer_profile_categories (photographer_id, category_id)
SELECT pp.profile_id, pc.id
FROM public.photographer_profiles pp
JOIN public.photographer_categories pc ON pc.is_active = true
WHERE NOT EXISTS (
  SELECT 1
  FROM public.photographer_profile_categories ppc
  WHERE ppc.photographer_id = pp.profile_id
)
AND pc.slug = 'portrait'
ON CONFLICT DO NOTHING;

-- Support chat from migration 010.
CREATE TABLE IF NOT EXISTS public.support_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  assigned_admin_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  subject text,
  last_message text,
  last_message_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.support_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  support_conversation_id uuid NOT NULL REFERENCES public.support_conversations(id) ON DELETE CASCADE,
  sender_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  content text NOT NULL,
  is_deleted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_support_conversations_one_open
  ON public.support_conversations(user_id)
  WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_support_conversations_status_updated
  ON public.support_conversations(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_messages_conversation_created
  ON public.support_messages(support_conversation_id, created_at);

DROP TRIGGER IF EXISTS support_conversations_set_updated_at ON public.support_conversations;
CREATE TRIGGER support_conversations_set_updated_at
BEFORE UPDATE ON public.support_conversations
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.support_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.support_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "support participants read" ON public.support_conversations;
CREATE POLICY "support participants read"
  ON public.support_conversations FOR SELECT
  USING (
    auth.uid() = user_id
    OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
  );

DROP POLICY IF EXISTS "support participants insert" ON public.support_conversations;
CREATE POLICY "support participants insert"
  ON public.support_conversations FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "support admin update" ON public.support_conversations;
CREATE POLICY "support admin update"
  ON public.support_conversations FOR UPDATE
  USING (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin'));

DROP POLICY IF EXISTS "support messages participants read" ON public.support_messages;
CREATE POLICY "support messages participants read"
  ON public.support_messages FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM public.support_conversations sc
      WHERE sc.id = support_conversation_id
        AND (
          sc.user_id = auth.uid()
          OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
        )
    )
  );

DROP POLICY IF EXISTS "support messages participants insert" ON public.support_messages;
CREATE POLICY "support messages participants insert"
  ON public.support_messages FOR INSERT
  WITH CHECK (
    sender_id = auth.uid()
    AND EXISTS (
      SELECT 1
      FROM public.support_conversations sc
      WHERE sc.id = support_conversation_id
        AND (
          sc.user_id = auth.uid()
          OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
        )
    )
  );

-- Subscription plans and manual payment system from migrations 014 and 015.
CREATE TABLE IF NOT EXISTS public.subscription_plan_details (
  code text PRIMARY KEY,
  name_ar text NOT NULL,
  name_en text NOT NULL,
  price_egp integer NOT NULL DEFAULT 0,
  duration_days integer NOT NULL DEFAULT 30,
  max_gallery_photos integer NOT NULL DEFAULT 6,
  max_packages integer NOT NULL DEFAULT 4,
  has_analytics boolean NOT NULL DEFAULT false,
  has_priority_support boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.subscription_plan_details (
  code,
  name_ar,
  name_en,
  price_egp,
  duration_days,
  max_gallery_photos,
  max_packages,
  has_analytics,
  has_priority_support,
  is_active
)
VALUES
  ('free', 'مجاني', 'Free', 0, 3, 6, 4, false, false, false),
  ('trial', 'تجربة مجانية', 'Free Trial', 0, 3, 6, 4, false, false, true),
  ('basic', 'باقة أساسية', 'Basic Plan', 400, 30, 25, 999999, true, false, true),
  ('premium', 'باقة مميزة', 'Premium Plan', 600, 30, 40, 999999, true, true, true)
ON CONFLICT (code) DO UPDATE SET
  name_ar = EXCLUDED.name_ar,
  name_en = EXCLUDED.name_en,
  price_egp = EXCLUDED.price_egp,
  duration_days = EXCLUDED.duration_days,
  max_gallery_photos = EXCLUDED.max_gallery_photos,
  max_packages = EXCLUDED.max_packages,
  has_analytics = EXCLUDED.has_analytics,
  has_priority_support = EXCLUDED.has_priority_support,
  is_active = EXCLUDED.is_active;

CREATE TABLE IF NOT EXISTS public.subscription_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  photographer_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  plan_code text NOT NULL REFERENCES public.subscription_plan_details(code),
  started_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  payment_method text,
  payment_amount integer,
  payment_reference text,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz,
  cancellation_reason text
);

CREATE INDEX IF NOT EXISTS idx_subscription_history_photographer
  ON public.subscription_history(photographer_id);
CREATE INDEX IF NOT EXISTS idx_subscription_history_status
  ON public.subscription_history(status);

ALTER TABLE public.subscription_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Photographers can view their own subscription history" ON public.subscription_history;
CREATE POLICY "Photographers can view their own subscription history"
  ON public.subscription_history FOR SELECT
  USING (auth.uid() = photographer_id);

DROP POLICY IF EXISTS "Admins can view all subscription history" ON public.subscription_history;
CREATE POLICY "Admins can view all subscription history"
  ON public.subscription_history FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid() AND profiles.role = 'admin'
    )
  );

CREATE TABLE IF NOT EXISTS public.manual_payment_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  photographer_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  plan_code text NOT NULL REFERENCES public.subscription_plan_details(code),
  payment_method text NOT NULL,
  sender_name text NOT NULL,
  transaction_ref text NOT NULL,
  receipt_url text,
  receipt_path text,
  subscription_id uuid REFERENCES public.subscriptions(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'pending',
  reviewed_by uuid REFERENCES public.profiles(id),
  reviewed_at timestamptz,
  rejection_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.manual_payment_requests
  ADD COLUMN IF NOT EXISTS receipt_path text,
  ADD COLUMN IF NOT EXISTS subscription_id uuid REFERENCES public.subscriptions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_manual_payment_photographer
  ON public.manual_payment_requests(photographer_id);
CREATE INDEX IF NOT EXISTS idx_manual_payment_status
  ON public.manual_payment_requests(status);
CREATE INDEX IF NOT EXISTS idx_manual_payment_created
  ON public.manual_payment_requests(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_manual_payment_transaction_ref
  ON public.manual_payment_requests(transaction_ref);
CREATE INDEX IF NOT EXISTS idx_manual_payment_subscription
  ON public.manual_payment_requests(subscription_id);

ALTER TABLE public.manual_payment_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Photographers can view their own payment requests" ON public.manual_payment_requests;
CREATE POLICY "Photographers can view their own payment requests"
  ON public.manual_payment_requests FOR SELECT
  USING (auth.uid() = photographer_id);

DROP POLICY IF EXISTS "Photographers can insert their own payment requests" ON public.manual_payment_requests;
CREATE POLICY "Photographers can insert their own payment requests"
  ON public.manual_payment_requests FOR INSERT
  WITH CHECK (auth.uid() = photographer_id);

DROP POLICY IF EXISTS "Admins can view all payment requests" ON public.manual_payment_requests;
CREATE POLICY "Admins can view all payment requests"
  ON public.manual_payment_requests FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid() AND profiles.role = 'admin'
    )
  );

DROP POLICY IF EXISTS "Admins can update payment requests" ON public.manual_payment_requests;
CREATE POLICY "Admins can update payment requests"
  ON public.manual_payment_requests FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid() AND profiles.role = 'admin'
    )
  );

DROP POLICY IF EXISTS "Admins can delete payment requests" ON public.manual_payment_requests;
CREATE POLICY "Admins can delete payment requests"
  ON public.manual_payment_requests FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid() AND profiles.role = 'admin'
    )
  );

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'subscription-receipts',
  'subscription-receipts',
  true,
  10485760,
  array['image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

CREATE OR REPLACE FUNCTION public.create_pending_booking(
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
) RETURNS public.bookings AS $$
DECLARE
  v_booking public.bookings;
  v_day int;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_photographer_id::text || p_booking_date::text));

  IF p_start_time >= p_end_time THEN
    RAISE EXCEPTION 'Invalid booking time range';
  END IF;

  v_day := EXTRACT(dow FROM p_booking_date)::int;

  IF NOT EXISTS (
    SELECT 1
    FROM public.working_hours wh
    WHERE wh.photographer_id = p_photographer_id
      AND wh.day_of_week = v_day
      AND wh.enabled = true
      AND p_start_time >= wh.start_time
      AND p_end_time <= wh.end_time
  ) THEN
    RAISE EXCEPTION 'Selected time is outside photographer working hours';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.availability_blocks ab
    WHERE ab.photographer_id = p_photographer_id
      AND ab.block_date = p_booking_date
      AND p_start_time < ab.end_time
      AND ab.start_time < p_end_time
  ) THEN
    RAISE EXCEPTION 'Selected time is unavailable';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.bookings
    WHERE photographer_id = p_photographer_id
      AND booking_date = p_booking_date
      AND status IN ('confirmed', 'pending')
      AND start_time < p_end_time
      AND end_time > p_start_time
  ) THEN
    RAISE EXCEPTION 'Time slot is no longer available' USING errcode = '23505';
  END IF;

  INSERT INTO public.bookings (
    client_id,
    photographer_id,
    package_id,
    booking_date,
    start_time,
    end_time,
    client_name,
    client_email,
    client_phone,
    notes,
    price_cents,
    status
  ) VALUES (
    p_client_id,
    p_photographer_id,
    p_package_id,
    p_booking_date,
    p_start_time,
    p_end_time,
    p_client_name,
    p_client_email,
    p_client_phone,
    p_notes,
    p_price_cents,
    'pending'
  )
  RETURNING * INTO v_booking;

  RETURN v_booking;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.activate_subscription(
  p_photographer_id uuid,
  p_plan_code text,
  p_payment_method text DEFAULT NULL,
  p_payment_amount integer DEFAULT NULL,
  p_payment_reference text DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_plan_details record;
  v_starts_at timestamptz;
  v_ends_at timestamptz;
  v_previous_plan text;
BEGIN
  SELECT * INTO v_plan_details
  FROM public.subscription_plan_details
  WHERE code = p_plan_code AND is_active = true;

  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'Invalid plan code');
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.profiles p
    JOIN public.photographer_profiles pp ON pp.profile_id = p.id
    WHERE p.id = p_photographer_id
      AND p.role = 'photographer'
      AND pp.is_suspended = false
  ) THEN
    RETURN json_build_object('success', false, 'error', 'Photographer not found or suspended');
  END IF;

  SELECT subscription_plan INTO v_previous_plan
  FROM public.photographer_profiles
  WHERE profile_id = p_photographer_id;

  v_starts_at := now();
  v_ends_at := now() + (v_plan_details.duration_days || ' days')::interval;

  UPDATE public.photographer_profiles
  SET
    subscription_status = 'active',
    subscription_plan = p_plan_code,
    subscription_due_at = v_ends_at,
    subscription_starts_at = v_starts_at,
    subscription_ends_at = v_ends_at,
    previous_plan = v_previous_plan
  WHERE profile_id = p_photographer_id;

  INSERT INTO public.subscription_history (
    photographer_id,
    plan_code,
    started_at,
    ends_at,
    payment_method,
    payment_amount,
    payment_reference,
    status
  ) VALUES (
    p_photographer_id,
    p_plan_code,
    v_starts_at,
    v_ends_at,
    p_payment_method,
    p_payment_amount,
    p_payment_reference,
    'active'
  );

  RETURN json_build_object(
    'success', true,
    'plan_code', p_plan_code,
    'plan_name', v_plan_details.name_ar,
    'starts_at', v_starts_at,
    'ends_at', v_ends_at,
    'previous_plan', v_previous_plan
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.check_plan_limit(
  p_photographer_id uuid,
  p_limit_type text
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_plan record;
  v_current_count integer;
  v_limit integer;
  v_allowed boolean;
BEGIN
  SELECT
    spd.max_gallery_photos,
    spd.max_packages,
    pp.subscription_status,
    pp.subscription_ends_at
  INTO v_plan
  FROM public.photographer_profiles pp
  JOIN public.subscription_plan_details spd ON spd.code = pp.subscription_plan
  WHERE pp.profile_id = p_photographer_id;

  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'Photographer not found');
  END IF;

  IF v_plan.subscription_status != 'active' OR v_plan.subscription_ends_at < now() THEN
    RETURN json_build_object('success', false, 'allowed', false, 'error', 'Subscription expired');
  END IF;

  IF p_limit_type = 'gallery_photos' THEN
    SELECT COUNT(*) INTO v_current_count
    FROM public.portfolio_photos
    WHERE photographer_id = p_photographer_id;

    v_limit := v_plan.max_gallery_photos;
  ELSIF p_limit_type = 'packages' THEN
    SELECT COUNT(*) INTO v_current_count
    FROM public.packages
    WHERE photographer_id = p_photographer_id AND status = 'active';

    v_limit := v_plan.max_packages;
  ELSE
    RETURN json_build_object('success', false, 'error', 'Invalid limit type');
  END IF;

  v_allowed := v_current_count < v_limit;

  RETURN json_build_object(
    'success', true,
    'allowed', v_allowed,
    'current_count', v_current_count,
    'limit', v_limit
  );
END;
$$;

DROP VIEW IF EXISTS public.photographer_with_plan;
DROP VIEW IF EXISTS public.photographer_directory;

CREATE VIEW public.photographer_directory AS
SELECT
  p.id,
  p.display_name,
  p.phone,
  p.avatar_url,
  COALESCE(
    NULLIF(string_agg(DISTINCT pc.name_en, ', ' ORDER BY pc.name_en) FILTER (WHERE pc.name_en IS NOT NULL), ''),
    pp.specialty
  ) AS specialty,
  COALESCE(
    jsonb_agg(
      DISTINCT jsonb_build_object(
        'id', pc.id,
        'slug', pc.slug,
        'name_en', pc.name_en,
        'name_ar', pc.name_ar,
        'is_active', pc.is_active,
        'sort_order', pc.sort_order
      )
    ) FILTER (WHERE pc.id IS NOT NULL),
    '[]'::jsonb
  ) AS categories,
  COALESCE(array_agg(DISTINCT pc.slug) FILTER (WHERE pc.slug IS NOT NULL), '{}'::text[]) AS category_slugs,
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
  pp.subscription_due_at,
  pp.subscription_starts_at,
  pp.subscription_ends_at,
  pp.trial_started_at,
  pp.created_at,
  COALESCE(COUNT(DISTINCT b.id) FILTER (WHERE b.status IN ('confirmed', 'completed')), 0) AS booking_count
FROM public.profiles p
JOIN public.photographer_profiles pp ON pp.profile_id = p.id
LEFT JOIN public.photographer_profile_categories ppc ON ppc.photographer_id = p.id
LEFT JOIN public.photographer_categories pc ON pc.id = ppc.category_id
LEFT JOIN public.bookings b ON b.photographer_id = p.id
WHERE p.role = 'photographer'
GROUP BY p.id, pp.profile_id;

CREATE VIEW public.photographer_with_plan AS
SELECT
  p.id,
  p.display_name,
  p.email,
  p.phone,
  p.avatar_url,
  p.role,
  pp.subscription_status,
  pp.subscription_plan,
  pp.subscription_starts_at,
  pp.subscription_ends_at,
  pp.trial_started_at,
  pp.previous_plan,
  spd.name_ar AS plan_name_ar,
  spd.name_en AS plan_name_en,
  spd.price_egp AS plan_price,
  spd.max_gallery_photos,
  spd.max_packages,
  spd.has_analytics,
  spd.has_priority_support,
  CASE
    WHEN pp.subscription_status = 'active' AND pp.subscription_ends_at > now() THEN true
    WHEN pp.subscription_plan = 'trial' AND pp.trial_started_at + INTERVAL '3 days' > now() THEN true
    ELSE false
  END AS is_subscription_active,
  CASE
    WHEN pp.subscription_ends_at IS NOT NULL THEN
      GREATEST(0, EXTRACT(EPOCH FROM (pp.subscription_ends_at - now())) / 86400)
    WHEN pp.subscription_plan = 'trial' THEN
      GREATEST(0, EXTRACT(EPOCH FROM ((pp.trial_started_at + INTERVAL '3 days') - now())) / 86400)
    ELSE 0
  END AS days_remaining
FROM public.profiles p
JOIN public.photographer_profiles pp ON pp.profile_id = p.id
LEFT JOIN public.subscription_plan_details spd ON spd.code = pp.subscription_plan
WHERE p.role = 'photographer';

NOTIFY pgrst, 'reload schema';
