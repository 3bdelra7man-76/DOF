/**
 * Admin API for Manual Payment Requests
 * GET /api/admin/manual-payments - جلب كل طلبات الدفع
 * PATCH /api/admin/manual-payments/:id/review - مراجعة طلب (قبول/رفض)
 * DELETE /api/admin/manual-payments/:id - حذف طلب
 */

import { 
  getAllManualPaymentRequests, 
  reviewManualPayment, 
  deleteManualPaymentRequest 
} from '../../backend/lib/subscriptions.js';
import { requireRole, requireUser } from '../../backend/lib/auth.js';
import { json, fail, readJson } from '../../backend/lib/http.js';

export default async function handler(req, res) {
  try {
    const { profile } = await requireUser(req);
    requireRole(profile, 'admin');

    const method = req.method;
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathParts = url.pathname.split('/').filter(Boolean);
    
    // GET /api/admin/manual-payments
    if (method === 'GET' && pathParts.length === 3) {
      const status = url.searchParams.get('status');
      const planCode = url.searchParams.get('planCode');
      const page = url.searchParams.get('page');
      const pageSize = url.searchParams.get('pageSize') || url.searchParams.get('limit');
      
      const filters = {};
      if (status) filters.status = status;
      if (planCode) filters.planCode = planCode;
      if (page) filters.page = page;
      if (pageSize) filters.pageSize = pageSize;
      
      const result = await getAllManualPaymentRequests(filters);
      return json(res, { success: true, ...result });
    }

    // PATCH /api/admin/manual-payments/:id/review
    if (method === 'PATCH' && pathParts.length === 5 && pathParts[4] === 'review') {
      const requestId = pathParts[3];
      const body = await readJson(req);
      
      if (!body.action || !['approve', 'reject'].includes(body.action)) {
        throw fail(400, 'Invalid action. Use "approve" or "reject"');
      }

      const result = await reviewManualPayment(
        requestId,
        profile.id,
        body.action,
        body.rejectionReason
      );
      
      return json(res, { success: true, ...result });
    }

    // DELETE /api/admin/manual-payments/:id
    if (method === 'DELETE' && pathParts.length === 4) {
      const requestId = pathParts[3];
      await deleteManualPaymentRequest(requestId);
      return json(res, { success: true, message: 'Payment request deleted' });
    }

    throw fail(404, 'Endpoint not found');

  } catch (error) {
    console.error('Admin manual payments error:', error);
    return res.status(error.status || 500).json({
      error: error.message || 'Internal server error'
    });
  }
}
