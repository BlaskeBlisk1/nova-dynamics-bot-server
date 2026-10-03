# Jemlio VVS pilot — implementation and onboarding

## Implementation update — 3 October 2026

The first Twilio missed-call/SMS runtime and private job-request page are now
implemented. They remain separate from the public simulation and require approved
provider, tenant and database configuration before activation. See
[MISSED-CALLS.md](MISSED-CALLS.md) for the supported routing topology, owner queue,
operator migration, opt-out handling and actual-delivery acceptance gate. No number
has been purchased or connected by publishing this code. Photos, payments and direct
Cordel/SmartDok connections remain unimplemented. The sections below document the
preceding VVS presentation release; references to SMS as unimplemented describe that
earlier release, not the new runtime.

## Product decision
The first target is Norwegian plumbers/VVS service businesses. Preserve the existing
chatbot, enquiries, owner pricing and follow-up rather than rebuilding a business
system. The differentiating direction is missed call → structured job request → owner
follow-up. The first release makes the structured web-request path configurable and
shows missed-call entry only as a clearly labelled simulation.

Seek 2–3 narrowly scoped pilots with actual usage and feedback. Setup and monthly
pilot fees must be agreed individually before activation; no standard paid tariff is
published by this release. The earlier 7,500–15,000 NOK setup / 2,990–4,990 NOK monthly
figures were later-stage hypotheses, not validated prices or terms accepted by a client.

## Implemented
- VVS-first homepage and interactive demonstration; older industry tabs and prospect
  URLs remain intact. No fictitious client counts, testimonials or revenue claims.
- Job category, declared urgency, exact service postcode, address, description, name,
  phone and email. Email is required for the existing private quote-delivery workflow.
- Shared server/browser validation. Explicit acute requests are directed to a phone
  contact; they are not silently accepted as dispatched jobs. Out-of-area requests
  are rejected, not booked. This is not diagnosis, emergency monitoring or a 24h service.
- The same captured record reaches the private workspace, owner-approved proposal,
  customer response and follow-up. All live web-intake source labels are server-set.
- Manual copy of the demonstration's job brief. Copying is not a Cordel/SmartDok sync.

## Not activated or implemented by publishing this release
Real missed-call events, phone forwarding, SMS delivery, photo uploads, payment capture,
provider booking or a direct Cordel/SmartDok connection are not implemented in this
release. Do not sell those as connected. There is no new production tenant, no automatic
migration and no real customer email test. Existing owner reminders remain separate
from automatic customer follow-up messages. Demonstrations use page memory only.

## Real client configuration
First follow docs/QUOTE-WORKFLOW.md and docs/FOLLOWUP-READINESS.md. Register the real
business with reviewed information and its shared demo template. Add its exact ID to
NOVA_VVS_CLIENTS as well as the existing NOVA_CAPTURE_CONFIG. Require approved origins,
recipient, sender, storage, privacy notice and explicit enabled/live switches. RoMa's
custom template is excluded from this opt-in. Unregistered client IDs cannot activate.

The capture entry must contain a `vvs` policy and the shared form:

    const VVS = require('./public/marketing/vvs-profile');
    const entry = {
      enabled: true,
      mode: 'live',
      services: VVS.SERVICES, // review these against the client's actual services
      form: VVS.form(),
      vvs: { postcodes: ['0150', '0160'] }, // example only; replace with approved area
      allowedOrigins: ['https://client.example.invalid'],
      recipient: 'owner@example.invalid',
      privacyUrl: 'https://client.example.invalid/privacy'
    };

An optional `vvs.emergencyPhone` must be a reviewed Norwegian number (8 digits or
+47 and 8 digits). Do not set a number without confirming who answers it and when.
Configuration must include the four required profile questions. New questions need
review of the shared validation rather than silently collecting more personal data.

No database migration is added: the existing request JSON stores a validated `job`
object plus the existing answer snapshots. `job.source` is always `website`; a browser
cannot assert that a request was recovered from a real missed call. The authenticated
workspace exposes the job metadata. Public analytics must not include address, name,
phone, email or problem text.

## Acceptance test before the first client goes live
Use an authorized internal recipient, not a prospect/customer. Verify submission,
owner notification, private login, quote approval, actual provider delivery and the
customer's private response. Confirm the same case reaches the follow-up queue. Check
expiry, changes, deletion, suppression, outside-area and acute-request behavior.
Confirm the emergency fallback by an agreed test, never a real emergency-service call.
Record results; a passing fake-provider test is not proof of real inbox delivery.

`npm run test:vvs` runs seven UI/configuration groups and the real HTTP rehearsal in
VVS mode on a disposable PGlite database. All email adapters are fake. Existing tests
remain in `npm test`. No tests in this release make actual calls, send SMS, or charge.

## Next phase: missed calls, only with a selected pilot
Establish the business's current phone provider and approved forwarding/event method.
Use verified provider event signatures, tenant/number binding, a final unanswered-call
status, stable call ID deduplication and an authenticated job link. Avoid sending for
answered, anonymous, non-mobile or opted-out callers. Set one bounded transactional
response, delivery handling, retention and operator controls before activation. Obtain
provider documentation and assess the selected flow's privacy/communication requirements.
Do not infer a callback number, sender ownership, customer consent or CRM API access.

## Pilot scorecard
Before activation record enquiry volume, response delay and how offers are followed up.
During the pilot count real requests, complete job briefs, owner response times, quotes,
customer responses and owner-confirmed jobs. Keep confirmed job value separate from
payments and do not label it incremental revenue without comparison evidence. Only
count recovered missed-call jobs after verified telephony provenance exists.

## Rollback
Revert the release commit and restore the previous Netlify deploy. No production
schema or client activation changes are required for this rollback.
