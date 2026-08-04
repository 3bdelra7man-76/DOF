# DOF Studios API

Base URL:

- Local: `http://localhost:3000/api`
- Vercel: `https://your-domain.vercel.app/api`

Authenticated routes require:

```http
Authorization: Bearer <supabase_access_token>
```

## Auth

- `POST /api/auth/register`
  - Body: `email`, `password`, `role`, `displayName`, `phone`
  - Photographer body also needs: `specialty`, `region`, `customLink`
- `POST /api/auth/login`
  - Body: `email`, `password`
  - Returns Supabase `session`, `user`, and app `profile`.
- `GET /api/me`
- `PATCH /api/me/profile`

## Marketplace

- `GET /api/photographers?region=&specialty=&search=`
- `GET /api/photographers/:customLink`
- `GET /api/photographers/:id/available-slots?date=YYYY-MM-DD&packageId=<uuid>`

## Portfolio And Packages

- `POST /api/uploads/sign`
  - Body: `kind` as `portfolio`, `package`, or `receipt`, plus `filename`.
- `POST /api/portfolio/photos`
  - Body: `url`, optional `storagePath`, `title`, `collectionId`.
  - Free photographers are limited to 6 photos.
- `DELETE /api/portfolio/photos/:id`
- `GET /api/packages`
- `POST /api/packages`
- `PATCH /api/packages/:id`
- `DELETE /api/packages/:id`

## Availability And Bookings

- `PUT /api/availability/working-hours`
  - Body: `{ "workingHours": [{ "dayOfWeek": 1, "startTime": "08:00", "endTime": "14:00", "enabled": true }] }`
- `GET /api/availability/working-hours`
- `POST /api/availability/blocks`
  - Body: `date`, `startTime`, `endTime`, optional `reason`
- `DELETE /api/availability/blocks/:id`
- `POST /api/bookings`
  - Body: `photographerId`, `packageId`, `date`, `startTime`, `clientName`, `clientPhone`
  - Optional: `clientEmail`, `notes`
- `GET /api/bookings`
- `PATCH /api/bookings/:id/cancel`

## Chat

- `GET /api/conversations`
- `POST /api/conversations`
  - Body: `photographerId`
- `PATCH /api/conversations/:id/block`
- `PATCH /api/conversations/:id/archive`
- `GET /api/conversations/:id/messages`
- `POST /api/conversations/:id/messages`
- `POST /api/reports`
  - Body: `reason`, optional `conversationId`, optional `reportedProfileId`

V1 chat is stored-message polling. The frontend should poll conversation messages every 5-10 seconds.

## Subscriptions

- `POST /api/subscriptions/paymob/start`
- `GET /api/subscriptions/current`
- `POST /api/webhooks/paymob`
- `POST /api/subscriptions/manual-payment`
  - Photographer only.
  - Body: `planCode`, `paymentMethod`, `senderName`, `transactionRef`, `receiptUrl`, `receiptPath`.
  - Activates Basic/Premium immediately and leaves the payment proof pending for admin review.

Paymob webhook success activates premium for one month and updates the photographer profile.

## Admin

- `GET /api/content`
  - Public content/settings used by the frontend.
- `GET /api/admin/overview`
- `GET /api/admin/users`
- `GET /api/admin/photographers`
- `PATCH /api/admin/photographers/:id/moderation`
  - Body: optional `isSuspended`, optional `isPublished`, optional `reason`.
- `GET /api/admin/bookings`
- `PATCH /api/admin/bookings/:id/status`
  - Body: `status` as `pending`, `confirmed`, `cancelled`, or `completed`.
- `GET /api/admin/reports`
- `PATCH /api/admin/reports/:id`
  - Body: `status` as `open`, `reviewing`, or `closed`.
- `GET /api/admin/subscriptions`
- `PATCH /api/admin/subscriptions/:id`
  - Body: `status`, optional `currentPeriodEnd`.
- `GET /api/admin/manual-payments`
- `PATCH /api/admin/manual-payments/:id/review`
  - Body: `action` as `approve` or `reject`, optional `rejectionReason`.
- `POST /api/admin/photographers/:id/cancel-subscription`
  - Body: optional `reason`, optional `suspendAccount`.
- `GET /api/admin/analytics?range=daily|weekly|monthly`
- `GET /api/admin/content`
- `PUT /api/admin/content`
- `GET /api/admin/settings`
- `PUT /api/admin/settings`
- `GET /api/admin/notifications`
- `PATCH /api/admin/notifications/:id`
- `PATCH /api/admin/notifications/read-all`
- `GET /api/admin/audit-logs`

Admin users are regular `profiles` rows with `role = 'admin'`.
