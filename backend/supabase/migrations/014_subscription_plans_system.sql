-- Migration 014: Subscription Plans System
-- نظام باقات الاشتراك للمصورين

-- إنشاء جدول تفاصيل الباقات
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

-- إدراج الباقات الثلاثة
INSERT INTO public.subscription_plan_details (code, name_ar, name_en, price_egp, duration_days, max_gallery_photos, max_packages, has_analytics, has_priority_support)
VALUES 
    ('trial', 'تجربة مجانية', 'Free Trial', 0, 3, 6, 4, false, false),
    ('basic', 'باقة أساسية', 'Basic Plan', 400, 30, 25, 999999, true, false),
    ('premium', 'باقة مميزة', 'Premium Plan', 600, 30, 40, 999999, true, true)
ON CONFLICT (code) DO NOTHING;

-- إضافة أعمدة جديدة لجدول photographer_profiles
ALTER TABLE public.photographer_profiles
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

-- تحديث المصورين الحاليين على trial
UPDATE public.photographer_profiles
SET 
    subscription_starts_at = trial_started_at,
    subscription_ends_at = trial_started_at + INTERVAL '3 days'
WHERE subscription_plan = 'trial' 
    AND subscription_starts_at IS NULL;

-- تحديث المصورين على باقات مدفوعة
UPDATE public.photographer_profiles
SET 
    subscription_starts_at = COALESCE(subscription_starts_at, now()),
    subscription_ends_at = COALESCE(subscription_ends_at, now() + INTERVAL '30 days')
WHERE subscription_status = 'active' 
    AND subscription_plan IN ('basic', 'premium')
    AND subscription_starts_at IS NULL;

-- إنشاء view محدث للمصورين مع تفاصيل الباقة
CREATE OR REPLACE VIEW public.photographer_with_plan AS
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
    spd.name_ar as plan_name_ar,
    spd.name_en as plan_name_en,
    spd.price_egp as plan_price,
    spd.max_gallery_photos,
    spd.max_packages,
    spd.has_analytics,
    spd.has_priority_support,
    CASE 
        WHEN pp.subscription_status = 'active' AND pp.subscription_ends_at > now() THEN true
        WHEN pp.subscription_plan = 'trial' AND pp.trial_started_at + INTERVAL '3 days' > now() THEN true
        ELSE false
    END as is_subscription_active,
    CASE
        WHEN pp.subscription_ends_at IS NOT NULL THEN 
            GREATEST(0, EXTRACT(EPOCH FROM (pp.subscription_ends_at - now())) / 86400)
        WHEN pp.subscription_plan = 'trial' THEN
            GREATEST(0, EXTRACT(EPOCH FROM ((pp.trial_started_at + INTERVAL '3 days') - now())) / 86400)
        ELSE 0
    END as days_remaining
FROM public.profiles p
JOIN public.photographer_profiles pp ON pp.profile_id = p.id
LEFT JOIN public.subscription_plan_details spd ON spd.code = pp.subscription_plan
WHERE p.role = 'photographer';

-- إنشاء جدول لتسجيل تاريخ الاشتراكات
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

CREATE INDEX IF NOT EXISTS idx_subscription_history_photographer ON public.subscription_history(photographer_id);
CREATE INDEX IF NOT EXISTS idx_subscription_history_status ON public.subscription_history(status);

-- RLS للـ subscription_history
ALTER TABLE public.subscription_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Photographers can view their own subscription history"
    ON public.subscription_history FOR SELECT
    USING (auth.uid() = photographer_id);

CREATE POLICY "Admins can view all subscription history"
    ON public.subscription_history FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE profiles.id = auth.uid() AND profiles.role = 'admin'
        )
    );

-- إنشاء جدول طلبات الدفع اليدوي
CREATE TABLE IF NOT EXISTS public.manual_payment_requests (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    photographer_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    plan_code text NOT NULL REFERENCES public.subscription_plan_details(code),
    payment_method text NOT NULL, -- vodafone_cash, instapay, bank_transfer
    sender_name text NOT NULL,
    transaction_ref text NOT NULL,
    receipt_url text,
    status text NOT NULL DEFAULT 'pending', -- pending, approved, rejected
    reviewed_by uuid REFERENCES public.profiles(id),
    reviewed_at timestamptz,
    rejection_reason text,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_manual_payment_photographer ON public.manual_payment_requests(photographer_id);
CREATE INDEX IF NOT EXISTS idx_manual_payment_status ON public.manual_payment_requests(status);
CREATE INDEX IF NOT EXISTS idx_manual_payment_created ON public.manual_payment_requests(created_at DESC);

-- RLS للـ manual_payment_requests
ALTER TABLE public.manual_payment_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Photographers can view their own payment requests"
    ON public.manual_payment_requests FOR SELECT
    USING (auth.uid() = photographer_id);

CREATE POLICY "Photographers can insert their own payment requests"
    ON public.manual_payment_requests FOR INSERT
    WITH CHECK (auth.uid() = photographer_id);

CREATE POLICY "Admins can view all payment requests"
    ON public.manual_payment_requests FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE profiles.id = auth.uid() AND profiles.role = 'admin'
        )
    );

CREATE POLICY "Admins can update payment requests"
    ON public.manual_payment_requests FOR UPDATE
    USING (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE profiles.id = auth.uid() AND profiles.role = 'admin'
        )
    );

CREATE POLICY "Admins can delete payment requests"
    ON public.manual_payment_requests FOR DELETE
    USING (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE profiles.id = auth.uid() AND profiles.role = 'admin'
        )
    );

-- Function لتفعيل الاشتراك
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
    -- التحقق من وجود الباقة
    SELECT * INTO v_plan_details
    FROM public.subscription_plan_details
    WHERE code = p_plan_code AND is_active = true;
    
    IF NOT FOUND THEN
        RETURN json_build_object('success', false, 'error', 'Invalid plan code');
    END IF;
    
    -- التحقق من وجود المصور
    IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_photographer_id AND role = 'photographer') THEN
        RETURN json_build_object('success', false, 'error', 'Photographer not found');
    END IF;
    
    -- حفظ الباقة السابقة
    SELECT subscription_plan INTO v_previous_plan
    FROM public.photographer_profiles
    WHERE profile_id = p_photographer_id;
    
    -- حساب تواريخ البداية والنهاية
    v_starts_at := now();
    v_ends_at := now() + (v_plan_details.duration_days || ' days')::interval;
    
    -- تحديث بيانات المصور
    UPDATE public.photographer_profiles
    SET 
        subscription_status = 'active',
        subscription_plan = p_plan_code,
        subscription_starts_at = v_starts_at,
        subscription_ends_at = v_ends_at,
        previous_plan = v_previous_plan,
        is_suspended = false
    WHERE profile_id = p_photographer_id;
    
    -- إضافة سجل في تاريخ الاشتراكات
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
    
    -- إرجاع النتيجة
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

-- Function للتحقق من حدود الباقة
CREATE OR REPLACE FUNCTION public.check_plan_limit(
    p_photographer_id uuid,
    p_limit_type text -- 'gallery_photos' or 'packages'
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
    -- جلب تفاصيل الباقة الحالية
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
    
    -- التحقق من أن الاشتراك نشط
    IF v_plan.subscription_status != 'active' OR v_plan.subscription_ends_at < now() THEN
        RETURN json_build_object('success', false, 'allowed', false, 'error', 'Subscription expired');
    END IF;
    
    -- حساب العدد الحالي والحد الأقصى
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
