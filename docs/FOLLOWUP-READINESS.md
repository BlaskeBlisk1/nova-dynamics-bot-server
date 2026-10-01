# Follow-up demonstration and client readiness

## Public demonstration

The marketing site's Oppfølging tab uses one explicitly fictional customer case.
It demonstrates assessment, clarification, owner-approved pricing, customer response,
scheduled owner follow-up and an explicitly confirmed outcome. It never sends email,
makes a booking, takes a payment or writes a customer record. Data and draft proposals
remain only in the current page's memory and survive tab switches, not page reloads.
The figures refer to that one fictional case, not Jemlio's customer base or real sales.
No customer testimonials, active-client counts or unverified business claims are added.

Only two static assets and the site's integration change. Existing prospect URLs,
ordinary question answering, private quote access and the website enquiry form stay
intact. The public demo is not a substitute for authenticating an owner in /workspace.
The production workflow remains the existing capture/quote/conversation/workspace
implementation from QUOTE-WORKFLOW.md.

## What must work for an onboarded client

1. Registered tenant, approved service list, necessary questions, exact allowed origins
   and privacy notice; real capture must be explicitly enabled for that tenant.
2. Durable production database with capture, workspace, offers, conversations, quote
   delivery and owner-alert schemas; no migration executes automatically on startup.
3. Private owner login with tenant isolation and CSRF checks, reviewed quote and reply
   actions, version conflicts and repeat-submission protection.
4. Verified sender and correct recipients. Owner notification and customer proposal
   dispatch use durable queues. Provider acceptance is not proof of inbox delivery.
5. Signed delivery-event webhook, suppression handling and the appropriate per-client
   send switches. The actual sent link must open the intended private quote.
6. Customer reply appears in the same case and creates a next action. Owner alerts
   require their separate configuration. A scheduled owner task is not an automated
   customer reminder, a payment, a contract or a confirmed appointment.
7. Controlled end-to-end acceptance test with an authorized internal recipient before
   exposing the flow to a client's customers; then verify deletion, token expiry,
   revised/withdrawn proposals and cancellation of unnecessary follow-ups.

## Reproducible acceptance rehearsal

`npm run test:followup` runs the shipped website scripts in a synthetic DOM and
rehearses real authenticated HTTP routes against a disposable PGlite database.
The HTTP rehearsal follows a request through durable owner notification, clarification,
private customer reply, approved quote, concurrent retries, signed delivery event,
customer quote response, owner alert, persisted follow-up and verified outcome.
Every email transport in this rehearsal is fake. It does not contact Resend or any
customer, and it is not evidence of delivery to a real mailbox.

CI additionally runs `node scripts/test-followup-pilot.js --postgres` on its disposable
localhost PostgreSQL service. This mode requires JEMLIO_THROWAWAY_DATABASE=true and a
localhost CI database name; it must never run on the production database. All prior
application and concurrency tests remain in the suite. The workspace runtime accepts
an optional injected sendMessage function for tests; normal production defaults are
unchanged and no send transport is exposed via the public HTTP interface.

## Observed production boundary, 1 October 2026

The recovered read-only public audit reported the site and demo routes available,
while /api/workspace/session returned HTTP 503 and the inspected prospect capture
configurations were off. HTTP 503 does not establish which configuration or schema
is missing. The Render connector confirmed a persistent production PostgreSQL instance
exists; its empty external IP allowlist prevented the connector's read-only schema
query. No network protection was relaxed. Database schema state therefore remains
unverified from that connection.

Publishing this improvement does not turn prospect demos into live data-collection
forms, configure a client's sender, apply a production migration or enable quote
sending. Configure and test the selected client deliberately using QUOTE-WORKFLOW.md.
No paid upgrade, database creation or real message dispatch is part of this release.

## Rollback

Revert the release commit and restore the prior Netlify production deploy if needed.
No business data migration or client setting is changed by the public UI release.
Keep production database network restrictions and private access controls intact.
