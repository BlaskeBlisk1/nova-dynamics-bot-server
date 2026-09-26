# Customer enquiry upgrade, first implementation

Current setup, 22 September 2026: the private production PostgreSQL database and
its schema, scoped Resend/Airtable credentials, and capture signing secret are
installed. Customer-demo capture remains off pending pilot-specific routing and
delivery verification. Jemlio's own website uses a separate
[signed notification receiver](website-delivery.md); its intake, CRM copying and
owner email alerts are active after the approved production test. This does not
enable any school or optician capture form.

This release adds a path from a visitor's question to a reviewed contact request.
Contact collection defaults off. The first production configuration enables
conversation context only for Tiller and Frank Olsen; every existing `/demos/:client`
link continues to answer questions without displaying contact collection.

## What is implemented

- Short-lived conversation context carries an explicitly named course or service
  into a follow-up question. Tenant and origin boundaries, expiry and a reset
  control prevent context leaking between conversations. Only bounded course,
  service and intent values are stored; this is not transcript memory.
- An optional Norwegian contact form offers service selection, name, email or
  phone, preferred callback time and affirmative contact consent. Visitors review
  details before submitting. They can also keep asking questions without using it.
- Durable PostgreSQL enquiry and notification-outbox records are written in one
  transaction. One submission ID yields one receipt; retries cannot change its
  data. The form keeps that ID while delivery of the HTTP response is uncertain.
- Server configuration determines the business recipient. No public request may
  choose recipients, attach files, supply a transcript or change tenant routing.
- Resend notifications use an immutable provider idempotency key, bounded retries,
  database worker leases and a current-recipient check before dispatch. A receipt
  means saved, and provider acceptance means accepted; neither means delivered,
  a confirmed booking, or a sale.
- Operator commands record contacted, qualified, won or lost outcomes by tenant
  and receipt. Aggregate reports separate recorded outcomes from notification
  acceptance. Scoped deletion defaults to a dry run, protects uncertain dispatch,
  and retains opaque submission tombstones so old retries cannot recreate mail.
- Form contact details stay out of PostHog, application logs and browser storage.
  Preview, owner/test query flags and localhost suppress the demo's analytics.

This slice does not include an owner dashboard, delivery/bounce webhook handling,
calendar booking, SMS, automatic follow-up, new website crawling, or a self-service
onboarding portal. The contact flow has operator-recorded outcome reports, but no public conversion
dashboard. Optional Airtable copying requires an explicitly approved destination
per business; see `lib/capture/README.md`. No business inherits Jemlio's website
CRM destination automatically.

## Local review

### Guided follow-up questions, 22 September 2026

Tiller and Frank Olsen now offer up to three **Spør videre** buttons after a
supported answer. The choices ask about the selected service's price, contents
or booking process. Frank Olsen's glasses and repair answers offer a contact
question; they never inherit the routine eye-exam price. Contact-lens choices
offer fitting information and booking guidance, not an unpublished price.

The server constructs complete questions from bounded service/class enums and
omits the intent just answered. Clicking a button uses the existing chat route;
it does not book an appointment, submit a lead or send a message. A complete
question still identifies its service if the conversation has expired.
Unsupported answers, ambiguity, privacy/personal-data questions, and sensitive
qualifiers offer no choices. Old buttons disappear when a new request starts,
on reset, or after a superseded response. Labels render as text, keyboard focus
is visible, and touch targets are at least 44 pixels high.

The optional `followup_question_clicked` event contains only an allowlisted
intent ID. Generated question text, conversation IDs and service names are not
added to analytics. Owner/test/preview analytics suppression remains in force.
Existing conversation switches limit this release to Tiller and Frank Olsen;
no capture, recipient, CRM, preview or deployment environment setting changes.

Verification includes every offered question through the real HTTP handlers,
expiry and superseded-turn checks, DOM click/reset/late-response checks, plain
text rendering, and the full existing regression suite. Live visual checks are
recorded in the release handover after deployment.

### Answer-quality update, 22 September 2026

The Tiller conversation resolver now retains the selected Standardpakke or
Superpakke and the numbered trinnvurdering. Bounded follow-ups about price,
contents, duration and booking reuse that selection. Comparisons remain
ambiguous; unknown answers, reset and expiry clear it. Only enum values remain
in memory, with the same tenant/origin boundaries and feature switches.

The direct Tiller handler distinguishes Norwegian `be om` from licence BE and
does not assign an ordinary lesson price to a requested 60/90-minute lesson or
double lesson. Frank Olsen keeps a repair follow-up separate from glasses and
asks for business confirmation for unverified attestation/førerkort exams and
durations. Optician clarification text no longer asks for a driving licence.
The normal booking answers still point to the businesses' existing websites.

Source review: [Tiller's published prices](https://tillertrafikkskole.no/priser)
and [Frank Olsen's services](https://www.frankolsen.no/tjenester), checked
22 September 2026. These changes reuse the existing published prices; they do
not verify appointment availability or an additional attestation service.
Focused HTTP and context tests cover complete multi-turn sequences, ambiguous
selection, ordinary-versus-specific requests, reset/expiry, and unknown-answer
invalidation. The legacy answer suites also exercise the handlers with context
disabled. This release changes no intake, delivery or pilot activation settings.

Use Node 24.15+ within the Node 24 release line for the development test dependencies
(this release was tested on Node 24.19). jsdom also supports Node 22.22.2+ within
the Node 22 release line and Node 26+.

```sh
npm ci
npm test
npm run preview:upgrade
```

Open `http://localhost:8788/previews/tiller` or
`http://localhost:8788/previews/frankolsen`. Use invented details only. Preview
records live in bounded process memory and disappear on restart; no email is sent.
The preview command clears database/provider settings and binds only to localhost.
RoMa is deliberately absent from the capture preview list.

The suite includes existing client regression tests, focused context behavior,
actual PostgreSQL-compatible schema/transaction/outbox tests in local PGlite,
HTTP feature and origin checks, and jsdom tests executing the real demo/RoMa HTML
and scripts. All notification and analytics calls in the new tests are mocked.
DOM tests are not visual browser verification or proof of production delivery.

## Configuration

| Variable | Purpose |
|---|---|
| `NOVA_PREVIEW_ENABLED` | Enable separate synthetic `/previews/:client` pages. Defaults false. |
| `NOVA_PREVIEW_ORIGINS` | Exact comma-separated origins allowed for preview chat and forms. |
| `NOVA_CONVERSATION_CLIENTS` | Explicit comma-separated live client slugs for conversation context. Empty by default. |
| `NOVA_CAPTURE_ENABLED` | Global contact-collection switch. Defaults false. |
| `NOVA_CAPTURE_WORKER_ENABLED` | Enable the in-process notification worker when running `node index.js`. Defaults false. |
| `NOVA_CAPTURE_CONFIG` | Per-client JSON below. No recipients appear in public demo config. |
| `NOVA_DATABASE_URL` | Dedicated durable PostgreSQL connection URL. Use the intended managed database and its required TLS configuration. |
| `NOVA_CAPTURE_SECRET` | Random signing secret, at least 32 characters. Store as a deployment secret. |
| `NOVA_CAPTURE_FROM` | Bare email address on a verified sending domain. |
| `RESEND_API_KEY` | Restricted production sending credential, stored as a deployment secret. |

Example structure only, with non-deliverable example destinations:

```json
{
  "tiller": {
    "enabled": true,
    "mode": "live",
    "recipient": "office@example.com",
    "privacyUrl": "https://example.com/privacy",
    "allowedOrigins": ["https://example.com"],
    "services": [
      {"id": "b-auto", "label": "Klasse B automat"},
      {"id": "grunnkurs", "label": "Trafikalt grunnkurs"}
    ]
  }
}
```

Use exact real origins and services agreed with the pilot business. The JSON
example is not ready to enable. Configuration is loaded at process startup;
changes require a restart/deployment. Public features remain disabled if the
database schema, signing secret, tenant settings or sender settings are missing.
Database presence is a readiness check; it does not prove sender verification or
email delivery. Secrets are not read from `.env` automatically by these scripts.

## First pilot activation

1. Set up a durable PostgreSQL database. Render's ordinary service filesystem is
   not enquiry storage. Configure backups, access and the business's retention
   and deletion process, including the notification copy and downstream email.
2. Set the database secret in the intended environment, then explicitly run
   `npm run capture:migrate -- --apply`. This applies the idempotent schema in a
   transaction and does not enable the feature or send mail.
3. Verify the sender domain and mailbox routing. Use one agreed pilot business,
   its contact recipient, a real privacy page, exact permitted origins and its
   genuine service list. Confirm the application's existing one-hop proxy trust
   setting matches the deployment so rate limits use the intended client IP.
4. Complete visual/mobile review of the synthetic preview. Then test durable
   storage and actual notification delivery in an isolated staging environment
   using an operator-owned recipient and synthetic details. Verify a retry, restart,
   storage outage and disabled-recipient behavior. Do not test by emailing a lead.
5. Enable only that business. Monitor `npm run capture:status`, response time and
   the provider dashboard. A nonempty `needs_review` or `failed` queue requires
   operator attention. Establish monitoring and a recovery owner before accepting
   real enquiries; a console warning alone is not an alerting system.

The database and sending credential were provisioned after this implementation;
see the current checkpoint above. Real in-chat collection and its worker remain
off pending the delivery test and agreed pilot routing; public synthetic preview
routes also remain off. A connected Google Workspace mailbox does not itself
supply a Resend API credential.
Jemlio's own marketing form uses Netlify Forms independently, with an email fallback.

The release configuration is `NOVA_CONVERSATION_CLIENTS=tiller,frankolsen`,
`NOVA_CAPTURE_ENABLED=false`, `NOVA_CAPTURE_WORKER_ENABLED=false`, and
`NOVA_PREVIEW_ENABLED=false`. The seven existing demo URLs and internal
Nova identifiers remain stable. Shared chat controls have bounded timeouts and
reset protection; personal medical details cannot seed routine price followups.

See `lib/capture/README.md` for the outcome/report/delete operator commands.
Synthetic local PGlite tests verify schema and retry behavior. The PostgreSQL CI
job also tests actual concurrent inserts, claims, worker separation and deletion
races using a disposable database; it does not send real notifications.

## Rollback and reconciliation

Set `NOVA_CAPTURE_ENABLED=false` and `NOVA_CAPTURE_WORKER_ENABLED=false`, remove
the pilot from `NOVA_CONVERSATION_CLIENTS`, and restart. This removes the form,
stops dispatch, and restores the old answer path; saved records remain in the
database. Do not drop tables to roll back a UI release.

`capture:status` prints tenant-level queue counts and age only, never contact
details or credentials. Inspect specific records only through restricted operator
access. Removing or changing a tenant destination stops its queued mail in
`needs_review`; it never silently reroutes an existing enquiry.

For an uncertain provider result, reconcile its existing request receipt and
provider idempotency key. Never create a replacement request, regenerate the key,
or reset the first-attempt timestamp as a retry. Automatic retries stop before 23
hours because Resend retains keys for 24 hours. Delivered status and bounce handling
require a separate future webhook integration.

Source references: [Resend idempotency](https://resend.com/docs/dashboard/emails/idempotency-keys),
[node-postgres transactions](https://node-postgres.com/features/transactions),
[Render storage](https://render.com/docs/disks).
