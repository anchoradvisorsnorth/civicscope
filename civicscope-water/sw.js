/*
 * civicscope-water/sw.js — make the plant log OPEN in a well house with no signal.
 *
 * WHAT THIS FIXES
 * The submit queue already survives a lost connection: entries are held in localStorage and
 * flushed when signal returns. What it could not survive was a COLD START. An operator who walks
 * into a concrete well house, opens the tablet, and has no cached page gets nothing at all — the
 * queue is irrelevant because the app never loads. That is the one failure that loses a round.
 *
 * DELIBERATELY NETWORK-FIRST, NOT CACHE-FIRST.
 * A cache-first service worker is the usual advice and it is the wrong trade here. This app
 * computes numbers that are filed with the state; if a stale shell can pin an old copy of
 * derive.js on a tablet, the screen and the filed record can disagree — which is the exact class
 * of defect this whole product exists to remove, reintroduced by the offline layer. So:
 *
 *     network first  →  fall back to cache only when the network genuinely fails
 *
 * With signal, the operator always runs current code. Without it, they run the last version that
 * loaded. There is no state in which the tablet is silently pinned to something old.
 *
 * NEVER intercepts /api/* — writes must fail loudly so the app's own queue takes them. A service
 * worker that "helpfully" served a cached API response would tell the operator a reading was
 * recorded when it was not.
 */
const VERSION = 'water-v1';
const SHELL = ['/water', '/civicscope-water/derive.js'];

self.addEventListener('install', (e) => {
  // Pre-cache so the very first offline open works, even if the operator has only ever loaded
  // the page once with signal. Failure here must not abort the install — a well house on a bad
  // connection would otherwise leave the tablet with no worker at all.
  e.waitUntil(
    caches.open(VERSION)
      .then((c) => Promise.allSettled(SHELL.map((u) => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;                       // submits are the app's job, not ours

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;           // never serve a stale API answer

  const isShell = req.mode === 'navigate' || SHELL.includes(url.pathname);
  if (!isShell) return;

  e.respondWith(
    fetch(req)
      .then((res) => {
        // Only cache a real success. Caching a 404 or an error page would persist the outage.
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(async () => {
        const hit = await caches.match(req);
        if (hit) return hit;
        // A navigation with nothing cached: fall back to the shell so the operator gets the app
        // rather than the browser's offline dinosaur.
        if (req.mode === 'navigate') {
          const shell = await caches.match('/water');
          if (shell) return shell;
        }
        return new Response(
          'Offline, and this tablet has no cached copy of the plant log yet. Open it once with '
          + 'signal — after that it works in the well house.',
          { status: 503, headers: { 'Content-Type': 'text/plain' } }
        );
      })
  );
});
