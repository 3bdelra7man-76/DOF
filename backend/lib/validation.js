import { fail } from './http.js';

export function required(body, fields) {
  const missing = fields.filter((field) => body[field] === undefined || body[field] === null || body[field] === '');
  if (missing.length) throw fail(422, 'Missing required fields', { missing });
}

export function asInt(value, fallback = 0) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function assertUuid(value, label = 'id') {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''))) {
    throw fail(422, `Invalid ${label}`);
  }
}

export function publicProfileSelect() {
  return `
    id,
    role,
    display_name,
    phone,
    avatar_url,
    photographer_profiles (
      specialty,
      region,
      custom_link,
      bio,
      cover_url,
      cover_position,
      social_links,
      is_published,
      is_suspended,
      subscription_status,
      subscription_plan,
      trial_started_at
    )
  `;
}
