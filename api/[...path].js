import { requireRole, requireUser } from '../backend/lib/auth.js';
import { config } from '../backend/lib/config.js';
import { created, fail, handleError, methodNotAllowed, noContent, ok, readJson } from '../backend/lib/http.js';
import { limitsForPlan, planForPhotographer } from '../backend/lib/limits.js';
import { createPaymobSubscriptionIntent, verifyPaymobHmac } from '../backend/lib/paymob.js';
import { addMinutes, generateSlots } from '../backend/lib/slots.js';
import { supabaseAnon, supabaseService } from '../backend/lib/supabase.js';
import { asInt, required } from '../backend/lib/validation.js';

const PORTFOLIO_BUCKET = 'portfolio';
const PACKAGE_BUCKET = 'package-attachments';
const MONTHLY_SUBSCRIPTION_EGP = 200;

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

function cleanString(value) {
  return String(value || '').trim();
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
    required(body, ['specialty', 'region', 'customLink']);
    const { error } = await sb.from('photographer_profiles').insert({
      profile_id: authData.user.id,
      specialty: cleanString(body.specialty),
      region: cleanString(body.region),
      custom_link: cleanString(body.customLink).toLowerCase(),
      bio: cleanString(body.bio),
      subscription_status: 'free',
      is_published: true
    });
    if (error) throw fail(422, error.message);
  }

  created(res, { userId: authData.user.id });
}

async function login(req, res) {
  const body = await readJson(req);
  required(body, ['email', 'password']);
  const { data, error } = await supabaseAnon().auth.signInWithPassword({
    email: cleanString(body.email).toLowerCase(),
    password: body.password
  });
  if (error) throw fail(401, error.message);

  const { data: profile } = await supabaseService()
    .from('profiles')
    .select('*, photographer_profiles(*)')
    .eq('id', data.user.id)
    .single();

  ok(res, { session: data.session, user: data.user, profile });
}

async function getMe(req, res) {
  const { profile } = await requireUser(req);
  const { data } = await supabaseService()
    .from('profiles')
    .select('*, photographer_profiles(*)')
    .eq('id', profile.id)
    .single();
  ok(res, { profile: data });
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
    ['specialty', 'region', 'customLink', 'bio', 'coverUrl', 'socialLinks', 'isPublished'].forEach((key) => {
      if (body[key] !== undefined) {
        const dbKey = { customLink: 'custom_link', coverUrl: 'cover_url', socialLinks: 'social_links', isPublished: 'is_published' }[key] || key;
        photographerPatch[dbKey] = body[key];
      }
    });
    if (Object.keys(photographerPatch).length) {
      const { error } = await sb.from('photographer_profiles').update(photographerPatch).eq('profile_id', profile.id);
      if (error) throw fail(422, error.message);
    }
  }
  ok(res, { saved: true });
}

async function listPhotographers(req, res) {
  const sb = supabaseService();
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
    const matchesSearch = !search || `${row.display_name} ${row.specialty}`.toLowerCase().includes(search);
    const matchesSpecialty = !specialty || String(row.specialty || '').toLowerCase().includes(specialty);
    return matchesSearch && matchesSpecialty;
  });
  ok(res, { photographers: filtered });
}

async function getPublicPhotographer(req, res, customLink) {
  const sb = supabaseService();
  const { data: photographer, error } = await sb
    .from('photographer_directory')
    .select('*')
    .eq('custom_link', customLink)
    .eq('is_published', true)
    .single();
  if (error || !photographer) throw fail(404, 'Photographer not found');

  const [{ data: collections }, { data: packages }] = await Promise.all([
    sb.from('portfolio_collections').select('*, portfolio_photos(*)').eq('photographer_id', photographer.id).order('created_at'),
    sb.from('packages').select('*').eq('photographer_id', photographer.id).eq('status', 'active').order('featured', { ascending: false })
  ]);

  ok(res, { photographer, collections: collections || [], packages: packages || [] });
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

async function addPortfolioPhoto(req, res) {
  const { profile } = await requireUser(req);
  requireRole(profile, 'photographer');
  const body = await readJson(req);
  required(body, ['url']);
  const sb = supabaseService();
  const photographer = await getPhotographerProfile(sb, profile.id);
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
  const { data, error } = await supabaseService()
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
  ok(res, { packages: data || [] });
}

async function createPackage(req, res) {
  const { profile } = await requireUser(req);
  requireRole(profile, 'photographer');
  const body = await readJson(req);
  required(body, ['name', 'price', 'durationMinutes']);
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
  const { data, error } = await supabaseService().from('packages').insert(payload).select('*').single();
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
  await sb.from('working_hours').delete().eq('photographer_id', profile.id);
  const rows = body.workingHours.map((item) => ({
    photographer_id: profile.id,
    day_of_week: asInt(item.dayOfWeek),
    start_time: item.startTime,
    end_time: item.endTime,
    enabled: item.enabled !== false
  }));
  const { data, error } = await sb.from('working_hours').insert(rows).select('*');
  if (error) throw fail(422, error.message);
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

async function createBooking(req, res) {
  const body = await readJson(req);
  required(body, ['photographerId', 'packageId', 'date', 'startTime', 'clientName', 'clientPhone']);
  const tokenUser = await requireUser(req).catch(() => null);
  const sb = supabaseService();
  const { data: pkg, error: pkgError } = await sb
    .from('packages')
    .select('*')
    .eq('id', body.packageId)
    .eq('photographer_id', body.photographerId)
    .eq('status', 'active')
    .single();
  if (pkgError || !pkg) throw fail(404, 'Package not found');

  const endTime = addMinutes(body.startTime, pkg.duration_minutes);

  /* Conflict check: no confirmed/pending booking in the same slot */
  const { data: conflicts } = await sb
    .from('bookings')
    .select('id')
    .eq('photographer_id', body.photographerId)
    .eq('booking_date', body.date)
    .in('status', ['confirmed', 'pending'])
    .lt('start_time', endTime)
    .gt('end_time', body.startTime);
  if (conflicts && conflicts.length > 0) throw fail(409, 'Time slot is no longer available');

  const clientId = tokenUser?.profile?.role === 'client' ? tokenUser.profile.id : null;
  const { data, error } = await sb
    .from('bookings')
    .insert({
      photographer_id: body.photographerId,
      client_id: clientId,
      package_id: body.packageId,
      booking_date: body.date,
      start_time: body.startTime,
      end_time: endTime,
      client_name: cleanString(body.clientName),
      client_email: cleanString(body.clientEmail),
      client_phone: cleanString(body.clientPhone),
      notes: cleanString(body.notes),
      price_cents: pkg.price_cents,
      status: 'pending'
    })
    .select('*, packages(name, duration_minutes)')
    .single();
  if (error) throw fail(422, error.message);
  created(res, { booking: data });
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
  ok(res, { bookings: data || [] });
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

  const { data: booking, error } = await sb
    .from('bookings')
    .update({ status: 'confirmed' })
    .eq('id', id)
    .eq('photographer_id', profile.id)
    .select('*, packages(name, duration_minutes)')
    .single();
  if (error) throw fail(422, error.message);

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
      const msgText = `📅 تم قبول حجزك!\nالخدمة: ${pkgName}\nالتاريخ: ${booking.booking_date}\nالوقت: ${(booking.start_time || '').slice(0, 5)}`;
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
    photographer_name: peopleById[row.photographer_id]?.display_name || 'Photographer',
    photographer_avatar: peopleById[row.photographer_id]?.avatar_url || null
  })) });
}

async function createConversation(req, res) {
  const { profile } = await requireUser(req);
  requireRole(profile, 'client');
  const body = await readJson(req);
  required(body, ['photographerId']);
  const { data, error } = await supabaseService()
    .from('conversations')
    .upsert(
      { client_id: profile.id, photographer_id: body.photographerId },
      { onConflict: 'client_id,photographer_id' }
    )
    .select('*')
    .single();
  if (error) throw fail(422, error.message);
  created(res, { conversation: data });
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
  required(body, ['content']);
  const sb = supabaseService();
  const { data: conversation } = await sb.from('conversations').select('*').eq('id', conversationId).single();
  if (!conversation || ![conversation.client_id, conversation.photographer_id].includes(profile.id)) throw fail(404, 'Conversation not found');
  if (conversation.blocked_by) throw fail(403, 'Conversation is blocked');

  const { data, error } = await sb
    .from('messages')
    .insert({ conversation_id: conversationId, sender_id: profile.id, content: cleanString(body.content) })
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

async function startSubscription(req, res) {
  const { profile } = await requireUser(req);
  requireRole(profile, 'photographer');
  const merchantOrderId = `dof-sub-${profile.id}-${Date.now()}`;
  const intent = await createPaymobSubscriptionIntent({
    amountCents: MONTHLY_SUBSCRIPTION_EGP * 100,
    merchantOrderId,
    customer: { email: profile.email || `${profile.id}@dof.local`, name: profile.display_name, phone: profile.phone }
  });
  await supabaseService().from('subscriptions').insert({
    photographer_id: profile.id,
    provider: 'paymob',
    provider_order_id: String(intent.orderId),
    merchant_order_id: merchantOrderId,
    amount_cents: MONTHLY_SUBSCRIPTION_EGP * 100,
    currency: 'EGP',
    status: 'pending'
  });
  ok(res, intent);
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
    await sb.from('photographer_profiles').update({
      subscription_status: 'active',
      subscription_due_at: due.toISOString(),
      is_suspended: false
    }).eq('profile_id', subscription.photographer_id);
  }
  ok(res, { received: true });
}

async function adminListUsers(req, res) {
  const { profile } = await requireUser(req);
  requireRole(profile, 'admin');
  const { data, error } = await supabaseService().from('profiles').select('*, photographer_profiles(*)').order('created_at', { ascending: false });
  if (error) throw fail(422, error.message);
  ok(res, { users: data || [] });
}

async function adminListReports(req, res) {
  const { profile } = await requireUser(req);
  requireRole(profile, 'admin');
  const { data, error } = await supabaseService().from('reports').select('*').order('created_at', { ascending: false });
  if (error) throw fail(422, error.message);
  ok(res, { reports: data || [] });
}

async function handle(req, res) {
  const parts = routePath(req);
  const [first, second, third, fourth] = parts;

  if (req.method === 'GET' && first === 'health') return ok(res, { ok: true, app: 'dof-studios-api' });

if (req.method === 'POST' && first === 'auth' && second === 'register') return register(req, res);
  if (req.method === 'POST' && first === 'auth' && second === 'login') return login(req, res);
  if (req.method === 'GET' && first === 'me') return getMe(req, res);
  if (req.method === 'PATCH' && first === 'me' && second === 'profile') return updateMe(req, res);

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
  if (req.method === 'POST' && first === 'bookings') return createBooking(req, res);
  if (req.method === 'GET' && first === 'bookings') return listBookings(req, res);
  if (req.method === 'PATCH' && first === 'bookings' && second && third === 'cancel') return cancelBooking(req, res, second);
  if (req.method === 'PATCH' && first === 'bookings' && second && third === 'confirm') return confirmBooking(req, res, second);

  if (req.method === 'GET' && first === 'conversations') return listConversations(req, res);
  if (req.method === 'POST' && first === 'conversations') return createConversation(req, res);
  if (req.method === 'PATCH' && first === 'conversations' && second && third === 'block') return updateConversationState(req, res, second, 'block');
  if (req.method === 'PATCH' && first === 'conversations' && second && third === 'archive') return updateConversationState(req, res, second, 'archive');
  if (req.method === 'GET' && first === 'conversations' && second && third === 'messages') return listMessages(req, res, second);
  if (req.method === 'POST' && first === 'conversations' && second && third === 'messages') return sendMessage(req, res, second);
  if (req.method === 'POST' && first === 'reports') return createReport(req, res);

  if (req.method === 'POST' && first === 'subscriptions' && second === 'paymob' && third === 'start') return startSubscription(req, res);
  if (req.method === 'GET' && first === 'subscriptions' && second === 'current') return currentSubscription(req, res);
  if (req.method === 'POST' && first === 'webhooks' && second === 'paymob') return paymobWebhook(req, res);

  if (req.method === 'GET' && first === 'admin' && second === 'users') return adminListUsers(req, res);
  if (req.method === 'GET' && first === 'admin' && second === 'reports') return adminListReports(req, res);

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
