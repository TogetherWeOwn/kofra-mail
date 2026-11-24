# kofra-mail

Riaklo Mail is a SvelteKit webmail app built for Cloudflare Workers. The local demo seeds example messages through the inbound path and serves them from a mailbox Durable Object over HTTP. It does not connect to a live mailbox. Local data is discarded when the demo process exits.

## Run locally

Use Node.js 24 and npm. From the repository root:

```sh
npm ci --ignore-scripts
npm ci --prefix workers/mail-backend --ignore-scripts
(cd apps/web && node tests/fixtures/mail-app.mjs)
```

Open the printed loopback URL and select “Floor plan revisions.” Images are blocked until you choose **Show images**. The isolated content fixture renders escaped text and one local test image; it does not proxy external requests. Add `--plain` to try the reader with no content origin configured.

The app uses [`contracts/mail-api`](contracts/mail-api/README.md) over `/api/v1`. The local API uses a loopback-only session fixture; the shipped app has no session provider or enabled API. Sending, local uploads, and Drive are not available in the demo. Expired Spam and Trash are hidden from mailbox reads and content downloads; the local API does not reclaim their storage.

## Verify

```sh
npm run check
npm test
npm run build
npm --prefix workers/mail-backend run typecheck
npm --prefix workers/mail-backend test
npm exec -- playwright install chromium
npm run test:e2e
```

The backend test includes HTTP conformance in local workerd. Only cases requiring the later send and upload implementation are marked `requires: m3`; the in-memory contract test still runs those cases. `npm run build` builds a Worker locally; it does not deploy.

## Content isolation

Use a dedicated, credential-free HTTPS site for real content, on a different registrable domain from the app and any storage or account services. The loopback HTTP exception is only for development with distinct loopback hosts. The app checks the frame origin, applies `frame-src`, and grants neither scripts nor same-origin access in the frame. It never receives message HTML as API data. The content service must sanitize HTML, authorize short-lived body URLs, prohibit direct remote image loads with its own CSP, and supply proxy URLs only after explicit opt-in. Those service features are not implemented here.

Licensed under the MIT License; see [LICENSE](LICENSE).
