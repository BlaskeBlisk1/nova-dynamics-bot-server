# Owner alerts and the connected customer journey

`/journey-demo` follows one fictional Nora enquiry through a selected visit, a reviewed proposal, one of three customer responses and an explicitly owner-confirmed outcome. State exists only in the tab's memory; reload/reset clears it. The page's CSP forbids network connections and form submission. Nothing is sent or booked. The 8,900 NOK amount is a fictional service price, not Jemlio pricing or a promise of revenue. Existing separate demos remain available.

Owner alerts are an **opt-in production capability**, disabled by default. They are separate from enquiry receipt emails. An approved tenant can receive a generic email after a new proposal response, plus one daily snapshot when the same queue used in the workspace results report has tasks needing attention. This includes overdue follow-ups and unresolved calendar checks. No customer names, contact details, proposal text, tokens or response notes enter these emails. Links open the private workspace, which still requires owner authentication.

## Activation for an approved pilot

1. Agree the owner recipient, sender, daily hour (Europe/Oslo), access, and retention with the pilot owner. Verify the sender domain in Resend and receipt by the approved owner. No prospect list is an alert recipient list.
2. Apply capture, booking and workspace migrations explicitly to the intended database. `npm run workspace:operations -- migrate --apply` now also applies `lib/owner-alerts/schema.sql`. `npm run workspace:operations -- status` checks both schemas. No startup DDL occurs.
3. Set existing `JEMLIO_WORKSPACE_ENABLED=true`, valid workspace origin/config, and `NOVA_DATABASE_URL`. Proposal reply alerts also require global `JEMLIO_OFFERS_ENABLED=true` and the tenant's `offersEnabled=true`.
4. Set `RESEND_API_KEY`, `JEMLIO_OWNER_ALERTS_FROM` (one verified plain sender address), `JEMLIO_OWNER_ALERTS_ENABLED=true`, and `JEMLIO_OWNER_ALERTS_CONFIG`:

```json
{"approved-business":{"enabled":true,"to":"approved-owner@example.invalid","digestHour":9,"startAt":"2026-09-26T07:00:00.000Z"}}
```

Use the agreed activation instant, never the example timestamp. Only replies at or after `startAt` are collected, avoiding historic response mail on activation. The daily snapshot includes current due tasks, including older unresolved tasks. Dates are Oslo dates, so DST and restarts do not create a second digest for the same day. A worker tick runs every minute; an empty queue sends nothing. If the service was down at the chosen hour, today's snapshot can be sent later that day; missed previous days are not backfilled. This is daily, including weekends, not a precise-minute scheduling guarantee.

5. Deploy, log in as the approved owner, and use **E-postvarsler til eieren → Kontroller varselstatus**. Run an agreed synthetic proposal response and a due task through delivery, verify the mailbox, and remove synthetic customer records. Provider acceptance is not proof of inbox delivery. Continue checking the workspace directly if notifications are delayed or unavailable.

## Delivery, operations and rollback

The worker polls durable proposal replies; it never relies on an in-memory post-response hook. Unique tenant/event keys prevent duplicate collection, including multiple instances. Replies whose proposal is superseded/withdrawn, task completed, or enquiry closed are suppressed at dispatch. Enquiry deletion cascades response alert rows through the offer foreign key. A delete cannot retract an email already accepted or in flight. Daily snapshots contain only counts and no customer references.

Queue payloads and recipient addresses are frozen for safe retries. Row leases and lock-token acknowledgement isolate workers. The existing Resend adapter uses a stable `jemlio-owner-alert/<uuid>` key and exponential backoff. Ambiguous attempts stop within 23 hours of the first attempt, before provider key expiry. Permanent errors become `failed`; expired retry windows, changed recipients and obsolete jobs become `needs_review`. No automatic replay after that boundary. Digests from a previous Oslo date are suppressed. A recipient change does not silently resend or forward a queued email.

The owner status endpoint is `GET /api/workspace/alerts`, behind the same session and tenant checks as the workspace. It returns only that tenant's aggregate queue status, not email addresses, provider IDs or customer details. Server worker errors contain no recipient/payload/provider response body. Inspect `jemlio_owner_alerts` using restricted operator access to reconcile `failed`/`needs_review` with Resend logs; suppress invalid/bouncing recipient configurations. There is no delivery-webhook integration or automated bounce suppression in this release, and `accepted` always means provider acceptance only.

Disable `JEMLIO_OWNER_ALERTS_ENABLED` and deploy to stop the worker, or remove a tenant from the alert configuration while keeping another valid tenant configured. Already accepted mail cannot be recalled. To remove a tenant's alert configuration and queue data for retention/offboarding, disable that tenant's dispatch first, then use authorized operator access; do not reset accepted/uncertain records to pending. Keep event keys while the matching source replies remain eligible, or advance the activation cutoff before removing them to prevent historic replay. Owner recipient metadata follows the agreed pilot retention policy. Customer response queue rows are removed with their enquiry. No migration or feature flag enables a customer automatically.

## Checks

`test:owner-alerts` covers strict configuration, no effects when disabled, Oslo/DST keys, activation cutoffs, tenant isolation, data minimization, concurrent collection/claims, restart deduplication, recipient changes, closed/deleted enquiries and bounded uncertain-send retries. CI repeats those tests against a disposable PostgreSQL database. `test:journey` checks all three reply paths, explicit outcome confirmation, same-customer continuity, reset, zero network and zero browser storage. The existing application suite protects the legacy demos and integrations.
