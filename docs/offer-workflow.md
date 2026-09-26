# Price proposals and customer responses

This extends the existing enquiry/workspace workflow. `/offer-demo` is a browser-only fictional customer example; `/workspace-demo` includes proposal creation and customer-response simulation on the same enquiry. Neither demonstration calls an API, sends a message, creates an order or stores browser data. The separate customer demo does not transfer its simulated response to another page.

## Included behavior

An authenticated owner can create a reviewed proposal from an open enquiry, with a title, scope, explicit total price in integer NOK øre, VAT label and 1–30 day response window. Jemlio does not calculate or infer taxes, scope or prices. The owner controls those fields. A new version replaces all previous response links and preserves earlier proposal/response records. Up to 30 recent versions can be viewed per enquiry.

Creating the proposal returns one private share URL. The owner copies and shares it themselves with the intended customer; the app sends no email/SMS and records no delivery/read receipt. Do not describe “created” as “sent.” Raw tokens are generated from 32 cryptographically random bytes and returned only once; only their SHA-256 hashes persist. A lost link is replaced by issuing a new version, which revokes the previous link.

The customer can request further discussion, ask for changes or decline. The page explicitly describes this as feedback for personal follow-up, not an order, signature, payment or automatic booking. The response is recorded against the same enquiry/version, and an immediate owner review task is created. Interest is counted separately from confirmed wins and sales values. Each response is attributed to the private link, not a verified named individual: anyone holding the link can read the proposal and respond. Do not use this workflow as identity verification or electronic contract signing.

Proposal creation creates an owner review task at the earlier of three days or link expiry. The workspace has waiting-proposal and unhandled-customer-response views. A staff member can set the next follow-up or mark it done through the existing controls. There is no automatic customer reminder, recipient notification, payment processor or electronic signature integration. Customer replies appear when the owner refreshes the workspace.

## Activation

No activation, customer credentials or production migration is part of merely deploying this release. Use the existing approved capture/workspace pilot setup. The owner must have a real saved enquiry in their own tenant; website marketing requests and outreach lists are separate data sources.

1. Apply the capture and booking migrations as required, then rerun the additive `npm run workspace:operations -- migrate --apply`. This adds `jemlio_offers` and `jemlio_offer_events`. Startup performs no DDL. Existing workspace schema readiness now requires these tables, even when proposal controls are disabled.
2. Keep the existing exact HTTPS `JEMLIO_WORKSPACE_ORIGIN`. Set `JEMLIO_OFFERS_ENABLED=true` and `offersEnabled:true` only for an approved business inside `JEMLIO_WORKSPACE_CONFIG`. Both workspace access and proposal feature gates must be active. All other tenants remain disabled. No new provider subscription is required for this feature.
3. Run a controlled synthetic enquiry with the approved owner: create a proposal, review the displayed business/title/total/scope, copy the private link, respond, refresh the owner view, verify the task and verify no sale/payment/booking was created. Issue a new version and confirm the old link is unavailable; withdraw the new link and confirm it is unavailable too. Verify another owner cannot read or mutate the enquiry.
4. Agree who checks the response queue and when. Confirm the total price and VAT label reflect the business's actual offer and intended audience. Keep sensitive/private customer notes out of the proposal text; the customer's public page shows only the proposal and its response, not contact details or internal intake/notes.

## Security and lifecycle

The existing owner session, tenant mapping, exact origin, CSRF and durable rate limits protect proposal creation, history and withdrawal. Owner changes use the same full enquiry revision guard as workspace edits. New customer responses invalidate stale owner revisions.

Public endpoints are `POST /api/offers/read` and `POST /api/offers/respond`. They require the private bearer token in the JSON body and the exact configured origin. The browser reads the token from the URL fragment, immediately removes it from the address bar, holds it only in memory and uses no cookies or browser storage. Tokens are never sent in a server path/query. The page/API use no-store and no-referrer, reject cross-site origins, load no third-party assets and cannot be framed. A reload without the original link needs that original link again. Do not add analytics to these pages or log request bodies.

An identical response replay is idempotent. A different response after submission is rejected; the customer is instructed to contact the business to revise it. On an uncertain network result, the UI requires a status check before enabling another submit. Parent-enquiry locks serialize issuing/replacing, responding, staff updates and deletion; the token/version/outcome is rechecked after acquiring the lock.

Expired, withdrawn or superseded links, closed enquiries, disabled tenants and deleted records fail closed. Marking an enquiry won/lost revokes its active response link. Authorized enquiry deletion cascades proposals and metadata-only offer audit records. The audit contains action codes and references, not note text or raw tokens. Proposal bodies and customer responses are retained as part of the enquiry and follow its existing approved retention policy; external copies shared by staff need separate handling.

Disable the global flag or the business's `offersEnabled` setting and deploy to stop access immediately. Existing records remain for the owner/retention process. No calendar event or notification is created or cancelled by rollback.

## Verification

`test:offers` verifies review requirements, prices, tenant isolation, token handling, public data minimization, follow-up, replay, revocation, expiry, deletion, owner auth/CSRF, public origins and rate limits. `test:offer-ui` exercises owner creation → simulated customer response → task completion without network/storage, the customer example, private-token removal and lost-response recovery. Real PostgreSQL CI additionally races concurrent creates, duplicate responses, replacement versus response, and deletion versus response.

The public release smoke verifies demo assets/CSP and disabled production proposal access. This is not a substitute for the approved owner/customer acceptance test.
