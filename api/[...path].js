import { requireRole, requireUser } from '../backend/lib/auth.js';
import { config } from '../backend/lib/config.js';
import { created, fail, handleError, methodNotAllowed, noContent, ok, readJson } from '../backend/lib/http.js';
import { limitsForPlan, planForPhotographer } from '../backend/lib/limits.js';
import { createPaymobSubscriptionIntent, verifyPaymobHmac } from '../backend/lib/paymob.js';
import { addMinutes, generateSlots, hasOverlap } from '../backend/lib/slots.js';
import { supabaseAnon, supabaseService } from '../backend/lib/supabase.js';
import { asInt, assertUuid, required } from '../backend/lib/validation.js';

const PORTFOLIO_BUCKET = 'portfolio';
const PACKAGE_BUCKET = 'package-attachments';
const BASIC_SUBSCRIPTION_EGP = 400;
const PREMIUM_SUBSCRIPTION_EGP = 600;
const ADMIN_PAGE_SIZE_MAX = 100;
const INTERNAL_MANUAL_PACKAGE_KIND = 'manual_booking_internal';
const MAX_PHOTOGRAPHER_CATEGORIES = 5;
const SUBSCRIPTION_PLANS = {
  basic: { label: 'Basic', priceEgp: BASIC_SUBSCRIPTION_EGP },
  premium: { label: 'Premium', priceEgp: PREMIUM_SUBSCRIPTION_EGP }
};
const DEFAULT_PHOTOGRAPHER_CATEGORIES = [
  ['wedding', 'Wedding Photography', 'تصوير أعراس'],
  ['portrait', 'Portrait Photography', 'تصوير بورتريه'],
  ['event', 'Event Photography', 'تصوير فعاليات'],
  ['fashion', 'Fashion Photography', 'تصوير أزياء'],
  ['newborn', 'Newborn Photography', 'تصوير مواليد'],
  ['product', 'Product Photography', 'تصوير منتجات'],
  ['food', 'Food Photography', 'تصوير طعام'],
  ['realestate', 'Real Estate Photography', 'تصوير عقارات'],
  ['sports', 'Sports Photography', 'تصوير رياضي'],
  ['drone', 'Drone/Aerial Photography', 'تصوير جوي'],
  ['cinematic', 'Cinematic Video', 'تصوير سينمائي'],
  ['maternity', 'Maternity Photography', 'تصوير حمل'],
  ['boudoir', 'Boudoir Photography', 'تصوير بودوار'],
  ['corporate', 'Corporate Photography', 'تصوير شركات'],
  ['street', 'Street Photography', 'تصوير شوارع']
];
const DEFAULT_PUBLIC_CONTENT = {
  heroTitle1Ar: 'حيث يلتقي التصوير',
  heroTitle2Ar: 'بالفرصة',
  heroTitle1En: 'Where Photography',
  heroTitle2En: 'Meets Opportunity',
  heroDescAr: 'تواصل مع مصورين موهوبين واستكشف معارض مذهلة واحجز جلستك المثالية.',
  heroDescEn: 'Connect with talented photographers, explore stunning portfolios, and book your perfect session.',
  footerAboutAr: 'المنصة المتكاملة للمصورين والعملاء.',
  footerAboutEn: 'The complete platform for photographers and clients.'
};
const DEFAULT_PLATFORM_SETTINGS = {
  registrationOpen: true,
  maintenanceMode: false,
  trialDays: 7,
  maxFreePortfolioPhotos: 6,
  basicPlanPriceEgp: BASIC_SUBSCRIPTION_EGP,
  premiumPlanPriceEgp: PREMIUM_SUBSCRIPTION_EGP,
  subscriptionPriceEgp: BASIC_SUBSCRIPTION_EGP
};
const RESERVED_PROFILE_SLUGS = new Set([
  'api',
  'assets',
  'adm',
  'admin',
  'dashboard',
  'index',
  'homepage',
  'explore',
  'publicprofile',
  'photographerdashboard',
  'reset',
  'favicon',
  'robots',
  'sitemap'
]);

function routePath(req) {
  // Try Vercel's injected query.path first (array or string)
  const raw = req.query?.path;
  if (Array.isArray(raw) && raw.length) return raw;
  if (typeof raw === 'string' && raw) return raw.split('/').filter(Boolean);

  // Fall back to parsing req.url — handles any Vercel runtime version
  try {
    const url = new URL(req.url, `https://${req.headers.host || 'localhost'}`);
    const stripped = url.pathname.replace(/^\/api\/?/, '');
    return stripped.split('/').filter(Boolean);
  } catch {
    return [];
  }
}

function param(req, name) {
  const url = new URL(req.url, `https://${req.headers.host || 'localhost'}`);
  return url.searchParams.get(name);
}

function headerValue(req, name) {
  const value = req.headers?.[name.toLowerCase()] || req.headers?.[name];
  return Array.isArray(value) ? value[0] : value;
}

function cleanString(value) {
  return String(value || '').trim();
}

function normalizeBaseUrl(value) {
  const raw = cleanString(value).replace(/\/+$/, '');
  if (!raw) return '';
  try {
    const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
    return `${url.protocol}//${url.host}`;
  } catch {
    return '';
  }
}

function isLocalBaseUrl(value) {
  try {
    const host = new URL(value).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host.endsWith('.local');
  } catch {
    return false;
  }
}

function publicSiteBaseUrl(req) {
  const explicit = [process.env.PUBLIC_SITE_URL, process.env.APP_BASE_URL].map(normalizeBaseUrl).filter(Boolean);
  const nonLocalExplicit = explicit.find((url) => !isLocalBaseUrl(url));
  if (nonLocalExplicit) return nonLocalExplicit;

  const vercelUrl = normalizeBaseUrl(process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL);
  if (vercelUrl) return vercelUrl;

  const forwardedHost = cleanString(headerValue(req, 'x-forwarded-host'));
  const forwardedProto = cleanString(headerValue(req, 'x-forwarded-proto')) || 'https';
  const host = forwardedHost || cleanString(headerValue(req, 'host'));
  const requestHostUrl = host ? normalizeBaseUrl(`${forwardedProto}://${host}`) : '';
  if (requestHostUrl && !isLocalBaseUrl(requestHostUrl)) return requestHostUrl;

  const originUrl = normalizeBaseUrl(headerValue(req, 'origin') || headerValue(req, 'referer'));
  if (originUrl && !isLocalBaseUrl(originUrl)) return originUrl;
  return explicit[0] || requestHostUrl || originUrl || '';
}

function categorySlug(value) {
  return cleanString(value)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function profileSlug(value) {
  return cleanString(value)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function fallbackProfileSlug(body) {
  return profileSlug(body.customLink || body.custom_link)
    || profileSlug(body.displayName)
    || profileSlug(cleanString(body.email).split('@')[0]);
}

async function assertProfileSlugAvailable(sb, slug, ownerId = '') {
  if (!slug || slug.length < 3) throw fail(422, 'Profile link must be at least 3 characters');
  if (RESERVED_PROFILE_SLUGS.has(slug) || slug.endsWith('.html')) throw fail(422, 'This profile link is reserved');
  const { data, error } = await sb
    .from('photographer_profiles')
    .select('profile_id')
    .eq('custom_link', slug)
    .maybeSingle();
  if (error) throw fail(422, error.message);
  if (data && String(data.profile_id) !== String(ownerId || '')) throw fail(409, 'This profile link is already used');
}

function categoryComparable(value) {
  return cleanString(value)
    .toLowerCase()
    .replace(/photography/g, '')
    .replace(/تصوير/g, '')
    .replace(/[^a-z0-9\u0600-\u06FF]+/g, ' ')
    .trim();
}

function defaultCategoryRows() {
  return DEFAULT_PHOTOGRAPHER_CATEGORIES.map(([slug, nameEn, nameAr], index) => ({
    id: slug,
    slug,
    name_en: nameEn,
    name_ar: nameAr,
    is_active: true,
    sort_order: (index + 1) * 10,
    fallback: true
  }));
}

function missingCategorySchema(error) {
  const msg = cleanString(error?.message).toLowerCase();
  return msg.includes('photographer_categories')
    || msg.includes('photographer_profile_categories')
    || msg.includes('schema cache');
}

function looksLikeUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(cleanString(value));
}

function cleanPosition(value) {
  const raw = cleanString(value);
  if (/^\d{1,3}% \d{1,3}%$/.test(raw)) {
    const [x, y] = raw.split(' ').map((part) => Math.max(0, Math.min(100, Number.parseInt(part, 10))));
    return `${x}% ${y}%`;
  }
  return '50% 50%';
}

function formatClock(value) {
  const match = String(value || '').trim().match(/^(\d{1,2}):(\d{2})/);
  if (!match) return String(value || '');
  const hour24 = Number.parseInt(match[1], 10);
  const suffix = hour24 >= 12 ? 'PM' : 'AM';
  const hour12 = hour24 % 12 || 12;
  return `${hour12}:${match[2]} ${suffix}`;
}

function normalizeApiTime(value) {
  const raw = cleanString(value);
  const ampm = raw.match(/^(\d{1,2}):(\d{2})\s*([ap]m)$/i);
  if (ampm) {
    let hour = Number.parseInt(ampm[1], 10);
    const minute = Number.parseInt(ampm[2], 10);
    if (hour < 1 || hour > 12 || minute < 0 || minute > 59) throw fail(422, 'Invalid time');
    if (ampm[3].toLowerCase() === 'pm' && hour !== 12) hour += 12;
    if (ampm[3].toLowerCase() === 'am' && hour === 12) hour = 0;
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  }
  const match = raw.match(/^(\d{1,2}):(\d{2})/);
  if (!match) throw fail(422, 'Invalid time');
  const hour = Number.parseInt(match[1], 10);
  const minute = Number.parseInt(match[2], 10);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) throw fail(422, 'Invalid time');
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function minutesFromTime(value) {
  const [hours, minutes] = normalizeApiTime(value).split(':').map((part) => Number.parseInt(part, 10));
  return hours * 60 + minutes;
}

function assertNotPastDate(dateValue) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const bookingDate = new Date(`${dateValue}T00:00:00`);
  if (isNaN(bookingDate.getTime()) || bookingDate < today) throw fail(422, 'لا يمكن الحجز في تاريخ ماضٍ');
}

function assertValidEmail(value) {
  const email = cleanString(value);
  if (!email) return;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw fail(422, 'صيغة البريد الإلكتروني غير صحيحة');
}

function isInternalManualPackage(pkg) {
  const attachments = Array.isArray(pkg?.attachments) ? pkg.attachments : [];
  return attachments.some((item) => item && item.kind === INTERNAL_MANUAL_PACKAGE_KIND);
}

function subscriptionPlanCode(value) {
  return cleanString(value).toLowerCase() === 'premium' ? 'premium' : 'basic';
}

function subscriptionPlanPrice(settings, planCode) {
  const plan = subscriptionPlanCode(planCode);
  const key = plan === 'premium' ? 'premiumPlanPriceEgp' : 'basicPlanPriceEgp';
  const fallback = SUBSCRIPTION_PLANS[plan].priceEgp;
  return Math.max(1, asInt(settings?.[key], fallback));
}

function isFreeTrialExpired(photographerProfile, settings) {
  if (planForPhotographer(photographerProfile) !== 'free') return false;
  const trialDays = Math.max(0, asInt(settings?.trialDays, DEFAULT_PLATFORM_SETTINGS.trialDays));
  const trialStartedAt = new Date(photographerProfile?.trial_started_at || photographerProfile?.created_at || 0).getTime();
  if (!trialStartedAt || Number.isNaN(trialStartedAt)) return false;
  return Date.now() >= trialStartedAt + trialDays * 24 * 60 * 60 * 1000;
}

function assertFreeTrialAvailable(photographerProfile, settings) {
  if (isFreeTrialExpired(photographerProfile, settings)) {
    throw fail(403, 'Free trial expired. Subscribe to Basic or Premium to continue.');
  }
}

function pageParams(req, defaultPageSize = 25) {
  const page = Math.max(1, asInt(param(req, 'page') || 1));
  const requested = asInt(param(req, 'pageSize') || defaultPageSize);
  const pageSize = Math.min(ADMIN_PAGE_SIZE_MAX, Math.max(1, requested || defaultPageSize));
  return { page, pageSize, from: (page - 1) * pageSize, to: page * pageSize - 1 };
}

function moneyFromCents(cents) {
  return Math.round(Number(cents || 0) / 100);
}

function dateKey(date) {
  return date.toISOString().slice(0, 10);
}

function monthKey(date) {
  return date.toISOString().slice(0, 7);
}

function weekStart(date) {
  const d = new Date(date);
  const day = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() - day);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function buildSeries(rows, range = 'monthly') {
  const now = new Date();
  const points = [];
  if (range === 'daily') {
    for (let i = 29; i >= 0; i -= 1) {
      const d = new Date(now);
      d.setDate(now.getDate() - i);
      const key = dateKey(d);
      points.push({ key, label: `${d.getDate()}/${d.getMonth() + 1}`, value: 0 });
    }
  } else if (range === 'weekly') {
    for (let i = 7; i >= 0; i -= 1) {
      const d = weekStart(now);
      d.setUTCDate(d.getUTCDate() - i * 7);
      const key = dateKey(d);
      points.push({ key, label: `W${points.length + 1}`, value: 0 });
    }
  } else {
    for (let i = 11; i >= 0; i -= 1) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
      const key = monthKey(d);
      points.push({ key, label: d.toLocaleString('en', { month: 'short' }), value: 0 });
    }
  }
  const byKey = Object.fromEntries(points.map((point) => [point.key, point]));
  for (const row of rows || []) {
    const rawDate = row.created_at || row.booking_date;
    if (!rawDate) continue;
    const d = new Date(rawDate);
    if (Number.isNaN(d.getTime())) continue;
    const key = range === 'daily' ? dateKey(d) : range === 'weekly' ? dateKey(weekStart(d)) : monthKey(d);
    if (byKey[key]) byKey[key].value += moneyFromCents(row.price_cents || row.amount_cents);
  }
  return points;
}

async function getPlatformSettings(sb = supabaseService()) {
  const { data } = await sb.from('site_settings').select('value').eq('key', 'platform').maybeSingle();
  return { ...DEFAULT_PLATFORM_SETTINGS, ...(data?.value || {}) };
}

async function getPublicCopy(sb = supabaseService()) {
  const { data } = await sb.from('site_content').select('value').eq('key', 'public_copy').maybeSingle();
  return { ...DEFAULT_PUBLIC_CONTENT, ...(data?.value || {}) };
}

async function requireAdmin(req) {
  const { profile } = await requireUser(req);
  requireRole(profile, 'admin');
  return profile;
}

async function writeAdminLog(sb, actor, action, entityType, entityId, metadata = {}) {
  await sb.from('admin_audit_logs').insert({
    actor_id: actor?.id || null,
    action,
    entity_type: entityType || null,
    entity_id: entityId ? String(entityId) : null,
    metadata
  });
}

async function writeAdminNotification(sb, type, title, message, metadata = {}) {
  await sb.from('admin_notifications').insert({ type, title, message, metadata });
}

function categoryValuesFromBody(body) {
  let values = [];
  let explicit = false;
  if (Array.isArray(body.categorySlugs)) {
    values = body.categorySlugs;
    explicit = true;
  } else if (Array.isArray(body.categories)) {
    values = body.categories.map((item) => (item && typeof item === 'object' ? item.slug : item));
    explicit = true;
  } else if (Array.isArray(body.specialties)) {
    values = body.specialties;
    explicit = true;
  } else if (body.specialty !== undefined) {
    values = [body.specialty];
  }
  const cleaned = Array.from(new Set(values.map(cleanString).filter(Boolean)));
  return { values: cleaned, explicit };
}

async function getActiveCategoryRows(sb = supabaseService()) {
  const { data, error } = await sb
    .from('photographer_categories')
    .select('*')
    .eq('is_active', true)
    .order('sort_order', { ascending: true })
    .order('name_en', { ascending: true });
  if (error) {
    if (missingCategorySchema(error)) return defaultCategoryRows();
    throw fail(422, error.message);
  }
  return data || [];
}

async function resolveCategoryRows(sb, body, { requiredSelection = false } = {}) {
  const { values, explicit } = categoryValuesFromBody(body);
  if (requiredSelection && values.length === 0) throw fail(422, 'Select at least one category');
  if (values.length > MAX_PHOTOGRAPHER_CATEGORIES) throw fail(422, `Select up to ${MAX_PHOTOGRAPHER_CATEGORIES} categories`);
  if (values.length === 0) return [];

  const categories = await getActiveCategoryRows(sb);
  const matched = [];
  const missing = [];
  for (const value of values) {
    const slug = categorySlug(value);
    const comparable = categoryComparable(value);
    const row = categories.find((cat) => {
      return cat.slug === slug
        || cleanString(cat.slug).toLowerCase() === cleanString(value).toLowerCase()
        || cleanString(cat.name_en).toLowerCase() === cleanString(value).toLowerCase()
        || cleanString(cat.name_ar) === cleanString(value)
        || categoryComparable(cat.name_en) === comparable
        || categoryComparable(cat.name_ar) === comparable;
    });
    if (row) matched.push(row);
    else missing.push(value);
  }

  if ((explicit || requiredSelection) && missing.length) throw fail(422, `Unknown category: ${missing[0]}`);
  return Array.from(new Map(matched.map((row) => [row.id, row])).values());
}

async function syncPhotographerCategories(sb, photographerId, categoryRows) {
  if (!Array.isArray(categoryRows)) return;
  if (!categoryRows.length || categoryRows.some((category) => category.fallback || !looksLikeUuid(category.id))) return;
  const { error: deleteError } = await sb
    .from('photographer_profile_categories')
    .delete()
    .eq('photographer_id', photographerId);
  if (missingCategorySchema(deleteError)) return;
  if (deleteError) throw fail(422, deleteError.message || 'Unable to update photographer categories');
  const rows = categoryRows.map((category) => ({ photographer_id: photographerId, category_id: category.id }));
  const { error } = await sb.from('photographer_profile_categories').insert(rows);
  if (missingCategorySchema(error)) return;
  if (error) throw fail(422, error.message);
}

function categoryDto(row) {
  return {
    id: row.id,
    slug: row.slug,
    nameEn: row.name_en,
    nameAr: row.name_ar,
    isActive: row.is_active !== false,
    sortOrder: row.sort_order || 0
  };
}

async function listCategories(req, res) {
  const rows = await getActiveCategoryRows();
  ok(res, { categories: rows.map(categoryDto) });
}

async function attachProfileCategories(sb, profile) {
  if (!profile || profile.role !== 'photographer') return profile;
  const photographerProfile = Array.isArray(profile.photographer_profiles)
    ? profile.photographer_profiles[0]
    : profile.photographer_profiles;
  if (!photographerProfile) return profile;

  const { data, error } = await sb
    .from('photographer_profile_categories')
    .select('photographer_categories(id, slug, name_en, name_ar, is_active, sort_order)')
    .eq('photographer_id', profile.id);
  if (error) return profile;

  const categories = (data || [])
    .map((row) => row.photographer_categories)
    .filter(Boolean)
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || String(a.name_en || '').localeCompare(String(b.name_en || '')));

  photographerProfile.categories = categories;
  photographerProfile.category_slugs = categories.map((category) => category.slug);
  if (categories.length) photographerProfile.specialty = categories.map((category) => category.name_en).join(', ');
  return profile;
}

async function getPhotographerProfile(sb, profileId) {
  const { data, error } = await sb
    .from('photographer_profiles')
    .select('*')
    .eq('profile_id', profileId)
    .single();
  if (error || !data) throw fail(404, 'Photographer profile not found');
  return data;
}

async function register(req, res) {
  const body = await readJson(req);
  required(body, ['email', 'password', 'role', 'displayName']);
  if (!['client', 'photographer'].includes(body.role)) throw fail(422, 'Invalid role');

  const sb = supabaseService();
  const settings = await getPlatformSettings(sb);
  if (settings.registrationOpen === false) throw fail(403, 'Registration is currently closed');
  const categoryRows = body.role === 'photographer'
    ? await resolveCategoryRows(sb, body, { requiredSelection: true })
    : [];
  const photographerCustomLink = body.role === 'photographer' ? fallbackProfileSlug(body) : '';
  if (body.role === 'photographer') {
    required(body, ['region']);
    await assertProfileSlugAvailable(sb, photographerCustomLink);
  }

  const { data: authData, error: authError } = await sb.auth.admin.createUser({
    email: cleanString(body.email).toLowerCase(),
    password: body.password,
    email_confirm: true,
    user_metadata: { role: body.role, display_name: cleanString(body.displayName) }
  });
  if (authError) throw fail(422, authError.message);

  const profile = {
    id: authData.user.id,
    email: cleanString(body.email).toLowerCase(),
    role: body.role,
    display_name: cleanString(body.displayName),
    phone: cleanString(body.phone),
    preferred_language: body.language === 'ar' ? 'ar' : 'en'
  };
  const { error: profileError } = await sb.from('profiles').insert(profile);
  if (profileError) throw fail(422, profileError.message);

  if (body.role === 'photographer') {
    const primaryCategory = categoryRows[0];
    const { error } = await sb.from('photographer_profiles').insert({
      profile_id: authData.user.id,
      specialty: primaryCategory?.name_en || cleanString(body.specialty) || 'Photography',
      region: cleanString(body.region),
      custom_link: photographerCustomLink,
      bio: cleanString(body.bio),
      subscription_status: 'free',
      subscription_plan: 'free',
      is_published: false
    });
    if (error) throw fail(422, error.message);
    await syncPhotographerCategories(sb, authData.user.id, categoryRows);
  }

  created(res, { userId: authData.user.id });
}

async function resetPassword(req, res) {
  const body = await readJson(req);
  required(body, ['email']);
  const email = cleanString(body.email).toLowerCase();
  const resetBaseUrl = publicSiteBaseUrl(req);
  const redirectTo = resetBaseUrl ? `${resetBaseUrl}/reset` : undefined;
  if (!redirectTo) {
    console.error('[auth/reset-password] missing public reset URL');
    throw fail(500, 'Password reset is not configured');
  }
  const { error } = await supabaseAnon().auth.resetPasswordForEmail(email, redirectTo ? { redirectTo } : undefined);
  if (error) {
    const providerMessage = cleanString(error.message) || 'Supabase rejected the reset request';
    const providerStatus = error.status || error.statusCode || null;
    const providerCode = error.code || null;
    console.error('[auth/reset-password] Supabase failed', {
      message: providerMessage,
      status: providerStatus,
      code: providerCode,
      redirectTo
    });
    throw fail(502, `Reset email failed: ${providerMessage}`, {
      providerMessage,
      providerStatus,
      providerCode,
      redirectTo
    });
  }
  ok(res, { ok: true });
}

async function login(req, res) {
  const body = await readJson(req);
  required(body, ['email', 'password']);
  const { data, error } = await supabaseAnon().auth.signInWithPassword({
    email: cleanString(body.email).toLowerCase(),
    password: body.password
  });
  if (error) throw fail(401, error.message);

  const sb = supabaseService();
  const { data: profile } = await sb
    .from('profiles')
    .select('*, photographer_profiles(*)')
    .eq('id', data.user.id)
    .single();

  ok(res, { session: data.session, user: data.user, profile: await attachProfileCategories(sb, profile) });
}

async function getMe(req, res) {
  const { profile } = await requireUser(req);
  const sb = supabaseService();
  const { data } = await sb
    .from('profiles')
    .select('*, photographer_profiles(*)')
    .eq('id', profile.id)
    .single();
  ok(res, { profile: await attachProfileCategories(sb, data) });
}

async function updateMe(req, res) {
  const { profile } = await requireUser(req);
  const body = await readJson(req);
  const sb = supabaseService();

  const profilePatch = {};
  ['displayName', 'phone', 'avatarUrl', 'language'].forEach((key) => {
    if (body[key] !== undefined) {
      const dbKey = { displayName: 'display_name', avatarUrl: 'avatar_url', language: 'preferred_language' }[key] || key;
      profilePatch[dbKey] = body[key];
    }
  });
  if (Object.keys(profilePatch).length) {
    const { error } = await sb.from('profiles').update(profilePatch).eq('id', profile.id);
    if (error) throw fail(422, error.message);
  }

  if (profile.role === 'photographer') {
    const photographerPatch = {};
    let categoryRows = null;
    if (body.categorySlugs !== undefined || body.categories !== undefined || body.specialties !== undefined) {
      categoryRows = await resolveCategoryRows(sb, body, { requiredSelection: true });
      photographerPatch.specialty = categoryRows.map((category) => category.name_en).join(', ');
    }
    ['specialty', 'region', 'customLink', 'bio', 'coverUrl', 'coverPosition', 'socialLinks', 'isPublished'].forEach((key) => {
      if (key === 'specialty' && categoryRows) return;
      if (body[key] !== undefined) {
        const dbKey = { customLink: 'custom_link', coverUrl: 'cover_url', coverPosition: 'cover_position', socialLinks: 'social_links', isPublished: 'is_published' }[key] || key;
        photographerPatch[dbKey] = key === 'coverPosition' ? cleanPosition(body[key]) : key === 'customLink' ? profileSlug(body[key]) : body[key];
      }
    });
    if (Object.keys(photographerPatch).length) {
      if (photographerPatch.custom_link !== undefined) await assertProfileSlugAvailable(sb, photographerPatch.custom_link, profile.id);
      const { error } = await sb.from('photographer_profiles').update(photographerPatch).eq('profile_id', profile.id);
      if (error) throw fail(422, error.message);
    }
    if (categoryRows) await syncPhotographerCategories(sb, profile.id, categoryRows);
  }
  ok(res, { saved: true });
}

async function getPublicContent(req, res) {
  const sb = supabaseService();
  const [content, settings] = await Promise.all([getPublicCopy(sb), getPlatformSettings(sb)]);
  ok(res, { content, settings });
}

async function listPhotographers(req, res) {
  const sb = supabaseService();
  const settings = await getPlatformSettings(sb);
  const search = cleanString(param(req, 'search')).toLowerCase();
  const region = cleanString(param(req, 'region'));
  const specialty = cleanString(param(req, 'specialty')).toLowerCase();

  let query = sb
    .from('photographer_directory')
    .select('*')
    .eq('is_published', true)
    .eq('is_suspended', false)
    .order('created_at', { ascending: false });

  if (region) query = query.eq('region', region);
  const { data, error } = await query;
  if (error) throw fail(422, error.message);

  const filtered = (data || []).filter((row) => {
    if (isFreeTrialExpired(row, settings)) return false;
    const categories = Array.isArray(row.categories) ? row.categories : [];
    const categoryText = categories.map((category) => `${category.slug} ${category.name_en} ${category.name_ar}`).join(' ');
    const categorySlugs = Array.isArray(row.category_slugs) ? row.category_slugs : [];
    const matchesSearch = !search || `${row.display_name} ${row.specialty} ${categoryText}`.toLowerCase().includes(search);
    const matchesSpecialty = !specialty
      || String(row.specialty || '').toLowerCase().includes(specialty)
      || categorySlugs.map((slug) => String(slug).toLowerCase()).includes(specialty)
      || categoryText.toLowerCase().includes(specialty);
    return matchesSearch && matchesSpecialty;
  });
  ok(res, { photographers: filtered });
}

async function getPublicPhotographer(req, res, customLink) {
  const sb = supabaseService();
  const settings = await getPlatformSettings(sb);
  const { data: photographer, error } = await sb
    .from('photographer_directory')
    .select('*')
    .eq('custom_link', customLink)
    .eq('is_published', true)
    .eq('is_suspended', false)
    .single();
  if (error || !photographer) throw fail(404, 'Photographer not found');
  if (isFreeTrialExpired(photographer, settings)) throw fail(404, 'Photographer not found');

  const [{ data: collections }, { data: packages }, { data: workingHours }] = await Promise.all([
    sb.from('portfolio_collections').select('*, portfolio_photos(*)').eq('photographer_id', photographer.id).order('created_at'),
    sb.from('packages').select('*').eq('photographer_id', photographer.id).eq('status', 'active').order('featured', { ascending: false }),
    sb.from('working_hours').select('*').eq('photographer_id', photographer.id).order('day_of_week')
  ]);

  ok(res, {
    photographer,
    collections: collections || [],
    packages: (packages || []).filter((pkg) => !isInternalManualPackage(pkg)),
    workingHours: workingHours || []
  });
}

async function signUpload(req, res) {
  const { profile } = await requireUser(req);
  const body = await readJson(req);
  required(body, ['kind', 'filename']);
  const sb = supabaseService();
  const isPackage = body.kind === 'package';
  const bucket = isPackage ? PACKAGE_BUCKET : PORTFOLIO_BUCKET;
  const safeName = cleanString(body.filename).replace(/[^a-z0-9._-]/gi, '-').toLowerCase();
  const path = `${profile.id}/${Date.now()}-${safeName}`;

  const { data, error } = await sb.storage.from(bucket).createSignedUploadUrl(path);
  if (error) throw fail(422, error.message);
  const { data: publicData } = sb.storage.from(bucket).getPublicUrl(path);
  ok(res, { bucket, path, token: data.token, signedUrl: data.signedUrl, publicUrl: publicData.publicUrl });
}

function decodeImageDataUrl(dataUrl) {
  const match = cleanString(dataUrl).match(/^data:(image\/(?:jpeg|png|webp));base64,([a-z0-9+/=\s]+)$/i);
  if (!match) throw fail(422, 'Invalid image data');
  const buffer = Buffer.from(match[2].replace(/\s/g, ''), 'base64');
  if (!buffer.length) throw fail(422, 'Invalid image data');
  if (buffer.length > 5 * 1024 * 1024) throw fail(422, 'Image must be 5MB or smaller');
  return { mimeType: match[1].toLowerCase(), buffer };
}

function extensionForMime(mimeType) {
  if (mimeType === 'image/png') return 'png';
  if (mimeType === 'image/webp') return 'webp';
  return 'jpg';
}

async function uploadProfileMedia(req, res) {
  const { profile } = await requireUser(req);
  const body = await readJson(req);
  required(body, ['type', 'dataUrl']);

  const type = cleanString(body.type);
  if (type !== 'cover') throw fail(422, 'Unsupported media type');
  requireRole(profile, 'photographer');

  const { mimeType, buffer } = decodeImageDataUrl(body.dataUrl);
  const sb = supabaseService();
  const coverPosition = cleanPosition(body.coverPosition);
  const path = `${profile.id}/profile-cover-${Date.now()}.${extensionForMime(mimeType)}`;
  const { error: uploadError } = await sb.storage.from(PORTFOLIO_BUCKET).upload(path, buffer, {
    contentType: mimeType,
    cacheControl: '31536000',
    upsert: false
  });
  if (uploadError) throw fail(422, uploadError.message);

  const { data: publicData } = sb.storage.from(PORTFOLIO_BUCKET).getPublicUrl(path);
  const publicUrl = publicData?.publicUrl;
  if (!publicUrl) throw fail(422, 'Could not create public image URL');

  const { error: profileError } = await sb
    .from('photographer_profiles')
    .update({ cover_url: publicUrl, cover_position: coverPosition })
    .eq('profile_id', profile.id);
  if (profileError) throw fail(422, profileError.message);

  ok(res, { type, publicUrl, coverPosition, path });
}

async function addPortfolioPhoto(req, res) {
  const { profile } = await requireUser(req);
  requireRole(profile, 'photographer');
  const body = await readJson(req);
  required(body, ['url']);
  const sb = supabaseService();
  const photographer = await getPhotographerProfile(sb, profile.id);
  const settings = await getPlatformSettings(sb);
  assertFreeTrialAvailable(photographer, settings);
  const plan = planForPhotographer(photographer);
  const limits = limitsForPlan(plan);

  let collectionId = body.collectionId;
  if (!collectionId) {
    const { data: collection, error } = await sb
      .from('portfolio_collections')
      .select('*')
      .eq('photographer_id', profile.id)
      .order('created_at')
      .limit(1)
      .maybeSingle();
    if (error) throw fail(422, error.message);
    if (collection) collectionId = collection.id;
    else {
      const { data: createdCollection, error: createError } = await sb
        .from('portfolio_collections')
        .insert({ photographer_id: profile.id, title: 'Portfolio' })
        .select('*')
        .single();
      if (createError) throw fail(422, createError.message);
      collectionId = createdCollection.id;
    }
  }

  const { count, error: countError } = await sb
    .from('portfolio_photos')
    .select('id', { count: 'exact', head: true })
    .eq('photographer_id', profile.id);
  if (countError) throw fail(422, countError.message);
  if ((count || 0) >= limits.portfolioPhotos) throw fail(403, `Portfolio photo limit reached for ${plan} plan`);

  const { data, error } = await sb
    .from('portfolio_photos')
    .insert({
      photographer_id: profile.id,
      collection_id: collectionId,
      url: body.url,
      storage_path: body.storagePath || null,
      title: cleanString(body.title)
    })
    .select('*')
    .single();
  if (error) throw fail(422, error.message);
  created(res, { photo: data });
}

async function deletePortfolioPhoto(req, res, id) {
  const { profile } = await requireUser(req);
  requireRole(profile, 'photographer');
  const { error } = await supabaseService().from('portfolio_photos').delete().eq('id', id).eq('photographer_id', profile.id);
  if (error) throw fail(422, error.message);
  noContent(res);
}

async function createCollection(req, res) {
  const { profile } = await requireUser(req);
  requireRole(profile, 'photographer');
  const body = await readJson(req);
  required(body, ['title']);
  const sb = supabaseService();
  const photographer = await getPhotographerProfile(sb, profile.id);
  const settings = await getPlatformSettings(sb);
  assertFreeTrialAvailable(photographer, settings);
  const { data, error } = await sb
    .from('portfolio_collections')
    .insert({ photographer_id: profile.id, title: cleanString(body.title) })
    .select('*')
    .single();
  if (error) throw fail(422, error.message);
  created(res, { collection: data });
}

async function deleteCollection(req, res, id) {
  const { profile } = await requireUser(req);
  requireRole(profile, 'photographer');
  await supabaseService().from('portfolio_collections').delete().eq('id', id).eq('photographer_id', profile.id);
  noContent(res);
}

async function listPackages(req, res) {
  const { profile } = await requireUser(req);
  requireRole(profile, 'photographer');
  const { data, error } = await supabaseService().from('packages').select('*').eq('photographer_id', profile.id).order('created_at', { ascending: false });
  if (error) throw fail(422, error.message);
  ok(res, { packages: (data || []).filter((pkg) => !isInternalManualPackage(pkg)) });
}

async function createPackage(req, res) {
  const { profile } = await requireUser(req);
  requireRole(profile, 'photographer');
  const body = await readJson(req);
  required(body, ['name', 'price', 'durationMinutes']);
  const sb = supabaseService();
  const photographer = await getPhotographerProfile(sb, profile.id);
  const settings = await getPlatformSettings(sb);
  assertFreeTrialAvailable(photographer, settings);
  const plan = planForPhotographer(photographer);
  const limits = limitsForPlan(plan);
  const { data: packageRows, error: countError } = await sb
    .from('packages')
    .select('id, attachments')
    .eq('photographer_id', profile.id);
  if (countError) throw fail(422, countError.message);
  const packageCount = (packageRows || []).filter((pkg) => !isInternalManualPackage(pkg)).length;
  if (packageCount >= limits.packages) throw fail(403, `Package limit reached for ${plan} plan`);
  const payload = {
    photographer_id: profile.id,
    name: cleanString(body.name),
    description: cleanString(body.description),
    price_cents: asInt(body.price) * 100,
    duration_minutes: asInt(body.durationMinutes),
    features: Array.isArray(body.features) ? body.features : [],
    attachments: Array.isArray(body.attachments) ? body.attachments : [],
    status: body.status === 'draft' ? 'draft' : 'active',
    featured: body.featured === true
  };
  const { data, error } = await sb.from('packages').insert(payload).select('*').single();
  if (error) throw fail(422, error.message);
  created(res, { package: data });
}

async function updatePackage(req, res, id) {
  const { profile } = await requireUser(req);
  requireRole(profile, 'photographer');
  const body = await readJson(req);
  const patch = {};
  if (body.name !== undefined) patch.name = cleanString(body.name);
  if (body.description !== undefined) patch.description = cleanString(body.description);
  if (body.price !== undefined) patch.price_cents = asInt(body.price) * 100;
  if (body.durationMinutes !== undefined) patch.duration_minutes = asInt(body.durationMinutes);
  if (Array.isArray(body.features)) patch.features = body.features;
  if (Array.isArray(body.attachments)) patch.attachments = body.attachments;
  if (body.status !== undefined) patch.status = body.status === 'draft' ? 'draft' : 'active';
  if (body.featured !== undefined) patch.featured = body.featured === true;

  const { data, error } = await supabaseService()
    .from('packages')
    .update(patch)
    .eq('id', id)
    .eq('photographer_id', profile.id)
    .select('*')
    .single();
  if (error) throw fail(422, error.message);
  ok(res, { package: data });
}

async function deletePackage(req, res, id) {
  const { profile } = await requireUser(req);
  requireRole(profile, 'photographer');
  const { error } = await supabaseService().from('packages').delete().eq('id', id).eq('photographer_id', profile.id);
  if (error) throw fail(422, error.message);
  noContent(res);
}

async function setWorkingHours(req, res) {
  const { profile } = await requireUser(req);
  requireRole(profile, 'photographer');
  const body = await readJson(req);
  if (!Array.isArray(body.workingHours)) throw fail(422, 'workingHours must be an array');
  const sb = supabaseService();
  const rows = body.workingHours.map((item) => ({
    photographer_id: profile.id,
    day_of_week: asInt(item.dayOfWeek),
    start_time: item.startTime,
    end_time: item.endTime,
    enabled: item.enabled !== false
  }));
  /* Validate before hitting DB so users get a clean error */
  for (const r of rows) {
    if (!(r.day_of_week >= 0 && r.day_of_week <= 6)) {
      throw fail(422, 'يوم الأسبوع يجب أن يكون بين 0 و 6');
    }
    if (!r.start_time || !r.end_time || r.start_time >= r.end_time) {
      throw fail(422, 'وقت النهاية يجب أن يكون بعد وقت البداية');
    }
  }
  const { data, error } = await sb
    .from('working_hours')
    .upsert(rows, { onConflict: 'photographer_id,day_of_week' })
    .select('*');
  if (error) throw fail(422, error.message);
  /* Remove days no longer in the submitted set */
  const activeDays = rows.map((r) => r.day_of_week);
  if (activeDays.length < 7) {
    await sb.from('working_hours')
      .delete()
      .eq('photographer_id', profile.id)
      .not('day_of_week', 'in', `(${activeDays.join(',')})`);
  }
  ok(res, { workingHours: data || [] });
}

async function getWorkingHours(req, res) {
  const { profile } = await requireUser(req);
  requireRole(profile, 'photographer');
  const { data, error } = await supabaseService()
    .from('working_hours')
    .select('*')
    .eq('photographer_id', profile.id)
    .order('day_of_week');
  if (error) throw fail(422, error.message);
  ok(res, { workingHours: data || [] });
}

async function createAvailabilityBlock(req, res) {
  const { profile } = await requireUser(req);
  requireRole(profile, 'photographer');
  const body = await readJson(req);
  required(body, ['date', 'startTime', 'endTime']);
  const blockDate = new Date(`${body.date}T00:00:00`);
  if (Number.isNaN(blockDate.getTime())) throw fail(422, 'Invalid block date');
  if (!body.startTime || !body.endTime || body.startTime >= body.endTime) {
    throw fail(422, 'وقت النهاية يجب أن يكون بعد وقت البداية');
  }
  const { data, error } = await supabaseService()
    .from('availability_blocks')
    .insert({
      photographer_id: profile.id,
      block_date: body.date,
      start_time: body.startTime,
      end_time: body.endTime,
      reason: cleanString(body.reason)
    })
    .select('*')
    .single();
  if (error) throw fail(422, error.message);
  created(res, { block: data });
}

async function deleteAvailabilityBlock(req, res, id) {
  const { profile } = await requireUser(req);
  requireRole(profile, 'photographer');
  const { error } = await supabaseService().from('availability_blocks').delete().eq('id', id).eq('photographer_id', profile.id);
  if (error) throw fail(422, error.message);
  noContent(res);
}

async function getAvailableSlots(req, res, photographerId) {
  const date = param(req, 'date');
  const packageId = param(req, 'packageId');
  if (!date || !packageId) throw fail(422, 'date and packageId are required');

  const sb = supabaseService();
  const photographer = await getPhotographerProfile(sb, photographerId);
  const settings = await getPlatformSettings(sb);
  assertFreeTrialAvailable(photographer, settings);
  const [{ data: pkg }, { data: workingHours }, { data: bookings }, { data: blocks }] = await Promise.all([
    sb.from('packages').select('*').eq('id', packageId).eq('photographer_id', photographerId).eq('status', 'active').single(),
    sb.from('working_hours').select('*').eq('photographer_id', photographerId),
    sb.from('bookings').select('start_time,end_time').eq('photographer_id', photographerId).eq('booking_date', date).in('status', ['confirmed', 'pending']),
    sb.from('availability_blocks').select('start_time,end_time').eq('photographer_id', photographerId).eq('block_date', date)
  ]);
  if (!pkg) throw fail(404, 'Package not found');

  const slots = generateSlots({
    date,
    durationMinutes: pkg.duration_minutes,
    workingHours: workingHours || [],
    bookings: bookings || [],
    blocks: blocks || []
  });
  ok(res, { slots });
}

function isMissingPendingBookingRpc(error) {
  const msg = String(error?.message || '');
  return error?.code === 'PGRST202' || (msg.includes('create_pending_booking') && msg.includes('schema cache'));
}

async function createPendingBookingFallback({ sb, body, pkg, startTime, endTime, clientId }) {
  const [{ data: workingHours, error: hoursError }, { data: bookings, error: bookingError }, { data: blocks, error: blockError }] = await Promise.all([
    sb.from('working_hours').select('*').eq('photographer_id', body.photographerId),
    sb.from('bookings').select('start_time,end_time').eq('photographer_id', body.photographerId).eq('booking_date', body.date).in('status', ['confirmed', 'pending']),
    sb.from('availability_blocks').select('start_time,end_time').eq('photographer_id', body.photographerId).eq('block_date', body.date)
  ]);
  const dataError = hoursError || bookingError || blockError;
  if (dataError) throw fail(422, dataError.message);

  const slots = generateSlots({
    date: body.date,
    durationMinutes: pkg.duration_minutes,
    workingHours: workingHours || [],
    bookings: bookings || [],
    blocks: blocks || []
  });
  const available = slots.some((slot) => slot.startTime === startTime && slot.endTime === endTime);
  if (!available) throw fail(409, 'Time slot is no longer available');

  const { data, error } = await sb
    .from('bookings')
    .insert({
      client_id: clientId,
      photographer_id: body.photographerId,
      package_id: body.packageId,
      booking_date: body.date,
      start_time: startTime,
      end_time: endTime,
      client_name: cleanString(body.clientName),
      client_email: cleanString(body.clientEmail),
      client_phone: cleanString(body.clientPhone),
      notes: cleanString(body.notes),
      price_cents: pkg.price_cents,
      status: 'pending'
    })
    .select('*')
    .single();
  if (error) throw fail(409, error.message || 'Time slot is no longer available');
  return data;
}

async function createBooking(req, res) {
  const body = await readJson(req);
  required(body, ['photographerId', 'packageId', 'date', 'startTime', 'clientName', 'clientPhone']);

  /* Reject past dates */
  assertNotPastDate(body.date);

  /* Validate email format if provided */
  assertValidEmail(body.clientEmail);

  const tokenUser = await requireUser(req).catch(() => null);
  if (!tokenUser || tokenUser.profile?.role !== 'client') {
    throw fail(401, 'يجب تسجيل الدخول كعميل للحجز');
  }
  const sb = supabaseService();
  const photographer = await getPhotographerProfile(sb, body.photographerId);
  const settings = await getPlatformSettings(sb);
  assertFreeTrialAvailable(photographer, settings);
  const { data: pkg, error: pkgError } = await sb
    .from('packages')
    .select('*')
    .eq('id', body.packageId)
    .eq('photographer_id', body.photographerId)
    .eq('status', 'active')
    .single();
  if (pkgError || !pkg) throw fail(404, 'Package not found');

  const startTime = addMinutes(cleanString(body.startTime).slice(0, 5), 0);
  const endTime = addMinutes(startTime, pkg.duration_minutes);
  const clientId = tokenUser.profile.id;

  /* Atomic conflict check + insert via advisory-locked RPC */
  const { data: rpcRow, error: rpcErr } = await sb.rpc('create_pending_booking', {
    p_client_id: clientId,
    p_photographer_id: body.photographerId,
    p_package_id: body.packageId,
    p_booking_date: body.date,
    p_start_time: startTime,
    p_end_time: endTime,
    p_client_name: cleanString(body.clientName),
    p_client_email: cleanString(body.clientEmail),
    p_client_phone: cleanString(body.clientPhone),
    p_notes: cleanString(body.notes),
    p_price_cents: pkg.price_cents
  });
  let bookingRow = rpcRow;
  if (rpcErr) {
    if (!isMissingPendingBookingRpc(rpcErr)) {
      throw fail(409, rpcErr.message || 'Time slot is no longer available');
    }
    bookingRow = await createPendingBookingFallback({ sb, body, pkg, startTime, endTime, clientId });
  }

  /* RPC returns the bookings row directly; fetch the package join for the client */
  const bookingId = bookingRow?.id;
  const { data, error } = await sb
    .from('bookings')
    .select('*, packages(name, duration_minutes)')
    .eq('id', bookingId)
    .single();
  if (error) throw fail(422, error.message);
  created(res, { booking: data });
}

async function createManualBooking(req, res) {
  const { profile } = await requireUser(req);
  requireRole(profile, 'photographer');
  const body = await readJson(req);
  required(body, ['clientName', 'clientPhone', 'date', 'startTime']);
  assertNotPastDate(body.date);
  assertValidEmail(body.clientEmail);

  const startTime = normalizeApiTime(body.startTime);
  const clientId = cleanString(body.clientId) || null;
  if (clientId) assertUuid(clientId, 'clientId');

  const sb = supabaseService();
  const photographer = await getPhotographerProfile(sb, profile.id);
  const settings = await getPlatformSettings(sb);
  assertFreeTrialAvailable(photographer, settings);
  const requestedPackageId = cleanString(body.packageId);
  let pkg = null;
  let durationMinutes = 0;
  let priceCents = 0;
  let packageId = requestedPackageId || null;
  let internalPackagePayload = null;

  if (requestedPackageId) {
    assertUuid(requestedPackageId, 'packageId');
    const { data: packageRow, error: packageError } = await sb
      .from('packages')
      .select('*')
      .eq('id', requestedPackageId)
      .eq('photographer_id', profile.id)
      .maybeSingle();
    if (packageError) throw fail(422, packageError.message);
    if (!packageRow || isInternalManualPackage(packageRow)) throw fail(404, 'Package not found');
    pkg = packageRow;
    durationMinutes = Number(pkg.duration_minutes || 0);
    priceCents = Number(pkg.price_cents || 0);
  } else {
    required(body, ['serviceName', 'price']);
    const endTimeForDuration = body.endTime ? normalizeApiTime(body.endTime) : '';
    if (endTimeForDuration) {
      durationMinutes = minutesFromTime(endTimeForDuration) - minutesFromTime(startTime);
    } else {
      durationMinutes = asInt(body.durationMinutes);
    }
    if (!durationMinutes || durationMinutes <= 0) throw fail(422, 'End time must be after start time');
    priceCents = Math.max(0, Math.round(Number(body.price || 0) * 100));
    if (!priceCents) throw fail(422, 'Price is required');
    internalPackagePayload = {
      photographer_id: profile.id,
      name: cleanString(body.serviceName),
      description: 'Internal custom booking package',
      price_cents: priceCents,
      duration_minutes: durationMinutes,
      features: [],
      attachments: [{ kind: INTERNAL_MANUAL_PACKAGE_KIND }],
      status: 'draft',
      featured: false
    };
  }

  if (!durationMinutes || durationMinutes <= 0) throw fail(422, 'Invalid booking duration');
  if (minutesFromTime(startTime) + durationMinutes > 24 * 60) throw fail(422, 'Booking cannot run past midnight');
  const endTime = addMinutes(startTime, durationMinutes);

  if (clientId) {
    const [{ data: relatedBookings, error: bookingLinkError }, { data: relatedConversations, error: conversationLinkError }] = await Promise.all([
      sb.from('bookings').select('id').eq('photographer_id', profile.id).eq('client_id', clientId).limit(1),
      sb.from('conversations').select('id').eq('photographer_id', profile.id).eq('client_id', clientId).limit(1)
    ]);
    const linkError = bookingLinkError || conversationLinkError;
    if (linkError) throw fail(422, linkError.message);
    if ((!relatedBookings || relatedBookings.length === 0) && (!relatedConversations || relatedConversations.length === 0)) {
      throw fail(403, 'Client is not linked to this photographer');
    }
  }

  const [{ data: bookings, error: bookingError }, { data: blocks, error: blockError }] = await Promise.all([
    sb.from('bookings').select('start_time,end_time').eq('photographer_id', profile.id).eq('booking_date', body.date).in('status', ['confirmed', 'pending']),
    sb.from('availability_blocks').select('start_time,end_time').eq('photographer_id', profile.id).eq('block_date', body.date)
  ]);
  const dataError = bookingError || blockError;
  if (dataError) throw fail(422, dataError.message);
  if (hasOverlap({ startTime, endTime, bookings: bookings || [], blocks: blocks || [] })) {
    throw fail(409, 'Time slot is no longer available');
  }

  if (!packageId && internalPackagePayload) {
    const { data: createdPackage, error: packageCreateError } = await sb
      .from('packages')
      .insert(internalPackagePayload)
      .select('*')
      .single();
    if (packageCreateError) throw fail(422, packageCreateError.message);
    pkg = createdPackage;
    packageId = createdPackage.id;
  }
  if (!packageId) throw fail(422, 'Package is required');

  const insertRow = {
    client_id: clientId,
    photographer_id: profile.id,
    package_id: packageId,
    booking_date: body.date,
    start_time: startTime,
    end_time: endTime,
    client_name: cleanString(body.clientName),
    client_email: cleanString(body.clientEmail),
    client_phone: cleanString(body.clientPhone),
    notes: cleanString(body.notes),
    price_cents: priceCents,
    status: 'confirmed'
  };

  const { data: booking, error } = await sb
    .from('bookings')
    .insert(insertRow)
    .select('*, packages(name, duration_minutes)')
    .single();
  if (error) throw fail(422, error.message);

  let conversationId = null;
  if (clientId) {
    const { data: conv } = await sb
      .from('conversations')
      .upsert(
        { client_id: clientId, photographer_id: profile.id },
        { onConflict: 'client_id,photographer_id' }
      )
      .select('*')
      .single();
    conversationId = conv?.id || null;
  }
  created(res, { booking, conversationId, package: pkg });
}

async function listBookings(req, res) {
  const { profile } = await requireUser(req);
  const sb = supabaseService();
  const column = profile.role === 'photographer' ? 'photographer_id' : 'client_id';
  const { data, error } = await sb
    .from('bookings')
    .select('*, packages(name, duration_minutes)')
    .eq(column, profile.id)
    .order('booking_date', { ascending: false });
  if (error) throw fail(422, error.message);
  const photographerIds = Array.from(new Set((data || []).map((booking) => booking.photographer_id).filter(Boolean)));
  const { data: photographers } = photographerIds.length
    ? await sb.from('profiles').select('id, display_name, avatar_url').in('id', photographerIds)
    : { data: [] };
  const photographerById = Object.fromEntries((photographers || []).map((person) => [person.id, person]));
  const bookings = (data || []).map((b) => ({
    ...b,
    photographer_name: photographerById[b.photographer_id]?.display_name || '',
    photographer_avatar: photographerById[b.photographer_id]?.avatar_url || ''
  }));
  ok(res, { bookings });
}

async function deleteMessage(req, res, conversationId, messageId) {
  const { profile } = await requireUser(req);
  const sb = supabaseService();
  const { data: conv } = await sb.from('conversations').select('*').eq('id', conversationId).single();
  if (!conv || ![conv.client_id, conv.photographer_id].includes(profile.id)) throw fail(404, 'Conversation not found');
  const { data, error } = await sb
    .from('messages')
    .update({ is_deleted: true })
    .eq('id', messageId)
    .eq('sender_id', profile.id)
    .select('*')
    .single();
  if (error) throw fail(422, error.message);
  ok(res, { message: data });
}

async function completeBooking(req, res, id) {
  const { profile } = await requireUser(req);
  requireRole(profile, 'photographer');
  const sb = supabaseService();
  const { data, error } = await sb
    .from('bookings')
    .update({ status: 'completed' })
    .eq('id', id)
    .eq('photographer_id', profile.id)
    .eq('status', 'confirmed')
    .select('*')
    .single();
  if (error || !data) throw fail(404, 'Booking not found or not confirmed');
  ok(res, { booking: data });
}

async function cancelBooking(req, res, id) {
  const { profile } = await requireUser(req);
  const sb = supabaseService();
  let query = sb.from('bookings').update({ status: 'cancelled' }).eq('id', id);
  if (profile.role === 'photographer') query = query.eq('photographer_id', profile.id);
  else if (profile.role === 'client') query = query.eq('client_id', profile.id);
  else requireRole(profile, 'admin');
  const { data, error } = await query.select('*').single();
  if (error) throw fail(422, error.message);
  ok(res, { booking: data });
}

async function confirmBooking(req, res, id) {
  const { profile } = await requireUser(req);
  requireRole(profile, 'photographer');
  const sb = supabaseService();

  /* Only pending bookings can be confirmed. This avoids re-confirming cancelled
     bookings (which would also re-fire the auto-message to the client). */
  const { data: booking, error } = await sb
    .from('bookings')
    .update({ status: 'confirmed' })
    .eq('id', id)
    .eq('photographer_id', profile.id)
    .eq('status', 'pending')
    .select('*, packages(name, duration_minutes)')
    .maybeSingle();
  if (error) throw fail(422, error.message);
  if (!booking) throw fail(409, 'Booking is not pending and cannot be confirmed');

  let conversationId = null;
  if (booking.client_id) {
    const { data: conv } = await sb
      .from('conversations')
      .upsert(
        { client_id: booking.client_id, photographer_id: profile.id },
        { onConflict: 'client_id,photographer_id' }
      )
      .select('*')
      .single();

    if (conv) {
      conversationId = conv.id;
      const pkgName = booking.packages?.name || '';
      const msgText = `📅 تم قبول حجزك!\nالخدمة: ${pkgName}\nالتاريخ: ${booking.booking_date}\nالوقت: ${formatClock(booking.start_time)}`;
      await sb.from('messages').insert({
        conversation_id: conv.id,
        sender_id: profile.id,
        content: msgText
      });
      await sb.from('conversations').update({
        last_message: msgText,
        last_message_at: new Date().toISOString()
      }).eq('id', conv.id);
    }
  }

  ok(res, { booking, conversationId });
}

async function listConversations(req, res) {
  const { profile } = await requireUser(req);
  const column = profile.role === 'photographer' ? 'photographer_id' : 'client_id';
  const sb = supabaseService();
  const { data, error } = await sb
    .from('conversations')
    .select('*')
    .eq(column, profile.id)
    .order('last_message_at', { ascending: false });
  if (error) throw fail(422, error.message);
  const rows = data || [];
  const profileIds = Array.from(new Set(rows.flatMap((row) => [row.client_id, row.photographer_id]).filter(Boolean)));
  const { data: people } = profileIds.length
    ? await sb.from('profiles').select('id, display_name, avatar_url').in('id', profileIds)
    : { data: [] };
  const peopleById = Object.fromEntries((people || []).map((person) => [person.id, person]));
  ok(res, { conversations: rows.map((row) => ({
    ...row,
    client_name: peopleById[row.client_id]?.display_name || 'Client',
    client_avatar: peopleById[row.client_id]?.avatar_url || null,
    photographer_name: peopleById[row.photographer_id]?.display_name || 'Photographer',
    photographer_avatar: peopleById[row.photographer_id]?.avatar_url || null
  })) });
}

async function enrichConversation(sb, conversation) {
  if (!conversation) return null;
  const ids = [conversation.client_id, conversation.photographer_id].filter(Boolean);
  const { data: people } = ids.length
    ? await sb.from('profiles').select('id, display_name, avatar_url').in('id', ids)
    : { data: [] };
  const peopleById = Object.fromEntries((people || []).map((person) => [person.id, person]));
  return {
    ...conversation,
    client_name: peopleById[conversation.client_id]?.display_name || 'Client',
    client_avatar: peopleById[conversation.client_id]?.avatar_url || null,
    photographer_name: peopleById[conversation.photographer_id]?.display_name || 'Photographer',
    photographer_avatar: peopleById[conversation.photographer_id]?.avatar_url || null
  };
}

async function createConversation(req, res) {
  const { profile } = await requireUser(req);
  const body = await readJson(req);
  if (profile.role === 'photographer') {
    if (body.bookingId) return createConversationFromBookingBody(profile, body, res);
    if (body.clientId) return createConversationForLinkedClient(profile, body, res);
    throw fail(422, 'Choose a linked booking or client to start this conversation');
  }
  if (profile.role !== 'client') throw fail(403, 'Only clients can start conversations with photographers');
  const sb = supabaseService();
  const settings = await getPlatformSettings(sb);
  let photographerId = '';
  const photographerLink = cleanString(body.photographerLink || body.customLink);
  if (photographerLink) {
    const { data: byLink, error: linkError } = await sb
      .from('photographer_directory')
      .select('id')
      .eq('custom_link', photographerLink)
      .eq('is_published', true)
      .eq('is_suspended', false)
      .maybeSingle();
    if (linkError) throw fail(422, linkError.message);
    photographerId = byLink?.id || '';
  } else {
    photographerId = cleanString(body.photographerId);
    if (photographerId) assertUuid(photographerId, 'photographerId');
  }
  if (!photographerId) throw fail(422, 'Could not identify the photographer to message');
  const { data: photographer, error: photographerError } = await sb
    .from('photographer_directory')
    .select('*')
    .eq('id', photographerId)
    .eq('is_published', true)
    .eq('is_suspended', false)
    .maybeSingle();
  if (photographerError) throw fail(422, photographerError.message);
  if (!photographer) throw fail(404, 'Photographer not found');
  assertFreeTrialAvailable(photographer, settings);
  const { data, error } = await sb
    .from('conversations')
    .upsert(
      { client_id: profile.id, photographer_id: photographerId },
      { onConflict: 'client_id,photographer_id' }
    )
    .select('*')
    .single();
  if (error) throw fail(422, error.message);
  created(res, { conversation: await enrichConversation(sb, data) });
}

async function createConversationForLinkedClient(profile, body, res) {
  const clientId = cleanString(body.clientId);
  if (!clientId) throw fail(422, 'Missing clientId');
  assertUuid(clientId, 'clientId');
  const sb = supabaseService();
  const [{ data: client, error: clientError }, { data: bookings, error: bookingError }, { data: conversations, error: conversationError }] = await Promise.all([
    sb.from('profiles').select('id, role').eq('id', clientId).maybeSingle(),
    sb.from('bookings').select('id').eq('photographer_id', profile.id).eq('client_id', clientId).limit(1),
    sb.from('conversations').select('id').eq('photographer_id', profile.id).eq('client_id', clientId).limit(1)
  ]);
  const linkError = clientError || bookingError || conversationError;
  if (linkError) throw fail(422, linkError.message);
  if (!client || client.role !== 'client') throw fail(404, 'Client not found');
  if ((!bookings || bookings.length === 0) && (!conversations || conversations.length === 0)) {
    throw fail(403, 'Client is not linked to this photographer');
  }

  const { data, error } = await sb
    .from('conversations')
    .upsert(
      { client_id: clientId, photographer_id: profile.id },
      { onConflict: 'client_id,photographer_id' }
    )
    .select('*')
    .single();
  if (error) throw fail(422, error.message);
  created(res, { conversation: await enrichConversation(sb, data) });
}

async function createConversationFromBookingBody(profile, body, res) {
  const bookingId = cleanString(body.bookingId);
  if (!bookingId) throw fail(422, 'Missing bookingId');
  assertUuid(bookingId, 'bookingId');
  const sb = supabaseService();
  const { data: booking, error: bookingError } = await sb
    .from('bookings')
    .select('id, client_id, photographer_id')
    .eq('id', bookingId)
    .eq('photographer_id', profile.id)
    .maybeSingle();
  if (bookingError) throw fail(422, bookingError.message);
  if (!booking) throw fail(404, 'Booking not found');
  if (!booking.client_id) throw fail(422, 'This booking is not linked to a client account');

  const { data, error } = await sb
    .from('conversations')
    .upsert(
      { client_id: booking.client_id, photographer_id: profile.id },
      { onConflict: 'client_id,photographer_id' }
    )
    .select('*')
    .single();
  if (error) throw fail(422, error.message);
  created(res, { conversation: await enrichConversation(sb, data) });
}

async function createConversationFromBooking(req, res) {
  const { profile } = await requireUser(req);
  requireRole(profile, 'photographer');
  const body = await readJson(req);
  return createConversationFromBookingBody(profile, body, res);
}

async function updateConversationState(req, res, conversationId, action) {
  const { profile } = await requireUser(req);
  const body = await readJson(req).catch(() => ({}));
  const sb = supabaseService();
  const { data: conversation } = await sb.from('conversations').select('*').eq('id', conversationId).single();
  if (!conversation || ![conversation.client_id, conversation.photographer_id].includes(profile.id)) throw fail(404, 'Conversation not found');

  const patch = {};
  if (action === 'block') {
    patch.blocked_by = body.blocked === false && conversation.blocked_by === profile.id ? null : profile.id;
  }
  if (action === 'archive') {
    const archived = new Set(conversation.archived_by || []);
    if (body.archived === false) archived.delete(profile.id);
    else archived.add(profile.id);
    patch.archived_by = Array.from(archived);
  }

  const { data, error } = await sb.from('conversations').update(patch).eq('id', conversationId).select('*').single();
  if (error) throw fail(422, error.message);
  ok(res, { conversation: data });
}

async function listMessages(req, res, conversationId) {
  const { profile } = await requireUser(req);
  const sb = supabaseService();
  const { data: conversation } = await sb.from('conversations').select('*').eq('id', conversationId).single();
  if (!conversation || ![conversation.client_id, conversation.photographer_id].includes(profile.id)) throw fail(404, 'Conversation not found');
  const { data, error } = await sb.from('messages').select('*').eq('conversation_id', conversationId).order('created_at');
  if (error) throw fail(422, error.message);
  ok(res, { messages: data || [] });
}

async function sendMessage(req, res, conversationId) {
  const { profile } = await requireUser(req);
  const body = await readJson(req);
  const content = cleanString(body.content);
  if (!content) throw fail(422, 'Message cannot be empty');
  const sb = supabaseService();
  const { data: conversation } = await sb.from('conversations').select('*').eq('id', conversationId).single();
  if (!conversation || ![conversation.client_id, conversation.photographer_id].includes(profile.id)) throw fail(404, 'Conversation not found');
  if (conversation.blocked_by) throw fail(403, 'Conversation is blocked');

  const { data, error } = await sb
    .from('messages')
    .insert({ conversation_id: conversationId, sender_id: profile.id, content })
    .select('*')
    .single();
  if (error) throw fail(422, error.message);
  await sb.from('conversations').update({ last_message: data.content, last_message_at: data.created_at }).eq('id', conversationId);
  created(res, { message: data });
}

async function createReport(req, res) {
  const { profile } = await requireUser(req);
  const body = await readJson(req);
  required(body, ['reason']);
  const { data, error } = await supabaseService()
    .from('reports')
    .insert({
      reporter_id: profile.id,
      reported_profile_id: body.reportedProfileId || null,
      conversation_id: body.conversationId || null,
      reason: cleanString(body.reason)
    })
    .select('*')
    .single();
  if (error) throw fail(422, error.message);
  created(res, { report: data });
}

async function enrichSupportConversations(sb, conversations) {
  const rows = conversations || [];
  const ids = Array.from(new Set(rows.flatMap((row) => [row.user_id, row.assigned_admin_id]).filter(Boolean)));
  const { data: people } = ids.length
    ? await sb.from('profiles').select('id, role, display_name, email, avatar_url').in('id', ids)
    : { data: [] };
  const peopleById = Object.fromEntries((people || []).map((person) => [person.id, person]));
  return rows.map((row) => {
    const user = peopleById[row.user_id];
    const admin = peopleById[row.assigned_admin_id];
    return {
      ...row,
      user_name: user?.display_name || 'User',
      user_email: user?.email || '',
      user_role: user?.role || '',
      user_avatar: user?.avatar_url || null,
      admin_name: admin?.display_name || 'Support',
      admin_avatar: admin?.avatar_url || null
    };
  });
}

async function enrichSupportMessages(sb, messages) {
  const rows = messages || [];
  const ids = Array.from(new Set(rows.map((row) => row.sender_id).filter(Boolean)));
  const { data: people } = ids.length
    ? await sb.from('profiles').select('id, role, display_name, avatar_url').in('id', ids)
    : { data: [] };
  const peopleById = Object.fromEntries((people || []).map((person) => [person.id, person]));
  return rows.map((row) => {
    const sender = peopleById[row.sender_id];
    return {
      ...row,
      sender_name: sender?.role === 'admin' ? 'Support' : sender?.display_name || 'User',
      sender_role: sender?.role || '',
      sender_avatar: sender?.avatar_url || null
    };
  });
}

async function getSupportConversationForUser(sb, profile, conversationId) {
  assertUuid(conversationId, 'conversationId');
  const { data, error } = await sb
    .from('support_conversations')
    .select('*')
    .eq('id', conversationId)
    .eq('user_id', profile.id)
    .maybeSingle();
  if (error) throw fail(422, error.message);
  if (!data) throw fail(404, 'Support conversation not found');
  return data;
}

async function getSupportConversationForAdmin(sb, conversationId) {
  assertUuid(conversationId, 'conversationId');
  const { data, error } = await sb
    .from('support_conversations')
    .select('*')
    .eq('id', conversationId)
    .maybeSingle();
  if (error) throw fail(422, error.message);
  if (!data) throw fail(404, 'Support conversation not found');
  return data;
}

async function createSupportMessage(sb, conversation, senderId, content, patch = {}) {
  const text = cleanString(content);
  if (!text) throw fail(422, 'Message cannot be empty');
  if (conversation.status === 'closed' && patch.status !== 'open') throw fail(403, 'Support conversation is closed');
  const { data, error } = await sb
    .from('support_messages')
    .insert({ support_conversation_id: conversation.id, sender_id: senderId, content: text })
    .select('*')
    .single();
  if (error) throw fail(422, error.message);
  await sb.from('support_conversations').update({
    last_message: text,
    last_message_at: data.created_at,
    ...patch
  }).eq('id', conversation.id);
  return data;
}

async function listSupportConversations(req, res) {
  const { profile } = await requireUser(req);
  const sb = supabaseService();
  const { data, error } = await sb
    .from('support_conversations')
    .select('*')
    .eq('user_id', profile.id)
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false });
  if (error) throw fail(422, error.message);
  ok(res, { conversations: await enrichSupportConversations(sb, data || []) });
}

async function createSupportConversation(req, res) {
  const { profile } = await requireUser(req);
  const body = await readJson(req).catch(() => ({}));
  const sb = supabaseService();
  let { data: conversation, error } = await sb
    .from('support_conversations')
    .select('*')
    .eq('user_id', profile.id)
    .eq('status', 'open')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw fail(422, error.message);

  if (!conversation) {
    const createdRow = await sb
      .from('support_conversations')
      .insert({ user_id: profile.id, subject: cleanString(body.subject) || 'Support' })
      .select('*')
      .single();
    if (createdRow.error) throw fail(422, createdRow.error.message);
    conversation = createdRow.data;
  }

  if (cleanString(body.message)) {
    await createSupportMessage(sb, conversation, profile.id, body.message);
    const { data: refreshed } = await sb.from('support_conversations').select('*').eq('id', conversation.id).single();
    conversation = refreshed || conversation;
  }

  created(res, { conversation: (await enrichSupportConversations(sb, [conversation]))[0] });
}

async function listSupportMessages(req, res, conversationId) {
  const { profile } = await requireUser(req);
  const sb = supabaseService();
  await getSupportConversationForUser(sb, profile, conversationId);
  const { data, error } = await sb
    .from('support_messages')
    .select('*')
    .eq('support_conversation_id', conversationId)
    .order('created_at');
  if (error) throw fail(422, error.message);
  ok(res, { messages: await enrichSupportMessages(sb, data || []) });
}

async function sendSupportMessage(req, res, conversationId) {
  const { profile } = await requireUser(req);
  const body = await readJson(req);
  const sb = supabaseService();
  const conversation = await getSupportConversationForUser(sb, profile, conversationId);
  const message = await createSupportMessage(sb, conversation, profile.id, body.content);
  created(res, { message: (await enrichSupportMessages(sb, [message]))[0] });
}

async function adminListSupportConversations(req, res) {
  await requireAdmin(req);
  const sb = supabaseService();
  const { page, pageSize, from, to } = pageParams(req, 25);
  const status = cleanString(param(req, 'status'));
  let query = sb
    .from('support_conversations')
    .select('*', { count: 'exact' })
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false })
    .range(from, to);
  if (['open', 'closed'].includes(status)) query = query.eq('status', status);
  const { data, error, count } = await query;
  if (error) throw fail(422, error.message);
  ok(res, { conversations: await enrichSupportConversations(sb, data || []), page, pageSize, total: count || 0 });
}

async function adminListSupportMessages(req, res, conversationId) {
  await requireAdmin(req);
  const sb = supabaseService();
  await getSupportConversationForAdmin(sb, conversationId);
  const { data, error } = await sb
    .from('support_messages')
    .select('*')
    .eq('support_conversation_id', conversationId)
    .order('created_at');
  if (error) throw fail(422, error.message);
  ok(res, { messages: await enrichSupportMessages(sb, data || []) });
}

async function adminSendSupportMessage(req, res, conversationId) {
  const admin = await requireAdmin(req);
  const body = await readJson(req);
  const sb = supabaseService();
  const conversation = await getSupportConversationForAdmin(sb, conversationId);
  const message = await createSupportMessage(sb, conversation, admin.id, body.content, {
    assigned_admin_id: conversation.assigned_admin_id || admin.id
  });
  created(res, { message: (await enrichSupportMessages(sb, [message]))[0] });
}

async function adminUpdateSupportConversation(req, res, conversationId) {
  const admin = await requireAdmin(req);
  assertUuid(conversationId, 'conversationId');
  const body = await readJson(req);
  const status = cleanString(body.status);
  if (!['open', 'closed'].includes(status)) throw fail(422, 'Invalid support conversation status');
  const sb = supabaseService();
  const { data, error } = await sb
    .from('support_conversations')
    .update({ status, assigned_admin_id: body.assignedAdminId === null ? null : admin.id })
    .eq('id', conversationId)
    .select('*')
    .single();
  if (error) throw fail(422, error.message);
  ok(res, { conversation: (await enrichSupportConversations(sb, [data]))[0] });
}

async function startSubscription(req, res) {
  const { profile } = await requireUser(req);
  requireRole(profile, 'photographer');
  const body = await readJson(req).catch(() => ({}));
  const planCode = subscriptionPlanCode(body.plan || body.planCode);
  const settings = await getPlatformSettings();
  const subscriptionPriceEgp = subscriptionPlanPrice(settings, planCode);
  const merchantOrderId = `dof-${planCode}-${profile.id}-${Date.now()}`;
  const intent = await createPaymobSubscriptionIntent({
    amountCents: subscriptionPriceEgp * 100,
    merchantOrderId,
    customer: { email: profile.email || `${profile.id}@dof.local`, name: profile.display_name, phone: profile.phone }
  });
  await supabaseService().from('subscriptions').insert({
    photographer_id: profile.id,
    provider: 'paymob',
    provider_order_id: String(intent.orderId),
    merchant_order_id: merchantOrderId,
    amount_cents: subscriptionPriceEgp * 100,
    currency: 'EGP',
    status: 'pending',
    plan_code: planCode
  });
  ok(res, { ...intent, plan: planCode, amountEgp: subscriptionPriceEgp });
}

async function currentSubscription(req, res) {
  const { profile } = await requireUser(req);
  requireRole(profile, 'photographer');
  const { data } = await supabaseService()
    .from('subscriptions')
    .select('*')
    .eq('photographer_id', profile.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  ok(res, { subscription: data || null });
}

async function paymobWebhook(req, res) {
  const body = await readJson(req);
  const object = body.obj || body;
  const sb = supabaseService();
  await sb.from('payment_events').insert({ provider: 'paymob', payload: body });

  if (body.hmac && !verifyPaymobHmac(body)) throw fail(401, 'Invalid Paymob HMAC');
  const merchantOrderId = object?.order?.merchant_order_id || object?.merchant_order_id;
  if (!merchantOrderId) return ok(res, { received: true });

  const status = object.success === true || object.success === 'true' ? 'active' : 'failed';
  const due = new Date();
  due.setMonth(due.getMonth() + 1);

  const { data: subscription } = await sb
    .from('subscriptions')
    .update({ status, current_period_end: status === 'active' ? due.toISOString() : null })
    .eq('merchant_order_id', merchantOrderId)
    .select('*')
    .maybeSingle();

  if (subscription && status === 'active') {
    const planCode = subscriptionPlanCode(subscription.plan_code);
    await sb.from('photographer_profiles').update({
      subscription_status: 'active',
      subscription_plan: planCode,
      subscription_due_at: due.toISOString(),
      is_suspended: false
    }).eq('profile_id', subscription.photographer_id);
  }
  ok(res, { received: true });
}

function adminSearchTerm(req) {
  return cleanString(param(req, 'search')).replace(/[,%]/g, ' ');
}

function normalizedEmbeddedOne(value) {
  return Array.isArray(value) ? value[0] : value;
}

async function adminOverview(req, res) {
  await requireAdmin(req);
  const sb = supabaseService();
  const [{ data: profiles }, { data: photographers }, { data: reports }, { data: bookings }, { data: subscriptions }, { data: latestUsers }, { data: latestLogs }] = await Promise.all([
    sb.from('profiles').select('id, role, created_at'),
    sb.from('photographer_profiles').select('profile_id, is_published, is_suspended, subscription_status'),
    sb.from('reports').select('id, status, created_at'),
    sb.from('bookings').select('id, status, price_cents, created_at'),
    sb.from('subscriptions').select('id, status, amount_cents, created_at'),
    sb.from('profiles').select('id, role, display_name, email, created_at').order('created_at', { ascending: false }).limit(5),
    sb.from('admin_audit_logs').select('*').order('created_at', { ascending: false }).limit(8)
  ]);

  const users = profiles || [];
  const photoRows = photographers || [];
  const bookingRows = bookings || [];
  const subscriptionRows = subscriptions || [];
  const activeBookingRows = bookingRows.filter((row) => row.status !== 'cancelled');

  ok(res, {
    metrics: {
      totalUsers: users.length,
      clients: users.filter((row) => row.role === 'client').length,
      photographers: users.filter((row) => row.role === 'photographer').length,
      admins: users.filter((row) => row.role === 'admin').length,
      activePhotographers: photoRows.filter((row) => !row.is_suspended && row.is_published).length,
      suspendedPhotographers: photoRows.filter((row) => row.is_suspended).length,
      openReports: (reports || []).filter((row) => row.status === 'open').length,
      pendingBookings: bookingRows.filter((row) => row.status === 'pending').length,
      completedBookings: bookingRows.filter((row) => row.status === 'completed').length,
      grossBookingValue: activeBookingRows.reduce((sum, row) => sum + moneyFromCents(row.price_cents), 0),
      activeSubscriptions: subscriptionRows.filter((row) => row.status === 'active').length,
      pendingSubscriptions: subscriptionRows.filter((row) => row.status === 'pending').length,
      failedSubscriptions: subscriptionRows.filter((row) => ['failed', 'overdue'].includes(row.status)).length,
      subscriptionRevenue: subscriptionRows.filter((row) => row.status === 'active').reduce((sum, row) => sum + moneyFromCents(row.amount_cents), 0)
    },
    series: {
      monthlyRevenue: buildSeries(activeBookingRows, 'monthly'),
      dailyRevenue: buildSeries(activeBookingRows, 'daily')
    },
    latestUsers: latestUsers || [],
    latestLogs: latestLogs || []
  });
}

async function adminListUsers(req, res) {
  await requireAdmin(req);
  const sb = supabaseService();
  const { page, pageSize, from, to } = pageParams(req);
  const role = cleanString(param(req, 'role'));
  const search = adminSearchTerm(req);
  let query = sb
    .from('profiles')
    .select('*, photographer_profiles(*)', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(from, to);

  if (['client', 'photographer', 'admin'].includes(role)) query = query.eq('role', role);
  if (search) query = query.or(`display_name.ilike.%${search}%,email.ilike.%${search}%,phone.ilike.%${search}%`);

  const { data, error, count } = await query;
  if (error) throw fail(422, error.message);

  const users = data || [];
  const ids = users.map((user) => user.id);
  const [{ data: clientBookings }, { data: photographerBookings }, { data: packages }, { data: photos }] = ids.length ? await Promise.all([
    sb.from('bookings').select('client_id, status, price_cents').in('client_id', ids),
    sb.from('bookings').select('photographer_id, status, price_cents').in('photographer_id', ids),
    sb.from('packages').select('photographer_id, id').in('photographer_id', ids),
    sb.from('portfolio_photos').select('photographer_id, id').in('photographer_id', ids)
  ]) : [{ data: [] }, { data: [] }, { data: [] }, { data: [] }];

  const rows = users.map((user) => {
    const photographerProfile = normalizedEmbeddedOne(user.photographer_profiles);
    const clientRows = (clientBookings || []).filter((row) => row.client_id === user.id && row.status !== 'cancelled');
    const photographerRows = (photographerBookings || []).filter((row) => row.photographer_id === user.id && row.status !== 'cancelled');
    return {
      id: user.id,
      email: user.email,
      role: user.role,
      displayName: user.display_name,
      phone: user.phone,
      avatarUrl: user.avatar_url,
      createdAt: user.created_at,
      photographerProfile: photographerProfile || null,
      status: user.role === 'photographer'
        ? photographerProfile?.is_suspended ? 'suspended' : photographerProfile?.is_published ? 'active' : 'hidden'
        : 'active',
      bookingCount: user.role === 'photographer' ? photographerRows.length : clientRows.length,
      grossValue: user.role === 'photographer'
        ? photographerRows.reduce((sum, row) => sum + moneyFromCents(row.price_cents), 0)
        : clientRows.reduce((sum, row) => sum + moneyFromCents(row.price_cents), 0),
      packageCount: (packages || []).filter((row) => row.photographer_id === user.id).length,
      portfolioPhotoCount: (photos || []).filter((row) => row.photographer_id === user.id).length
    };
  });

  ok(res, { users: rows, page, pageSize, total: count || 0 });
}

async function adminListPhotographers(req, res) {
  await requireAdmin(req);
  const sb = supabaseService();
  const { page, pageSize, from, to } = pageParams(req);
  const search = adminSearchTerm(req);
  const status = cleanString(param(req, 'status'));
  const subscription = cleanString(param(req, 'subscription'));
  const region = cleanString(param(req, 'region'));

  let query = sb
    .from('photographer_directory')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(from, to);

  if (search) query = query.or(`display_name.ilike.%${search}%,specialty.ilike.%${search}%,region.ilike.%${search}%`);
  if (region) query = query.eq('region', region);
  if (subscription) query = query.eq('subscription_status', subscription);
  if (status === 'suspended') query = query.eq('is_suspended', true);
  if (status === 'published') query = query.eq('is_suspended', false).eq('is_published', true);
  if (status === 'hidden') query = query.eq('is_published', false);

  const { data, error, count } = await query;
  if (error) throw fail(422, error.message);
  const photographers = data || [];
  const ids = photographers.map((row) => row.id);
  const [{ data: bookings }, { data: packages }, { data: photos }, { data: people }] = ids.length ? await Promise.all([
    sb.from('bookings').select('photographer_id, status, price_cents').in('photographer_id', ids),
    sb.from('packages').select('photographer_id, id').in('photographer_id', ids),
    sb.from('portfolio_photos').select('photographer_id, id').in('photographer_id', ids),
    sb.from('profiles').select('id, email').in('id', ids)
  ]) : [{ data: [] }, { data: [] }, { data: [] }, { data: [] }];
  const emailById = Object.fromEntries((people || []).map((person) => [person.id, person.email]));

  ok(res, {
    photographers: photographers.map((row) => {
      const bookingRows = (bookings || []).filter((booking) => booking.photographer_id === row.id && booking.status !== 'cancelled');
      return {
        ...row,
        email: emailById[row.id] || '',
        status: row.is_suspended ? 'suspended' : row.is_published ? 'active' : 'hidden',
        packageCount: (packages || []).filter((pkg) => pkg.photographer_id === row.id).length,
        portfolioPhotoCount: (photos || []).filter((photo) => photo.photographer_id === row.id).length,
        grossRevenue: bookingRows.reduce((sum, booking) => sum + moneyFromCents(booking.price_cents), 0)
      };
    }),
    page,
    pageSize,
    total: count || 0
  });
}

async function adminUpdatePhotographerModeration(req, res, photographerId) {
  const actor = await requireAdmin(req);
  assertUuid(photographerId, 'photographerId');
  const body = await readJson(req);
  const patch = {};
  if (body.isSuspended !== undefined) patch.is_suspended = body.isSuspended === true;
  if (body.isPublished !== undefined) patch.is_published = body.isPublished === true;
  if (!Object.keys(patch).length) throw fail(422, 'No moderation fields supplied');

  const sb = supabaseService();
  const { data, error } = await sb
    .from('photographer_profiles')
    .update(patch)
    .eq('profile_id', photographerId)
    .select('*')
    .single();
  if (error) throw fail(422, error.message);
  await writeAdminLog(sb, actor, 'photographer_moderation_update', 'photographer', photographerId, { patch, reason: cleanString(body.reason) });
  if (patch.is_suspended === true) {
    await writeAdminNotification(sb, 'moderation', 'Photographer suspended', `A photographer was suspended by ${actor.display_name}.`, { photographerId });
  }
  ok(res, { photographerProfile: data });
}

async function adminListCategories(req, res) {
  await requireAdmin(req);
  const { data, error } = await supabaseService()
    .from('photographer_categories')
    .select('*')
    .order('is_active', { ascending: false })
    .order('sort_order', { ascending: true })
    .order('name_en', { ascending: true });
  if (error) throw fail(422, error.message);
  ok(res, { categories: (data || []).map(categoryDto) });
}

async function adminCreateCategory(req, res) {
  const actor = await requireAdmin(req);
  const body = await readJson(req);
  const nameEn = cleanString(body.nameEn || body.name_en);
  const nameAr = cleanString(body.nameAr || body.name_ar) || nameEn;
  if (!nameEn) throw fail(422, 'English category name is required');

  const sb = supabaseService();
  const slug = categorySlug(body.slug || nameEn);
  if (!slug) throw fail(422, 'Category slug is required');
  const { data: lastCategory } = await sb
    .from('photographer_categories')
    .select('sort_order')
    .order('sort_order', { ascending: false })
    .limit(1)
    .maybeSingle();

  const { data, error } = await sb
    .from('photographer_categories')
    .insert({
      slug,
      name_en: nameEn,
      name_ar: nameAr,
      is_active: true,
      sort_order: Number(lastCategory?.sort_order || 0) + 10
    })
    .select('*')
    .single();
  if (error) throw fail(422, error.message);
  await writeAdminLog(sb, actor, 'category_create', 'photographer_category', data.id, { nameEn, nameAr, slug });
  created(res, { category: categoryDto(data) });
}

async function adminUpdateCategory(req, res, categoryId) {
  const actor = await requireAdmin(req);
  assertUuid(categoryId, 'categoryId');
  const body = await readJson(req);
  const patch = {};
  if (body.nameEn !== undefined || body.name_en !== undefined) {
    const nameEn = cleanString(body.nameEn || body.name_en);
    if (!nameEn) throw fail(422, 'English category name is required');
    patch.name_en = nameEn;
  }
  if (body.nameAr !== undefined || body.name_ar !== undefined) {
    const nameAr = cleanString(body.nameAr || body.name_ar);
    if (!nameAr) throw fail(422, 'Arabic category name is required');
    patch.name_ar = nameAr;
  }
  if (body.isActive !== undefined || body.is_active !== undefined) {
    patch.is_active = (body.isActive ?? body.is_active) === true;
  }
  if (body.sortOrder !== undefined || body.sort_order !== undefined) {
    patch.sort_order = asInt(body.sortOrder ?? body.sort_order);
  }
  if (!Object.keys(patch).length) throw fail(422, 'No category fields supplied');
  patch.updated_at = new Date().toISOString();

  const sb = supabaseService();
  const { data, error } = await sb
    .from('photographer_categories')
    .update(patch)
    .eq('id', categoryId)
    .select('*')
    .single();
  if (error) throw fail(422, error.message);
  await writeAdminLog(sb, actor, 'category_update', 'photographer_category', categoryId, { patch });
  ok(res, { category: categoryDto(data) });
}

async function adminDeleteCategory(req, res, categoryId) {
  const actor = await requireAdmin(req);
  assertUuid(categoryId, 'categoryId');
  const sb = supabaseService();
  const { data, error } = await sb
    .from('photographer_categories')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('id', categoryId)
    .select('*')
    .single();
  if (error) throw fail(422, error.message);
  await writeAdminLog(sb, actor, 'category_deactivate', 'photographer_category', categoryId, {});
  ok(res, { category: categoryDto(data) });
}

async function adminListBookings(req, res) {
  await requireAdmin(req);
  const sb = supabaseService();
  const { page, pageSize } = pageParams(req);
  const status = cleanString(param(req, 'status'));
  const fromDate = cleanString(param(req, 'from'));
  const toDate = cleanString(param(req, 'to'));
  const search = adminSearchTerm(req).toLowerCase();

  let query = sb
    .from('bookings')
    .select('*, packages(name, duration_minutes)')
    .order('created_at', { ascending: false })
    .limit(1000);
  if (['pending', 'confirmed', 'cancelled', 'completed'].includes(status)) query = query.eq('status', status);
  if (fromDate) query = query.gte('booking_date', fromDate);
  if (toDate) query = query.lte('booking_date', toDate);

  const { data, error } = await query;
  if (error) throw fail(422, error.message);
  const rows = data || [];
  const profileIds = Array.from(new Set(rows.flatMap((row) => [row.client_id, row.photographer_id]).filter(Boolean)));
  const { data: people } = profileIds.length
    ? await sb.from('profiles').select('id, display_name, email, phone, avatar_url').in('id', profileIds)
    : { data: [] };
  const peopleById = Object.fromEntries((people || []).map((person) => [person.id, person]));
  const enriched = rows.map((row) => ({
    ...row,
    client: peopleById[row.client_id] || null,
    photographer: peopleById[row.photographer_id] || null,
    value: moneyFromCents(row.price_cents)
  })).filter((row) => {
    if (!search) return true;
    const haystack = `${row.client_name} ${row.client_email} ${row.client_phone} ${row.client?.display_name || ''} ${row.photographer?.display_name || ''} ${row.packages?.name || ''}`.toLowerCase();
    return haystack.includes(search);
  });
  const total = enriched.length;
  const start = (page - 1) * pageSize;
  ok(res, { bookings: enriched.slice(start, start + pageSize), page, pageSize, total });
}

async function adminUpdateBookingStatus(req, res, bookingId) {
  const actor = await requireAdmin(req);
  assertUuid(bookingId, 'bookingId');
  const body = await readJson(req);
  const status = cleanString(body.status);
  if (!['pending', 'confirmed', 'cancelled', 'completed'].includes(status)) throw fail(422, 'Invalid booking status');
  const sb = supabaseService();
  const { data, error } = await sb.from('bookings').update({ status }).eq('id', bookingId).select('*').single();
  if (error) throw fail(422, error.message);
  await writeAdminLog(sb, actor, 'booking_status_update', 'booking', bookingId, { status });
  ok(res, { booking: data });
}

async function adminListReports(req, res) {
  await requireAdmin(req);
  const sb = supabaseService();
  const { page, pageSize, from, to } = pageParams(req);
  const status = cleanString(param(req, 'status'));
  let query = sb.from('reports').select('*', { count: 'exact' }).order('created_at', { ascending: false }).range(from, to);
  if (['open', 'reviewing', 'closed'].includes(status)) query = query.eq('status', status);
  const { data, error, count } = await query;
  if (error) throw fail(422, error.message);
  const reports = data || [];
  const conversationIds = Array.from(new Set(reports.map((row) => row.conversation_id).filter(Boolean)));
  const { data: conversations } = conversationIds.length
    ? await sb.from('conversations').select('*').in('id', conversationIds)
    : { data: [] };
  const conversationById = Object.fromEntries((conversations || []).map((conversation) => [conversation.id, conversation]));
  const profileIds = Array.from(new Set(reports.flatMap((row) => {
    const conv = conversationById[row.conversation_id];
    return [row.reporter_id, row.reported_profile_id, conv?.client_id, conv?.photographer_id];
  }).filter(Boolean)));
  const { data: people } = profileIds.length
    ? await sb.from('profiles').select('id, display_name, email, role').in('id', profileIds)
    : { data: [] };
  const peopleById = Object.fromEntries((people || []).map((person) => [person.id, person]));
  ok(res, {
    reports: reports.map((row) => {
      const conv = conversationById[row.conversation_id];
      const derivedReportedId = row.reported_profile_id || (conv && row.reporter_id === conv.client_id ? conv.photographer_id : conv?.client_id);
      return {
        ...row,
        reporter: peopleById[row.reporter_id] || null,
        reported: peopleById[derivedReportedId] || null,
        conversation: conv || null
      };
    }),
    page,
    pageSize,
    total: count || 0
  });
}

async function adminUpdateReport(req, res, reportId) {
  const actor = await requireAdmin(req);
  assertUuid(reportId, 'reportId');
  const body = await readJson(req);
  const status = cleanString(body.status);
  if (!['open', 'reviewing', 'closed'].includes(status)) throw fail(422, 'Invalid report status');
  const sb = supabaseService();
  const { data, error } = await sb.from('reports').update({ status }).eq('id', reportId).select('*').single();
  if (error) throw fail(422, error.message);
  await writeAdminLog(sb, actor, 'report_status_update', 'report', reportId, { status });
  ok(res, { report: data });
}

async function adminListSubscriptions(req, res) {
  await requireAdmin(req);
  const sb = supabaseService();
  const { page, pageSize } = pageParams(req);
  const status = cleanString(param(req, 'status'));
  const search = adminSearchTerm(req).toLowerCase();
  let query = sb.from('subscriptions').select('*').order('created_at', { ascending: false }).limit(1000);
  if (['pending', 'active', 'failed', 'cancelled', 'overdue'].includes(status)) query = query.eq('status', status);
  const { data, error } = await query;
  if (error) throw fail(422, error.message);
  const subscriptions = data || [];
  const photographerIds = Array.from(new Set(subscriptions.map((row) => row.photographer_id).filter(Boolean)));
  const [{ data: people }, { data: photographerProfiles }] = photographerIds.length ? await Promise.all([
    sb.from('profiles').select('id, display_name, email, phone').in('id', photographerIds),
    sb.from('photographer_profiles').select('profile_id, custom_link, subscription_status, subscription_plan, subscription_due_at, is_suspended').in('profile_id', photographerIds)
  ]) : [{ data: [] }, { data: [] }];
  const peopleById = Object.fromEntries((people || []).map((person) => [person.id, person]));
  const photographerProfileById = Object.fromEntries((photographerProfiles || []).map((profile) => [profile.profile_id, profile]));
  const enriched = subscriptions.map((row) => ({
    ...row,
    amount: moneyFromCents(row.amount_cents),
    photographer: peopleById[row.photographer_id] || null,
    photographerProfile: photographerProfileById[row.photographer_id] || null
  })).filter((row) => {
    if (!search) return true;
    const haystack = `${row.photographer?.display_name || ''} ${row.photographer?.email || ''} ${row.merchant_order_id || ''} ${row.provider_order_id || ''}`.toLowerCase();
    return haystack.includes(search);
  });
  const total = enriched.length;
  const start = (page - 1) * pageSize;
  ok(res, { subscriptions: enriched.slice(start, start + pageSize), page, pageSize, total });
}

async function adminUpdateSubscription(req, res, subscriptionId) {
  const actor = await requireAdmin(req);
  assertUuid(subscriptionId, 'subscriptionId');
  const body = await readJson(req);
  const status = cleanString(body.status);
  if (!['pending', 'active', 'failed', 'cancelled', 'overdue'].includes(status)) throw fail(422, 'Invalid subscription status');
  const patch = { status };
  if (body.plan !== undefined || body.planCode !== undefined) patch.plan_code = subscriptionPlanCode(body.plan || body.planCode);
  if (body.currentPeriodEnd !== undefined) patch.current_period_end = body.currentPeriodEnd || null;
  const sb = supabaseService();
  const { data, error } = await sb.from('subscriptions').update(patch).eq('id', subscriptionId).select('*').single();
  if (error) throw fail(422, error.message);
  const photographerStatus = status === 'failed' ? 'overdue' : status;
  const profilePatch = {
    subscription_status: photographerStatus,
    subscription_plan: status === 'active' ? subscriptionPlanCode(data.plan_code) : 'free',
    subscription_due_at: data.current_period_end || null
  };
  if (status === 'active') profilePatch.is_suspended = false;
  if (['pending', 'active', 'overdue', 'cancelled'].includes(photographerStatus)) {
    await sb.from('photographer_profiles').update(profilePatch).eq('profile_id', data.photographer_id);
  }
  await writeAdminLog(sb, actor, 'subscription_status_update', 'subscription', subscriptionId, { status, plan: data.plan_code });
  ok(res, { subscription: data });
}

async function adminAnalytics(req, res) {
  await requireAdmin(req);
  const range = ['daily', 'weekly', 'monthly'].includes(param(req, 'range')) ? param(req, 'range') : 'monthly';
  const sb = supabaseService();
  const [{ data: bookings }, { data: subscriptions }] = await Promise.all([
    sb.from('bookings').select('status, price_cents, created_at'),
    sb.from('subscriptions').select('status, amount_cents, created_at')
  ]);
  const bookingRows = (bookings || []).filter((row) => row.status !== 'cancelled');
  const subscriptionRows = (subscriptions || []).filter((row) => row.status === 'active');
  ok(res, {
    range,
    revenueSeries: buildSeries(bookingRows, range),
    subscriptionSeries: buildSeries(subscriptionRows, range),
    visitSeries: [],
    totals: {
      bookingRevenue: bookingRows.reduce((sum, row) => sum + moneyFromCents(row.price_cents), 0),
      subscriptionRevenue: subscriptionRows.reduce((sum, row) => sum + moneyFromCents(row.amount_cents), 0),
      visits: 0
    }
  });
}

async function adminGetContent(req, res) {
  await requireAdmin(req);
  ok(res, { content: await getPublicCopy() });
}

async function adminSaveContent(req, res) {
  const actor = await requireAdmin(req);
  const body = await readJson(req);
  const content = { ...DEFAULT_PUBLIC_CONTENT, ...(body.content || body || {}) };
  const sb = supabaseService();
  const { data, error } = await sb
    .from('site_content')
    .upsert({ key: 'public_copy', value: content, updated_by: actor.id, updated_at: new Date().toISOString() })
    .select('*')
    .single();
  if (error) throw fail(422, error.message);
  await writeAdminLog(sb, actor, 'site_content_update', 'site_content', 'public_copy', {});
  ok(res, { content: data.value });
}

async function adminGetSettings(req, res) {
  await requireAdmin(req);
  ok(res, { settings: await getPlatformSettings() });
}

async function adminSaveSettings(req, res) {
  const actor = await requireAdmin(req);
  const body = await readJson(req);
  const settings = {
    ...DEFAULT_PLATFORM_SETTINGS,
    ...(body.settings || body || {})
  };
  settings.registrationOpen = settings.registrationOpen !== false;
  settings.maintenanceMode = settings.maintenanceMode === true;
  settings.trialDays = Math.max(0, asInt(settings.trialDays, DEFAULT_PLATFORM_SETTINGS.trialDays));
  settings.maxFreePortfolioPhotos = Math.max(1, asInt(settings.maxFreePortfolioPhotos, DEFAULT_PLATFORM_SETTINGS.maxFreePortfolioPhotos));
  settings.basicPlanPriceEgp = Math.max(1, asInt(settings.basicPlanPriceEgp, DEFAULT_PLATFORM_SETTINGS.basicPlanPriceEgp));
  settings.premiumPlanPriceEgp = Math.max(1, asInt(settings.premiumPlanPriceEgp, DEFAULT_PLATFORM_SETTINGS.premiumPlanPriceEgp));
  settings.subscriptionPriceEgp = settings.basicPlanPriceEgp;

  const sb = supabaseService();
  const { data, error } = await sb
    .from('site_settings')
    .upsert({ key: 'platform', value: settings, updated_by: actor.id, updated_at: new Date().toISOString() })
    .select('*')
    .single();
  if (error) throw fail(422, error.message);
  await writeAdminLog(sb, actor, 'site_settings_update', 'site_settings', 'platform', settings);
  ok(res, { settings: data.value });
}

async function adminListNotifications(req, res) {
  await requireAdmin(req);
  const sb = supabaseService();
  const { page, pageSize, from, to } = pageParams(req, 30);
  const { data, error, count } = await sb
    .from('admin_notifications')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(from, to);
  if (error) throw fail(422, error.message);
  ok(res, { notifications: data || [], page, pageSize, total: count || 0 });
}

async function adminReadNotification(req, res, notificationId) {
  await requireAdmin(req);
  assertUuid(notificationId, 'notificationId');
  const { data, error } = await supabaseService()
    .from('admin_notifications')
    .update({ read_at: new Date().toISOString() })
    .eq('id', notificationId)
    .select('*')
    .single();
  if (error) throw fail(422, error.message);
  ok(res, { notification: data });
}

async function adminReadAllNotifications(req, res) {
  await requireAdmin(req);
  const { error } = await supabaseService()
    .from('admin_notifications')
    .update({ read_at: new Date().toISOString() })
    .is('read_at', null);
  if (error) throw fail(422, error.message);
  ok(res, { saved: true });
}

async function adminListLogs(req, res) {
  await requireAdmin(req);
  const sb = supabaseService();
  const { page, pageSize, from, to } = pageParams(req, 50);
  const { data, error, count } = await sb
    .from('admin_audit_logs')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(from, to);
  if (error) throw fail(422, error.message);
  ok(res, { logs: data || [], page, pageSize, total: count || 0 });
}

async function handle(req, res) {
  const parts = routePath(req);
  const [first, second, third, fourth] = parts;

  if (req.method === 'GET' && first === 'health') return ok(res, { ok: true, app: 'dof-studios-api' });
  if (req.method === 'GET' && first === 'config') return ok(res, {
    supabaseUrl: process.env.SUPABASE_URL || '',
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || ''
  });
  if (req.method === 'GET' && first === 'content') return getPublicContent(req, res);
  if (req.method === 'GET' && first === 'categories') return listCategories(req, res);

  if (req.method === 'POST' && first === 'auth' && second === 'register') return register(req, res);
  if (req.method === 'POST' && first === 'auth' && second === 'login') return login(req, res);
  if (req.method === 'POST' && first === 'auth' && second === 'reset-password') return resetPassword(req, res);
  if (req.method === 'GET' && first === 'me') return getMe(req, res);
  if (req.method === 'PATCH' && first === 'me' && second === 'profile') return updateMe(req, res);
  if (req.method === 'POST' && first === 'me' && second === 'profile' && third === 'media') return uploadProfileMedia(req, res);

  if (req.method === 'GET' && first === 'photographers' && !second) return listPhotographers(req, res);
  if (req.method === 'GET' && first === 'photographers' && second && third === 'available-slots') return getAvailableSlots(req, res, second);
  if (req.method === 'GET' && first === 'photographers' && second) return getPublicPhotographer(req, res, second);

  if (req.method === 'POST' && first === 'uploads' && second === 'sign') return signUpload(req, res);
  if (req.method === 'POST' && first === 'portfolio' && second === 'collections') return createCollection(req, res);
  if (req.method === 'DELETE' && first === 'portfolio' && second === 'collections' && third) return deleteCollection(req, res, third);
  if (req.method === 'POST' && first === 'portfolio' && second === 'photos') return addPortfolioPhoto(req, res);
  if (req.method === 'DELETE' && first === 'portfolio' && second === 'photos' && third) return deletePortfolioPhoto(req, res, third);

  if (req.method === 'GET' && first === 'packages') return listPackages(req, res);
  if (req.method === 'POST' && first === 'packages') return createPackage(req, res);
  if (req.method === 'PATCH' && first === 'packages' && second) return updatePackage(req, res, second);
  if (req.method === 'DELETE' && first === 'packages' && second) return deletePackage(req, res, second);

  if (req.method === 'GET' && first === 'availability' && second === 'working-hours') return getWorkingHours(req, res);
  if (req.method === 'PUT' && first === 'availability' && second === 'working-hours') return setWorkingHours(req, res);
  if (req.method === 'POST' && first === 'availability' && second === 'blocks') return createAvailabilityBlock(req, res);
  if (req.method === 'DELETE' && first === 'availability' && second === 'blocks' && third) return deleteAvailabilityBlock(req, res, third);
  if (req.method === 'POST' && first === 'bookings' && second === 'manual') return createManualBooking(req, res);
  if (req.method === 'POST' && first === 'bookings') return createBooking(req, res);
  if (req.method === 'GET' && first === 'bookings') return listBookings(req, res);
  if (req.method === 'PATCH' && first === 'bookings' && second && third === 'cancel') return cancelBooking(req, res, second);
  if (req.method === 'PATCH' && first === 'bookings' && second && third === 'confirm') return confirmBooking(req, res, second);
  if (req.method === 'PATCH' && first === 'bookings' && second && third === 'complete') return completeBooking(req, res, second);

  if (req.method === 'POST' && first === 'conversations' && second === 'from-booking') return createConversationFromBooking(req, res);
  if (req.method === 'PATCH' && first === 'conversations' && second && third === 'block') return updateConversationState(req, res, second, 'block');
  if (req.method === 'PATCH' && first === 'conversations' && second && third === 'archive') return updateConversationState(req, res, second, 'archive');
  if (req.method === 'GET' && first === 'conversations' && second && third === 'messages') return listMessages(req, res, second);
  if (req.method === 'POST' && first === 'conversations' && second && third === 'messages') return sendMessage(req, res, second);
  if (req.method === 'DELETE' && first === 'conversations' && second && third === 'messages' && fourth) return deleteMessage(req, res, second, fourth);
  if (req.method === 'GET' && first === 'conversations' && !second) return listConversations(req, res);
  if (req.method === 'POST' && first === 'conversations' && !second) return createConversation(req, res);
  if (req.method === 'POST' && first === 'reports') return createReport(req, res);

  if (req.method === 'GET' && first === 'support' && second === 'conversations' && third && fourth === 'messages') return listSupportMessages(req, res, third);
  if (req.method === 'POST' && first === 'support' && second === 'conversations' && third && fourth === 'messages') return sendSupportMessage(req, res, third);
  if (req.method === 'GET' && first === 'support' && second === 'conversations' && !third) return listSupportConversations(req, res);
  if (req.method === 'POST' && first === 'support' && second === 'conversations' && !third) return createSupportConversation(req, res);

  if (req.method === 'POST' && first === 'subscriptions' && second === 'paymob' && third === 'start') return startSubscription(req, res);
  if (req.method === 'GET' && first === 'subscriptions' && second === 'current') return currentSubscription(req, res);
  if (req.method === 'POST' && first === 'webhooks' && second === 'paymob') return paymobWebhook(req, res);

  if (req.method === 'GET' && first === 'admin' && second === 'overview') return adminOverview(req, res);
  if (req.method === 'GET' && first === 'admin' && second === 'users') return adminListUsers(req, res);
  if (req.method === 'GET' && first === 'admin' && second === 'photographers') return adminListPhotographers(req, res);
  if (req.method === 'PATCH' && first === 'admin' && second === 'photographers' && third && fourth === 'moderation') return adminUpdatePhotographerModeration(req, res, third);
  if (req.method === 'GET' && first === 'admin' && second === 'categories') return adminListCategories(req, res);
  if (req.method === 'POST' && first === 'admin' && second === 'categories') return adminCreateCategory(req, res);
  if (req.method === 'PATCH' && first === 'admin' && second === 'categories' && third) return adminUpdateCategory(req, res, third);
  if (req.method === 'DELETE' && first === 'admin' && second === 'categories' && third) return adminDeleteCategory(req, res, third);
  if (req.method === 'GET' && first === 'admin' && second === 'bookings') return adminListBookings(req, res);
  if (req.method === 'PATCH' && first === 'admin' && second === 'bookings' && third && fourth === 'status') return adminUpdateBookingStatus(req, res, third);
  if (req.method === 'GET' && first === 'admin' && second === 'reports') return adminListReports(req, res);
  if (req.method === 'PATCH' && first === 'admin' && second === 'reports' && third) return adminUpdateReport(req, res, third);
  if (req.method === 'GET' && first === 'admin' && second === 'support' && third && fourth === 'messages') return adminListSupportMessages(req, res, third);
  if (req.method === 'POST' && first === 'admin' && second === 'support' && third && fourth === 'messages') return adminSendSupportMessage(req, res, third);
  if (req.method === 'PATCH' && first === 'admin' && second === 'support' && third) return adminUpdateSupportConversation(req, res, third);
  if (req.method === 'GET' && first === 'admin' && second === 'support' && !third) return adminListSupportConversations(req, res);
  if (req.method === 'GET' && first === 'admin' && second === 'subscriptions') return adminListSubscriptions(req, res);
  if (req.method === 'PATCH' && first === 'admin' && second === 'subscriptions' && third) return adminUpdateSubscription(req, res, third);
  if (req.method === 'GET' && first === 'admin' && second === 'analytics') return adminAnalytics(req, res);
  if (req.method === 'GET' && first === 'admin' && second === 'content') return adminGetContent(req, res);
  if (req.method === 'PUT' && first === 'admin' && second === 'content') return adminSaveContent(req, res);
  if (req.method === 'GET' && first === 'admin' && second === 'settings') return adminGetSettings(req, res);
  if (req.method === 'PUT' && first === 'admin' && second === 'settings') return adminSaveSettings(req, res);
  if (req.method === 'GET' && first === 'admin' && second === 'notifications') return adminListNotifications(req, res);
  if (req.method === 'PATCH' && first === 'admin' && second === 'notifications' && third === 'read-all') return adminReadAllNotifications(req, res);
  if (req.method === 'PATCH' && first === 'admin' && second === 'notifications' && third) return adminReadNotification(req, res, third);
  if (req.method === 'GET' && first === 'admin' && second === 'audit-logs') return adminListLogs(req, res);

  if (first) throw fail(404, 'Endpoint not found');
  methodNotAllowed(res);
}

export default async function api(req, res) {
  res.setHeader('Access-Control-Allow-Origin', config.appBaseUrl === '*' ? '*' : config.appBaseUrl);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') return noContent(res);

  try {
    await handle(req, res);
  } catch (error) {
    handleError(res, error);
  }
}
