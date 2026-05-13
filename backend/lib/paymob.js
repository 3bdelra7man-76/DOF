import crypto from 'node:crypto';
import { config } from './config.js';
import { fail } from './http.js';

const PAYMOB_BASE_URL = 'https://accept.paymob.com/api';

async function paymobFetch(path, payload) {
  if (!config.paymobApiKey) throw fail(500, 'Paymob is not configured');
  const response = await fetch(`${PAYMOB_BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw fail(502, 'Paymob request failed', data);
  return data;
}

export async function createPaymobSubscriptionIntent({ amountCents, merchantOrderId, customer }) {
  const auth = await paymobFetch('/auth/tokens', { api_key: config.paymobApiKey });
  const order = await paymobFetch('/ecommerce/orders', {
    auth_token: auth.token,
    delivery_needed: false,
    amount_cents: amountCents,
    currency: 'EGP',
    merchant_order_id: merchantOrderId,
    items: []
  });
  const paymentKey = await paymobFetch('/acceptance/payment_keys', {
    auth_token: auth.token,
    amount_cents: amountCents,
    expiration: 3600,
    order_id: order.id,
    billing_data: {
      apartment: 'NA',
      email: customer.email,
      floor: 'NA',
      first_name: customer.firstName || customer.name || 'DOF',
      street: 'NA',
      building: 'NA',
      phone_number: customer.phone || '+200000000000',
      shipping_method: 'NA',
      postal_code: 'NA',
      city: 'Cairo',
      country: 'EG',
      last_name: customer.lastName || 'Studios',
      state: 'Cairo'
    },
    currency: 'EGP',
    integration_id: Number(config.paymobIntegrationId)
  });

  return {
    orderId: order.id,
    merchantOrderId,
    paymentToken: paymentKey.token,
    iframeUrl: `https://accept.paymob.com/api/acceptance/iframes/${config.paymobIframeId}?payment_token=${paymentKey.token}`
  };
}

export function verifyPaymobHmac(query) {
  if (!config.paymobHmacSecret) return false;
  const keys = [
    'amount_cents',
    'created_at',
    'currency',
    'error_occured',
    'has_parent_transaction',
    'id',
    'integration_id',
    'is_3d_secure',
    'is_auth',
    'is_capture',
    'is_refunded',
    'is_standalone_payment',
    'is_voided',
    'order',
    'owner',
    'pending',
    'source_data_pan',
    'source_data_sub_type',
    'source_data_type',
    'success'
  ];
  const raw = keys.map((key) => query[key] ?? '').join('');
  const expected = crypto.createHmac('sha512', config.paymobHmacSecret).update(raw).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(query.hmac || '')));
}
