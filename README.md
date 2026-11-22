# kofra-mail

Riaklo Mail is a SvelteKit webmail app built for Cloudflare Workers. This repository currently runs a demo with example data. It does not connect to a real mailbox, and all changes reset on reload.

## Run locally

Use Node.js 24 and npm.

```sh
npm ci --ignore-scripts
npm run dev
npm run check
npm test
npm run build
npm exec -- playwright install chromium
npm run test:e2e
```

`packages/mail-core` defines the TypeScript interface consumed by `apps/web` and its in-memory implementation. The interface is not a published HTTP or JMAP contract. `npm run build` builds a Worker locally; it does not deploy.

## Formatted message demo

Formatted message rendering is off by default; the app uses plain text when no content origin is configured. To try the authored fixture locally, run these in two terminals from the repository root:

```sh
node apps/web/tests/fixtures/content-server.mjs
MAIL_DEMO_CONTENT_ORIGIN=http://localhost:4180 npm run dev -w @kofra/mail-web -- --host 127.0.0.1 --port 4179 --strictPort
```

Open `http://127.0.0.1:4179` and select “Floor plan revisions.” Images are blocked until you choose **Show images** in that message. The fixture serves static HTML and one local image; it does not process arbitrary messages or perform external requests.

Use a dedicated, credential-free HTTPS site for real content, on a different registrable domain from the app and any storage or account services. The loopback HTTP exception is only for development with distinct loopback hosts. The app checks the frame origin, applies `frame-src`, and grants neither scripts nor same-origin access in the frame. It never receives message HTML as API data. The content service must sanitize HTML, authorize short-lived body URLs, prohibit direct remote image loads with its own CSP, and supply proxy URLs only after explicit opt-in. Those service features are not implemented here.

Licensed under the MIT License; see [LICENSE](LICENSE).
