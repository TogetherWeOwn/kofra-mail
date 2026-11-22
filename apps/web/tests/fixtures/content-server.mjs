import { createServer } from 'node:http';

// Static authored fixtures only: no user-supplied HTML, redirects, or outbound requests.
const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost:4180');
  const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' };
  if (url.pathname === '/healthz') { response.writeHead(200, headers).end('ok'); return; }
  if (url.pathname === '/body/plan-latest') {
    const images = url.searchParams.get('images') === '1';
    response.writeHead(200, {
      ...headers,
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; img-src ${images ? "'self'" : "'none'"}; form-action 'none'; base-uri 'none'; frame-ancestors http://127.0.0.1:4179`
    });
    response.end(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Demo formatted message</title><style>
      html { color-scheme: light dark; font: 16px/1.4 system-ui; overflow-wrap: anywhere; } img { display: block; max-width: 100%; }
      </style><body data-fixture-body><main><h1>Plan update</h1><p>Kitchen measurements revised.</p>${images ? '<img src="/image/plan-latest.svg" alt="Demo floor plan" width="160" height="52">' : ''}</main></body></html>`);
    return;
  }
  if (url.pathname === '/image/plan-latest.svg') {
    response.writeHead(200, { ...headers, 'Content-Type': 'image/svg+xml' });
    response.end('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="52"><path fill="#d9e4ff" stroke="#1f4fd1" d="M2 2h156v48H2zm52 0v48M110 2v48"/></svg>');
    return;
  }
  response.writeHead(404, headers).end();
});
server.listen(4180, '127.0.0.1');
