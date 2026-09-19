# Capture module contract

`createCaptureRouter({ getTenantConfig, liveStore, previewStore, secret, notificationFrom, now, rateLimit })`
returns an Express router, mounted by the application at `/api/capture`. Importing this module never
creates a database, starts workers, or sends notifications. Default configuration is disabled. A missing
live store never falls back to memory.

`getTenantConfig(client, { preview, origin, req })` returns `null`/off or:

```js
{ mode: 'preview' /* or 'live' */, name: 'School',
  services: [{id: 'class-b', label: 'Klasse B'}],
  allowedOrigins: ['https://example.no'],
  recipient: 'office@example.no', privacyUrl: 'https://example.no/privacy' }
```

Live requires a durable store, a signing secret of at least 32 characters, a server-configured
`notificationFrom` bare email address, a valid single recipient, and an HTTPS privacy URL. Root must
add deployment readiness checks (database migrated, provider configured, tenant explicitly enabled).
`router.getPublicConfig(client, {preview})` returns the same sanitized enabled/mode/name/services/privacy
configuration as the GET endpoint; it never exposes email destinations or signing secrets.

Endpoints:

- `GET /config/:client?preview=1`: sanitized public configuration. Omit preview for live.
- `POST /session`: `{client, preview: true}` for explicit preview; omit/false for live. Origin must
  exactly match the tenant allowlist. Returns `{token,expiresAt,mode}` with a 15-minute signed session.
- `POST /requests`: `{client,token,submissionId,name,email?,phone?,service,preferredTime?,consent:true,website:''}`.
  UUID submissionId must be reused for a retry of the same submission. Unknown properties, including
  destinations, transcripts, arbitrary source URLs and a preview override, are rejected. Mode comes
  from the signed session. Name max100, email254, phone30 (6–15 digits), preferredTime120 characters.
  At least one contact method is required. Services must match the configured service IDs.
- New201 / exact retry200: `{receipt,mode,status,message}`. Preview status is `preview_saved` and states
  that nothing was sent. Live status `received` means durably saved, not provider acceptance or delivery.
- Errors: 400 invalid fields/request; 403 invalid/expired session or origin; 409 reused ID with changed
  data; 429 rate limit; 503 disabled/unconfigured/unavailable storage. Responses never include PII.

Preview store is bounded ephemeral memory, 24-hour TTL, max1,000 rows by default. It rejects notification
payloads. No owner inbox is publicly exposed. Production requests and contact details never go to logs
or analytics from this module. Request IP is HMAC-hashed for rate limiting and is never stored verbatim.
Rate limiting defaults to 20 session issuances and 5 submission attempts per minute per tenant/IP.
Production uses shared atomic database counters. Reverse proxy trust must be configured correctly by
the application. Prune inactive rate-limit rows during maintenance; deployment operators must define
and implement the business's retention/deletion policy before a real pilot.

`PgStore({pool})` accepts a `pg.Pool`. It may alternatively create its own pool with
`{connectionString,ssl,max}`. `initialize()` explicitly applies `schema.sql`; it is never called on
module load. Tables are `nova_capture_requests`, `nova_capture_outbox`, `nova_capture_rate_limits`.
`create()` transactionally saves both request and frozen notification. Unique `(client,submission_id)`
plus a canonical data hash prevents duplicate enquiries or changed retries. No delivery call occurs
inside a transaction or request handler.

`createResendNotifier({apiKey,fetchFn?,timeoutMs?})` produces the delivery adapter. The endpoint is fixed
to `https://api.resend.com/emails`, redirects are forbidden, and each request uses the same stored message
and `nova-capture/<receipt>` idempotency key. The adapter receives only server-created notification
objects; never call it with a public request body.

Call `flushNotifications({store,sendNotification,isTenantEnabled,now?,limit?})` explicitly from a
controlled worker. `isTenantEnabled(client,notification)` is required and should verify current tenant
approval, global kill switch and that the frozen recipient/from still match current configuration.
Disabled/revoked items stop in `needs_review`. Database claims use `FOR UPDATE SKIP LOCKED`, 60-second
leases and a claim token, preventing simultaneous workers from updating each other's claims. Provider
idempotency also protects a lost response or process crash after sending. Provider acceptance is stored
as `accepted`, never `delivered`. No delivery webhook or actual booking claim is implemented.

Automatic retry uses exponential backoff and stops before 23 hours from the first attempt, because
[Resend retains idempotency keys for 24 hours](https://resend.com/docs/dashboard/emails/idempotency-keys).
Expired or uncertain items require human provider reconciliation; do not reset their timestamps, create
new request IDs or generate new provider keys as a retry. A provider acceptance followed by a database
failure leaves the claim intact for the same safe retry. Unexpected errors never log provider bodies.

Tests inject a fake email adapter and use local PGlite for actual schema/transaction/claim behavior.
No email or external database connection is used by `scripts/test-capture.js`.
