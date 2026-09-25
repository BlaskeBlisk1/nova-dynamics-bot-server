# Business workspace

`/workspace-demo` is a browser-only synthetic example. No API calls, contact messages, real bookings or browser storage. Reload or reset clears edits. `/workspace` is the real private owner interface; `/api/workspace` is disabled by default.

## Included

- Tenant-scoped enquiries, due/open/won/lost, upcoming/past/cancelled/calendar-attention views and 50-row pagination.
- Contact details, internal notes, manual follow-up dates, verified outcomes and observed appointment results.
- Recorded sales values in integer øre. These are self-reported values, not collected payments, profit or measured incremental revenue. Booking confirmation never means a won sale.
- Durable sessions, CSRF/origin checks, rate limits, hashed access keys, revision conflicts and a field-change audit. No contact text or raw credentials in the audit.
- Booking uncertainty remains visible even after closing an enquiry. Optional signed calendar synchronization handles verified cancellations and linked reschedules; unresolved cases remain an operator task. See `calendar-sync.md`.

## Approved pilot setup

1. Agree the pilot business, data controller/retention terms, staff with access and approved intake source. Existing prospect demos remain off. This release does not provision a customer or connect a calendar.
2. Apply existing capture and booking migrations, then `npm run workspace:operations -- migrate --apply` against the intended database. Verify with `npm run workspace:operations -- status`.
3. Generate a unique high-entropy key using `npm run workspace:operations -- key --out /absolute/private/path.json`. The file is created once with mode 0600; no secret is printed. Keep it out of source control and hand the key to the verified business owner through an agreed private channel.
4. Configure Render's server-only environment:
   - `NOVA_DATABASE_URL`: approved PostgreSQL connection.
   - `JEMLIO_WORKSPACE_ORIGIN=https://nova-dynamics-bot-server.onrender.com` (exact origin, no trailing slash).
   - `JEMLIO_WORKSPACE_CONFIG={"approved-slug":{"enabled":true,"name":"Approved business","keyHash":"64-character SHA-256 hash from private file"}}`
   - `JEMLIO_WORKSPACE_ENABLED=true` only after steps above.
5. Use a controlled test enquiry for that tenant to verify login, visibility, persistence and logout. Confirm another business cannot view it. Remove the test record through existing retention operations.

The business slug must match the existing `nova_capture_requests.client`. Website demo requests in `jemlio_website_enquiries` and Airtable cold-outreach leads are separate data sources and are not automatically imported. No seed data enters production.

Booking configuration and Calendly permissions are separate; see `booking-workflow.md`. The workspace never modifies a provider calendar, sends customer follow-up messages or charges a card. Staff record observed results; cancellation must happen in the provider system first.

## Access lifecycle

The initial pilot has one owner access key per business, not named staff roles, SSO, MFA or self-service password recovery. Sessions expire after 8 hours or 30 minutes idle. Cookie: `__Host-jemlio_workspace`, Secure, HttpOnly, SameSite=Strict, path `/`. Session tokens and key hashes are stored server-side. Data endpoints and workspace pages use `no-store`; the demo CSP disallows connections.

To revoke a business, remove its config entry; to rotate access, generate a new key and replace its `keyHash`. Deploy the change. Every authenticated request checks the current credential hash, so old sessions are revoked immediately after the new config is live. Keep at least one valid tenant or disable the feature entirely; malformed config fails closed for everyone. Revoke keys before staff lose authorization and delete expired access-key files safely. Rate-limited shared offices may need to wait 15 minutes after repeated login failures.

Workspace notes and audit records cascade when an enquiry is deleted using existing authorized retention operations. Session rows hold no contact content; expired/idle sessions are removed on the next successful login. Audit identities identify the business key, not individual staff. Recorded notes and outcome events follow the enquiry's retention policy.

## Validation

`npm run test:workspace` checks HTTP authentication, tenant isolation, CSRF, origins, session expiry/logout/rotation, persistence, revision conflicts, verified sales, uncertainty and throttling against embedded PostgreSQL. `npm run test:workspace-ui` checks synthetic demo interactions, no network/storage, unsafe text, conflict preservation and session-expiry data clearing. The PostgreSQL CI job additionally races workspace edits on real row locks. Existing demos and booking/capture tests remain required.

Security references: [OWASP sessions](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html) and [OWASP CSRF](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html).
