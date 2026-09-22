# Jemlio enquiry release status

Historical checkpoint: 2026-09-21. See the current note below before following the older activation gates.

## Current checkpoint — 22 September 2026

The public native Netlify form is registered and a synthetic submission was saved
and read back. A permanent private PostgreSQL 18 database in Frankfurt is wired to
production and its seven enquiry tables are migrated. Scoped Resend and Airtable
credentials and a capture signing key are installed. The deployed server passed a
real synthetic Airtable write/retry/removal check and a non-sending Resend
authentication check. Actual backend inbox delivery is still a separate test.

The new [signed website handoff](website-delivery.md) reuses this durable storage
and provider queues. Its Netlify notification, public processing notice and
controlled end-to-end delivery check must be verified before activation. The old
Airtable webhook draft stays off; it is not needed by the new direct upsert path.
Customer-demo capture still requires its own approved pilot routing and handling.

The remainder records the earlier staging-only workflow and is not the current
production setup or a requirement to enable the superseded Airtable automation.

## Verified this session

- The separate `jemlio-integration-staging` service delivered one synthetic Airtable webhook example. No customer details or emails were used.
- Airtable reported `webhookSchemaIsSet: true` for `Jemlio inbound enquiry webhook`.
- The replacement automation draft passed configuration validation. It maps the captured fields into `Inbound Enquiries`, requires explicit consent and `setupOnly: false`, limits its source to `Jemlio website`, and skips receipts already found in that table.
- The staging setup switch was turned off and its webhook URL and expiry were cleared after capture. Auto-deploy on that service is off.

## What is still not live

The Airtable automation remains OFF. Its tool supports editing the draft, not publishing it; the owner must review and enable it in Airtable. Configuration validation is not a successful action execution.

The public Netlify website remains on its separately published release until its deploy ID is verified. Merging the backend does not publish the Netlify site. The repository's `/enquiry` form must not be promoted as a working durable intake while its destination is unverified.

The marketing gateway requires both `JEMLIO_ENQUIRY_ENABLED=true` and a valid server-side `JEMLIO_ENQUIRY_WEBHOOK_URL`. Neither is enabled by this release. A webhook URL alone does not activate collection.

Customer-demo capture, its email worker and production database wiring remain disabled. The seven shared demo URLs must remain unchanged.

## Acceptance is not persistence

Airtable can acknowledge a webhook even when the automation is off. The gateway therefore returns HTTP 202 with `persisted: false` and a correlation `requestId`, not HTTP 201 with an alleged durable receipt. The no-JavaScript response states the same distinction. It must never redirect to a page claiming storage or email delivery based only on that acknowledgement.

The CRM receipt lookup prevents ordinary sequential duplicate rows from resetting sales progress. It is not atomic: simultaneous requests can race. The marketing gateway currently generates a new correlation ID per call and does not offer restart-safe idempotency. Do not advertise it as an exactly-once or durable capture system.

## Next activation gates, in order

1. Choose and verify the durable primary store for website enquiries. Use a controlled synthetic submission and read the saved record back from the authoritative storage API.
2. Review and enable the mapped Airtable automation in its UI. Confirm a fresh, clearly labeled synthetic non-setup payload produces the intended row with the correct fields and consent. Keep live forwarding disabled until this readback is complete.
3. Verify deletion, retries and duplicate handling across the durable store and any CRM projection. Do not repeatedly POST after an ambiguous response.
4. Verify the marketing deployment, canonical domain, no-JavaScript form, error recovery and mobile presentation. Do not treat a 200 status, a thank-you page or a configuration check as proof of a stored enquiry.
5. Test email notification separately using an owner-approved recipient. No notification recipient has been silently selected by this release.
6. Only then enable the relevant production feature and repeat the live smoke checks. In-chat capture remains a separate pilot rollout.

## Staging database

`jemlio-capture-staging` is a free PostgreSQL 18 instance in Frankfurt, separate from production. Its recorded expiry is 2026-10-21T18:42:45Z. It is not an approved permanent production store; do not move real customer records there. Its connection has not been wired into the live chatbot.

## Security and rollback

- Never commit webhook URLs, database passwords, API keys or deployment capabilities to the repository.
- The staging seed script runs only through its explicit staging start command. `npm start` never imports it.
- To disable marketing forwarding, set `JEMLIO_ENQUIRY_ENABLED=false`; keep customer capture and worker flags unchanged/off.
- Keep the existing FAQ/chat paths independent of optional storage and notification failures.
