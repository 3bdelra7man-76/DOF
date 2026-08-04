-- Migration 015: Manual payment auto-activation with admin review

ALTER TABLE public.photographer_profiles
  DROP CONSTRAINT IF EXISTS photographer_profiles_subscription_plan_check;

ALTER TABLE public.photographer_profiles
  ADD CONSTRAINT photographer_profiles_subscription_plan_check
  CHECK (subscription_plan IN ('free', 'trial', 'basic', 'premium'));

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
) VALUES (
  'free',
  'مجاني',
  'Free',
  0,
  3,
  6,
  4,
  false,
  false,
  false
)
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

ALTER TABLE public.manual_payment_requests
  ADD COLUMN IF NOT EXISTS receipt_path text,
  ADD COLUMN IF NOT EXISTS subscription_id uuid REFERENCES public.subscriptions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_manual_payment_transaction_ref
  ON public.manual_payment_requests(transaction_ref);

CREATE INDEX IF NOT EXISTS idx_manual_payment_subscription
  ON public.manual_payment_requests(subscription_id);

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
  v_result json;
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

  v_result := json_build_object(
    'success', true,
    'plan_code', p_plan_code,
    'plan_name', v_plan_details.name_ar,
    'starts_at', v_starts_at,
    'ends_at', v_ends_at,
    'previous_plan', v_previous_plan
  );

  RETURN v_result;
END;
$$;

NOTIFY pgrst, 'reload schema';
