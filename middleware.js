// Vercel edge middleware — host-based routing for groundwork.civicscope.io.
// Runs before filesystem routes, so it can intercept the root path `/`
// (which would otherwise be served by /index.html, the CS marketing page).
//
// Other paths on groundwork.civicscope.io (e.g. /editions/1, /api/...) are
// handled by `has: [host=...]` rewrites in vercel.json; only `/` needs
// middleware because of the root-index.html collision.

import { rewrite, next } from '@vercel/edge';

export const config = {
  matcher: '/',
};

export default function middleware(request) {
  const host = (request.headers.get('host') || '').toLowerCase();
  if (host === 'groundwork.civicscope.io') {
    return rewrite(new URL('/groundwork/index.html', request.url));
  }
  return next();
}
