import { dev } from '$app/environment';
import { env } from '$env/dynamic/private';
import type { RequestHandler } from './$types';
import { handleMailApi } from '$lib/server/mail-api';

const forwardHeaders = ['accept', 'content-type', 'x-csrf-token', 'idempotency-key', 'if-match'];
const handle: RequestHandler = ({ request, platform, url }) => {
  // Vite has no Durable Object bindings. Its local test relay is compiled out
  // of the Worker build and neither sends cookies nor forwards account selection.
  if (dev && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    const configured = env.MAIL_DEV_API_ORIGIN;
    if (configured && /^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(configured)) {
      const upstream = new URL(configured);
      upstream.pathname = url.pathname;
      upstream.search = url.search;
      const headers = new Headers({ 'accept-encoding': 'identity' });
      for (const name of forwardHeaders) {
        const value = request.headers.get(name);
        if (value !== null) headers.set(name, value);
      }
      const origin = request.headers.get('origin');
      if (origin !== null) headers.set('origin', origin === url.origin ? upstream.origin : 'null');
      const options: RequestInit & { duplex: 'half' } = {
        method: request.method, headers, body: request.body, redirect: 'error', duplex: 'half',
      };
      return fetch(upstream, options);
    }
  }
  return handleMailApi(request, platform?.env);
};

// The shipped Worker config has no local flag, session provider or demo bindings.
export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const fallback = handle;
