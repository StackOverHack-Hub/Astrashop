import http from 'node:http';
import { isIP } from 'node:net';
import { readFile } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';

export const shopRoutes = [
  'GET /items', 'POST /reservations', 'GET /reservations/{id}', 'GET /me',
  'GET /shop/reservations', 'PUT /shop/items/{id}', 'GET /shop/stats',
  ...['collect', 'release', 'returned', 'set-aside'].map((action) => `POST /shop/reservations/{id}/${action}`),
  'GET /shops/{shopId}/items', 'GET /shops/{shopId}/reservations', 'PUT /shops/{shopId}/items/{id}', 'GET /shops/{shopId}/stats',
  ...['collect', 'release', 'returned', 'set-aside'].map((action) => `POST /shops/{shopId}/reservations/{id}/${action}`),
  'PUT /shops/{shopId}/staff/{userId}', 'POST /admin/shops',
  'GET /shops/{shopId}/catalog', 'POST /shops/{shopId}/items', 'PUT /shops/{shopId}/items/{id}/details', 'PUT /shops/{shopId}',
  'GET /shops/{shopId}/staff', 'POST /shops/{shopId}/invites', 'POST /invites/accept', 'GET /shops/{shopId}/audit',
  'GET /admin/shops', 'PUT /admin/shops/{shopId}',
  'GET /shops', 'GET /me/reservations', 'PUT /shops/{shopId}/items/{id}/photo',
];
// Photo uploads carry a resized image as base64; every other request stays small.
export const bodyLimit = (routeKey) => routeKey === 'PUT /shops/{shopId}/items/{id}/photo' ? 1_000_000 : 8192;
const routes = [
  ...shopRoutes,
  'GET /marketplace/listings', 'POST /marketplace/listings', 'GET /marketplace/mine',
  'GET /marketplace/listings/{id}', 'PUT /marketplace/listings/{id}',
  'POST /marketplace/listings/{id}/contact', 'POST /marketplace/listings/{id}/report',
  'GET /marketplace/inbox', 'GET /marketplace/threads/{id}', 'POST /marketplace/threads/{id}',
  'GET /marketplace/reports', 'PUT /marketplace/listings/{id}/moderate',
  'GET /marketplace/listings/{id}/comments', 'POST /marketplace/listings/{id}/comments',
  'PUT /marketplace/listings/{id}/comments/{commentId}',
  'GET /marketplace/sellers', 'GET /marketplace/sellers/{id}',
  'GET /marketplace/sellers/{id}/listings', 'GET /marketplace/sellers/{id}/reviews',
  'GET /marketplace/profile', 'PUT /marketplace/profile',
  'GET /marketplace/saved', 'GET /marketplace/saved/{id}', 'PUT /marketplace/saved/{id}',
  'GET /marketplace/threads/{id}/exchange', 'PUT /marketplace/threads/{id}/exchange',
  'POST /marketplace/threads/{id}/review',
].map((routeKey) => {
  const [method, path] = routeKey.split(' ');
  return {
    routeKey, method, params: [...path.matchAll(/\{(\w+)\}/g)].map((match) => match[1]),
    pattern: new RegExp(`^${path.replace(/\{\w+\}/g, '([^/]+)')}$`),
  };
});
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2',
  '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
};

export function createHttpServer({ shop, marketplace, verify, readiness = async () => {}, publicDir, publicConfig = {},
  allowedOrigin, trustProxyHops = 0, production = false, maxActive = 128, photos }) {
  let active = 0;
  let ready;
  let readyUntil = 0;
  let checking = false;
  const checkReady = () => {
    if (!ready || !checking && Date.now() > readyUntil) {
      checking = true;
      ready = readiness().then(() => true, () => false).finally(() => {
        checking = false;
        readyUntil = Date.now() + 1000;
      });
    }
    return ready;
  };
  const connect = ["'self'", publicConfig.loginOrigin].filter(Boolean).join(' ');
  // Photos come from this server locally, or from their CDN in production.
  const images = ["'self'", 'data:', /^https:\/\//.test(photos?.baseUrl ?? '') ? new URL(photos.baseUrl).origin : ''].filter(Boolean).join(' ');
  const security = {
    'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin',
    'x-frame-options': 'DENY',
    'content-security-policy': `default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src ${images}; connect-src ${connect}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`,
    ...(production ? { 'strict-transport-security': 'max-age=31536000' } : {}),
  };
  const server = http.createServer({ maxHeaderSize: 16_384 }, async (req, res) => {
    const cors = req.headers.origin === allowedOrigin ? {
      'access-control-allow-origin': allowedOrigin, vary: 'Origin',
      'access-control-allow-headers': 'content-type,x-shop-key,authorization',
      'access-control-allow-methods': 'GET,POST,PUT,OPTIONS', 'access-control-expose-headers': 'retry-after',
    } : {};
    const json = (status, error, extra = {}) => {
      if (res.destroyed || res.headersSent) return;
      res.writeHead(status, { ...security, ...cors, 'content-type': 'application/json', 'cache-control': 'no-store', ...extra });
      res.end(JSON.stringify(typeof error === 'string' ? { error } : error));
    };
    let counted = false;
    try {
      if (req.url.length > 2048) return json(414, 'Request URL is too long.');
      const { pathname: rawPath, searchParams } = new URL(req.url, 'http://localhost');
      const pathname = rawPath.replace(/^\/api(?=\/|$)/, '') || '/';
      if (pathname === '/health/live') return json(200, { status: 'alive' });
      if (pathname === '/health/ready') {
        const available = await checkReady();
        return json(available ? 200 : 503, { status: available ? 'ready' : 'unavailable' });
      }
      if (req.method === 'OPTIONS') {
        if (req.headers.origin !== allowedOrigin) return json(403, 'Origin not allowed.');
        res.writeHead(204, { ...security, ...cors });
        return res.end();
      }
      if (pathname === '/config.js' && req.method === 'GET') {
        res.writeHead(200, { ...security, 'content-type': types['.js'], 'cache-control': 'no-store' });
        return res.end(`window.__ASTRASHOP_CONFIG__=${JSON.stringify(publicConfig).replace(/</g, '\\u003c')};`);
      }
      if (pathname.startsWith('/photos/') && photos?.read && ['GET', 'HEAD'].includes(req.method)) {
        const data = await photos.read(pathname.slice('/photos/'.length));
        if (!data) return json(404, 'Not found.');
        res.writeHead(200, { ...security, 'content-type': types[extname(pathname)] ?? 'application/octet-stream', 'cache-control': photos.cacheControl });
        return res.end(req.method === 'HEAD' ? undefined : data);
      }
      const matching = routes.filter(({ pattern }) => pattern.test(pathname));
      const route = matching.find(({ method }) => method === req.method);
      if (!route) {
        if (matching.length) return json(405, 'Method not allowed.', { allow: matching.map(({ method }) => method).join(', ') });
        if (!publicDir || !['GET', 'HEAD'].includes(req.method)) return json(404, 'Not found.');
        const filePath = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
        if (filePath.split('/').some((part) => part.startsWith('.'))) return json(404, 'Not found.');
        const root = resolve(publicDir);
        const file = resolve(root, `.${filePath}`);
        if (!file.startsWith(root + sep) || !types[extname(file)]) return json(404, 'Not found.');
        const data = await readFile(file).catch((error) => {
          if (error.code === 'ENOENT' || error.code === 'EISDIR') return null;
          throw error;
        });
        if (!data) return json(404, 'Not found.');
        res.writeHead(200, { ...security, 'content-type': types[extname(file)],
          'cache-control': pathname.startsWith('/assets/') ? 'public,max-age=31536000,immutable' : 'no-cache' });
        return res.end(req.method === 'HEAD' ? undefined : data);
      }
      const limit = bodyLimit(route.routeKey);
      // Check the sign-in before reading any body, so an unsigned client can't make the server
      // buffer a large upload; only signed-in routes accept more than a small body.
      let claims;
      if (req.headers.authorization) {
        try { claims = await verify(req.headers.authorization); }
        catch (error) {
          req.resume();
          if (error.code === 'AUTH_UNAVAILABLE') return json(503, 'Campus sign-in is temporarily unavailable. Try again.', { 'retry-after': '2' });
          return json(401, 'Sign in again to continue.');
        }
      }
      if (limit > 8192 && !claims) { req.resume(); return json(401, 'Sign in to continue.'); }
      if (Number(req.headers['content-length']) > limit) {
        req.resume();
        return json(413, 'Request is too large.');
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        size += chunk.length;
        if (size > limit) { req.resume(); return json(413, 'Request is too large.'); }
        chunks.push(chunk);
      }
      // Count only requests doing work: a stalled upload is bounded by requestTimeout and
      // maxConnections, and must not use a slot that real requests need.
      if (active >= maxActive) return json(503, 'Busy, try again.', { 'retry-after': '1' });
      active++;
      counted = true;
      let sourceIp = req.socket.remoteAddress;
      if (trustProxyHops) {
        const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',').map((ip) => ip.trim());
        const candidate = forwarded.at(-trustProxyHops);
        if (candidate && isIP(candidate)) sourceIp = candidate;
      }
      const event = {
        routeKey: route.routeKey, headers: req.headers,
        pathParameters: Object.fromEntries(route.params.map((name, index) => [name, decodeURIComponent(route.pattern.exec(pathname)[index + 1])])),
        queryStringParameters: Object.fromEntries(searchParams),
        body: size ? new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)) : undefined,
        requestContext: { http: { sourceIp } },
      };
      if (claims) event.requestContext.authorizer = { jwt: { claims } };
      const out = await (pathname.startsWith('/marketplace/') ? marketplace : shop)(event);
      if (!res.destroyed) {
        res.writeHead(out.statusCode, { ...security, ...out.headers, ...cors, 'cache-control': 'no-store' });
        res.end(out.body);
      }
    } catch (error) {
      if (res.destroyed) return;
      const invalid = error instanceof URIError || error.code === 'ERR_ENCODING_INVALID_ENCODED_DATA';
      if (!invalid) console.error(JSON.stringify({ event: 'http_request_failed', type: error.name }));
      json(invalid ? 400 : 500, invalid ? 'Invalid request encoding.' : 'Could not complete the request.');
    } finally { if (counted) active--; }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 8_000;
  server.keepAliveTimeout = 5000;
  server.maxConnections = 256;
  return server;
}
