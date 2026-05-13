# Backend

Vercel serverless API for DOF Studios.

## Contents

- `../api/[...path].js` - Vercel catch-all API route.
- `lib/` - Supabase, auth, validation, booking slot, and Paymob helpers.
- `supabase/migrations/001_initial_schema.sql` - Initial database schema and booking function.
- `docs/setup.md` - Supabase/Vercel setup guide.
- `docs/api.md` - Endpoint reference.

## Local Check

```bash
npm install
npm run check:api
```
