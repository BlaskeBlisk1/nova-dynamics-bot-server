# Jemlio completion pass — 22 September 2026

This is a single maintenance release across the seven customer demos, the Jemlio website chat and deployment verification. Existing answers, business routing and enquiry delivery are preserved.

## Visitor experience

- Demo loading has a 25-second deadline, an explicit retry for temporary failures and a distinct missing-link message for HTTP 404. The composer cannot send before configuration is ready.
- A local new-conversation control is available on every demo, including those without server context. Reset clears drafts, pending requests and old retries. Late responses cannot restore a cleared conversation.
- Offline attempts keep the draft and do not contact the server. Reconnecting does not send anything automatically. Failed questions can be retried explicitly; rate limiting has its own explanation, including non-JSON upstream responses.
- Suggestion, follow-up and retry clicks preserve a different question in the composer. Input-method composition cannot accidentally submit unfinished text. A failed response discards uncertain server context.
- The website's example chats and support chat have consistent retry behavior. Support now has its own reset control. Switching the example type cancels the previous request and timer. Uncertain answers do not reveal the success-driven demo CTA.
- Narrow layouts put chat before the suggestions panel and bound the transcript area. Composer text uses 16px on narrow screens; reset/retry targets are at least 44px. Long words and links wrap, text answers retain line breaks, and transcript regions are keyboard focusable. Light panels keep light native controls.
- Customer demos have loading/status announcements, skip links, associated privacy guidance and no-JavaScript help. Private demo pages are marked noindex/nofollow; this is indexing guidance, not authentication.

No question or contact details are newly saved in browser storage or analytics. No automatic retry, booking or customer message is introduced. The native website contact form and existing uncertain-submission guard remain unchanged.

## Release verification

`GET /api/release` returns only the service name and a validated 40-character deployment revision, with no-store caching. Local builds without Render metadata return a null revision. No environment settings or secrets are exposed.

The public smoke workflow waits for its own merged revision, then checks the seven URLs/configs, synthetic FAQ answers, Tiller/Frank Olsen follow-ups, website chat proxies, signed intake enabled, legacy forwarding disabled and the native website form/privacy page. The report distinguishes configuration checks from proof of stored enquiries or provider delivery.

Local DOM tests cover configuration stalls, unavailable/malformed config, offline recovery, IME input, retained drafts, 429 errors, stale buttons, reset and late responses. Existing delivery, privacy and idempotency checks remain mandatory. Browser inspection and exact deployment records belong in the final release handover.

## Completion boundary

Routine polish and release reliability are handled in this batch. Real customer-capture activation still depends on the selected business's agreed recipient, privacy page and allowed origins. A calendar integration, automatic outreach and synchronizing Airtable sales outcomes are larger product features, not unfinished UI polish.
