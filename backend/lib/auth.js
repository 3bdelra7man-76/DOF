import { fail } from './http.js';
import { supabaseService } from './supabase.js';

export function bearerToken(req) {
  const header = req.headers.authorization || req.headers.Authorization || '';
  if (!header.startsWith('Bearer ')) return '';
  return header.slice('Bearer '.length).trim();
}

export async function requireUser(req) {
  const token = bearerToken(req);
  if (!token) throw fail(401, 'Authentication required');

  const sb = supabaseService();
  const { data, error } = await sb.auth.getUser(token);
  if (error || !data?.user) throw fail(401, 'Invalid or expired session');

  const { data: profile, error: profileError } = await sb
    .from('profiles')
    .select('*')
    .eq('id', data.user.id)
    .single();

  if (profileError || !profile) throw fail(401, 'Profile not found');
  return { authUser: data.user, profile };
}

export function requireRole(profile, roles) {
  const allowed = Array.isArray(roles) ? roles : [roles];
  if (!allowed.includes(profile.role)) throw fail(403, 'Insufficient permissions');
}
