# Content origin: formatted bodies, attachments and remote images

Status: design, version 1. It pairs with the [Mail API contract](../contracts/mail-api/README.md) (`getBodyUrl`, `getAttachmentUrl`).

**Goal.** Message HTML, inline images, remote images and attachment bytes never run or render on the mail app's origin. A message cannot read the app's cookies, its DOM, other messages or the user's IP address.

## 1. Layout

| Host | Serves | Cookies |
|---|---|---|
| `mail.<suite-domain>` | the app and `/api/v1` | the app session only |
| `content.<content-domain>` | sanitised bodies, inline (`cid:`) images, attachment downloads, and the remote-image proxy | **none, ever** |

**The content domain:**
- It is a dedicated **registrable** domain. It is neither the suite domain nor any storage or account domain, so it is cross-site to the app.
- It hosts nothing else: no other Workers, no sign-in and no email.
- It sends `Strict-Transport-Security: max-age=31536000; includeSubDomains`.

**The `mail-content` Worker:**
- It runs on `content.<content-domain>` and holds the URL-signing keys.
- It uses one separate read-only object-store credential pair with one grant per authorised workspace mail bucket (`mail-<workspace_id>`). It derives the bucket from the verified `ws` claim, never from other input, and reads only keys of the form `raw/<sha256>/<gen>` or `att/<sha256>/<gen>` that the mailbox Durable Object returned. Checking the grants is an operator acceptance step at deploy, and provisioning a workspace adds its grant. Separate credentials selected per workspace are not implemented.
- It has two service bindings and no direct mailbox storage bindings: `MAIL_LOOKUP` to a read-only named entrypoint of the mail backend (`ContentLookup`: the mailbox owner and the owner-checked message record, no mutation methods) and a named account entrypoint that exposes only `credentialEpoch`. It has no D1, Durable Object, queue, KV or R2 binding. A lookup on a cold mailbox still runs the Durable Object constructor's existing schema and alarm self-repair; the lookup method itself only reads.
- It has no VPC, Tunnel or other binding into a private network.

**The app:**
- It reads the content origin from trusted server configuration and checks it with `separateContentOrigin` (`apps/web/src/lib/content-origin.ts`): `https:`, a different registrable domain, and no credentials or path.
- It sends `frame-src https://content.<content-domain>` in its own CSP.
- It embeds a body only as:

```html
<iframe src="…signed body URL…" sandbox="allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer"></iframe>
```

The iframe has no `allow-scripts`, no `allow-same-origin`, no `allow-top-navigation` and no `allow-forms`. A `srcdoc` iframe is not used: it would inherit the app's origin and CSP.

## 2. Signed URLs

### 2.1 Format

```
https://content.<content-domain>/v1/<purpose>/<kid>.<payload>.<mac>
```

- **`purpose`** is `body`, `cid`, `att` or `img`. `lnk` is reserved for revocable file links (a planned outbound package, drafted in pull request #11): it adds a link-id claim, and the verifier checks the link is live on every request.
- **`payload`** is base64url (no padding) of compact JSON claims:

| Claim | Meaning | Purposes |
|---|---|---|
| `v` | `1` | all |
| `ws`, `mb` | workspace id and mailbox id | all |
| `msg` | message id | all |
| `part` | MIME part index | `cid`, `att` |
| `ri` | remote images allowed (boolean) | `body` |
| `u` | the exact remote image URL, at most 2,048 bytes | `img` |
| `sub` | account user id of the mailbox owner at mint time | all |
| `ep` | the user's credential epoch at mint time | all |
| `iat`, `exp` | issue and expiry time, Unix seconds | all |

- **`mac`** is base64url of HMAC-SHA-256 under key `kid`, over the bytes of `"kofra-mail-content/v1\n" + purpose + "\n" + payload`. The purpose is inside the MAC, so a token for one purpose is refused on another path.
- **No encryption.** Claims are opaque ids, the URL is visible only to the signed-in user's page, and both origins send `Referrer-Policy: no-referrer`. The claims carry no session secret, no address and no content.

### 2.2 Minting

- **Bodies and attachments:** `mail-web` authenticates the session and resolves its mailbox. It then calls `mintForWeb(purpose, claims)` on the `mail-content` Worker over a service binding: an RPC entrypoint that is not reachable from the internet.
  - Only `mail-content` holds the keys.
  - `mail-web` sets `ws`, `mb` and `sub` from the session, never from request input.
- **`cid` and `img` URLs** are minted by `mail-content` itself, while it sanitises a body it has already authorised. They copy that body token's `ws`, `mb`, `msg`, `sub`, `ep` and `exp`, so a body's images expire with the body.
- **Lifetime:** `exp - iat` is at most `contentUrlSeconds` (300 s). The verifier rejects any token with a longer span, so a minting bug cannot issue long-lived URLs. The app mints a new URL when the user reopens a message after expiry.

### 2.3 Verification, in order

Every step must pass. Any failure answers 404 with an empty body, and the reason is never shown.

1. **Format:** exactly three parts, a known `kid`, `v = 1`, a payload of at most 4 KiB, and the token's purpose equal to the path segment.
2. **MAC:** `crypto.subtle.verify` (constant time).
3. **Time:** `iat - 30 s ≤ now < exp`, `iat < exp`, and `exp - iat ≤ 300`.
4. **For `body`, `cid` and `att`, still authorised:**
   - The account service confirms the credential epoch of `sub` is still `ep`. The answer is cached for at most 60 seconds, as the app does.
   - A point lookup in the directory confirms that mailbox `mb` is still owned by `sub`.
5. **For `body`, `cid` and `att`, the message still exists:** the mailbox Durable Object (`ws`, `mb`) returns the message's raw key, attachment object keys and verdict. A message that was deleted or expired answers 404. The Durable Object is addressed only from the token's claims.

`img` tokens skip steps 4 and 5. They reveal no mailbox data: they only let the holder fetch one public URL through the proxy until `exp`.

### 2.4 Keys and rotation

- **The secret:** `CONTENT_URL_KEYS` is a Worker secret of `mail-content`, as JSON `{ "current": "<kid>", "keys": { "<kid>": "<32 random bytes, base64>" } }`.
  - It is generated with `openssl rand`, piped to `wrangler secret put` through stdin, and never printed, logged or committed.
  - `kid` is a short, non-secret label such as `k3`.
- **Rotation:**
  1. Add the new key.
  2. Deploy.
  3. Switch `current` to it.
  4. Wait at least 5 minutes plus 30 seconds of skew.
  5. Remove the old key.
- **Emergency revocation** (for example a leaked current key): one secret update to `{ "current": "<new kid>", "keys": { "<new kid>": "<new key>" } }`, which removes every other key, the current one included. All outstanding URLs then fail at step 1.
- **Gradual deployments:** a Worker version still running beside the new one keeps minting with its old `kid`. Step 4's wait starts only when every request is served by a version that has the new `current`, and an emergency revocation is deployed to all traffic at once.

### 2.5 Revocation summary

"Dead" means the verifier refuses the URL. Every response is `no-store` (section 3.1), so the browser keeps no copy it could show without asking the verifier again.

| Event | `body`, `cid`, `att` | `img` |
|---|---|---|
| Time passes | Dead after at most 5 minutes | Dead at the body token's `exp`, at most 5 minutes |
| Password change or reset, factor change, "sign out everywhere" (the credential epoch rises) | Dead within 60 s (step 4) | Lives until its `exp` |
| Message deleted, expired or purged | Dead at once (step 5) | Lives until its `exp` |
| Mailbox given to another member | Dead at once (step 4, directory owner) | Lives until its `exp` |
| Key removed | Dead at once (step 1) | Dead at once (step 1) |
| Ordinary sign-out of one session | URLs already minted live out their at most 5 minutes. They exist only in that session's page, which the sign-out has closed | The same |

An `img` URL skips steps 4 and 5 because it carries no mailbox data: it lets its holder fetch one public image URL through the proxy, and the image comes from the sender's server, not from the mailbox. Its life is never longer than the body token it was minted from.

## 3. Responses

The raw MIME is read and parsed under a per-isolate budget that is released before the response starts; a request that cannot reserve within 2 s answers 503 with Retry-After. Any reservation that spans a response transfer is released on close, on cancel or 60 s after the response starts.

Overlapping reads of the same raw key within a workspace share one admission and parse. A subject can lead one read with at most one additional request joining it, or join another subject's read once. Extra requests from that subject return 503 immediately.

### 3.1 Headers on every response

```
Content-Security-Policy: default-src 'none'; img-src https://content.<content-domain> data:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors https://mail.<suite-domain>; sandbox allow-popups allow-popups-to-escape-sandbox
Referrer-Policy: no-referrer
X-Content-Type-Options: nosniff
Cache-Control: private, no-store
```

- **The CSP `sandbox` directive** gives the document an opaque origin even if someone opens the URL in a top-level tab.
- **`frame-ancestors`** stops other sites from framing a leaked URL.
- **Scripts:** there is no `script-src`, so `default-src 'none'` forbids scripts even if the sanitiser misses one.
- **`img-src`** names the content host explicitly. Under `sandbox` the document's origin is opaque, so `'self'` is not relied on.
- **`no-store` applies to every response,** including `cid` and image proxy responses. A browser cache entry could otherwise be reused after the token expired or was revoked; with `no-store`, every use of a signed URL passes the verifier.

### 3.2 `body`

**Steps:**
1. Read the raw MIME from object storage with the read-only key.
2. Check its SHA-256 against the content-addressed key.
3. Parse it.
4. Pick the HTML part. A plain-text-only message is rendered as escaped text in `<pre>`, so long text has one display path.
5. Sanitise (section 4) and wrap in a minimal document with `<meta charset="utf-8">` and a base stylesheet: system font, `overflow-wrap: anywhere`, `img { max-width: 100% }`. Count the expanded HTML in UTF-8 before materialising it; if it exceeds 8 MiB, use escaped plain text that fits or a neutral notice.

**Inline images:** `cid:` references become `cid` URLs for that message's parts.

**Remote images:**
- With `ri` false, remote images are replaced by an empty placeholder. No URL is emitted, so nothing is fetched.
- With `ri` true, each remote `http(s)` image becomes an `img` URL. At most 100 per body; any beyond that get the placeholder.
- **Phishing:** for a message whose verdict is `phishing`, `ri` is ignored (images stay blocked) and every link's `href` is removed, leaving its text.

### 3.3 `cid`

- The part must be `image/png`, `image/jpeg`, `image/gif` or `image/webp`, and its magic bytes must match.
- It is served with that type and `Content-Disposition: inline`.
- Anything else answers 404.

### 3.4 `att`

- The part is streamed: from its own content-addressed object when one exists (parts of 256 KiB or more), otherwise decoded from the raw MIME. Object-backed `att` and `cid` transfers have 60 seconds to receive headers and a 30-second upstream idle timeout between chunks, not a total body deadline.
- **Headers:**
  - always `Content-Type: application/octet-stream`;
  - `Content-Disposition: attachment; filename="<ASCII fallback>"; filename*=UTF-8''<percent-encoded name>`. The name has control characters, `/` and `\` removed and is at most 255 bytes. In the ASCII fallback, `"`, `\`, `;` and every non-ASCII character are replaced by `_`, so a name from the message cannot add or end a parameter; `filename*` carries the full name, percent-encoded.
- **It is never rendered.** Previews are not part of version 1.

## 4. Sanitiser

**How it works:** an allowlist sanitiser built on the Workers `HTMLRewriter`, with no DOM and no new dependency. Anything not listed is removed.

**Elements:**
- **Kept:** `a abbr b blockquote br caption center code col colgroup dd del div dl dt em font h1 h2 h3 h4 h5 h6 hr i img ins li ol p pre q s small span strike strong style sub sup table tbody td tfoot th thead tr tt u ul wbr`.
- **Unwrapped** (tag removed, children kept): `html head body` and unknown elements.
- **Removed with their content:** `script noscript template iframe frame frameset object embed applet form input button select textarea option svg math link meta base title audio video source track canvas xmp noembed noframes plaintext listing`.
- **Raw-text elements are never unwrapped.** `HTMLRewriter` passes the contents of raw-text and RCDATA elements through as unescaped text, so unwrapping one would turn its text into live markup that the attribute and URL rules never saw. Every element whose contents the HTML tokenizer reads as raw text or RCDATA (`script style textarea title xmp iframe noembed noframes noscript plaintext`) is either removed with its content or, for `style`, kept with its text sanitised as CSS.
- **Comments are removed**, including Outlook conditional comments.

**Attributes:**
- **Global:** `align valign bgcolor color width height border cellpadding cellspacing colspan rowspan dir lang class style title`.
- **`a`:** `href`.
- **`img`:** `src alt`.
- **Everything else is removed**, including every `on*`, `srcset`, `background`, `formaction`, `xmlns` and `data-*`.

**URLs:**
- **`a href`:** only `https:`, `http:` and `mailto:` are kept. Every anchor gets `target="_blank" rel="noopener noreferrer"`.
- **`img src`:** only `cid:`, `data:image/(png|jpeg|gif|webp)` up to 64 KiB, or remote `http(s)`. Remote URLs are rewritten as in section 3.2.

**CSS** (in `style` attributes and `<style>` elements):
- Removed: `@import`, `@font-face`, `expression(…)`, `behavior`, `-moz-binding`, and `url(…)` other than `data:image/…`.
- When remote images are in effect (`ri` true and the verdict is not `phishing`), remote `url(…)` in `background`/`background-image` is rewritten to an `img` URL, like an `<img>`.
- `position: fixed` and `position: sticky` become `position: static`.
- **The phishing and suspicious-sender warnings are drawn by the app, above the iframe and outside it,** never inside the content document. Message CSS cannot paint outside its iframe, so no `position`, `z-index`, `transform` or negative margin can cover or hide them.

**Version and caching:** sanitiser output carries a `sanitizer` version number. Any later output cache stores **token-free** output, with each `cid` and remote-image reference left as a placeholder, keyed by `(raw digest, ri, verdict, version)`. The Worker mints the `cid` and `img` URLs into the cached output for each authorised response, from that response's own body token. A cached body therefore never carries another mailbox's or another request's tokens, expiry or revocation scope.

## 5. Remote-image proxy (`img`)

**What it does:**
- It loads remote images only after the user chooses "Show images" for that message.
- It hides the reader's IP address, cookies and referrer.
- It refuses anything that is not a validly signed `img` token.

**Policy:**
1. **Methods:** `GET` only; `HEAD` answers 405.
2. **URL:**
   - only `http:` and `https:`, ports 80 and 443, no user information, at most 2,048 bytes;
   - the host must be a DNS name. IP literals (IPv4, IPv6 and integer forms) are refused. A DNS name that resolves to a private address cannot reach anything: Workers `fetch` has no route into private networks, and `mail-content` has no VPC, Tunnel or other private binding (section 1).
   - Refused host names: `localhost`, `*.localhost`, `*.local`, `*.internal`, `*.arpa`, the suite domain, the content domain, the storage and account domains, and the account's `workers.dev` subdomain, all as configuration. This stops the proxy from reaching our own services or itself.
3. **The fetch:**
   - `redirect: 'manual'`, following at most `remoteImageRedirects` (3) hops. Each `Location` is resolved and checked again under rule 2.
   - A 10-second total timeout.
   - Request headers are only `Accept: image/avif,image/webp,image/png,image/*;q=0.8` and a fixed generic `User-Agent`. No cookies, `Referer`, `X-Forwarded-For` or client hints are sent.
4. **The response:**
   - status 200 only;
   - `Content-Type` must be `image/png`, `image/jpeg`, `image/gif`, `image/webp`, `image/avif`, `image/bmp` or `image/x-icon`, and the first bytes must match that type. **SVG is refused.**
   - The body is read into memory, at most `remoteImageBytes` (5 MiB), **before** the response starts: an image that turns out larger, or a fetch that times out, still answers 404 with an empty body, and nothing is cached. A response with no declared length is handled the same way.
   - Concurrent image reads in one isolate share an in-flight budget (32 MiB); a read that cannot reserve its bytes fails as too large.
   - Outgoing headers are rebuilt from scratch: the normalised `Content-Type`, `Content-Length` when known, and the security headers of section 3.1. No upstream header is passed through.
5. **Failures:** anything else answers 404 with an empty body, so the browser shows a broken image.
6. Version 1 keeps no fetch cache; every image request fetches upstream after verification.
7. **Logging:** never the token, never the remote URL. Only the purpose, status, byte count and the first 8 characters of `SHA-256(token)`. Workers invocation logs are off for mail-content; any log export is an operator acceptance step that verifies request URLs are redacted.

**What users should know:** proxying still tells a sender that someone opened the message, and when. That is why images stay blocked until the user asks. The UI says so next to "Show images".

## 6. Build lane and acceptance

| Package | Builder | Review |
|---|---|---|
| C1: token mint and verify, key loading, rotation, the epoch and owner checks | Opus (crypto and authorisation) | security review (Opus high) plus general review (Sol) |
| C2: sanitiser and the vector corpus | Sol, under this spec | security review (Opus high) |
| C3: proxy URL and redirect policy | Opus (SSRF guard) | security review (Opus high) |
| C4: `body`/`cid`/`att`/`img` handlers, headers, streaming, the `mail-web` mint call | Sol | general review (Sol) plus security review (Opus high) |

**Acceptance (all in local workerd; no live domain):**
1. **Tokens:**
   - A round trip works.
   - A flipped bit in the payload or MAC fails.
   - A wrong purpose path fails.
   - An unknown `kid` fails.
   - `exp - iat = 301` fails.
   - The MAC is checked with `crypto.subtle.verify`, never with a string comparison.
2. **Authorisation:**
   - A raised epoch fails within the cache TTL.
   - A reassigned mailbox fails.
   - A deleted message fails.
   - A token for mailbox A never reads mailbox B, even when B's ids are substituted into the path.
3. **Sanitiser:**
   - A corpus of at least 150 vectors (html5sec-style plus real newsletter samples written for the tests) leaves no element, attribute, URL scheme or CSS construct outside section 4. It includes markup hidden inside `xmp`, `noembed`, `noframes`, `plaintext`, `listing`, `textarea`, `title` and `noscript`, and a phishing message whose links must all lose `href`.
   - A Playwright test loads every vector in the real iframe and sees no script execution, no network request outside the content host, and no top navigation.
   - Overlay vectors (`position: absolute` with a large `z-index`, `transform`, negative margins) leave the app's warning banner, which is outside the iframe, fully visible and clickable.
4. **Proxy:**
   - Refusals: IP literals, private and own-zone names, a fourth redirect, a redirect to a refused host, SVG, a mislabelled HTML body, more than 5 MiB, and over 10 s.
   - It never forwards a cookie or `Referer`, checked with a local upstream fixture.
   - An upstream body with no `Content-Length` that grows past 5 MiB answers 404, and nothing is cached.
5. **Headers and image verification:**
   - Every response, including `cid` and `img`, has the section 3.1 headers, `Cache-Control: private, no-store` included, and downloads are `application/octet-stream` with `attachment`.
   - Repeated valid requests for the same image fetch upstream each time. Expired or MAC-flipped image tokens answer 404 before an upstream fetch.
6. **Logs:** no token or remote URL appears in captured logs.

**Stop rule:** no live domain, DNS, certificate or secret is created by the lane. Choosing and attaching the content domain is an operator step after review. If the sanitiser cannot meet the corpus with `HTMLRewriter` alone, stop and report the failing vectors instead of adding a dependency.
