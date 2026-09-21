# Jemlio website and domain rollout

The marketing site lives in `public/marketing/`. It uses the approved white Jemlio wordmark and blue orbital O. On the existing Render service, visit `/jemlio/`; the root harness and all previously shared `/demos/:client` links remain available.

## Publish the existing Netlify site

Keep the existing Netlify site (`prismatic-taffy-e96ac7`). Connect this repository with main as the production branch and `public/marketing` as the publish directory; no build command is needed. `netlify.toml` includes the publish path. Alternatively deploy the contents of that folder, including `_redirects` and `_headers`, to the existing site.

The `/chat` proxy targets the stable Render service. `/jemlio/*` redirects to the corresponding marketing path. No customer demos are moved to Netlify.

The contact form submits a visitor-requested mini-demo enquiry directly to Netlify Forms on the canonical Jemlio website. A honeypot, affirmative contact request, duplicate-submit guard and explicit uncertain state protect the submission path. Email composition and copy/manual fallback preserve the entered details. Form processing must be verified after each deployment; a connection to Google Workspace does not automatically configure Netlify email notifications. The public mailbox is `hei@jemlio.com`, now managed through Google Workspace according to the completed setup. Customer-demo contact collection is separate and remains disabled until its database, sender and pilot routing are verified.

The 20 September product release adds clearer demo/pilot copy, a post-answer mini-demo call to action, a confirmation page and updated provider/privacy information. It enables conversation context only for Tiller and Frank Olsen while retaining all seven customer demo links. Run `npm test` for legacy, context, HTTP, capture, operator and DOM checks; deployment verification belongs in the release PR. The domain-cutover entries below are historical evidence.

## Current cutover status — 19 September 2026

The Jemlio domain cutover is **live and verified** at `https://www.jemlio.com/`.

- Domeneshop has `jemlio.com` ANAME → `apex-loadbalancer.netlify.com` and `www.jemlio.com` CNAME → `prismatic-taffy-e96ac7.netlify.app`, both with TTL 300. Netlify verified the DNS settings. Independent Google and Cloudflare DNS checks confirmed the www CNAME points to Netlify; apex A records match Netlify's load balancer. Existing MX, TXT and other unrelated records were unchanged.
- `www.jemlio.com` is Netlify's primary domain, and `jemlio.com` redirects to it. Netlify reports HTTPS enabled with a Let's Encrypt certificate covering both new domains. Ordinary HTTPS requests with default certificate verification returned 200 for the new site and verified the apex redirect without any TLS bypass.
- Render is live with `JEMLIO_MARKETING_ORIGINS=https://www.jemlio.com,https://jemlio.com`. The three Jemlio chats each returned 200 through the new site's `/chat` proxy with the new Origin and relevant bounded answers. An unrelated Origin returned 403. Existing origins and service/API identifiers remain unchanged.
- Both old Nova names retain Domeneshop forwarding, updated in place to `https://www.jemlio.com`; their web records did not need replacing. HTTPS and HTTP roots for `nova-dynamics.no` and `www.nova-dynamics.no` were verified to redirect to the new site. Their `/solutions` and `/demo` links reach `#losningen` and `#demo`; `/contact?source=legacy` reaches `https://www.jemlio.com/?source=legacy#contact`, preserving the query. The temporary certificate/forwarding blocker was resolved through this route; no further approval is needed for the completed cutover.
- Netlify production is deploy `6aaedc8ffc3faf975099be58`, published `2026-09-19T19:03:48.577Z`, with 18 redirect rules and one header rule processed without errors. The new canonical metadata and domain redirects are deployed. HTTPS checks confirmed the homepage canonical, privacy canonical, apex redirects and old Netlify-host redirects, including path/query preservation.
- All seven existing Render `/demos/:client` pages and corresponding `/api/demo-config/:client` routes returned 200; each configuration retained its matching client ID. Customer demo URLs and disabled PR14 capture features remain unchanged.

The remote browser still reported a certificate hostname mismatch on its network path during verification, so this cutover does not claim a fresh visual browser review on the new domain. The independent HTTPS checks above succeeded with normal certificate validation; the page's visual review was completed on the earlier Netlify deployment.

## Jemlio domain configuration

The owned domain is `jemlio.com`, registered with Domeneshop. The canonical marketing URL is `https://www.jemlio.com/`. Homepage canonical and Open Graph metadata use that URL; the privacy page canonical is `https://www.jemlio.com/privacy`.

1. Add `jemlio.com` and `www.jemlio.com` to the existing Netlify site's custom domains and select `www.jemlio.com` as primary. Keep DNS at Domeneshop: point `www` by CNAME to `prismatic-taffy-e96ac7.netlify.app` and the apex by ANAME/ALIAS to `apex-loadbalancer.netlify.com` if supported, otherwise by A record to `75.2.60.5`. Confirm the site's own DNS instructions before applying values. Preserve existing mail and verification records; resolve only conflicting web records or forwarding. Wait for HTTPS to be valid. Do not change the Render hostname or repository name.
2. Set `JEMLIO_MARKETING_ORIGINS` on Render to `https://www.jemlio.com,https://jemlio.com` and deploy the environment change. Keep existing origins: the code retains them automatically.
3. Verify a real browser can load the site and ask one question in each of the three new chats. Verify rejected unrelated origins still receive HTTP403. If routing through the same-origin Netlify proxy, confirm forwarded browser origins are accepted.
4. Keep the existing Domeneshop forwarding for `nova-dynamics.no` and `www.nova-dynamics.no` directed to `https://www.jemlio.com`. This verified route preserves paths and query parameters without replacing the old web records. The deployed `_redirects` also handles legacy aliases that reach Netlify, the old Netlify hostname and the Jemlio apex. Existing `/solutions`, `/demo` and `/contact` links resolve to their matching homepage sections. Ordinary fragment links remain browser-side across host redirects. The `/chat` proxy stays first, so existing POST clients continue working without a method-changing redirect. Verify every public host and old path after publication. Keep Render `/demos/` URLs unchanged for previously emailed links.
5. The new mailbox `hei@jemlio.com` is verified and used by visible contact links, email composition, privacy contact details, and the three Jemlio assistant paths. Update registered business details when confirmed. Configure SPF/DKIM/DMARC through the actual mail provider before using a new sender address. No email sender changes happen automatically with the website domain.

Only exact origins are accepted: production HTTPS; local development HTTP localhost is supported. Wildcards, paths, credentials, query strings and production HTTP are rejected. The owned Jemlio origins are configured through the environment rather than hardcoded into the compatibility allowlist.

## Compatibility boundaries

Public brand names can change independently of infrastructure identifiers. Preserve:

- Render service/repository names and its current onrender.com address.
- Tenant slugs `fram`, `fyllingsdalen`, `onsoy`, `tiller`, `trafikk1`, `frankolsen`, `roma` and their demo URLs.
- Existing PostHog event names, session keys and `nova-demo` product identifier, so historical usage stays comparable.
- Internal theme keys/CSS hooks such as `nova` and `.nova-credit`.
- PR14's `NOVA_*` environment keys, database tables and idempotency keys. Rebranding does not migrate data or activate capture. Its per-client `allowedOrigins` are separate from `JEMLIO_MARKETING_ORIGINS`.

The new `jemlio`, `jemlio-driving-demo` and `jemlio-optician-demo` clients have isolated deterministic handlers. The two industry examples are explicitly fictional, with no client endorsement, real booking or medical advice. They never enter the generic model fallback. The marketing page adds no analytics or advertising cookies.

## Validation

Run `npm test` for the existing demos and `npm run test:brand` for exact-origin handling, all old demo/config URLs, new example answers and safety fallbacks. Check marketing JavaScript with `node --check public/marketing/site.js`.

After deployment, visually inspect desktop and mobile layouts, both example tabs, custom questions, support launcher/close, keyboard focus, FAQ and email draft preparation. Never submit a real test email without authorization. Keep contact fields intact when an email app cannot open.

## Rollback

Revert the website rebrand commit on main to restore the previous Render code. On Netlify, publish the previous successful deploy. No database, existing client identifiers or old shared URLs are changed by this rollout.
