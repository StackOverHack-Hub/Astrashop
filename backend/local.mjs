// Run Astrashop's API on your machine, no AWS account needed: the real Lambda handler behind a
// small HTTP server, the in-memory database from the tests, and the sample catalog.
// Data lives in memory and resets when you stop it.
//
//   npm run local                       then, in frontend/:  npm run dev
//   PORT=9000 SHOP_KEY=… HOLD_MINUTES=5 npm run local
import http from 'node:http';
import { makeHandler } from './src/app.mjs';
import { fakeDb } from './fake-db.mjs';
import { migrateToTenancy } from './src/tenancy-migration.mjs';
import { seedLocalShop } from './src/container-bootstrap.mjs';
import { shopRoutes } from './src/http-server.mjs';
import { demoIdentities } from './server.mjs';
import { sampleItems } from './sample-items.mjs';
import { makeMarketplace } from './src/marketplace.mjs';
import { memoryMarketplace, memoryLimiter } from './marketplace-local.mjs';

const port = Number(process.env.PORT) || 8787;
const shopKey = process.env.SHOP_KEY || 'local-shop-key';
const host = process.env.HOST || '127.0.0.1';
const holdMinutes = Number(process.env.HOLD_MINUTES) || 1440;
const db = fakeDb(sampleItems());
const handler = makeHandler(db, {
  itemsTable: 'items', reservationsTable: 'reservations', tenancyTable: 'tenancy', shopKey, holdMinutes,
});
// Demo accounts: asha, ravi and neha are students, owner and staff run the demo shop, admin opens shops.
const identities = demoIdentities();
await migrateToTenancy(db, { items: 'items', reservations: 'reservations', tenancy: 'tenancy' }, {
  shopId: 'campus-shop', name: 'Campus stationery shop', pickupWindow: 'Mon–Sat, 10 am–6 pm', holdMinutes,
});
await seedLocalShop(handler, identities, 'campus-shop');
const profiles = new Map([
  ['Bearer demo-asha', { id: 'asha' }],
  ['Bearer demo-ravi', { id: 'ravi' }],
  ['Bearer demo-neha', { id: 'neha' }],
  ['Bearer demo-moderator', { id: 'moderator', moderator: true }],
  ...['owner', 'staff', 'admin'].map((name) => [`Bearer demo-${name}`, { id: name }]),
]);
const store = memoryMarketplace();
const actorFrom = (event) => profiles.get(event.headers.authorization);
const marketplace = makeMarketplace(store, memoryLimiter(), { actorFrom });
const seedMarketplace = makeMarketplace(store, async () => 0, { actorFrom });
for (const [account, name, programme, about] of [
  ['asha', 'Asha', 'Product Design', 'I share drawing supplies and help students get started in the workshop.'],
  ['ravi', 'Ravi', 'Mechanical Engineering', 'I like fixing bikes and finding a second home for useful things.'],
]) {
  await seedMarketplace({
    routeKey: 'PUT /marketplace/profile',
    headers: { authorization: `Bearer demo-${account}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name, programme, about }),
  });
}
for (const [index, [kind, title, description, meetup, pricePaise]] of [
  ['item', 'Mini drafter', 'Used for one drawing course. Includes the carrying sleeve.', 'Library courtyard', 24000],
  ['service', 'Bicycle tune-up', 'I can adjust your brakes and gears after class.', 'Student activity centre', 15000],
  ['favor', 'Help with first-year lab setup', 'I can show you how to set up the shared equipment.', 'Physics lab lobby', 0],
].entries()) {
  await seedMarketplace({
    routeKey: 'POST /marketplace/listings',
    headers: { authorization: index === 1 ? 'Bearer demo-ravi' : 'Bearer demo-asha', 'content-type': 'application/json' },
    body: JSON.stringify({ id: `00000000-0000-4000-8000-00000000000${index}`, kind, title, description, meetup, pricePaise,
      ...(kind === 'item' ? { condition: 'good' } : { scope: description }), availability: 'Weekdays after class' }),
  });
}

// The same routes as template.yaml; in AWS, API Gateway does this matching and CORS.
const routes = [
  ...shopRoutes,
  'GET /marketplace/listings', 'POST /marketplace/listings', 'GET /marketplace/mine',
  'PUT /marketplace/listings/{id}', 'POST /marketplace/listings/{id}/contact',
  'POST /marketplace/listings/{id}/report', 'GET /marketplace/inbox',
  'GET /marketplace/threads/{id}', 'POST /marketplace/threads/{id}',
  'GET /marketplace/reports', 'PUT /marketplace/listings/{id}/moderate',
  'GET /marketplace/listings/{id}', 'GET /marketplace/listings/{id}/comments', 'POST /marketplace/listings/{id}/comments',
  'PUT /marketplace/listings/{id}/comments/{commentId}',
  'GET /marketplace/sellers', 'GET /marketplace/sellers/{id}',
  'GET /marketplace/sellers/{id}/listings', 'GET /marketplace/sellers/{id}/reviews',
  'GET /marketplace/profile', 'PUT /marketplace/profile',
  'GET /marketplace/saved', 'GET /marketplace/saved/{id}', 'PUT /marketplace/saved/{id}',
  'GET /marketplace/threads/{id}/exchange', 'PUT /marketplace/threads/{id}/exchange', 'POST /marketplace/threads/{id}/review',
].map((routeKey) => {
  const [method, path] = routeKey.split(' ');
  const params = [...path.matchAll(/\{(\w+)\}/g)].map((match) => match[1]);
  return { routeKey, method, params, pattern: new RegExp(`^${path.replace(/\{\w+\}/g, '([^/]+)')}$`) };
});
const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type,x-shop-key,authorization',
  'access-control-allow-methods': 'GET,POST,PUT,OPTIONS',
  'access-control-expose-headers': 'retry-after',
};

function localError(res, statusCode, error) {
  res.writeHead(statusCode, { ...cors, 'content-type': 'application/json' });
  res.end(JSON.stringify({ error }));
}

http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    return res.end();
  }
  try {
    const { pathname, searchParams } = new URL(req.url, 'http://localhost');
    const route = routes.find(({ method, pattern }) => method === req.method && pattern.test(pathname));
    if (!route) return localError(res, 404, 'Not found');
    const values = route.pattern.exec(pathname).slice(1);
    const chunks = [];
    let size = 0;
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      size += chunk.length;
      if (size > 8192) {
        req.resume();
        return localError(res, 413, 'Request is too large.');
      }
      chunks.push(chunk);
    }
    const dispatch = pathname.startsWith('/marketplace/') ? marketplace : handler;
    const claims = identities.get(req.headers.authorization);
    const out = await dispatch({
      routeKey: route.routeKey,
      pathParameters: Object.fromEntries(route.params.map((name, index) => [name, decodeURIComponent(values[index])])),
      queryStringParameters: Object.fromEntries(searchParams),
      headers: req.headers,
      body: size ? Buffer.concat(chunks).toString('utf8') : undefined,
      requestContext: { http: { sourceIp: req.socket.remoteAddress }, ...(claims ? { authorizer: { jwt: { claims } } } : {}) },
    });
    res.writeHead(out.statusCode, { ...out.headers, ...cors });
    res.end(out.body);
  } catch (error) {
    if (!res.headersSent) localError(res, error instanceof URIError ? 400 : 500, 'Could not complete the request.');
  }
}).listen(port, host, () => console.log(`AstraShop API on http://${host}:${port}`));

// Stands in for the 10-minute EventBridge schedule; every minute so short HOLD_MINUTES are easy to try.
setInterval(() => handler({ source: 'aws.events' }).catch((err) => console.error(err)), 60_000);
