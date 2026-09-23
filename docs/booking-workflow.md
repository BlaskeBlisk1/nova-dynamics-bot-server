# Booking, staff follow-up and results — first release

Date: 23 September 2026. Customer booking stays disabled until one business has an agreed pilot and approved configuration. All seven existing `/demos/:client` links retain their current behaviour.

## Available now

- `/booking-demo`: interactive Norwegian example of choosing a service, choosing a time, confirmation, no availability, and an uncertain provider response. Uses fictional Eksempel Bilpleie and fixed fictional contact details. The example owner dashboard tracks only actions performed on this page. Reloading clears everything. Its Content Security Policy blocks all API connections; no storage, analytics, email or calendar writes.
- `/book/:client`: separate real booking page, returning 404 unless both live capture and booking are fully configured and their database tables exist. This release does not redirect existing chat demos to it.
- A fixed-endpoint Calendly adapter with availability lookup, explicit confirmation, and a durable attempt before its booking POST. Existing calendars remain the source of availability. Management links lead to Calendly.
- Private operator commands for due follow-up tasks, provider reconciliation, appointment results and recorded sale amounts. There is no public customer-data dashboard or public reporting API. The browser dashboard is a demonstration, not the live operator system.

## Not connected or completed by this release

No customer's booking account, event type, recipient, service mapping or privacy notice has been approved. No real appointment or provider notification was sent while testing. No Calendly paid account entitlement has been verified. The provider integration has been tested against synthetic responses; an approved-account end-to-end test remains necessary.

Automated callback messages, SMS, payment collection, customer reminders, live dashboard authentication and automatic booking webhooks are not implemented here. Existing approved enquiry-to-staff notifications remain handled by the capture outbox. Calendly may send its own confirmation emails and run workflows configured by the account owner when a real booking is made.

TABS is not integrated. Do not promise traffic-school lesson bookings through TABS until that school's permitted integration method is established. A customer already using another platform does not need to change platforms for this demo; assess their existing system before selecting an adapter.

## Live activation, once a pilot is agreed

1. Use the existing live-capture onboarding in `customer-capture-v1.md`: approved recipient, actual service IDs, authorised origins, privacy URL, durable database, sender, operational staff notification and optional CRM. Include the backend page's exact HTTPS origin if `/book/:client` is used there. Missing origins fail closed.
2. Verify the business's Calendly account supports the Scheduling API, has the required token scopes, and is authorised to manage the exact event type. Current Calendly documentation specifies a paid Standard-or-higher plan for POST `/invitees`. Store a credential in a private environment variable. Never put it in HTML, a repository file, a chat transcript or a handover.
3. Choose an event type compatible with this first adapter: a simple appointment with name/email and any fixed physical location approved by the business. Independently verify that configured duration matches the provider, timezone, buffers, notice and availability. Paid events, extra mandatory questions, dynamic attendee location and round-robin location rules need additional adapter work; do not activate a partially supported event.
4. Apply the additive migration explicitly to the intended database after the capture schema:

   ```sh
   npm run booking:operations -- migrate --apply
   ```

   This creates tables only, with no provider call and no feature activation. Startup never performs this migration.
5. Set the private configuration and global flag. Example only; replace the tenant and event type with verified values:

   ```json
   {
     "approved-client": {
       "enabled": true,
       "credentialEnv": "JEMLIO_CALENDLY_APPROVED_CLIENT",
       "services": {
         "approved-visit-service": {
           "mode": "calendly",
           "eventType": "https://api.calendly.com/event_types/00000000-0000-4000-8000-000000000000",
           "durationMinutes": 30,
           "location": { "kind": "physical", "location": "Approved business address" }
         },
         "approved-quote-service": { "mode": "request" }
       }
     }
   }
   ```

   Set as `JEMLIO_BOOKING_CONFIG`; `JEMLIO_BOOKING_ENABLED=true` is the global switch. Only explicitly mapped capture services are exposed. Omit `location` when the verified event type does not require one.
6. Conduct one agreed test with a business-controlled address/calendar. Explicitly authorise the real provider booking and resulting notifications. Verify availability, resulting calendar event, recipient confirmation, cancellation/rescheduling links, staff notification and receipt reconciliation. This deployment alone does not prove any of these provider behaviours.
7. Add the booking link to the agreed customer journey only after this acceptance check. Independently define staff responsibility, follow-up times and retention. Turning the flag off stops new booking traffic but does not cancel appointments already made; operators can still reconcile them privately.

## Status and duplicate prevention

An enquiry is first committed to PostgreSQL with its staff-notification outbox. The response can include a 15-minute token bound to the receipt, tenant and exact approved origin. Confirmation rechecks the saved service, explicit consent and current availability before claiming that receipt once under a parent row lock.

Only one provider POST is allowed for a receipt. A repeated reviewed request reads the durable attempt. A changed time on an existing attempt is a conflict. A rejected or unclear attempt does not automatically retry or silently become a new booking. A timeout, malformed response, server error or lost database acknowledgement remains uncertain. A stale attempt appears as `needs_review` after 30 seconds. It remains visible in the staff queue even if a lead is closed or marked done.

This avoids retry-created duplicates for the same receipt. The calendar provider enforces availability across different visitors. It does not deduplicate someone opening a new session and making a separate new enquiry. Do not tell a visitor with an uncertain result to submit again; check the actual calendar first.

The provider adapter does not auto-retry POST `/invitees`, even on a 429. Definite validation/auth rejection is recorded as `rejected`; the saved enquiry remains for staff to follow up. Provider management links are limited to canonical Calendly cancellation/rescheduling paths.

## Private staff workflow

All commands below run in the approved server environment with `NOVA_DATABASE_URL`. They print receipt/service/status references, not contact details or credentials. Use the existing authorised staff notification or CRM to look up contact details. They do not send messages, charge money or cancel a provider event.

```sh
# Due new enquiries after 24 hours, plus all unresolved booking attempts.
npm run booking:operations -- due --client approved-client --hours 24 --limit 100

# Schedule a staff callback (UTC), preview first, then apply.
npm run booking:operations -- schedule --client approved-client --receipt UUID --action callback --due 2026-09-24T12:30:00Z
npm run booking:operations -- schedule --client approved-client --receipt UUID --action callback --due 2026-09-24T12:30:00Z --apply

# Match the actual provider invitee, event type, time and email. Reads only.
npm run booking:operations -- reconcile --client approved-client --receipt UUID --provider-id https://api.calendly.com/scheduled_events/EVENT_ID/invitees/INVITEE_ID
# Repeat with --apply after reviewing the matched result.

# Record an independently verified appointment result; preview is the default.
npm run booking:operations -- result --client approved-client --receipt UUID --status completed --apply

# Record a verified win using the existing capture outcome command first.
# Then record its known value in ore (250000 = NOK 2500), not an estimated ROI.
npm run booking:operations -- result --client approved-client --receipt UUID --status sale --amount-ore 250000 --apply

# Read current verified outcomes for an enquiry-created cohort.
npm run booking:operations -- report --client approved-client --since 2026-09-01T00:00:00Z --before 2026-10-01T00:00:00Z
```

Other follow-up actions: `review`, `reconcile`, `done`. Other observed appointment results: `cancelled`, `no_show`. Completion/no-show cannot be recorded before the appointment starts. Cancellation is an observed fact; the command itself does not cancel the calendar event.

A provider event must be positively matched before resolving an uncertain attempt as confirmed/cancelled/no-show. If no event can be found, leave it unresolved until staff verifies the case; this release has no command that clears the attempt and retries a booking. Escalate that case to the operator. A cancelled/rescheduled event is not automatically refreshed. Reconciliation verifies the original event; tracking a new time created through a provider rescheduling link requires additional reconciliation support. Tell staff to check the provider for the current appointment state.

## Reporting meaning

Counts distinguish enquiries, current qualified stage, provider bookings recorded, currently confirmed appointments, completed appointments, cancellations, no-shows, uncertainties, wins and wins with recorded values. Bookings are last verified states; there is no webhook-based automatic updating. Sales are manually recorded values attached to independently recorded wins, not collected payments, profit or demonstrated incremental revenue. Changing the current outcome away from won excludes its amount. A booking never automatically becomes a sale.

Date bounds describe when the enquiry was created, not when an appointment happened or payment arrived. Deleted records are excluded. Appointment and sale records cascade with approved capture deletion. Active and uncertain bookings are protected, including concurrent booking/deletion races. External calendar, Airtable and email copies need their own handling.

## Verification

- `npm test`: existing FAQ, chat, capture, UI, CRM, website and security regression suite, plus the new adapter/store/API and booking UI checks.
- `node scripts/test-booking-postgres.js`: actual PostgreSQL concurrency tests in the explicitly named disposable localhost CI database only; runs in GitHub CI after capture concurrency checks.
- `node scripts/verify-safe-release.cjs --live`: public release identity, demo assets and Content Security Policy, disabled live-booking routes, all seven existing demos, website proxy and existing intake status. No capture submission or calendar write.
- Browser review: interact with `/booking-demo`, confirm the three example scenarios and inspect the customer and example owner layouts.

Technical references checked for this implementation:
- https://developer.calendly.com/api-docs/calendly-api/scheduled-events/create-event-invitee
- https://developer.calendly.com/docs/api-guides/schedule-events-with-ai-agents
