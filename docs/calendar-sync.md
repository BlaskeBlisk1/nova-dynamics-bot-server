# Calendar changes and appointment views

Released code is opt-in. This release creates no webhook subscription, customer credentials, calendar event, notification or live pilot. Existing prospect demos remain unchanged. The public `/workspace-demo` uses fictional appointments and demonstrates a move, cancellation and uncertain calendar state without network calls or storage.

## What happens after activation

1. Calendly sends `invitee.created` or `invitee.canceled` to `POST /api/calendar-sync/calendly/APPROVED-SLUG`.
2. The endpoint authenticates the exact raw body with the business's unique signing key and a three-minute timestamp window (30 seconds future tolerance). It matches an already saved Jemlio booking using provider references, historical aliases or opaque attempt tracking, restricted to the business and approved event types. Unrelated calendar contacts are never imported.
3. The server acknowledges with 204 only after a database transaction records a hash receipt and queues the booking. It stores no raw webhook body or contact text. Identical redelivery is a no-op; multiple changes coalesce into a single job with a new generation.
4. A worker reads the current Calendly invitee and scheduled event with GET requests, checking email, event type, original time and each reschedule relationship. It follows up to eight linked appointments, retaining aliases. It never creates or cancels appointments or sends messages. Delayed notifications therefore do not roll back a newer verified appointment.
5. The workspace shows the resulting time/status, last calendar check and pending/attention state. Views include upcoming, past appointments awaiting a recorded outcome, cancelled and calendar attention. Upcoming is a count of currently confirmed future appointments, including any explicitly labelled pending review. A confirmed appointment is never a recorded sale or proof of attendance.

Jobs have durable leases, bounded retries and a generation check. Provider mismatches park immediately; temporary failures retry up to six attempts before attention. New notifications or an explicit operator retry can reopen a job. Parent-row locks and booking snapshots protect concurrent staff edits and deletion. Manually completed attendance is retained; contradictory calendar results require review. Only an approved deletion of the parent enquiry removes jobs, hash receipts and aliases.

## Approved pilot activation

Use the existing booking and business-workspace checklists first. Agree the business, exact calendar/event types, staff access, privacy terms and controlled test. An actual account acceptance test is still required; mocked responses do not prove Calendly account permissions or delivery.

1. In the intended database, rerun the additive booking migration to add `calendar_state` and `calendar_checked_at`, then apply this queue migration explicitly:

   ```sh
   npm run booking:operations -- migrate --apply
   npm run calendar:operations -- migrate --apply
   npm run calendar:operations -- status
   ```

2. Configure server-only environment variables. Use the approved booking credential and a separate random signing key of at least 32 characters for each business; never paste secrets into source, notes or public pages.

   ```text
   JEMLIO_CALENDAR_SYNC_CONFIG={"approved-slug":{"enabled":true,"credentialEnv":"JEMLIO_CALENDLY_APPROVED","signingKeyEnv":"JEMLIO_CALENDLY_WEBHOOK_APPROVED","eventTypes":["https://api.calendly.com/event_types/APPROVED-ID"]}}
   JEMLIO_CALENDAR_SYNC_ENABLED=true
   ```

   The named credential and signing-key variables must also be present. Invalid configuration or reused signing keys fail closed. `NOVA_DATABASE_URL` must point to the intended database. Startup performs no migrations.

3. With the approved business's Calendly account, create the webhook subscription for exactly `invitee.created` and `invitee.canceled`, the HTTPS endpoint above and that business's signing key. Use the account's supported personal-access-token subscription configuration with its own signing key. A shared OAuth application signing key is not supported by this tenant configuration. Verify account scopes and subscription status against Calendly's current API before creating it. Subscription creation is a separate account mutation; this deployment does not perform it.
4. Make the agreed controlled booking, move it through Calendly, then cancel it. Check all three states on the same Jemlio receipt, correct new time, no duplicate booking, scoped owner access and no other account's contacts. Check signature failures, subscription delivery status and the attention queue. Remove test records with the approved retention process.
5. Enable the approved customer journey only after acceptance. Subscription delivery, provider access and the attention queue require operator monitoring. No periodic full-calendar polling or subscription health monitor is implemented. A missed notification can leave the last verified state unchanged; the displayed check time is not a freshness guarantee. Provider no-show events are not subscribed to; attendance stays a verified staff task.

## Operations and rollback

`npm run calendar:operations -- status` reports schema readiness, queued jobs and parked attention count without contacts. To retry an existing job after fixing the provider/configuration issue:

```sh
npm run calendar:operations -- retry --client APPROVED-SLUG --receipt UUID
npm run calendar:operations -- retry --client APPROVED-SLUG --receipt UUID --apply
```

The first call is a dry run. Retry performs no provider write. It does not find/import unknown events or clear booking attempts. Check the actual provider calendar whenever a case remains uncertain. Existing manual booking reconciliation verifies the original provider record; use the queued sync path for linked reschedules.

Set `JEMLIO_CALENDAR_SYNC_ENABLED=false` to stop this receiver and worker. Existing bookings and queued work remain; disabling does not cancel appointments or delete the provider subscription. Coordinate subscription pause/removal in the approved account to avoid failed deliveries. Redeploying resumes expired leases. Rotate the per-business signing key together with its provider subscription.

## Verification and references

`npm run test:calendar` covers signatures, isolation, duplicate delivery, unknown contacts, durable retries, attempt recovery, ordering, reschedules, verified reads, deletion and HTTP acknowledgement with synthetic local data. `test:workspace-ui` covers all demo scenarios without network/storage. The real PostgreSQL CI suite checks concurrent enqueue/claim, new notifications during reads, manual reconciliation races and deletion during a read.

Primary provider references: [signature format](https://developer.calendly.com/api-docs/overview/webhooks/webhook-signatures), [reschedule relationships](https://developer.calendly.com/docs/api-guides/see-how-webhook-payloads-change-when-invitees-reschedule-events), [subscription creation](https://developer.calendly.com/api-docs/calendly-api/webhooks/create-webhook-subscription), [timeouts](https://developer.calendly.com/api-docs/overview/webhooks/webhook-timeouts).
