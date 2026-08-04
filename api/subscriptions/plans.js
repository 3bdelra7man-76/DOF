/**
 * GET /api/subscriptions/plans
 * جلب كل الباقات المتاحة
 */

import { getAvailablePlans } from '../../backend/lib/subscriptions.js';
import { json } from '../../backend/lib/http.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const plans = await getAvailablePlans();
    return json(res, { success: true, plans });
  } catch (error) {
    console.error('Failed to fetch plans:', error);
    return res.status(error.status || 500).json({
      error: error.message || 'Failed to fetch plans'
    });
  }
}
