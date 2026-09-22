# Jemlio production status

Current checkpoint: 22 September 2026. This document replaces the obsolete staging-only activation checklist. Historical steps remain in Git history.

## Live and completed

- All seven shared demo URLs are preserved: `fram`, `fyllingsdalen`, `onsoy`, `tiller`, `trafikk1`, `frankolsen`, `roma`.
- Tiller and Frank Olsen have bounded conversation context and guided service follow-ups. The other demos retain their established answer handlers. Resetting the visible conversation does not require enabling server context.
- Jemlio's website uses the existing native Netlify form `jemlio-demo-request`. The form has already passed its production storage test; do not resubmit the original test to check a later UI release.
- The form-specific signed notification saves enquiries and independent email/CRM outboxes in the permanent private PostgreSQL 18 database in Frankfurt.
- Website enquiries copy to the private **Jemlio Sales** Airtable base. Owner alerts go to the approved `hei@jemlio.com` inbox. The original synthetic email was delivered; future owner alerts are approved and enabled.
- The private enquiry workspace and sales follow-up planner are published. Follow-up dates create a manual work queue; they do not send messages.

See [website delivery](website-delivery.md) for verified receipt, provider and database details, [marketing intake](marketing-intake.md) for publishing, and [the completion pass](completion-pass.md) for the current UI and release behavior.

## Intentionally inactive

- Customer-demo capture and its delivery switches remain off. Activating a real business pilot requires its agreed recipient, privacy notice, exact website origins and a verified delivery test.
- Public synthetic preview routes remain off.
- The older `/api/marketing-enquiry` forwarding gateway remains disabled. The live website does not submit to it.
- The superseded Airtable webhook automation remains off. **Do not enable it**: the signed receiver already performs CRM ingestion.
- The expiring staging database is not a production store.

## What still needs a business decision or separate verification

1. Select the first willing business for a customer-capture pilot and obtain its routing/privacy details. The code and permanent infrastructure are present; this is a customer onboarding step.
2. Verify the redesigned owner notification visually in an actual email client when an approved/new real alert is available. Its HTML/text, escaping and routing tests passed, but inbox placement and email-client appearance are not inferred from provider delivery.
3. Airtable sales status changes remain in Airtable; they do not synchronize back into PostgreSQL outcome reports. A broader sales-outcome integration is a separate feature.

No booking calendar, SMS or automated prospect follow-up is implied by the present release.

## Release and recovery checks

`npm test` covers the existing answers, context, UI recovery, enquiry validation, transactional outboxes and worker behavior. GitHub CI separately runs PostgreSQL concurrency and production dependency auditing.

After backend deployment, `JEMLIO_EXPECTED_COMMIT=<full SHA> node scripts/verify-safe-release.cjs --live` waits for that exact revision at `/api/release`, then checks all seven demos, guided follow-ups, website chat, intake configuration and the public native form/privacy page. It never submits a contact form or sends an email. It cannot prove fresh CRM/email delivery.

The public smoke workflow now runs on relevant backend, client, UI and dependency changes. Netlify publishing remains separate from a Render merge: verify the published website assets and Netlify deploy ID as well.

To pause website forwarding, disable its three `JEMLIO_WEBSITE_*_ENABLED` flags and its Netlify notification as needed. Native Netlify submissions remain stored. Customer flags and demo links are independent; do not change them to pause the website queue.
