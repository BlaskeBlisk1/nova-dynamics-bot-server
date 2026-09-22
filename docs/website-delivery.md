# Signed website enquiry delivery

The existing `jemlio-demo-request` Netlify form remains the primary website
intake. Its action, confirmation page and all seven chatbot demo URLs are
unchanged. This receiver handles a signed notification **after Netlify has saved
the submission**. It does not replace the form with a direct browser API call.

## Receiver and storage

Send a form-specific Netlify HTTP POST notification to:

`https://nova-dynamics-bot-server.onrender.com/api/website-enquiries/netlify`

Configure its JWS secret privately. The receiver verifies HS256,
`iss=netlify` and the SHA-256 of the original body bytes. An unsigned, altered,
oversized or wrong-form request cannot enqueue delivery. Mounting this route
before Express JSON parsing is required. The route has no public chat CORS.

Source: [Netlify notification signatures](https://docs.netlify.com/deploy/deploy-notifications/#payload-signature)
and [form notifications](https://docs.netlify.com/manage/forms/notifications/).
The form notification's actual payload and signature still require a controlled
production check before this integration is described as live.

The configured site ID, form ID and native submission ID produce one stable
internal submission UUID. PostgreSQL saves the enquiry, frozen email and CRM
payload in the existing transaction. An identical retry returns the same receipt;
changed contact data under the same source ID conflicts instead of overwriting it.
IP, user-agent, referrer, provider-rendered summaries and chat transcripts are not
retained by this receiver. Only the consented website fields are copied.

The internal client is `jemlio-website`. Website and pilot workers claim separate
queues in PostgreSQL, including when both run concurrently. Provider failures
retry independently using the existing immutable email key and Airtable Receipt
upsert. Staff Status and Notes are never overwritten. The website's submitted
message uses a separate `Visitor message` long-text field.

There is no new schema migration. Existing operator status, outcome reporting and
protected deletion commands cover this client. A source-ID tombstone prevents a
later signed webhook replay from recreating a deleted enquiry or its deliveries.

## Explicit configuration

All switches default off. Configure the **production Render service**, not the
public website JavaScript. Never place credentials in source or webhook URLs.

| Variable | Setting |
| --- | --- |
| `JEMLIO_WEBSITE_ENQUIRY_ENABLED` | `true` only after source and storage verification |
| `JEMLIO_NETLIFY_SITE_ID` | Existing Jemlio Netlify site ID |
| `JEMLIO_NETLIFY_FORM_ID` | Verified `jemlio-demo-request` native form ID |
| `JEMLIO_NETLIFY_WEBHOOK_SECRET` | Separate random secret, at least 32 characters, also configured in the Netlify notification |
| `JEMLIO_WEBSITE_RECIPIENT` | Explicitly approved Jemlio inbox; never supplied by a visitor |
| `JEMLIO_WEBSITE_AIRTABLE_BASE_ID` | Approved CRM base |
| `JEMLIO_WEBSITE_AIRTABLE_TABLE_ID` | Its Inbound Enquiries table |
| `JEMLIO_WEBSITE_CRM_ENABLED` | Opt in to website CRM dispatch |
| `JEMLIO_WEBSITE_EMAIL_ENABLED` | Opt in to website email dispatch after an approved delivery test |

Reuse the installed `NOVA_DATABASE_URL`, `NOVA_CAPTURE_FROM`, `RESEND_API_KEY` and
`AIRTABLE_PERSONAL_ACCESS_TOKEN`. The website has separate switches from
`NOVA_CAPTURE_ENABLED`, `NOVA_CAPTURE_WORKER_ENABLED` and `NOVA_CAPTURE_CRM_ENABLED`.
Do not enable customer-demo capture to activate the website receiver.

Intake saves both outboxes even when a website delivery switch is off. Such
pending items remain held, including across restarts. Do not activate dispatch
without reviewing any held cohort and its frozen destination. Changing a recipient
does not reroute old mail; the worker holds a mismatched destination for review.

## Activation and verification

1. Confirm the current public privacy notice describes the intended database,
   Airtable and email processing, and confirm the operator's retention process.
2. Add `Visitor message` (long text) to Inbound Enquiries. Keep its existing Source
   choice `Jemlio website`, Receipt, contact fields, Status and Notes.
3. Add a notification for **only** `jemlio-demo-request` under Netlify Forms →
   Submission notifications, using the endpoint and dedicated JWS secret.
4. After the owner approves one synthetic notification email, enable the website
   intake and dispatch switches with the owner inbox as the sole recipient.
   Submit a clearly labeled synthetic form. Read back its native Netlify ID,
   durable receipt, Airtable record and actual email outcome. Never use a prospect
   as a test recipient. An HTTP 201 or Resend acceptance is not inbox delivery.
5. Replay the same signed event or use the same stored source record through the
   operator recovery process; verify the same receipt without another email or
   CRM row. Do not create a new source ID to retry uncertain delivery.

Netlify's webhook retry policy is not assumed to guarantee eventual delivery.
If a notification does not reach this server, the submission remains in Netlify.
Reconcile Netlify's saved submissions against receiver records after outages.
This implementation does not automatically import old submissions or delete
Netlify/Airtable/mailbox copies. Those copies need the agreed separate handling.

```sh
npm run capture:status
npm run capture:operations -- report --client jemlio-website
npm run capture:operations -- delete --client jemlio-website --receipt UUID
```

The final command is a dry run; unresolved email or CRM delivery remains protected.
`GET /api/website-enquiries/netlify/status` reports configuration only. It is not
evidence that Netlify has a notification configured or that data has been saved.

To stop website forwarding, set `JEMLIO_WEBSITE_ENQUIRY_ENABLED=false` and both
website dispatch switches to false, then restart. Remove or disable its Netlify
notification if needed. The native form still saves enquiries in Netlify; the
chatbot demos, pending database records and original source submissions remain.
