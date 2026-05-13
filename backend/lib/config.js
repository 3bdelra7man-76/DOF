export function env(name, fallback = '') {
  return process.env[name] || fallback;
}

export function requireEnv(name) {
  const value = env(name);
  if (!value) {
    const error = new Error(`Missing required environment variable: ${name}`);
    error.status = 500;
    throw error;
  }
  return value;
}

export const config = {
  supabaseUrl: env('SUPABASE_URL'),
  supabaseAnonKey: env('SUPABASE_ANON_KEY'),
  supabaseServiceRoleKey: env('SUPABASE_SERVICE_ROLE_KEY'),
  paymobApiKey: env('PAYMOB_API_KEY'),
  paymobIntegrationId: env('PAYMOB_INTEGRATION_ID'),
  paymobIframeId: env('PAYMOB_IFRAME_ID'),
  paymobHmacSecret: env('PAYMOB_HMAC_SECRET'),
  appBaseUrl: env('APP_BASE_URL', 'http://localhost:3000')
};
