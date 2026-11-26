import { dev } from '$app/environment';
import { env } from '$env/dynamic/private';
import { separateContentOrigin } from '$lib/content-origin';
import type { Handle } from '@sveltejs/kit';

export const handle: Handle = async ({ event, resolve }) => {
  const platform = event.platform?.env;
  const configured = (platform?.MAIL_CONTENT_ENABLED === 'on' ? platform.MAIL_CONTENT_ORIGIN : undefined)
    ?? (dev ? env.MAIL_DEMO_CONTENT_ORIGIN : undefined);
  const origin = separateContentOrigin(configured, event.url, dev || event.platform?.env?.MAIL_LOCAL_API === 'on');
  event.locals.mailContentOrigin = origin;
  const response = await resolve(event);
  const headers = new Headers(response.headers);
  headers.append('content-security-policy', `frame-src ${origin ?? "'none'"}; object-src 'none'`);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
};
