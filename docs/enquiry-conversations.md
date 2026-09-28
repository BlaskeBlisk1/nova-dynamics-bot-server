# Existing form to an owner-reviewed conversation

This release connects one configured website form to the existing Jemlio
workspace, then lets an owner review a reply and invite the customer to continue
on a private reply page. It extends the existing enquiries, tasks, proposals and
outcome workflow. It is not a general email inbox or a universal form connector.

No customer is enabled by adding or deploying this code. Intake, conversation
access and actual sending have separate opt-ins. Each business still requires an
agreed source, workspace, sender, recipient handling and a verified delivery test.

## What the first version does

1. The customer submits the business's existing Netlify form. Netlify remains the
   public destination and saves the submission before forwarding its signed event.
2. A configured adapter checks that the site and form match the approved source,
   then saves one enquiry, a follow-up task and an audit entry in the business's
   workspace. The source's tenant comes from server configuration.
3. The owner reads the enquiry, edits a reply draft and approves the exact
   customer recipient and message. Drafts use templates; this is not autonomous
   AI writing or automatic sending on receipt of a lead.
4. With sending separately enabled, the customer receives an email containing a
   private reply-page link. The owner can distinguish provider acceptance from
   delivery, and see delivery failures reported by signed provider events.
5. A reply submitted on that private page belongs to the same enquiry. The owner
   can follow up, prepare an existing proposal, and later record an outcome.

A customer reply does not approve a price, sign a contract, book an appointment,
record a sale or collect a payment. Existing proposal responses and manually
verified outcomes retain their own meaning.

### The boundary around email

Customer replies are captured through the private reply page. If a customer
instead replies directly to the email's configured `Reply-To` mailbox, that
message remains in the business's mailbox outside Jemlio. Do not promise mailbox
synchronisation, forwarded-email ingestion, reply-aware automatic follow-ups or
support for other website forms in this release.

The private reply link expires after 14 days. Closing an enquiry permanently revokes its existing reply links, including if the enquiry is later reopened. Customer reply text is limited to
2,000 characters. Tokens must not be placed in analytics, logs or public links.

## Fictional public demonstration

`/journey-demo` starts with **Fra nettsideskjema**:

- Register Nora Eksempel's fictional website enquiry.
- Edit **Svarutkast** and select **Godkjenn eksempelsvaret**.
- Select **Vis Noras svar** to simulate her clarification on the private reply
  page. The same case changes from **Avventer kundesvar** to **Trenger oppfølging**.
- Continue to the existing price proposal, customer feedback and owner-verified
  outcome. The result links to `/workspace-demo` for the owner view.

**Med booking** keeps the previous journey through an example appointment.
Changing journeys or restarting clears the fictional state. The demo uses only
memory in the current page: no API calls, browser storage, messages, appointments
or payment requests. The example amount is the fictional business's proposal,
not Jemlio pricing. A demo must never be presented as a customer result or a test
of a live integration.

## First adapter: Netlify

The raw-body receiver is mounted before the global JSON parser:

`POST /api/enquiry-intake/netlify/:source`

It verifies the `x-webhook-signature` and the configured source's exact site and
form. The source identifier is an opaque 24–64 character value containing only
letters, digits, underscores and hyphens. It identifies a configured source; it
does not replace signature verification.

Required configuration:

| Configuration | Purpose |
| --- | --- |
| `JEMLIO_WORKSPACE_ENABLED=true` | Enable the existing protected workspace. |
| `JEMLIO_ENQUIRY_INTAKE_ENABLED=true` | Enable the form adapter separately. |
| `JEMLIO_ENQUIRY_INTAKE_SOURCES` | JSON object keyed by the opaque source identifier. |
| `JEMLIO_ENQUIRY_INTAKE_KEY_<NAME>` | The signing secret selected by a source's `signingKeyEnv`; 32–512 characters. |

Each source contains `enabled`, `client`, `siteId`, `formId`, `formName`,
`siteUrl` and `signingKeyEnv`. Optional `fields` maps the canonical `name`, `email`,
`phone`, `service` and `message` fields to the existing form's field names.
`honeypotField` defaults to `bot-field`. Default field mappings use the canonical
names. The configured workspace tenant must be enabled and have valid protected
access credentials.

Apply `lib/enquiry-intake/schema.sql` explicitly after the existing workspace
schema. Runtime startup does not apply database schema changes. The source/site/
form ledger freezes the tenant binding; changing that binding is refused rather
than silently routing an existing source to another business.

Intake bounds the stored values and does not retain attachments or raw telemetry.
An enquiry needs a valid email address or phone number. Missing name, service or
email can require owner review; a phone-only enquiry does not become eligible for
email sending merely because it was stored. Intake does not assert consent on
the customer's behalf. Its receipt confirms storage only (`sendsMessages:false`)
and does not dispatch email or create a second CRM copy.

## Conversation and delivery configuration

| Configuration | Purpose |
| --- | --- |
| `JEMLIO_CONVERSATIONS_ENABLED=true` | Enable the conversation feature globally. |
| Workspace tenant `conversationsEnabled: true` | Enable it for one agreed business. |
| `JEMLIO_CONVERSATION_SEND_ENABLED=true` | Separate global opt-in for actual sending. |
| `JEMLIO_CONVERSATION_SEND_CONFIG` | JSON keyed by client, with `enabled`, an approved verified `from`, and the business's `replyTo` mailbox. |
| `JEMLIO_CONVERSATION_ENCRYPTION_KEY` | Canonical base64 encoding of a 32-byte encryption key. |
| `RESEND_API_KEY` | Existing private email-provider credential. |
| `JEMLIO_CONVERSATION_WEBHOOK_SECRET` | Private signing secret for provider delivery events. |

Owner approval freezes the intended recipient and body. Provider acceptance is
not delivery. Signed delivery, bounce and complaint callbacks update delivery
state; bounce/complaint handling suppresses the relevant tenant and recipient.

Customer-facing routes:

- `/reply/#<token>`: private reply page; the page immediately removes the token
  from the URL and holds it only in memory for the current visit.
- `POST /api/replies/read`: read the private conversation identified by its token.
- `POST /api/replies/respond`: submit a bounded customer reply.
- `POST /api/conversation-events`: signed provider delivery events.

These routes do not turn incoming email contents into operational instructions.
Never enable sending by trusting a form field, customer text or an inbound event's
claimed tenant. Keep transport retries, source deduplication and recipient
suppression independent of an owner's commercial decision about an enquiry.

## Per-business activation

Before activation, agree the existing form and its field mapping, the privacy
wording, the people who can access the workspace, the verified sender and reply
mailbox, and the support/retention process. Review any queued or held messages
before enabling delivery. Use the relevant operational commands and explicit
migrations; do not change database network access or reuse another business's
credentials to make a test pass.

Verify with a clearly labelled synthetic enquiry and an agreed test recipient:
native form storage, signed intake, one workspace record after a duplicate event,
owner-reviewed draft and approval, provider acceptance and delivery status, private
page access, customer reply on the same case, and expiry/failure behaviour. A
successful public demo, deployment or thank-you page proves none of these live
delivery steps. Do not send a test or activate a real business without the required
recipient and activation authorization.

## Verification

Run `npm test` for the complete regression suite. The GitHub CI PostgreSQL job
runs `node scripts/test-enquiry-conversations-postgres.js` and
`node scripts/test-enquiry-intake.js --postgres` against its explicitly named
disposable local database. These tests include concurrent approval, provider
leases, closure ordering and a signed replay blocked behind deletion. No
production provider or customer is used.

Apply the additive schemas with `node scripts/workspace-operations.js migrate --apply`
on the intended database after capture and booking migrations. Check readiness
with `node scripts/workspace-operations.js status`. Migration does not activate
a business or start sending.

`node scripts/test-enquiry-journey.js` covers the fictional default journey,
editable and empty drafts, explicit approval, customer clarification in the same
case, all three proposal responses, outcome verification, reset, booking-path
availability and absence of network/storage side effects. The existing
`scripts/test-journey.js` continues to exercise the booking journey by selecting
**Med booking** first. Backend and adapter tests provide separate evidence for
their own boundaries; these demo checks do not exercise external providers.

## Inline chat experience (28 September 2026)

The homepage examples now demonstrate enquiry → review → fictional business reply
→ customer clarification inside the existing chat. All fields remain in memory;
no demo form, clarification, message, booking or sale is submitted. FAQ requests
are paused during this exercise, so entered contact details never reach `/chat`.
The owner's workspace and the existing detailed demos remain available.

For shared chatbot tenants (the `UPGRADE_UI_CLIENTS` allowlist), newly approved
emails use `/demos/<client>?reply=1#reply=<token>`. The same reply controller mounts
inside that chatbot. It removes the fragment immediately, uses no analytics or
browser storage, sends only to `/api/replies`, binds requests to the route tenant,
and retains identical retry payloads after an ambiguous submission. Reloading a
scrubbed link fails closed; the customer must reopen the original email link.
The private route uses a same-origin CSP, no-referrer and no-store headers.

Old `/reply/#<token>` links, previously frozen emails and tenants without a shared
chatbot keep the standalone fallback. This change does not migrate schemas,
activate tenants, collect a new enquiry automatically, or enable email delivery.
Booking and proposal controls are still separate in this first integration.
