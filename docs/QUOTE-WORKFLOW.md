# Request → owner-approved proposal → customer response

## Release scope

The website and all shared prospect demos include an interactive in-chat example
with editable request fields, owner pricing, clarification, revisions, and customer
responses. The example never makes network writes, sends email, books an appointment,
records a sale, or stores contact details outside the current page's memory.

The application also implements the real flow behind explicit tenant configuration:

1. A customer submits a reviewed quote request using configured questions.
2. The existing capture transaction saves the request and owner notification together.
3. The owner reads the same request in `/workspace`, asks any clarification through
   the existing approved-reply system, and enters scope, total, tax basis and validity.
4. The new authenticated `POST /api/workspace/enquiries/:id/offer/send` approves and
   saves a versioned proposal plus one encrypted customer-email dispatch in a single
   transaction. A stable operation UUID makes identical retries idempotent.
5. The existing delivery worker sends the private customer link. Queueing, provider
   acceptance and confirmed delivery remain visibly distinct.
6. The link opens the proposal inside the shared chat surface. Customer responses
   create an owner follow-up, not an automatic sale, booking, payment or contract.

Existing link-only proposals, private clarification replies, FAQ demos and website
lead intake continue to work. No activation switches are changed by publishing code.

## Client configuration

Use existing capture onboarding and workspace documentation first. The client must
be a registered tenant supported by the shared capture UI; the existing allowlist in
`lib/upgrade-config.js` remains in force. Add newly onboarded client IDs deliberately
with matching shared UI and regression tests, not just an environment entry. RoMa's
custom page is still demonstration-only for capture.

Each enabled live entry in `NOVA_CAPTURE_CONFIG` can additionally contain:

```json
{
  "form": {
    "kind": "quote",
    "requireEmail": true,
    "requirePhone": false,
    "questions": [
      {"id": "need", "label": "Hva ønsker du hjelp med?", "type": "text", "required": true},
      {"id": "size", "label": "Omfang", "type": "select", "required": true,
       "options": ["Lite", "Stort"], "services": ["cleaning"]}
    ]
  }
}
```

`services` refers to configured service IDs, not arbitrary labels. Omit it for a
question applying to every service. At most eight questions and fifteen choices per
select; text answers are bounded to 500 characters. Unknown, inapplicable, missing
required or invalid answers are rejected on the server. Stored answer labels are
snapshotted with the request. Schema fields do not accept HTML or executable code.
Do not configure questions soliciting medical or other sensitive information.

Email is required for this release's private quote delivery. Phone may be required
or optional. No SMS, uploads or payment fields are implemented. A suggested service
can always be corrected by the customer before submission.

## Activation checklist — per approved pilot only

1. Verify the existing capture database, durable owner-email outbox, sender, recipient,
   allowed origins, privacy notice, and existing workspace/conversation migrations.
2. Inspect the additive migration with `npm run offers:operations -- status`.
   Apply only on the approved database using
   `npm run offers:operations -- migrate --apply`. This creates only
   `jemlio_offer_deliveries`; it does not enable features or send messages.
3. Configure `JEMLIO_WORKSPACE_ENABLED`, `JEMLIO_WORKSPACE_ORIGIN`, tenant access,
   `JEMLIO_OFFERS_ENABLED`, and per-tenant `offersEnabled` using existing procedures.
4. Configure and verify the existing private reply delivery: per-tenant
   `conversationsEnabled`, `JEMLIO_CONVERSATIONS_ENABLED`,
   `JEMLIO_CONVERSATION_SEND_ENABLED`, encryption key, sender configuration,
   `RESEND_API_KEY` and signed delivery-event webhook. Verify the real sender and
   controlled recipient before production use. Never paste secrets into GitHub.
5. Opt in explicitly with `JEMLIO_OFFER_SEND_ENABLED=true` and per-workspace-tenant
   `quoteDeliveryEnabled=true`. The new send control requires offers and conversations
   enabled. Missing migration, invalid recipient, suppression or unready sender fails
   closed. Other tenants retain the existing copy-private-link action.
6. Configure the existing owner-alert integration for customer-offer responses and
   overdue follow-ups. Do not describe dashboard follow-up as an email notification
   unless that delivery integration has also been verified.
7. With authorization, test a controlled non-customer recipient end-to-end: submit,
   owner notification, login, approved quote, provider delivery, private link,
   response, owner follow-up, correction and deletion. Do not test with prospects.

## Privacy and delivery behavior

Private quote tokens are never sent in a URL query or analytics event. The page
removes the fragment before ordinary demo initialization and suppresses chat
analytics/config loading in private mode. A token is retained only in same-tab,
path-scoped sessionStorage so reload can restore that private view. Closing the tab
clears that session according to browser session-storage behavior; do not use a
shared browser for private links. A new proposal revokes prior proposal links;
expiry, withdrawal and enquiry deletion also revoke access.

Approved email envelopes are encrypted using the existing conversation encryption
key; plaintext message history contains no private quote link. The worker rechecks
recipient, suppression, client activation, quote expiry/state and the quote kill
switch before dispatch. Turning off `JEMLIO_OFFER_SEND_ENABLED` blocks new queued
quote sends; it cannot recall messages already sent.

The amount is a proposal, not automatic payment capture. The customer may express
interest, request changes, or decline. The owner must separately confirm the actual
outcome and any booking/invoice. Checkout, deposits and legally binding order
acceptance are outside this release.

## Verification and rollback

`npm test` includes `test:quotes`, which tests required/conditional answers, atomic
approval, encrypted delivery, recipient matching, concurrent identical retries,
revisions, expiry/withdrawal gates, deletion, and synthetic browser flows. Email
providers in these tests are fake and all addresses use reserved example domains.

Disable quote sending first if a pilot needs to pause. Revert the release commit to
roll back the UI/runtime; the additive delivery table can remain in place. Do not
delete real request data or overwrite client configuration as part of a rollback.
