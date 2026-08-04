/**
 * POST /api/subscriptions/manual-payment
 * إرسال طلب دفع يدوي
 */

import { submitManualPaymentRequest } from '../../backend/lib/subscriptions.js';
import { requireRole, requireUser } from '../../backend/lib/auth.js';
import { json, fail, readJson } from '../../backend/lib/http.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { profile } = await requireUser(req);
    requireRole(profile, 'photographer');

    const body = await readJson(req);
    const result = await submitManualPaymentRequest(profile.id, body);
    
    return json(res, { success: true, request: result });
  } catch (error) {
    console.error('Failed to submit payment request:', error);
    return res.status(error.status || 500).json({
      error: error.message || 'Failed to submit payment request'
    });
  }
}
