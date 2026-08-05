/**
 * POST /api/subscriptions/manual-payment
 * إرسال طلب دفع يدوي
 */

import { submitManualPaymentRequest } from '../../backend/lib/subscriptions.js';
import { requireRole, requireUser } from '../../backend/lib/auth.js';
import { ok, fail, readJson, methodNotAllowed, handleError } from '../../backend/lib/http.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return methodNotAllowed(res);
  }

  try {
    const { profile } = await requireUser(req);
    requireRole(profile, 'photographer');

    const body = await readJson(req);
    const result = await submitManualPaymentRequest(profile.id, body);
    
    return ok(res, { success: true, request: result });
  } catch (error) {
    console.error('Failed to submit payment request:', error);
    return handleError(res, error);
  }
}
