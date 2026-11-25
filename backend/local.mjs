// Run Astrashop's API on your machine, no AWS account needed: the real Lambda handler behind a
// small HTTP server, the in-memory database from the tests, and the sample catalog.
// Data lives in memory and resets when you stop it.
//
//   npm run local                       then, in frontend/:  npm run dev
//   PORT=9000 SHOP_KEY=… HOLD_MINUTES=5 npm run local
import http from 'node:http';
import { makeHandler } from './src/app.mjs';
import { fakeDb } from './fake-db.mjs';
import { sampleItems } from './sample-items.mjs';

const port = Number(process.env.PORT) || 8787;
const shopKey = process.env.SHOP_KEY || 'local-shop-key';
const handler = makeHandler(fakeDb(sampleItems()), {
  itemsTable: 'items',
  reservationsTable: 'reservations',
  shopKey,
  holdMinutes: Number(process.env.HOLD_MINUTES) || 1440,
});

// The same routes as template.yaml; in AWS, API Gateway does this matching and CORS.
const routes = [
  'GET /items', 'POST /reservations', 'GET /reservations/{id}',
  'GET /shop/reservations', 'PUT /shop/items/{id}',
  'POST /shop/reservations/{id}/collect', 'POST /shop/reservations/{id}/release', 'POST /shop/reservations/{id}/returned',
].map((routeKey) => {
  const [method, path] = routeKey.split(' ');
  return { routeKey, method, pattern: new RegExp(`^${path.replace('{id}', '([^/]+)')}$`) };
});
const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type,x-shop-key',
  'access-control-allow-methods': 'GET,POST,PUT,OPTIONS',
};

http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    return res.end();
  }
  let body = '';
  for await (const chunk of req) body += chunk;
  const { pathname } = new URL(req.url, 'http://localhost');
  const route = routes.find(({ method, pattern }) => method === req.method && pattern.test(pathname));
  const id = route?.pattern.exec(pathname)[1];
  const out = route
    ? await handler({
      routeKey: route.routeKey,
      pathParameters: id ? { id: decodeURIComponent(id) } : undefined,
      headers: req.headers,
      body: body || undefined,
      requestContext: { http: { sourceIp: req.socket.remoteAddress } },
    })
    : { statusCode: 404, headers: { 'content-type': 'application/json' }, body: '{"error":"Not found"}' };
  res.writeHead(out.statusCode, { ...out.headers, ...cors });
  res.end(out.body);
}).listen(port, () => console.log(`Astrashop API on http://localhost:${port}  (shop key: ${shopKey})`));

// Stands in for the 10-minute EventBridge schedule; every minute so short HOLD_MINUTES are easy to try.
setInterval(() => handler({ source: 'aws.events' }).catch((err) => console.error(err)), 60_000);
