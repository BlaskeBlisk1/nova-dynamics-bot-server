# RoMa demo sources

Verified 2026-09-17 against the official school website; scoped to the requested
mini-demo. Magnus's request concerns classes, courses, prices and registration.
The public demo does not reproduce the private email thread or contact metadata.

## School sources

- https://romatrafikkskole.no/ — identity, Tolvsrød, class/course navigation.
- https://romatrafikkskole.no/klasser — all published class prices, package
  contents, Magnus and Rune's public professional contacts.
- https://romatrafikkskole.no/kontakt — address, public phone, business email.
- https://romatrafikkskole.no/kursoversikt — live handoff for dates and places.
- https://romatrafikkskole.no/kalender?class=307&product=286 — MC booking link
  observed on the homepage. Use the general course page unless a class is known.
- https://romatrafikkskole.no/kursoversikt?classId=305&courseId=2366066&officeId=465
  — publicly accessible booking conditions; expired course date is NOT used as
  an upcoming date. Conditions must be reconfirmed for the actual booking.

## Rule sources

- https://www.vegvesen.no/forerkort/ta-forerkort/veien-til-forerkortet/personbil-b/
  — TG from 15, 17 teaching hours, exemption from 25 excluding first aid and
  darkness, automatic code 78, training stages and individual lesson needs.
- https://www.vegvesen.no/forerkort/ta-forerkort/trafikant-i-morket/
  — current seasonal darkness rules. Prefer this over the school's imprecise
  March/November wording in an A1 package description.
- https://www.vegvesen.no/forerkort/ta-forerkort/ — official handoff for fees,
  individual eligibility and unverified legal details.

## Conflicts and explicit limits

- BE road course appears at both NOK 2,500 and NOK 2,850. Never choose one as a
  definitive price. B96 separately lists NOK 2,850.
- B track course explicitly includes NAF. A separate NAF line must not be
  silently added again. B warmup says 60 minutes / NOK 880: don't silently
  normalize to 45 minutes.
- First aid: published as an over-25 course at NOK 1,000, not a general all-age
  price. Trafikalt grunnkurs (NOK 2,100) excludes darkness (NOK 1,800).
- A1-to-A2 is a conversion package, not a verified direct-entry A2 package.
- No fixed office hours, pickup policy, language commitments, payment methods,
  refunds or full licence total were verified. Ask the school.
- No booked/reserved claims, lead capture, email forwarding or payments.
- RoMa's live page has a Messenger link. This is a solicited demo for an active
  lead, not another cold-outreach candidate; do not claim they have no chat.

## Implementation and publishing

- Branch: `codex/roma-demo`, based on `d050b12` (current main at build start).
- Target route after deployment: `/demos/roma`.
- Existing shared frontend assets and client answer functions stay unchanged.
- Only Roma uses the new page and answer module. The shared `index.js` has a
  guarded route choice and guarded `/chat` dispatch; publication requires review.
- Run `npm test` for existing and Roma regression checks.
- Run `npm run preview:roma` for local visual QA with analytics disabled.
- Do not send a prospective deployment URL as though it is already live.

## Verification status — 2026-09-17

- `npm test` passed, including all existing client suites and analytics checks.
- Roma passed 123 distinct question scenarios against both the isolated module
  and the HTTP endpoint, using 42 sourced knowledge entries. Running each case
  twice does not make this 246 different questions.
- Route, public-config, CORS, sensitive-input response and client-isolation
  checks passed. `git diff --check` passed.
- Rendered desktop/mobile visual QA is still pending: the cloud browser blocked
  the local preview URL with `net::ERR_BLOCKED_BY_CLIENT`. Static inspection and
  successful HTTP checks are not a substitute for visual browser verification.
- No push, merge, production deployment or email send was performed during the
  build. Review the shared routing change before publishing, then verify the
  hosted page and its answers before replying with the live link.
