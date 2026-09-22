# Jemlio enquiry release status

Historical checkpoint: 2026-09-21. See the current note below before following the older activation gates.

## Current checkpoint — 22 September 2026, 18:03 UTC

Jemlio website intake, Airtable copying and owner email alerts are now active.
The native Netlify form remains the primary submission store. Its form-specific,
signed notification saves each enquiry in the permanent private PostgreSQL 18
database in Frankfurt; independent workers handle CRM and email delivery.

One clearly marked synthetic enquiry was submitted through the actual website,
read back from Netlify and PostgreSQL, and copied to Airtable within five seconds.
A signed replay returned the same receipt with `duplicate: true`. After the owner
approved sending the held test, the production notification code sent it once to
`hei@jemlio.com`. Resend confirmed `delivered`; the database records provider
acceptance after one attempt. Gmail's connector was rate-limited, so inbox-folder
placement was not independently checked.

The owner also approved future website alerts to that same inbox. All three
`JEMLIO_WEBSITE_*_ENABLED` switches are now true; the activation deploy
`dep-dapc5n0ae00c73cjg8mg` is live. The public privacy notice is published. See
[website-delivery.md](website-delivery.md) and the
[verified release record](https://github.com/BlaskeBlisk1/nova-dynamics-bot-server/pull/22).

The old Airtable webhook draft remains off. Customer-demo capture and its delivery
switches remain off pending pilot-specific routing and verification. The seven
existing demo links remain available.

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
