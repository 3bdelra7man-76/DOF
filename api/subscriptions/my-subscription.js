/**
 * GET /api/subscriptions/my-subscription
 * جلب تفاصيل اشتراك المصور الحالي
 */

import { getPhotographerSubscription } from '../../backend/lib/subscriptions.js';
import { requireRole, requireUser } from '../../backend/lib/auth.js';
import { json, fail } from '../../backend/lib/http.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { profile } = await requireUser(req);
    requireRole(profile, 'photographer');

    const subscription = await getPhotographerSubscription(profile.id);
    return json(res, { success: true, subscription });
  } catch (error) {
    console.error('Failed to fetch subscription:', error);
    return res.status(error.status || 500).json({
      error: error.message || 'Failed to fetch subscription'
    });
  }
}
