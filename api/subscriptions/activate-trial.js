/**
 * POST /api/subscriptions/activate-trial
 * تفعيل التجربة المجانية للمصور
 */

import { activateFreeTrial } from '../../backend/lib/subscriptions.js';
import { requireRole, requireUser } from '../../backend/lib/auth.js';
import { json, fail } from '../../backend/lib/http.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { profile } = await requireUser(req);
    requireRole(profile, 'photographer');

    const result = await activateFreeTrial(profile.id);
    return json(res, { success: true, subscription: result });
  } catch (error) {
    console.error('Failed to activate trial:', error);
    return res.status(error.status || 500).json({
      error: error.message || 'Failed to activate trial'
    });
  }
}
