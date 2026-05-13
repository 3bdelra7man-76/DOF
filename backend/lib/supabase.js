import { createClient } from '@supabase/supabase-js';
import { requireEnv } from './config.js';

let serviceClient;
let anonClient;

export function supabaseService() {
  if (!serviceClient) {
    serviceClient = createClient(
      requireEnv('SUPABASE_URL'),
      requireEnv('SUPABASE_SERVICE_ROLE_KEY'),
      { auth: { persistSession: false } }
    );
  }
  return serviceClient;
}

export function supabaseAnon() {
  if (!anonClient) {
    anonClient = createClient(
      requireEnv('SUPABASE_URL'),
      requireEnv('SUPABASE_ANON_KEY'),
      { auth: { persistSession: false } }
    );
  }
  return anonClient;
}
