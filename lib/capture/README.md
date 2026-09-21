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

## Restricted business-outcome operations

`node scripts/capture-operations.js` is an operator-only database tool, with no
public route and no sending capability. Use the dedicated database environment;
reapply the explicit schema migration to add the outcome tables before using it.

```sh
# Counts only, scoped to one business. Dates select the request-created cohort.
node scripts/capture-operations.js report --client tiller --since 2026-09-01 --before 2026-10-01

# Preview an actual, independently verified outcome before recording it.
node scripts/capture-operations.js outcome --client tiller --receipt UUID --status qualified
node scripts/capture-operations.js outcome --client tiller --receipt UUID --status qualified --apply

# Preview the agreed retention cutoff. No retention duration is assumed.
node scripts/capture-operations.js delete --client tiller --before 2026-01-01
node scripts/capture-operations.js delete --client tiller --before 2026-01-01 --limit 100 --apply
```

Replace `UUID` with the existing receipt for the same business. Outcomes are
`new`, `contacted`, `qualified`, `won` and `lost`. They never change email-dispatch
status. Current outcomes and distinct explicitly recorded historical outcomes
are counted separately; historical counts may overlap. Recording a win does not
invent a prior contact or qualification. Provider acceptance does not imply a
delivered email, confirmed booking, paying customer or business outcome.

Mutation commands are dry runs unless `--apply` is present. Deletion requires an
exact client and either an explicit cutoff or receipt, and removes at most 100
requests by default (maximum 1,000). It locks eligible request/outbox rows before
cascading deletion of stored contacts, frozen notification data and outcome
history. A tombstone containing only the client, opaque submission ID and deletion
time prevents delayed retries from recreating a deleted enquiry or email. The
store checks it after the insert/unique-key conflict wait, within the same
transaction, to cover a simultaneous delete. An old pending or uncertain email is never made safe to delete merely
by its age. Pending, sending, needs-review, missing-outbox, unknown failure and
payload-conflict records remain protected. Only provider-accepted items with a
stored provider ID, or a fixed set of definite permanent provider rejections,
are eligible. There is no force flag and no automatic retry or rerouting.

Deletion does not erase copies already held by the email provider or business
mailbox; their agreed process must cover those copies. Reports exclude deleted
enquiries, so they are operational views rather than permanent historical totals.
Contact details, notification text and provider credentials are absent from CLI
output. `scripts/test-capture-operations.js` verifies tenant boundaries, truthful
counts, dry-run behavior and protected dispatch states using local synthetic data.

New notifications set `reply_to` to the validated visitor email when supplied,
so the business can reply directly; phone-only enquiries omit it. The verified
sender and approved recipient remain server-configured. Existing queued payloads
and idempotency keys are unchanged. See the [Resend send-email API](https://resend.com/docs/api-reference/emails/send-email).
