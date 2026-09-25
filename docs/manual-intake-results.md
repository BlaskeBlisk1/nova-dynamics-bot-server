# Manual enquiries and pilot results

The private workspace now supports a focused pilot using enquiries the business already receives by phone, email, social media, recommendation or another channel. The owner records them manually; no website replacement or chat integration is required for this path. This does not import mail, social accounts or contacts, generate demand, send notifications, or verify the stated source.

## Owner workflow

1. Search existing enquiries by name, email, phone or service to avoid entering the same enquiry twice.
2. Choose **Legg til henvendelse**, enter one received enquiry, its source, at least one contact method and a follow-up time. Confirm that the information has been checked. Avoid sensitive details and cold contact lists.
3. The enquiry appears in **Alle henvendelser**, with a dated callback task. The existing proposal and outcome workflow applies. Manual entry does not assert visitor consent or put anything in email/CRM delivery queues.
4. Open **Se pilotresultater**. Select the last 7, 30 or 90 rolling days, or all retained enquiries. Copy the aggregate report when needed. It contains no names, contact details, notes or proposal scope.

`/workspace-demo` includes the same actions with fictional, memory-only data. Reload/reset discards changes, and the demo CSP prevents API connections. A direct link to the existing website contact section lets interested businesses request a discussion. Nothing in this release changes existing prices or creates a free product trial.

## Report definitions

A period selects enquiries by **registration time in Jemlio**, not the time of a sale, original phone call, response or invoice. It is a current snapshot of that cohort, not a historical snapshot or causal revenue report. Deleted enquiries are excluded.

- Enquiries: retained records registered in the period.
- Open / due: current disposition and follow-up state, including unresolved booking/calendar attention.
- With proposal: enquiries with at least one proposal; revisions do not inflate the count.
- Responses: the response attached to the latest proposal version for each enquiry. Replacing a proposal can change these counts. Customer interest is not a sale.
- Won / lost: current owner-recorded result. Reported values count only current wins. Missing amounts are shown separately from zero.
- Sources: `phone`, `email`, `social`, `referral`, `other` are manual owner selections; `submitted` groups the existing capture submissions. These are not independently verified marketing attribution.

No ROI, profit, payment collection, conversion lift, delivered/opened-email rate or additional revenue is inferred. Source rows and the total use one database query/snapshot. Results do not depend on the list's search or queue filter.

## API and safeguards

- `POST /api/workspace/enquiries`: validated, tenant-scoped manual intake. Random submission UUID + canonical payload hash makes an exact retry return the same record. Changed data under that UUID is a conflict. One transaction saves the enquiry, follow-up and metadata-only audit.
- `POST /api/workspace/enquiries/search`: literal bounded search and existing pagination. Personal search terms remain out of URLs. Same origin, CSRF, authenticated session and durable limits apply.
- `GET /api/workspace/results?since=<ISO UTC>&before=<ISO UTC>`: aggregate results only; start inclusive/end exclusive. Existing key/session isolation and no-store headers apply.
- Creation also has a tenant-wide 30/minute limit, in addition to the existing 120/minute session limit. No user-provided destination is used.
- The UI freezes an uncertain create attempt and requires an explicit retry using the exact same UUID/payload. It stores neither the attempt nor contact details in browser storage. After a reload, search before making a new record. Separate independently created enquiries for the same person are intentionally not auto-merged.
- Existing retention now recognizes server-marked manual entries with no email/CRM rows. Unknown missing dispatch records stay protected. Active/uncertain bookings stay protected. Deletion locks/rechecks, cascades child records, and retains the opaque submission guard to block delayed retries.

## Activation and rollback

The existing workspace gate remains off until a named pilot is agreed, its capture/booking/workspace schemas are applied, and owner access and handling/retention are configured. No additional schema or environment variable is introduced by this release. No account is provisioned automatically. The existing workspace setup is still required even for the manual path; there is no requirement to turn on a public chat or calendar integration.

Manual enquiries can contain only a phone number. Do not promise provider booking from that record until the provider's required contact fields are available. The initial proposal flow remains manual sharing and personal follow-up.

Before activation, test a controlled entry, exact retry, search, proposal response, outcome, report and authorized deletion for the intended tenant. Check another tenant cannot see it. During use the owner must check the workspace; no new alerts/reminders are sent.

To disable private access, use the existing workspace global/tenant gate. A code rollback to PR33 also removes the new intake/search/results endpoints. Before rolling back while real manual records exist, account for their retention: PR33's deletion tool treats absent dispatch rows as protected. The new retention implementation must be retained or restored for their authorized deletion.

## Validation

The workspace tests cover authentication/CSRF, input rejection, no delivery side effects, exact/conflicting retries, literal tenant search, result bounds/amounts, deletion and tombstones. UI tests cover isolated demo entry/report, aggregate copying, response-loss retry preservation and private-data clearing on session expiry. Real PostgreSQL CI races eight creation retries and deletion against a retry, alongside existing booking/offer/calendar races.
