# Backend Setup

## 1. Create Supabase Project

Create a free Supabase project.

In the Supabase dashboard, copy these values from Project Settings:

- API URL -> `SUPABASE_URL`
- anon public key -> `SUPABASE_ANON_KEY`
- service_role key -> `SUPABASE_SERVICE_ROLE_KEY`

Then open SQL Editor and run:

```sql
-- Supabase SQL editor
-- Paste and run backend/supabase/migrations/001_initial_schema.sql
```

The migration creates:

- Auth-linked profile tables
- Photographer marketplace tables
- Portfolio and package tables
- Working hours and instant booking logic
- Chat tables
- Paymob subscription tables
- Storage buckets for portfolio/package files

## 2. Configure Environment

Create `.env.local` in the project root for local testing:

```text
SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
PAYMOB_API_KEY=
PAYMOB_INTEGRATION_ID=
PAYMOB_IFRAME_ID=
PAYMOB_HMAC_SECRET=
APP_BASE_URL=https://your-domain.com
```

For local development, use:

```text
APP_BASE_URL=http://localhost:3000
```

Use the Supabase service role key only in Vercel server-side environment variables. Never expose it in frontend code.

## 3. Local Development

Install dependencies:

```bash
npm install
```

Run locally:

```bash
npx vercel dev
```

Check API syntax:

```bash
npm run check:api
```

Smoke test:

```bash
curl http://localhost:3000/api/health
```

Register a photographer:

```bash
curl -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"role":"photographer","displayName":"Lina Test","email":"lina@test.com","password":"Password123!","phone":"+201000000000","specialty":"Wedding Photography","region":"cairo","customLink":"lina-test"}'
```

Login and copy `session.access_token`:

```bash
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"lina@test.com","password":"Password123!"}'
```

Set working hours:

```bash
curl -X PUT http://localhost:3000/api/availability/working-hours \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
  -d '{"workingHours":[{"dayOfWeek":1,"startTime":"08:00","endTime":"14:00","enabled":true}]}'
```

Create a package:

```bash
curl -X POST http://localhost:3000/api/packages \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
  -d '{"name":"Three Hour Session","description":"Test booking package","price":3000,"durationMinutes":180,"features":["3 hours"],"status":"active"}'
```

## 4. Deploy

Deploy the repo to Vercel. The API entry point is:

```text
api/[...path].js
```

The static frontend remains in the root HTML files. API calls should use `/api/...`.

After deployment, add the same environment variables in Vercel Project Settings. Use your deployed URL for:

```text
APP_BASE_URL=https://your-domain.com
```

## 5. First Admin

Register a normal user, then in Supabase SQL editor run:

```sql
update public.profiles
set role = 'admin'
where email = 'your@email.com';
```

## 6. Free Portfolio Limit

Free photographers can upload:

- 1 portfolio collection
- 10 photos

Premium status comes from Paymob subscription webhook success.

## 7. Paymob Setup

Start with Paymob sandbox/test credentials.

Add these values locally and in Vercel:

```text
PAYMOB_API_KEY=
PAYMOB_INTEGRATION_ID=
PAYMOB_IFRAME_ID=
PAYMOB_HMAC_SECRET=
```

Configure the Paymob transaction/webhook callback URL:

```text
https://your-domain.com/api/webhooks/paymob
```

For local webhook testing, expose Vercel dev with a tunnel such as ngrok and use:

```text
https://your-ngrok-url.ngrok-free.app/api/webhooks/paymob
```

Test flow:

1. Login as photographer.
2. Open the upgrade/subscription modal.
3. Click subscribe.
4. Complete Paymob sandbox checkout.
5. Confirm Supabase `subscriptions.status = active`.
6. Confirm `photographer_profiles.subscription_status = active`.

## 8. Frontend Test Flow

The frontend now calls the backend for auth, packages, working hours, bookings, public directory, portfolio URL entries, chat, and subscriptions.

Recommended test order:

1. Run `npx vercel dev`.
2. Open `http://localhost:3000/homepage.html`.
3. Register a photographer.
4. Go to Calendar and save working hours.
5. Go to Packages and create a package with a duration.
6. Go to Portfolio and add image URLs up to the free limit.
7. Open Explore and view the photographer profile.
8. Select a package/date/time and submit a booking.
9. Login as the photographer and confirm the booking appears in dashboard data.
