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

Licensed under the MIT License; see [LICENSE](LICENSE).
