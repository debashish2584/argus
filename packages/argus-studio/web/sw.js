/**
 * Argus Studio service worker.
 *
 * Strategy:
 *  - /api/*      network-first, never cached (state is live; a stale run
 *                table is worse than a short blank state)
 *  - assets      stale-while-revalidate against the runtime cache, with the
 *                precached app shell as offline fallback for navigations
 *
 * Bump CACHE when the shell changes; old caches are evicted on activate.
 */
const VERSION = "argus-studio-v1";
const CACHE = `${VERSION}-assets`;
const SHELL = [
  "/",
  "/index.html",
  "/app.js",
  "/studio.css",
  "/favicon.svg",
  "/manifest.webmanifest",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("argus-studio-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // live data: always from the network, never served from cache
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(
      fetch(req).catch(() =>
        new Response(JSON.stringify({ error: "offline — studio server unreachable" }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    return;
  }

  // assets: stale-while-revalidate
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(req, { ignoreSearch: true });
      const network = fetch(req)
        .then((res) => {
          if (res.ok && (url.pathname.startsWith("/icons/") || url.pathname === "/" || !url.pathname.startsWith("/api/"))) {
            cache.put(req, res.clone());
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});
