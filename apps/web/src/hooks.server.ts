import { dev } from '$app/environment';
import { env } from '$env/dynamic/private';
import { separateContentOrigin } from '$lib/content-origin';
import type { Handle } from '@sveltejs/kit';

export const handle: Handle = async ({ event, resolve }) => {
  const origin = separateContentOrigin(env.MAIL_DEMO_CONTENT_ORIGIN, event.url, dev);
  event.locals.mailContentOrigin = origin;
  const response = await resolve(event);
  const headers = new Headers(response.headers);
  headers.append('content-security-policy', `frame-src ${origin ?? "'none'"}; object-src 'none'`);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
};
