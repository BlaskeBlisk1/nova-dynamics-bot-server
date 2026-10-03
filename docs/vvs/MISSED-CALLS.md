# Missed-call recovery: Twilio rollout

3 October 2026. Executable integration, not the public simulation. No account,
number, forwarding, migration or sending is activated by publishing this code.

## Implemented

A Twilio Voice POST to `/api/missed-calls/<client>/voice` emits the approved Dial
route. Only final `busy`/`no-answer` callbacks are eligible. The worker validates
both parent and child Call resources, account/number bindings, recent end time and
Norwegian mobile status through Lookup. Answered, canceled, failed, stale, masked,
landline and mismatched events do not trigger recovery SMS.

Each call has a durable unique recovery record with an encrypted phone/link envelope.
Sending requires verified tenant readiness, explicit recipient approval, no STOP
suppression, a 24-hour recipient cooldown and the configured per-tenant daily cap.
The worker records an attempt before its one SDK send. Timeouts or interrupted sends
are uncertain, never automatically retried. Signed callbacks and provider reads
reconcile status: accepted and sent are not proof of delivery.

The private `/job-request/#<token>` link collects reviewed VVS details. The caller's
phone and `missed_call` provenance are server-owned. Enquiry, owner-email/optional
CRM outbox and link consumption commit in one transaction. Identical retries reuse
the receipt; changed submissions conflict. The existing owner-approved quote and
follow-up workflow remains in control of price, capacity and outcome.

Configured owners have **Ubesvarte anrop og SMS** in the authenticated workspace:
last 30 tenant-scoped records, delivery checking and stop controls. Checking performs
provider reads, not another SMS. Stopping cannot recall messages already sent.

## Supported phone setup

This is a Twilio ingress-to-business Dial adapter, not a listener for arbitrary
Telenor/Telia call logs. Agree the pilot's actual phone route, caller-ID preservation,
voicemail and outage fallback before changing it. Never forward back to the Twilio
ingress or create a forwarding loop. Voicemail counts as answered. No emergency
service, photo upload, payment or direct Cordel/SmartDok integration is added.

## Required configuration

All credentials/numbers belong in environment variables, never repository files.

Global: `NOVA_DATABASE_URL`, `JEMLIO_MISSED_CALL_ORIGIN` (exact HTTPS backend origin,
no trailing slash), `JEMLIO_MISSED_CALL_KEY` (base64 random 32-byte encryption/HMAC
key), and `JEMLIO_MISSED_CALL_CONFIG` (JSON keyed by registered client ID).

Every client entry requires `enabled`, `routingApproved`, `smsApproved`, `accountSid`,
`authToken`, `voiceNumber`, `forwardTo`, `smsFrom`, `activatedAt`, `dailyLimit`,
`smsText`, `testRecipients` and `liveRecipientsApproved`. Approval booleans are true;
`liveRecipientsApproved` must initially be false. `testRecipients` lists only explicitly
authorized internal Norwegian mobiles (maximum ten). `dailyLimit` is 1–100 attempted
messages per rolling 24 hours, not a currency cap. Lookups, calls and multipart SMS
can have separate charges. Configure provider spending alerts and a low initial cap.

The numeric `smsFrom` must be supported/approved in the account and receive STOP.
`forwardTo` is an approved +47 business number different from the ingress. A reviewed
one-line `smsText` identifies the business, contains exactly one `{link}`, includes
STOP instructions, contains no other URL, and is at most 220 characters before link
expansion. It must not imply a confirmed job or emergency response.

Enable the receiver separately with `JEMLIO_MISSED_CALLS_ENABLED=true` and dispatch
with `JEMLIO_MISSED_CALL_SEND_ENABLED=true`. Test-recipient mode sends real billable
SMS to its allowlist; it is not a mock mode. Approval flags do not establish legal
consent. Review the pilot's transactional messaging and privacy requirements before
approving general callers. A call is not recorded as marketing consent.

The same client needs working live VVS capture, private workspace, approved origins,
privacy notice, email sender/recipient, existing quote/conversation schemas and
sender switches. Include the backend origin in its allowed capture origins. Follow
`PILOT.md` and `../QUOTE-WORKFLOW.md`; this module cannot replace those prerequisites.

Review the additive schema, then on the approved database only:

    npm run missed-calls:operations -- status
    npm run missed-calls:operations -- migrate --apply

No startup DDL. The encryption/HMAC key fingerprint is pinned; unexpected key rotation
fails closed rather than discarding opt-outs. Key rotation needs a separate reviewed
migration. Never delete suppression/keyring records to bypass a readiness failure.

Provider POST webhooks: incoming voice `/api/missed-calls/<client>/voice`, incoming
SMS `/api/missed-calls/<client>/inbound`. Dial action and status callbacks are generated.
Do not configure a production phone route without testing its normal-call fallback.

## Opt-out and retention

Signed STOP/STOPP/STOPALL/UNSUBSCRIBE/CANCEL/END/QUIT or `OptOutType=STOP` persistently
suppress later recovery and revoke existing recovery links. START does not clear
application suppression. Other SMS replies are not yet forwarded to an owner inbox;
the template directs job details into the private form rather than soliciting SMS chat.

Phones/tokens are AES-256-GCM encrypted; link lookup is hashed; suppression is keyed,
tenant-scoped HMAC. Private links are removed from the address bar before requests.
No analytics, cookies or browser persistence on the private page. Page exit aborts
requests and clears private state. Reload requires reopening the original SMS link.

Links expire after three days, but expiration alone does not erase database payloads.
For an activated pilot, arrange the approved retention schedule for:

    npm run missed-calls:operations -- prune --apply

It removes expired encrypted envelopes/token hashes except in-flight sending rows.
Interrupted sends require operator review. Deduplication IDs/suppression keys remain;
job data follows existing capture retention. Provider records are not deleted by this
command. No production retention schedule was enabled by this release.

## Workspace diagnostics and acceptance

Startup logs a non-sensitive `Jemlio workspace readiness` report with enabled,
configurationValid, databaseConfigured, schemaReady and reason. It distinguishes
disabled/misconfigured workspace, missing database, missing schema and unreachable
database without exposing credentials or customer data. Never bypass login to hide HTTP 503.

Before actual callers use the route, test controlled authorized numbers through
answered/unanswered/busy/voicemail calls, duplicates, STOP, timeout, delivery,
private submission, owner notification, quote, response, expiry and deletion. Confirm
real phone/inbox receipt. Fake-provider tests are not delivery evidence.

`npm run test:missed-calls` runs 13 backend groups on disposable PGlite and five DOM
groups with network intercepted. Release checks also run the backend groups with
`--postgres`, requiring `JEMLIO_THROWAWAY_DATABASE=true`, a localhost connection and
an `_ci` database. No real calls/SMS are made. Existing tests remain in `npm test`.

## Rollback and integration references

Stop new SMS via the send switch, keeping STOP handling available. Before disabling
the receiver/Voice route or reverting code, restore the approved provider phone route.
Preserve additive tables/suppression records until migration/retention review. A sent
SMS cannot be recalled.

Primary references:
- https://www.twilio.com/docs/voice/twiml/dial
- https://www.twilio.com/docs/voice/api/call-resource
- https://www.twilio.com/docs/usage/security
- https://www.twilio.com/docs/lookup/v2-api/line-type-intelligence
- https://www.twilio.com/docs/messaging/api/message-resource
- https://www.twilio.com/en-us/guidelines/no/sms
