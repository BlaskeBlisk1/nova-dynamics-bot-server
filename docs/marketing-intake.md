# Website intake and CRM forwarding

## Current release design

This document updates the website portion of `enquiry-release-status.md`.

The public website form uses **native Netlify Forms** with the existing name `jemlio-demo-request`. Its action is the canonical `https://www.jemlio.com/demo-requested` URL. It retains the acknowledgment checkbox, honeypot, accessible labels, pending/uncertain states and manual email fallback.

The protected Render `/api/marketing-enquiry` gateway is a **separate, disabled future forwarding path**. It is not the public website's submission destination in this release. The public website must not depend on an Airtable automation that has not been enabled and verified.

Netlify form detection must be enabled and the site must be deployed afterward. A successful deploy or thank-you page is insufficient evidence of collection: require the form to appear in the Netlify Forms API, make one clearly labeled synthetic owner-only submission, and read that same marker back from the submissions API.

## Publishing safety

`staging-site-task.cjs` can run only on the dedicated integration staging service, at an explicitly configured tested commit and within a short validity window. Its deployment capability is supplied privately through the staging environment, not in source code.

The publisher constructs a temporary bundle containing only the ten named public marketing assets and a minimal `netlify.toml`. It does not upload the backend, `.git`, environment files or private configuration. Subprocess output is discarded because a deployment client could echo its bearer-capability URL.

The native-form smoke operation is armed separately after registration is confirmed. It uses the owner's already-public business mailbox, a unique marker and a conspicuous `DO NOT CONTACT` test company. It does not contact prospects. HTTP completion is recorded separately from successful storage readback.

After either task, set `JEMLIO_SITE_TASK=off` and clear the proxy, expected commit, deadline and test marker. The staging service has auto-deploy disabled and no request-triggered write endpoint.

## Website delivery upgrade — 22 September 2026

The backend now contains a separately gated signed Netlify notification receiver.
It saves the website enquiry and both delivery payloads in PostgreSQL before
acknowledging persistence, then uses independent Airtable/email retry workers.
The native Netlify form remains the public submission destination. This code does
not automatically create a Netlify notification or enable dispatch. See
[website-delivery.md](website-delivery.md) for exact configuration and verification.

The production PostgreSQL database, Resend sending credential, Airtable token and
signing secrets are installed. Website intake and Airtable dispatch passed an
actual public-form test and duplicate replay. After explicit owner approval, the
held test email was sent once through the production sender and Resend confirmed
delivery. Future website alerts to `hei@jemlio.com` are enabled. Gmail's connector
was rate-limited, so inbox-folder placement was not independently verified.
Customer-demo capture and its delivery switches remain off.

## Previous Airtable automation

The mapped `Jemlio inbound enquiry webhook` draft has a captured schema and validated field mapping. It remains OFF. The signed notification receiver uses direct, receipt-based Airtable upserts instead; do not enable both as duplicate importers. Publishing the website alone does not activate either path.

Airtable is a CRM projection. The superseded automation draft's receipt lookup protects sequential retries only, not simultaneous races. The active signed receiver deduplicates native source IDs in PostgreSQL and uses a separately leased, receipt-based CRM upsert. Preserve sales progress when synchronizing existing records.

## In-chat capture status

The existing seven customer-demo links remain unchanged. In-chat capture and its email worker remain disabled. The permanent production database is wired and migrated; the expiring free staging database is not used for real customer records.

## Verification record

Record the exact Netlify deploy ID, native form ID, synthetic submission ID/marker and verified readback in the release PR discussion. Record the Render deployment commit and public demo/chat smoke result separately. Do not equate any of these independent checks with successful email notification delivery.
