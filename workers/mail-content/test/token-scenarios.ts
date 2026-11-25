// Runtime-neutral acceptance scenarios for package C1 (docs/content-origin.md sections 2 and 6).
// tokens.test.ts runs each one in Node and again inside workerd (token-fixture-worker.ts).
// Keys are generated per scenario with crypto.getRandomValues; nothing secret-looking is committed.
import { ContentKeysError, contentUrlKeys, loadContentUrlKeys, type ContentUrlKeys } from '../src/keys.ts';
import { CONTENT_URL_SECONDS, checkToken, mint, type Purpose } from '../src/tokens.ts';
import {
  createVerifier, EpochCache, mintFromBody, REFUSED,
  type ContentPorts, type MessageRecord, type Verified, type VerifiedBody,
} from '../src/verify.ts';

export interface ScenarioResult { ok: boolean; error?: string; logs: string[]; sensitive: string[] }
interface Context { sensitive(...values: string[]): void }
interface Scenario { name: string; run(ctx: Context): Promise<void> }

class CheckError extends Error {}
function check(condition: unknown, label: string): asserts condition {
  if (!condition) throw new CheckError(label);
}

const encoder = new TextEncoder();
const NOW = 1_800_000_000;
const DOMAIN = 'kofra-mail-content/v1';

function b64url(bytes: Uint8Array): string {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64url(text: string): Uint8Array {
  return Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
}
function b64(bytes: Uint8Array): string {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}
const hex = (n: number) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
function bytesOf(source: unknown): Uint8Array {
  if (source instanceof ArrayBuffer) return new Uint8Array(source);
  if (ArrayBuffer.isView(source)) return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
  throw new CheckError('not a buffer source');
}
const canon = (value: object) => JSON.stringify(value, Object.keys(value).sort());

interface TestKeys { secret: string; raw: Map<string, Uint8Array>; keys: ContentUrlKeys }
async function makeKeys(current: string, kids: string[], reuse?: Map<string, Uint8Array>): Promise<TestKeys> {
  const raw = new Map<string, Uint8Array>();
  for (const kid of kids) raw.set(kid, reuse?.get(kid) ?? crypto.getRandomValues(new Uint8Array(32)));
  const secret = JSON.stringify({ current, keys: Object.fromEntries([...raw].map(([kid, bytes]) => [kid, b64(bytes)])) });
  return { secret, raw, keys: await loadContentUrlKeys(secret) };
}

/** The spec's MAC, computed independently of src/. */
async function sign(raw: Uint8Array, purpose: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(`${DOMAIN}\n${purpose}\n${payload}`))));
}
/** A correctly MACed token over arbitrary claims, so a refusal can only come from a format or time rule. */
async function forge(k: TestKeys, kid: string, purpose: string, claims: unknown): Promise<string> {
  const payload = b64url(typeof claims === 'string' ? encoder.encode(claims) : claims instanceof Uint8Array ? claims : encoder.encode(JSON.stringify(claims)));
  return `${kid}.${payload}.${await sign(k.raw.get(kid)!, purpose, payload)}`;
}
function parts(token: string) {
  const [kid, payload, mac] = token.split('.');
  return { kid, payload, mac };
}
function decodeClaims(token: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(unb64url(parts(token).payload)));
}
const mintAny = (keys: ContentUrlKeys, purpose: string, claims: Record<string, unknown>, now: number) =>
  mint(keys, purpose as Purpose, claims as never, now);

interface Ids { ws: string; mb: string; msg: string; sub: string }
const newIds = (): Ids => ({ ws: `ws-${hex(6)}`, mb: `mb-${hex(6)}`, msg: `msg-${hex(6)}`, sub: `usr-${hex(6)}` });
const full = (ids: Ids, extra: Record<string, unknown>, ep = 1, iat = NOW, exp = NOW + CONTENT_URL_SECONDS) =>
  ({ v: 1, ...ids, ...extra, ep, iat, exp });

class World implements ContentPorts {
  epochs = new Map<string, number>();
  owners = new Map<string, string>();
  messages = new Map<string, MessageRecord>();
  calls: string[][] = [];
  broken = false;
  add(ids: Ids, ep = 1) {
    this.epochs.set(ids.sub, ep);
    this.owners.set(`${ids.ws}/${ids.mb}`, ids.sub);
    this.messages.set(`${ids.ws}/${ids.mb}/${ids.msg}`, { rawKey: `raw/${hex(32)}/1`, attachmentKeys: [`att/${hex(32)}/1`], verdict: 'pass' });
  }
  record(ids: Ids) { return this.messages.get(`${ids.ws}/${ids.mb}/${ids.msg}`); }
  async credentialEpoch(sub: string) {
    this.calls.push(['credentialEpoch', sub]);
    if (this.broken) throw new Error(`port failed for ${sub}`);
    return this.epochs.get(sub) ?? null;
  }
  async mailboxOwner(ws: string, mb: string) {
    this.calls.push(['mailboxOwner', ws, mb]);
    if (this.broken) throw new Error(`port failed for ${mb}`);
    return this.owners.get(`${ws}/${mb}`) ?? null;
  }
  async message(ws: string, mb: string, msg: string) {
    this.calls.push(['message', ws, mb, msg]);
    if (this.broken) throw new Error(`port failed for ${msg}`);
    return this.messages.get(`${ws}/${mb}/${msg}`) ?? null;
  }
}

async function setup(ctx: Context, extra: { ep?: number } = {}) {
  const k = await makeKeys('k1', ['k1']);
  const ids = newIds();
  const world = new World();
  world.add(ids, extra.ep ?? 1);
  const epochs = new EpochCache();
  const verifier = createVerifier({ keys: k.keys, ports: world, epochs });
  ctx.sensitive(...Object.values(ids));
  const issue = async (purpose: string, claims: Record<string, unknown>, now = NOW) => {
    const token = await mintAny(k.keys, purpose, { ...ids, ep: extra.ep ?? 1, ...claims }, now);
    ctx.sensitive(token, parts(token).payload, parts(token).mac);
    return token;
  };
  return { k, ids, world, epochs, verifier, issue };
}

async function refused(result: Promise<Verified | typeof REFUSED>, label: string) {
  check((await result) === REFUSED, `${label}: expected the single refusal value`);
}
async function accepted(result: Promise<Verified | typeof REFUSED>, label: string): Promise<Verified> {
  const value = await result;
  check(value !== REFUSED && value.ok === true, `${label}: expected acceptance`);
  return value;
}
async function throws(run: () => Promise<unknown>, label: string) {
  let threw = false;
  try { await run(); } catch { threw = true; }
  check(threw, `${label}: expected a throw`);
}

const EXTRA: Record<Purpose, Record<string, unknown>> = {
  body: { ri: true }, cid: { part: 2 }, att: { part: 3 }, img: { u: 'https://sender.example/a.png' },
};
const ALL: Purpose[] = ['body', 'cid', 'att', 'img'];

export const scenarios: Scenario[] = [];
const s = (name: string, run: Scenario['run']) => { scenarios.push({ name, run }); };

// 1. Tokens

s('tokens: round trip for every purpose, MAC matches the spec construction', async (ctx) => {
  const { k, ids, world, verifier, issue } = await setup(ctx);
  for (const purpose of ALL) {
    const token = await issue(purpose, EXTRA[purpose]);
    const { kid, payload, mac } = parts(token);
    check(token.split('.').length === 3 && kid === 'k1', `${purpose}: kid.payload.mac with the current kid`);
    check(/^[A-Za-z0-9_-]+$/.test(payload) && /^[A-Za-z0-9_-]{43}$/.test(mac), `${purpose}: unpadded base64url`);
    check(mac === await sign(k.raw.get('k1')!, purpose, payload), `${purpose}: HMAC-SHA-256 over domain, purpose and payload`);
    const claims = decodeClaims(token);
    check(canon(claims) === canon(full(ids, EXTRA[purpose])), `${purpose}: claims`);
    const result = await accepted(verifier.verify(purpose, token, NOW + 10), purpose);
    check(result.purpose === purpose && canon(result.claims) === canon(claims), `${purpose}: verified claims`);
    if (result.purpose !== 'img') check(result.message === world.record(ids), `${purpose}: message record`);
    check(canon((await checkToken(k.keys, purpose, token, NOW))!) === canon(claims), `${purpose}: steps 1-3 alone`);
  }
});

s('tokens: every flipped bit in the payload or the MAC fails', async (ctx) => {
  const { verifier, issue } = await setup(ctx);
  const token = await issue('body', { ri: false });
  const { kid, payload, mac } = parts(token);
  const bytes = unb64url(payload);
  let wellFormed = 0;
  for (let bit = 0; bit < bytes.length * 8; bit++) {
    const flipped = bytes.slice();
    flipped[bit >> 3] ^= 1 << (bit & 7);
    try { if (JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(flipped)).v === 1) wellFormed++; } catch { /* format refusal */ }
    await refused(verifier.verify('body', `${kid}.${b64url(flipped)}.${mac}`, NOW), `payload bit ${bit}`);
  }
  check(wellFormed > 0, 'some flips leave a well-formed payload, so the MAC step is exercised');
  const macBytes = unb64url(mac);
  for (let bit = 0; bit < 256; bit++) {
    const flipped = macBytes.slice();
    flipped[bit >> 3] ^= 1 << (bit & 7);
    await refused(verifier.verify('body', `${kid}.${payload}.${b64url(flipped)}`, NOW), `MAC bit ${bit}`);
  }
  await accepted(verifier.verify('body', token, NOW), 'original');
});

s('tokens: a token on another purpose path fails, and lnk is refused', async (ctx) => {
  const { k, ids, verifier, issue } = await setup(ctx);
  for (const purpose of ALL) {
    const token = await issue(purpose, EXTRA[purpose]);
    for (const path of [...ALL.filter((p) => p !== purpose), 'lnk', 'BODY', '', `${purpose} `, '__proto__', 'constructor']) {
      await refused(verifier.verify(path, token, NOW), `${purpose} token on ${JSON.stringify(path)}`);
    }
  }
  // cid and att share a claim shape, so only the MAC separates them.
  const att = await issue('att', { part: 1 });
  await refused(verifier.verify('cid', att, NOW), 'att token on the cid path');
  const lnk = await forge(k, 'k1', 'lnk', full(ids, { part: 1 }));
  await refused(verifier.verify('lnk', lnk, NOW), 'a correctly MACed lnk token');
  await throws(() => mintAny(k.keys, 'lnk', { ...ids, ep: 1, part: 1 }, NOW), 'minting lnk');
});

s('tokens: an unknown kid fails', async (ctx) => {
  const { k, ids, verifier, issue } = await setup(ctx);
  const token = await issue('body', { ri: false });
  const { payload, mac } = parts(token);
  for (const kid of ['k2', 'K1', 'k1 ', '', '__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    await refused(verifier.verify('body', `${kid}.${payload}.${mac}`, NOW), `kid ${JSON.stringify(kid)}`);
  }
  const other = await makeKeys('k9', ['k9']);
  await refused(verifier.verify('body', await forge(other, 'k9', 'body', full(ids, { ri: false })), NOW), 'a kid the verifier does not hold');
  await refused(verifier.verify('body', `k9.${payload}.${await sign(other.raw.get('k9')!, 'body', payload)}`, NOW), 'payload re-signed under another key');
  check(k.keys.current === 'k1', 'current kid');
});

s('tokens: exp - iat = 301 fails at mint and at verify; 300 passes', async (ctx) => {
  const { k, ids, verifier, issue } = await setup(ctx);
  await throws(() => mintAny(k.keys, 'body', { ...ids, ep: 1, ri: false, iat: NOW, exp: NOW + 301 }, NOW), 'mint span 301');
  await issue('body', { ri: false, iat: NOW, exp: NOW + 300 });
  await refused(verifier.verify('body', await forge(k, 'k1', 'body', full(ids, { ri: false }, 1, NOW, NOW + 301)), NOW), 'verify span 301');
  await accepted(verifier.verify('body', await forge(k, 'k1', 'body', full(ids, { ri: false }, 1, NOW, NOW + 300)), NOW), 'verify span 300');
  await refused(verifier.verify('body', await forge(k, 'k1', 'body', full(ids, { ri: false }, 1, NOW, NOW)), NOW - 10), 'verify exp = iat');
  await throws(() => mintAny(k.keys, 'body', { ...ids, ep: 1, ri: false, iat: NOW, exp: NOW }, NOW - 10), 'mint exp = iat');
});

s('tokens: iat 31 s in the future fails, 30 and 29 s pass, and exp is exclusive', async (ctx) => {
  const { k, ids, verifier, issue } = await setup(ctx);
  const token = await issue('body', { ri: false });
  await refused(verifier.verify('body', token, NOW - 31), 'iat 31 s ahead');
  await accepted(verifier.verify('body', token, NOW - 30), 'iat 30 s ahead');
  await accepted(verifier.verify('body', token, NOW - 29), 'iat 29 s ahead');
  await accepted(verifier.verify('body', token, NOW + 299), 'last second');
  await refused(verifier.verify('body', token, NOW + 300), 'now = exp');
  await refused(verifier.verify('body', token, NOW + 100_000), 'long expired');
  await throws(() => mintAny(k.keys, 'body', { ...ids, ep: 1, ri: false, iat: NOW + 31 }, NOW), 'mint iat 31 s ahead');
  await issue('body', { ri: false, iat: NOW + 29, exp: NOW + 29 + 300 });
  await throws(() => mintAny(k.keys, 'body', { ...ids, ep: 1, ri: false, iat: NOW - 300, exp: NOW }, NOW), 'mint an expired token');
});

s('tokens: a payload over 4 KiB fails', async (ctx) => {
  const { k, ids, verifier, issue } = await setup(ctx);
  const quoted = '"'.repeat(2000); // within the 2,048-byte URL limit, but JSON escaping doubles it
  const big = await forge(k, 'k1', 'img', full(ids, { u: quoted }));
  check(parts(big).payload.length > 4096 && encoder.encode(quoted).length <= 2048, 'fixture: an oversized payload with valid claims');
  await refused(verifier.verify('img', big, NOW), 'payload over 4 KiB');
  await throws(() => mintAny(k.keys, 'img', { ...ids, ep: 1, u: quoted }, NOW), 'mint payload over 4 KiB');
  const longest = `https://sender.example/${'a'.repeat(2048 - 23)}`;
  check(encoder.encode(longest).length === 2048, 'fixture: 2,048-byte URL');
  await accepted(verifier.verify('img', await issue('img', { u: longest }), NOW), 'u of 2,048 bytes');
  await throws(() => mintAny(k.keys, 'img', { ...ids, ep: 1, u: `${longest}a` }, NOW), 'mint u of 2,049 bytes');
  await refused(verifier.verify('img', await forge(k, 'k1', 'img', full(ids, { u: `${longest}a` })), NOW), 'verify u of 2,049 bytes');
});

s('tokens: v other than 1 fails', async (ctx) => {
  const { k, ids, verifier } = await setup(ctx);
  for (const v of [2, 0, '1', true, null]) {
    await refused(verifier.verify('body', await forge(k, 'k1', 'body', { ...full(ids, { ri: false }), v }), NOW), `v = ${JSON.stringify(v)}`);
  }
  const { v: _v, ...noVersion } = full(ids, { ri: false });
  await refused(verifier.verify('body', await forge(k, 'k1', 'body', noVersion), NOW), 'v missing');
});

s('tokens: malformed tokens and claims fail even with a valid MAC', async (ctx) => {
  const { k, ids, verifier, issue } = await setup(ctx);
  const token = await issue('body', { ri: false });
  const { kid, payload, mac } = parts(token);
  const shapes = [
    '', kid, `${kid}.${payload}`, `${token}.`, `.${token}`, `${token}.x`, `${kid}..${mac}`, `${kid}.${payload}.`,
    `${kid}.${payload}=.${mac}`, `${kid}.${payload}.${mac}=`, `${kid}.${payload}.${mac.slice(1)}`, `${kid}.${payload}.${mac}A`,
    `${kid}.${payload.slice(0, -1)}+.${mac}`, ` ${token}`, `${token}\n`, `${kid}.${'A'.repeat(20_000)}.${mac}`,
  ];
  for (const shape of shapes) await refused(verifier.verify('body', shape, NOW), `shape ${shapes.indexOf(shape)}`);
  const bad: unknown[] = [
    'not json', '[]', 'null', '1', '"body"', new Uint8Array([0x7b, 0xff, 0x7d]),
    { ...full(ids, { ri: false }), extra: 1 },
    { ...full(ids, { ri: false }), part: 1 },
    { ...full(ids, { ri: false }), u: 'https://sender.example/' },
    { ...full(ids, { ri: 'true' }) },
    { ...full(ids, {}) },
    { ...full({ ...ids, ws: 7 as unknown as string }, { ri: false }) },
    { ...full({ ...ids, mb: '' }, { ri: false }) },
    { ...full({ ...ids, msg: 'x'.repeat(257) }, { ri: false }) },
    { ...full({ ...ids, sub: 'a\nb' }, { ri: false }) },
    { ...full(ids, { ri: false }), ep: '1' },
    { ...full(ids, { ri: false }), ep: -1 },
    { ...full(ids, { ri: false }), ep: 1.5 },
    { ...full(ids, { ri: false }), iat: String(NOW) },
    { ...full(ids, { ri: false }), exp: NOW + 0.5 },
  ];
  for (const claims of bad) await refused(verifier.verify('body', await forge(k, 'k1', 'body', claims), NOW), `body claims ${bad.indexOf(claims)}`);
  for (const part of [-1, 1.5, '1', null, 2 ** 53]) {
    await refused(verifier.verify('cid', await forge(k, 'k1', 'cid', full(ids, { part })), NOW), `part ${String(part)}`);
  }
  await refused(verifier.verify('cid', await forge(k, 'k1', 'cid', full(ids, { part: 1, ri: true })), NOW), 'ri on cid');
  await refused(verifier.verify('img', await forge(k, 'k1', 'img', full(ids, { u: '' })), NOW), 'empty u');
  await refused(verifier.verify('img', await forge(k, 'k1', 'img', full(ids, { u: 1 })), NOW), 'numeric u');
  await accepted(verifier.verify('cid', await forge(k, 'k1', 'cid', full(ids, { part: 0 })), NOW), 'control: part 0');
  await throws(() => mintAny(k.keys, 'body', { ...ids, ep: 1, ri: false, extra: 1 }, NOW), 'mint with an extra claim');
  await throws(() => mintAny(k.keys, 'body', { ...ids, ep: 1, ri: false, v: 1 }, NOW), 'mint with v supplied');
  await throws(() => mintAny(k.keys, 'cid', { ...ids, ep: 1, part: Number('x') }, NOW), 'mint with a NaN part');
  await throws(() => mintAny(k.keys, 'body', { ...ids, ep: 1, ri: false }, Number.NaN), 'mint with a NaN clock');
});

s('tokens: the MAC is decided by crypto.subtle.verify alone', async (ctx) => {
  const { k, ids, verifier, issue } = await setup(ctx);
  const token = await issue('body', { ri: false });
  const { kid, payload, mac } = parts(token);
  const subtle = crypto.subtle;
  const realVerify = subtle.verify, realSign = subtle.sign;
  const calls: unknown[][] = [];
  let signs = 0;
  let forced: boolean | undefined;
  subtle.verify = async function (...args: Parameters<SubtleCrypto['verify']>) {
    calls.push(args);
    const real = await realVerify.apply(subtle, args);
    return forced ?? real;
  } as SubtleCrypto['verify'];
  subtle.sign = async function (...args: Parameters<SubtleCrypto['sign']>) {
    signs++;
    return realSign.apply(subtle, args);
  } as SubtleCrypto['sign'];
  try {
    await accepted(verifier.verify('body', token, NOW), 'real result');
    check(calls.length === 1, 'exactly one subtle.verify call');
    const [algorithm, key, signature, data] = calls[0] as [string | { name: string }, CryptoKey, BufferSource, BufferSource];
    check((typeof algorithm === 'string' ? algorithm : algorithm.name) === 'HMAC', 'HMAC algorithm');
    check(key.algorithm.name === 'HMAC' && (key.algorithm as unknown as { hash: { name: string } }).hash.name === 'SHA-256', 'HMAC-SHA-256 key');
    check(sameBytes(bytesOf(signature), unb64url(mac)), 'the token MAC is the signature argument');
    check(sameBytes(bytesOf(data), encoder.encode(`${DOMAIN}\nbody\n${payload}`)), 'the signed bytes');
    check(signs === 0, 'verification never re-signs to compare');
    forced = false;
    await refused(verifier.verify('body', token, NOW), 'subtle.verify says no');
    forced = true;
    const forged = `${kid}.${payload}.${b64url(crypto.getRandomValues(new Uint8Array(32)))}`;
    await accepted(verifier.verify('body', forged, NOW), 'subtle.verify says yes to a random MAC');
    forced = undefined;
    await refused(verifier.verify('body', forged, NOW), 'random MAC with the real verify');
  } finally {
    subtle.verify = realVerify;
    subtle.sign = realSign;
  }
  check(crypto.subtle.verify === realVerify, 'spy removed');
  void k; void ids;
});

// 2. Authorisation

s('authorisation: a raised epoch fails once the 60 s cache entry lapses, not later', async (ctx) => {
  const { world, ids, verifier, issue, k } = await setup(ctx);
  const token = await issue('body', { ri: false });
  await accepted(verifier.verify('body', token, NOW), 'before the change');
  world.epochs.set(ids.sub, 2);
  const epochCalls = () => world.calls.filter(([op]) => op === 'credentialEpoch').length;
  check(epochCalls() === 1, 'one account-service call');
  // Within the TTL the cached answer may still be served (the spec allows up to 60 s).
  const within = await verifier.verify('body', token, NOW + 59);
  check(within !== REFUSED && epochCalls() === 1, 'the answer is cached for up to 60 s');
  await refused(verifier.verify('body', token, NOW + 60), 'refused when the cache entry is 60 s old');
  await refused(verifier.verify('body', token, NOW + 61), 'still refused later');
  // A verifier with no cached answer refuses at once.
  const fresh = createVerifier({ keys: k.keys, ports: world, epochs: new EpochCache() });
  await refused(fresh.verify('body', token, NOW + 1), 'uncached');
  // cid and att are checked the same way.
  await refused(fresh.verify('cid', await issue('cid', { part: 1 }), NOW + 1), 'cid with the old epoch');
  await refused(fresh.verify('att', await issue('att', { part: 1 }), NOW + 1), 'att with the old epoch');
  world.epochs.delete(ids.sub);
  await refused(createVerifier({ keys: k.keys, ports: world, epochs: new EpochCache() }).verify('body', token, NOW), 'unknown user');
});

s('authorisation: a newer token refreshes a stale cached epoch, which then refuses older tokens', async (ctx) => {
  const { world, ids, verifier, k, issue } = await setup(ctx);
  const old = await issue('body', { ri: false });
  await accepted(verifier.verify('body', old, NOW), 'old epoch');
  world.epochs.set(ids.sub, 2);
  const renewed = await mintAny(k.keys, 'body', { ...ids, ep: 2, ri: false }, NOW + 5);
  ctx.sensitive(renewed);
  await accepted(verifier.verify('body', renewed, NOW + 5), 'a token minted after the change');
  await refused(verifier.verify('body', old, NOW + 6), 'the old token after the refresh');
  // A token claiming a higher epoch than the account service knows is refused.
  const ahead = await mintAny(k.keys, 'body', { ...ids, ep: 3, ri: false }, NOW + 7);
  ctx.sensitive(ahead);
  await refused(verifier.verify('body', ahead, NOW + 7), 'an epoch ahead of the account service');
});

s('authorisation: the epoch cache is keyed by sub, bounded, and expires', async (ctx) => {
  const { k, world, verifier, issue } = await setup(ctx);
  const other = newIds();
  world.add(other, 5);
  ctx.sensitive(...Object.values(other));
  await accepted(verifier.verify('body', await issue('body', { ri: false }), NOW), 'first user');
  const second = await mintAny(k.keys, 'body', { ...other, ep: 5, ri: false }, NOW);
  ctx.sensitive(second);
  await accepted(verifier.verify('body', second, NOW), 'second user, own epoch');
  check(world.calls.filter(([op]) => op === 'credentialEpoch').map(([, sub]) => sub).join() === [world.calls[0][1], other.sub].join(), 'one lookup per sub');
  const cache = new EpochCache(60, 2);
  const counter = { loads: 0, failures: 0 };
  const loads = () => counter.loads, failures = () => counter.failures;
  const load = async (sub: string) => { counter.loads++; return sub.length; };
  check(await cache.epoch('a', NOW, load) === 1 && await cache.epoch('a', NOW + 59, load) === 1 && loads() === 1, 'hit within TTL');
  check(await cache.epoch('a', NOW + 60, load) === 1 && loads() === 2, 'miss at TTL');
  check(await cache.epoch('a', NOW - 5, load) === 1 && loads() === 3, 'miss when the clock goes back');
  await cache.epoch('bb', NOW, load); await cache.epoch('ccc', NOW, load);
  check(cache.size <= 2, 'bounded');
  const before = loads();
  await cache.epoch('a', NOW, load);
  check(loads() === before + 1, 'the oldest entry was evicted');
  const failing = async () => { counter.failures++; throw new Error('down'); };
  await throws(() => cache.epoch('d', NOW, failing), 'port failure propagates');
  await throws(() => cache.epoch('d', NOW, failing), 'failures are not cached');
  check(failures() === 2, 'two attempts');
  const nulls = async () => { counter.failures++; return null; };
  check(await cache.epoch('e', NOW, nulls) === null && await cache.epoch('e', NOW, nulls) === null && failures() === 4, 'unknown users are not cached');
});

s('authorisation: a reassigned mailbox fails at once', async (ctx) => {
  const { world, ids, verifier, issue } = await setup(ctx);
  const token = await issue('body', { ri: false });
  const att = await issue('att', { part: 1 });
  await accepted(verifier.verify('body', token, NOW), 'owner');
  world.owners.set(`${ids.ws}/${ids.mb}`, `usr-${hex(6)}`);
  await refused(verifier.verify('body', token, NOW + 1), 'reassigned, body');
  await refused(verifier.verify('att', att, NOW + 1), 'reassigned, att');
  world.owners.delete(`${ids.ws}/${ids.mb}`);
  await refused(verifier.verify('body', token, NOW + 1), 'mailbox gone');
});

s('authorisation: a deleted message fails at once', async (ctx) => {
  const { world, ids, verifier, issue } = await setup(ctx);
  const tokens = { body: await issue('body', { ri: false }), cid: await issue('cid', { part: 1 }), att: await issue('att', { part: 2 }) };
  for (const [purpose, token] of Object.entries(tokens)) await accepted(verifier.verify(purpose, token, NOW), `${purpose} present`);
  world.messages.delete(`${ids.ws}/${ids.mb}/${ids.msg}`);
  for (const [purpose, token] of Object.entries(tokens)) await refused(verifier.verify(purpose, token, NOW + 1), `${purpose} deleted`);
});

s('authorisation: a token for mailbox A never reaches mailbox B', async (ctx) => {
  const { k, world, ids: a, verifier, issue } = await setup(ctx);
  const b = { ...newIds(), ws: a.ws };
  const c = newIds();
  world.add(b);
  world.add(c);
  ctx.sensitive(...Object.values(b), ...Object.values(c));
  const tokenA = await issue('att', { part: 1 });
  const tokenB = await mintAny(k.keys, 'att', { ...b, ep: 1, part: 1 }, NOW);
  ctx.sensitive(tokenB);
  const A = parts(tokenA), B = parts(tokenB);
  const claimsA = decodeClaims(tokenA);
  world.calls = [];
  const attempts: string[] = [];
  for (const swap of [{ mb: b.mb }, { mb: b.mb, msg: b.msg }, { mb: b.mb, msg: b.msg, sub: b.sub }, { ws: c.ws, mb: c.mb, msg: c.msg, sub: c.sub }, { ws: c.ws }]) {
    attempts.push(`${A.kid}.${b64url(encoder.encode(JSON.stringify({ ...claimsA, ...swap })))}.${A.mac}`);
  }
  attempts.push(`${A.kid}.${B.payload}.${A.mac}`, `${B.kid}.${A.payload}.${B.mac}`);
  for (const attempt of attempts) await refused(verifier.verify('att', attempt, NOW), `substitution ${attempts.indexOf(attempt)}`);
  check(world.calls.length === 0, 'no port is called before the MAC passes');
  const result = await accepted(verifier.verify('att', tokenA, NOW), 'A itself');
  check(result.purpose === 'att' && result.message === world.record(a), 'A reads only its own message');
  check(JSON.stringify(world.calls) === JSON.stringify([
    ['credentialEpoch', a.sub], ['mailboxOwner', a.ws, a.mb], ['message', a.ws, a.mb, a.msg],
  ]), 'ports are addressed only from the verified claims, steps 4 then 5');
});

s('authorisation: a failing port refuses without a reason', async (ctx) => {
  const { world, verifier, issue } = await setup(ctx);
  const token = await issue('body', { ri: false });
  world.broken = true;
  await refused(verifier.verify('body', token, NOW), 'broken account service');
  world.broken = false;
  await accepted(verifier.verify('body', token, NOW), 'recovered');
  world.broken = true;
  await refused(verifier.verify('body', token, NOW), 'broken directory with a cached epoch');
});

s('authorisation: img tokens skip steps 4 and 5', async (ctx) => {
  const { world, ids, verifier, issue } = await setup(ctx);
  const token = await issue('img', { u: 'https://sender.example/p.gif' });
  world.epochs.set(ids.sub, 9);
  world.owners.delete(`${ids.ws}/${ids.mb}`);
  world.messages.clear();
  world.broken = true;
  const result = await accepted(verifier.verify('img', token, NOW), 'img');
  check(result.purpose === 'img' && !('message' in result), 'no message data');
  check(world.calls.length === 0, 'no port called');
});

// 3. Rotation and key loading

s('rotation: old kid verifies while present, fails after removal and after emergency revocation', async (ctx) => {
  const ids = newIds();
  const world = new World();
  world.add(ids);
  ctx.sensitive(...Object.values(ids));
  const verifierFor = (k: TestKeys) => createVerifier({ keys: k.keys, ports: world, epochs: new EpochCache() });
  const k1 = await makeKeys('k1', ['k1']);
  const old = await mintAny(k1.keys, 'body', { ...ids, ep: 1, ri: false }, NOW);
  const both = await makeKeys('k1', ['k1', 'k2'], k1.raw);
  await accepted(verifierFor(both).verify('body', old, NOW), 'step 1: new key added');
  const switched = await makeKeys('k2', ['k1', 'k2'], both.raw);
  await accepted(verifierFor(switched).verify('body', old, NOW), 'step 3: current switched, old key still present');
  const fresh = await mintAny(switched.keys, 'body', { ...ids, ep: 1, ri: false }, NOW);
  ctx.sensitive(old, fresh);
  check(parts(fresh).kid === 'k2' && parts(fresh).mac === await sign(switched.raw.get('k2')!, 'body', parts(fresh).payload), 'minting uses current');
  const removed = await makeKeys('k2', ['k2'], switched.raw);
  await refused(verifierFor(removed).verify('body', old, NOW), 'step 5: old key removed');
  await accepted(verifierFor(removed).verify('body', fresh, NOW), 'current key still works');
  const emergency = await makeKeys('k3', ['k3']);
  await refused(verifierFor(emergency).verify('body', old, NOW), 'emergency: k1 token');
  await refused(verifierFor(emergency).verify('body', fresh, NOW), 'emergency: k2 token');
  const after = await mintAny(emergency.keys, 'img', { ...ids, ep: 1, u: 'https://sender.example/' }, NOW);
  ctx.sensitive(after);
  check(parts(after).kid === 'k3', 'new mints use the new key');
  await accepted(verifierFor(emergency).verify('img', after, NOW), 'new token');
});

s('keys: CONTENT_URL_KEYS is parsed strictly and errors never echo it', async (ctx) => {
  const material = b64(crypto.getRandomValues(new Uint8Array(32)));
  const marker = material.slice(0, 20);
  ctx.sensitive(material, marker);
  const bad: unknown[] = [
    undefined, 7, '', `not json ${material}`, `{"current":"k1","keys":{"k1":"${material}"`, '[]', 'null',
    JSON.stringify({ keys: { k1: material } }),
    JSON.stringify({ current: 'k2', keys: { k1: material } }),
    JSON.stringify({ current: 'k1', keys: {} }),
    JSON.stringify({ current: 'k1', keys: { k1: material.slice(0, 40) } }),
    JSON.stringify({ current: 'k1', keys: { k1: b64(crypto.getRandomValues(new Uint8Array(31))) } }),
    JSON.stringify({ current: 'k1', keys: { k1: b64(crypto.getRandomValues(new Uint8Array(33))) } }),
    JSON.stringify({ current: 'k1', keys: { k1: material.replace(/=$/, '') } }),
    JSON.stringify({ current: 'k1', keys: { k1: `${material}\n` } }),
    JSON.stringify({ current: 'k1', keys: { k1: material.replace(/[A-Za-z0-9]/, '-') } }),
    JSON.stringify({ current: 'k1', keys: { k1: 7 } }),
    JSON.stringify({ current: 'k.1', keys: { 'k.1': material } }),
    JSON.stringify({ current: '', keys: { '': material } }),
    JSON.stringify({ current: 'k'.repeat(33), keys: { ['k'.repeat(33)]: material } }),
    JSON.stringify({ current: 1, keys: { 1: material } }),
    JSON.stringify({ current: 'k1', keys: { k1: material }, extra: true }),
    JSON.stringify({ current: 'k1', keys: [material] }),
  ];
  for (const secret of bad) {
    let error: unknown;
    try { await loadContentUrlKeys(secret); } catch (caught) { error = caught; }
    check(error instanceof ContentKeysError, `secret ${bad.indexOf(secret)} is refused`);
    const text = `${error.message}\n${error.stack ?? ''}\n${String((error as { cause?: unknown }).cause ?? '')}`;
    check(!text.includes(marker), `secret ${bad.indexOf(secret)}: the error does not echo the value`);
  }
  const good = await loadContentUrlKeys(JSON.stringify({ current: 'k-1_A', keys: { 'k-1_A': material, k2: b64(crypto.getRandomValues(new Uint8Array(32))) } }));
  check(good.current === 'k-1_A' && good.keys.size === 2, 'valid secret');
  for (const key of good.keys.values()) {
    check(!key.extractable && key.algorithm.name === 'HMAC' && key.usages.includes('sign') && key.usages.includes('verify'), 'non-extractable HMAC key');
  }
  check(!('k1' in good) && JSON.stringify(good).indexOf(marker) === -1, 'the loaded value does not expose key bytes');
  const secret = JSON.stringify({ current: 'k1', keys: { k1: material } });
  check(contentUrlKeys(secret) === contentUrlKeys(secret), 'one load per secret value');
  const rotated = JSON.stringify({ current: 'k2', keys: { k2: material } });
  check((await contentUrlKeys(rotated)).current === 'k2', 'a changed secret reloads');
});

// mintFromBody (section 2.2)

s('derived: cid and img claims copy the verified body token, and expire with it', async (ctx) => {
  const { k, ids, verifier, issue, world } = await setup(ctx);
  const body = await accepted(verifier.verify('body', await issue('body', { ri: true }, NOW - 100), NOW), 'body') as VerifiedBody;
  const cid = await mintFromBody(k.keys, body, { purpose: 'cid', part: 4 }, NOW);
  const img = await mintFromBody(k.keys, body, { purpose: 'img', u: 'https://sender.example/i.png' }, NOW);
  ctx.sensitive(cid, img);
  check(canon(decodeClaims(cid)) === canon(full(ids, { part: 4 }, 1, NOW, NOW + 200)), 'cid claims');
  check(canon(decodeClaims(img)) === canon(full(ids, { u: 'https://sender.example/i.png' }, 1, NOW, NOW + 200)), 'img claims');
  await accepted(verifier.verify('cid', cid, NOW + 1), 'cid verifies');
  world.calls = [];
  await accepted(verifier.verify('img', img, NOW + 199), 'img verifies until the body exp');
  await refused(verifier.verify('img', img, NOW + 200), 'img dies with the body');
  await refused(verifier.verify('cid', cid, NOW + 200), 'cid dies with the body');
  check(world.calls.length === 0, 'img skips the ports');
  await throws(() => mintFromBody(k.keys, body, { purpose: 'cid', part: 1 }, NOW + 200), 'mint after the body exp');
  await throws(() => mintFromBody(k.keys, body, { purpose: 'att' as 'cid', part: 1 }, NOW), 'att is never derived');
  await throws(() => mintFromBody(k.keys, body, { purpose: 'img', u: 'x'.repeat(2049) }, NOW), 'img URL too long');
});

s('derived: only a verifier-issued body result is accepted, img needs ri, and skew stays within 300 s', async (ctx) => {
  const { k, ids, verifier, issue } = await setup(ctx);
  const plain = await accepted(verifier.verify('body', await issue('body', { ri: false }), NOW), 'ri false') as VerifiedBody;
  await throws(() => mintFromBody(k.keys, plain, { purpose: 'img', u: 'https://sender.example/' }, NOW), 'img from a body without remote images');
  await mintFromBody(k.keys, plain, { purpose: 'cid', part: 0 }, NOW);
  const copy = { ...plain, claims: { ...plain.claims, ri: true } } as VerifiedBody;
  await throws(() => mintFromBody(k.keys, copy, { purpose: 'img', u: 'https://sender.example/' }, NOW), 'an object not issued by the verifier');
  const att = await accepted(verifier.verify('att', await issue('att', { part: 1 }), NOW), 'att');
  await throws(() => mintFromBody(k.keys, att as unknown as VerifiedBody, { purpose: 'cid', part: 1 }, NOW), 'a verified att result');
  // A body minted on a clock 20 s ahead: the derived iat is never before the body iat, so the span stays <= 300.
  const ahead = await accepted(verifier.verify('body', await issue('body', { ri: true }, NOW + 20), NOW), 'skewed body') as VerifiedBody;
  const derived = await mintFromBody(k.keys, ahead, { purpose: 'img', u: 'https://sender.example/' }, NOW);
  ctx.sensitive(derived);
  const claims = decodeClaims(derived);
  check(claims.iat === NOW + 20 && claims.exp === NOW + 320, 'derived span within 300 s');
  await accepted(verifier.verify('img', derived, NOW), 'derived token verifies');
  void ids;
});

// 4. Logs: the runner captures console output for every scenario; this one walks every refusal path once more.

s('logs: no path writes to the console', async (ctx) => {
  const { k, ids, world, verifier, issue } = await setup(ctx);
  const token = await issue('body', { ri: false });
  const { kid, payload, mac } = parts(token);
  await refused(verifier.verify('body', `${kid}.${payload}.${mac.slice(0, -1)}A`, NOW), 'MAC');
  await refused(verifier.verify('cid', token, NOW), 'purpose');
  await refused(verifier.verify('body', token, NOW + 301), 'time');
  await refused(verifier.verify('body', `zz.${payload}.${mac}`, NOW), 'kid');
  world.broken = true;
  await refused(verifier.verify('body', token, NOW), 'port');
  await throws(() => mintAny(k.keys, 'body', { ...ids, ep: 1, ri: false, exp: NOW + 999 }, NOW), 'mint refusal');
  await throws(() => loadContentUrlKeys('{'), 'key refusal');
});

export async function runScenario(name: string): Promise<ScenarioResult> {
  const scenario = scenarios.find((entry) => entry.name === name);
  const sensitive: string[] = [];
  const logs: string[] = [];
  const methods = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const;
  const saved = methods.map((method) => console[method]);
  for (const method of methods) console[method] = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
  try {
    if (!scenario) throw new CheckError('unknown scenario');
    await scenario.run({ sensitive: (...values) => { sensitive.push(...values.filter(Boolean)); } });
    return { ok: true, logs, sensitive };
  } catch (error) {
    // Check labels are fixed strings; anything else is reported by type only so no value can leak.
    return { ok: false, error: error instanceof CheckError ? error.message : `${(error as Error)?.name}: ${(error as Error)?.message}`, logs, sensitive };
  } finally {
    methods.forEach((method, i) => { console[method] = saved[i]; });
  }
}
