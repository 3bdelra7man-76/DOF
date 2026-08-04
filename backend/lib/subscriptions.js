/**
 * Subscriptions Library
 * مكتبة إدارة الاشتراكات والباقات
 */

import { supabaseService } from './supabase.js';
import { fail } from './http.js';

const PAID_PLAN_CODES = new Set(['basic', 'premium']);
const VALID_MANUAL_PAYMENT_METHODS = new Set(['vodafone_cash', 'instapay', 'bank_transfer']);
const MANUAL_PAYMENT_PAGE_SIZE = 25;
const MANUAL_PAYMENT_MAX_PAGE_SIZE = 100;

function db() {
  return supabaseService();
}

function cleanString(value) {
  return String(value ?? '').trim();
}

function normalizePaidPlanCode(value) {
  const code = cleanString(value).toLowerCase();
  if (!PAID_PLAN_CODES.has(code)) throw fail(400, 'Choose Basic or Premium plan');
  return code;
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function pageOptions(filters = {}) {
  const page = positiveInt(filters.page, 1);
  const requested = positiveInt(filters.pageSize || filters.limit, MANUAL_PAYMENT_PAGE_SIZE);
  const pageSize = Math.min(MANUAL_PAYMENT_MAX_PAGE_SIZE, requested);
  return { page, pageSize, from: (page - 1) * pageSize, to: page * pageSize - 1 };
}

function addDays(date, days) {
  const next = new Date(date.getTime());
  next.setDate(next.getDate() + days);
  return next;
}

function activationDates(result, plan) {
  const startsAt = cleanString(result?.starts_at) || new Date().toISOString();
  const startDate = new Date(startsAt);
  const fallbackEnd = addDays(Number.isNaN(startDate.getTime()) ? new Date() : startDate, positiveInt(plan.duration_days, 30)).toISOString();
  const endsAt = cleanString(result?.ends_at) || fallbackEnd;
  return { startsAt, endsAt };
}

function manualMerchantOrderId(planCode, photographerId) {
  return `manual-${planCode}-${photographerId}-${Date.now()}`;
}

async function ensurePhotographerCanSubscribe(client, photographerId) {
  const { data, error } = await client
    .from('photographer_profiles')
    .select('profile_id, is_suspended')
    .eq('profile_id', photographerId)
    .single();

  if (error || !data) throw fail(404, 'Photographer not found', error);
  if (data.is_suspended) throw fail(403, 'Account is suspended. Contact support.');
  return data;
}

async function findManualSubscriptionForRequest(client, request) {
  if (request.subscription_id) {
    const { data, error } = await client
      .from('subscriptions')
      .select('*')
      .eq('id', request.subscription_id)
      .maybeSingle();
    if (error) throw fail(500, 'Failed to fetch linked subscription', error);
    if (data) return data;
  }

  const { data, error } = await client
    .from('subscriptions')
    .select('*')
    .eq('photographer_id', request.photographer_id)
    .eq('provider', 'manual')
    .eq('provider_order_id', request.transaction_ref)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw fail(500, 'Failed to fetch linked subscription', error);
  return data || null;
}

async function linkPaymentRequestToSubscription(client, requestId, subscriptionId) {
  const { error } = await client
    .from('manual_payment_requests')
    .update({ subscription_id: subscriptionId })
    .eq('id', requestId);

  if (error) throw fail(500, 'Failed to link payment request to subscription', error);
}

async function latestActiveSubscription(client, photographerId, excludeId = '') {
  let query = client
    .from('subscriptions')
    .select('*')
    .eq('photographer_id', photographerId)
    .eq('status', 'active');

  if (excludeId) query = query.neq('id', excludeId);

  const { data, error } = await query
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw fail(500, 'Failed to check active subscription', error);
  return data || null;
}

async function syncPhotographerToSubscription(client, photographerId, subscription) {
  const planCode = cleanString(subscription?.plan_code).toLowerCase();
  if (!PAID_PLAN_CODES.has(planCode)) return false;

  const dueAt = subscription.current_period_end || null;
  const { error } = await client
    .from('photographer_profiles')
    .update({
      subscription_status: 'active',
      subscription_plan: planCode,
      subscription_due_at: dueAt,
      subscription_starts_at: subscription.created_at || new Date().toISOString(),
      subscription_ends_at: dueAt
    })
    .eq('profile_id', photographerId);

  if (error) throw fail(500, 'Failed to restore previous subscription', error);
  return true;
}

async function activatePaidSubscription(client, photographerId, plan, paymentMethod, transactionRef) {
  const { data: activationResult, error: activationError } = await client.rpc('activate_subscription', {
    p_photographer_id: photographerId,
    p_plan_code: plan.code,
    p_payment_method: paymentMethod,
    p_payment_amount: plan.price_egp,
    p_payment_reference: transactionRef
  });

  if (activationError || !activationResult?.success) {
    throw fail(500, activationResult?.error || 'Failed to activate subscription', activationError);
  }

  const { startsAt, endsAt } = activationDates(activationResult, plan);
  const { error: profileSyncError } = await client
    .from('photographer_profiles')
    .update({
      subscription_status: 'active',
      subscription_plan: plan.code,
      subscription_due_at: endsAt,
      subscription_starts_at: startsAt,
      subscription_ends_at: endsAt
    })
    .eq('profile_id', photographerId);

  if (profileSyncError) throw fail(500, 'Failed to sync subscription dates', profileSyncError);

  const { data: subscriptionRow, error: subscriptionError } = await client
    .from('subscriptions')
    .insert({
      photographer_id: photographerId,
      provider: 'manual',
      provider_order_id: transactionRef,
      merchant_order_id: manualMerchantOrderId(plan.code, photographerId),
      amount_cents: Number(plan.price_egp || 0) * 100,
      currency: 'EGP',
      status: 'active',
      current_period_end: endsAt,
      plan_code: plan.code
    })
    .select('*')
    .single();

  if (subscriptionError) throw fail(500, 'Failed to create subscription record', subscriptionError);

  return {
    activation: activationResult,
    subscription: subscriptionRow,
    startsAt,
    endsAt
  };
}

async function revokeLinkedManualSubscription(client, request, reason = '') {
  const linked = await findManualSubscriptionForRequest(client, request);
  const latestActive = await latestActiveSubscription(client, request.photographer_id);
  const shouldDowngradeProfile = linked
    ? latestActive?.id === linked.id
    : !latestActive || (latestActive.provider === 'manual' && latestActive.provider_order_id === request.transaction_ref);

  if (linked) {
    const { error } = await client
      .from('subscriptions')
      .update({ status: 'cancelled' })
      .eq('id', linked.id);
    if (error) throw fail(500, 'Failed to cancel linked subscription', error);
  }

  if (!shouldDowngradeProfile) {
    return { revokedProfile: false, subscription: linked };
  }

  const restored = linked
    ? await latestActiveSubscription(client, request.photographer_id, linked.id)
    : await latestActiveSubscription(client, request.photographer_id);

  if (restored && await syncPhotographerToSubscription(client, request.photographer_id, restored)) {
    return {
      revokedProfile: false,
      restoredProfile: true,
      subscription: linked,
      restoredSubscription: restored
    };
  }

  await downgradePhotographer(client, request.photographer_id, reason || 'Manual payment rejected', false);
  return { revokedProfile: true, subscription: linked };
}

async function downgradePhotographer(client, photographerId, reason = '', suspendAccount = false) {
  const { data: currentProfile, error: profileFetchError } = await client
    .from('photographer_profiles')
    .select('subscription_plan, subscription_status, is_suspended')
    .eq('profile_id', photographerId)
    .single();

  if (profileFetchError || !currentProfile) throw fail(404, 'Photographer not found', profileFetchError);

  const previousPlan = ['trial', 'basic', 'premium'].includes(currentProfile.subscription_plan)
    ? currentProfile.subscription_plan
    : 'trial';
  const patch = {
    subscription_status: 'free',
    subscription_plan: 'free',
    subscription_due_at: null,
    subscription_starts_at: null,
    subscription_ends_at: null,
    previous_plan: previousPlan
  };
  if (suspendAccount) patch.is_suspended = true;

  const { error: profileError } = await client
    .from('photographer_profiles')
    .update(patch)
    .eq('profile_id', photographerId);

  if (profileError) throw fail(500, 'Failed to cancel subscription', profileError);

  const now = new Date().toISOString();
  const { error: historyError } = await client
    .from('subscription_history')
    .insert({
      photographer_id: photographerId,
      plan_code: previousPlan === 'free' ? 'trial' : previousPlan,
      started_at: now,
      ends_at: now,
      payment_method: 'admin_action',
      payment_amount: 0,
      payment_reference: reason || 'Admin cancelled subscription',
      status: 'cancelled',
      cancelled_at: now,
      cancellation_reason: reason || null
    });

  if (historyError) {
    console.warn('Failed to log subscription cancellation:', historyError);
  }

  return { previousPlan };
}

/**
 * جلب كل الباقات المتاحة
 */
export async function getAvailablePlans() {
  const { data, error } = await db()
    .from('subscription_plan_details')
    .select('*')
    .eq('is_active', true)
    .order('price_egp', { ascending: true });

  if (error) throw fail(500, 'Failed to fetch plans', error);
  return data || [];
}

/**
 * جلب تفاصيل باقة معينة
 */
export async function getPlanDetails(planCode) {
  const { data, error } = await db()
    .from('subscription_plan_details')
    .select('*')
    .eq('code', planCode)
    .eq('is_active', true)
    .single();

  if (error || !data) throw fail(404, 'Plan not found', error);
  return data;
}

/**
 * جلب تفاصيل اشتراك المصور الحالي
 */
export async function getPhotographerSubscription(photographerId) {
  const { data, error } = await db()
    .from('photographer_with_plan')
    .select('*')
    .eq('id', photographerId)
    .single();

  if (error) throw fail(404, 'Photographer not found', error);
  return data;
}

/**
 * تفعيل التجربة المجانية للمصور
 */
export async function activateFreeTrial(photographerId) {
  const client = db();
  // التحقق من أن المصور لم يفعل التجربة المجانية من قبل
  const { data: photographer } = await client
    .from('photographer_profiles')
    .select('subscription_plan, previous_plan, trial_started_at, is_suspended')
    .eq('profile_id', photographerId)
    .single();

  if (!photographer) {
    throw fail(404, 'Photographer not found');
  }
  if (photographer.is_suspended) throw fail(403, 'Account is suspended. Contact support.');

  // إذا كان المصور بالفعل في باقة مدفوعة، لا يمكنه العودة للتجربة المجانية
  if (PAID_PLAN_CODES.has(photographer.subscription_plan) || (photographer.previous_plan && photographer.previous_plan !== 'trial')) {
    throw fail(400, 'Trial already used');
  }

  // تفعيل التجربة المجانية
  const { data, error } = await client.rpc('activate_subscription', {
    p_photographer_id: photographerId,
    p_plan_code: 'trial',
    p_payment_method: 'free_trial',
    p_payment_amount: 0,
    p_payment_reference: null
  });

  if (error) throw fail(500, 'Failed to activate trial', error);
  
  if (!data || !data.success) {
    throw fail(500, data?.error || 'Failed to activate trial');
  }

  return data;
}

/**
 * إنشاء طلب دفع يدوي وتفعيل الاشتراك فوراً
 */
export async function submitManualPaymentRequest(photographerId, {
  planCode,
  paymentMethod,
  senderName,
  transactionRef,
  receiptUrl,
  receiptPath
}) {
  const client = db();
  const normalizedPlanCode = normalizePaidPlanCode(planCode);
  const normalizedPaymentMethod = cleanString(paymentMethod).toLowerCase();
  const normalizedSenderName = cleanString(senderName);
  const normalizedTransactionRef = cleanString(transactionRef);
  const normalizedReceiptUrl = cleanString(receiptUrl);
  const normalizedReceiptPath = cleanString(receiptPath);

  // التحقق من صحة البيانات
  if (!normalizedPaymentMethod || !normalizedSenderName || !normalizedTransactionRef || (!normalizedReceiptUrl && !normalizedReceiptPath)) {
    throw fail(400, 'Missing required fields');
  }

  if (!VALID_MANUAL_PAYMENT_METHODS.has(normalizedPaymentMethod)) {
    throw fail(400, 'Invalid payment method');
  }

  await ensurePhotographerCanSubscribe(client, photographerId);

  // التحقق من أن الباقة ليست trial
  const plan = await getPlanDetails(normalizedPlanCode);

  // التحقق من عدم تكرار رقم العملية
  const { data: existing, error: existingError } = await client
    .from('manual_payment_requests')
    .select('id')
    .eq('transaction_ref', normalizedTransactionRef)
    .limit(1);

  if (existingError) throw fail(500, 'Failed to check transaction reference', existingError);
  if ((existing || []).length) {
    throw fail(400, 'Transaction reference already used');
  }

  // إنشاء طلب الدفع مع حالة pending، لكن الاشتراك يتفعل فوراً
  const { data: paymentRequest, error } = await client
    .from('manual_payment_requests')
    .insert({
      photographer_id: photographerId,
      plan_code: normalizedPlanCode,
      payment_method: normalizedPaymentMethod,
      sender_name: normalizedSenderName,
      transaction_ref: normalizedTransactionRef,
      receipt_url: normalizedReceiptUrl,
      receipt_path: normalizedReceiptPath,
      status: 'pending'
    })
    .select('*')
    .single();

  if (error) throw fail(500, 'Failed to submit payment request', error);

  const activation = await activatePaidSubscription(client, photographerId, plan, normalizedPaymentMethod, normalizedTransactionRef);
  await linkPaymentRequestToSubscription(client, paymentRequest.id, activation.subscription.id);

  return {
    paymentRequest: { ...paymentRequest, subscription_id: activation.subscription.id },
    subscription: activation.subscription,
    activation: activation.activation,
    autoActivated: true,
    pendingReview: true
  };
}

/**
 * جلب طلبات الدفع اليدوي للمصور
 */
export async function getPhotographerPaymentRequests(photographerId) {
  const { data, error } = await db()
    .from('manual_payment_requests')
    .select('*')
    .eq('photographer_id', photographerId)
    .order('created_at', { ascending: false });

  if (error) throw fail(500, 'Failed to fetch payment requests', error);
  return data || [];
}

/**
 * الأدمن: جلب كل طلبات الدفع اليدوي
 */
export async function getAllManualPaymentRequests(filters = {}) {
  const { page, pageSize, from, to } = pageOptions(filters);
  let query = db()
    .from('manual_payment_requests')
    .select(`
      *,
      photographer:profiles!photographer_id(
        id,
        display_name,
        email,
        phone
      ),
      plan:subscription_plan_details!plan_code(
        code,
        name_ar,
        name_en,
        price_egp
      )
    `, { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(from, to);

  // تطبيق الفلاتر
  if (filters.status && filters.status !== 'all') {
    query = query.eq('status', filters.status);
  }

  if (filters.planCode) {
    query = query.eq('plan_code', filters.planCode);
  }

  const { data, error, count } = await query;
  if (error) throw fail(500, 'Failed to fetch payment requests', error);
  return { requests: data || [], page, pageSize, total: count || 0 };
}

/**
 * الأدمن: مراجعة طلب دفع (قبول أو رفض)
 */
export async function reviewManualPayment(requestId, adminId, action, rejectionReason = null) {
  const client = db();
  if (!['approve', 'reject'].includes(action)) {
    throw fail(400, 'Invalid action');
  }

  // جلب تفاصيل الطلب
  const { data: request, error: fetchError } = await client
    .from('manual_payment_requests')
    .select('*')
    .eq('id', requestId)
    .single();

  if (fetchError || !request) {
    throw fail(404, 'Payment request not found');
  }

  if (request.status !== 'pending') {
    throw fail(400, 'Payment request already reviewed');
  }

  // إذا تم القبول، لا نفعله مرة ثانية لو كان اتفعل تلقائياً
  if (action === 'approve') {
    let subscription = await findManualSubscriptionForRequest(client, request);
    if (!subscription) {
      const plan = await getPlanDetails(request.plan_code);
      const activation = await activatePaidSubscription(client, request.photographer_id, plan, request.payment_method, request.transaction_ref);
      subscription = activation.subscription;
      await linkPaymentRequestToSubscription(client, request.id, subscription.id);
    }

    const { error: updateError } = await client
      .from('manual_payment_requests')
      .update({
        status: 'approved',
        reviewed_by: adminId,
        reviewed_at: new Date().toISOString(),
        rejection_reason: null
      })
      .eq('id', requestId);

    if (updateError) throw fail(500, 'Failed to update payment request', updateError);

    return {
      success: true,
      action: 'approved',
      subscription
    };
  }

  const revoked = await revokeLinkedManualSubscription(client, request, rejectionReason || 'Manual payment rejected');
  const { error: updateError } = await client
    .from('manual_payment_requests')
    .update({
      status: 'rejected',
      reviewed_by: adminId,
      reviewed_at: new Date().toISOString(),
      rejection_reason: rejectionReason || null
    })
    .eq('id', requestId);

  if (updateError) throw fail(500, 'Failed to update payment request', updateError);

  return {
    success: true,
    action: 'rejected',
    revoked
  };
}

/**
 * الأدمن: حذف طلب دفع
 */
export async function deleteManualPaymentRequest(requestId) {
  const { error } = await db()
    .from('manual_payment_requests')
    .delete()
    .eq('id', requestId);

  if (error) throw fail(500, 'Failed to delete payment request', error);
  return { success: true };
}

/**
 * الأدمن: إلغاء اشتراك مصور (في حالة نصب أو مخالفة)
 */
export async function cancelPhotographerSubscription(photographerId, reason = '', options = {}) {
  const client = db();
  const suspendAccount = options.suspendAccount === true;

  const { error: subscriptionError } = await client
    .from('subscriptions')
    .update({ status: 'cancelled' })
    .eq('photographer_id', photographerId)
    .in('status', ['pending', 'active', 'overdue']);

  if (subscriptionError) throw fail(500, 'Failed to cancel subscription records', subscriptionError);
  const downgrade = await downgradePhotographer(client, photographerId, reason || 'Admin cancelled subscription', suspendAccount);

  return {
    success: true,
    suspended: suspendAccount,
    previousPlan: downgrade.previousPlan,
    message: suspendAccount
      ? 'Subscription cancelled and photographer account suspended'
      : 'Subscription cancelled and photographer returned to free plan'
  };
}

/**
 * التحقق من حد معين للباقة
 */
export async function checkPlanLimit(photographerId, limitType) {
  const { data, error } = await db().rpc('check_plan_limit', {
    p_photographer_id: photographerId,
    p_limit_type: limitType
  });

  if (error) throw fail(500, 'Failed to check plan limit', error);
  
  if (!data || !data.success) {
    throw fail(403, data?.error || 'Plan limit check failed');
  }

  return data;
}
