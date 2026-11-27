import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { tokenVerifier } from './src/container-auth.mjs';
import { makeHandler } from './src/app.mjs';
import { backfillListingWords, makeMarketplace } from './src/marketplace.mjs';
import { diskPhotos, s3Photos } from './src/photo-store.mjs';
import { emfMetrics } from './src/metrics.mjs';
import { dynamoMarketplace } from './src/marketplace-store.mjs';
import { redisLimiter } from './src/marketplace-limit.mjs';
import { containerConfig } from './src/container-config.mjs';
import { initializeLocalTables, seedLocalMarketplace, seedLocalShop } from './src/container-bootstrap.mjs';
import { migrateToTenancy } from './src/tenancy-migration.mjs';
import { createHttpServer } from './src/http-server.mjs';
import { digest } from './src/marketplace-shared.mjs';

const demoGroups = { moderator: ['MarketplaceModerators'], admin: ['PlatformAdmins'] };

export function demoIdentities(count = 0) {
  const identities = new Map(['asha', 'ravi', 'neha', 'moderator', 'owner', 'staff', 'admin'].map((name, index) => [
    `Bearer demo-${name}`, {
      sub: `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`, token_use: 'access',
      'cognito:groups': demoGroups[name] ?? [],
    },
  ]));
  for (let index = 0; index < count; index++) identities.set(`Bearer demo-stress-${index}`, {
    sub: `20000000-0000-4000-8000-${String(index).padStart(12, '0')}`, token_use: 'access',
  });
  return identities;
}

export async function startContainer(env = process.env) {
  const config = containerConfig(env);
  const client = new DynamoDBClient({
    region: config.region, endpoint: config.endpoint, maxAttempts: 2,
    ...(config.local ? { credentials: { accessKeyId: 'local', secretAccessKey: 'local' } } : {}),
    requestHandler: { connectionTimeout: 1000, requestTimeout: 2000, throwOnRequestTimeout: true },
  });
  const db = DynamoDBDocumentClient.from(client);
  const limit = redisLimiter(config.redis);
  const store = dynamoMarketplace(db, config.tables.marketplace);
  const marketplace = makeMarketplace(store, limit);
  const photos = !config.photos ? undefined
    : config.photos.dir ? diskPhotos(config.photos) : s3Photos(config.photos);
  const shopHandler = makeHandler(db, {
    itemsTable: config.tables.items, reservationsTable: config.tables.reservations, tenancyTable: config.tables.tenancy,
    shopKey: config.shopKey, defaultShopId: config.defaultShopId, holdMinutes: config.holdMinutes, photos,
    razorpaySecret: config.razorpaySecret, emit: emfMetrics(),
  });
  const shop = async (event) => {
    if (event.source === 'aws.events') return shopHandler(event);
    let wait;
    try {
      const write = !event.routeKey.startsWith('GET ');
      const buckets = [[`shop-${write ? 'write' : 'read'}:${digest(event.requestContext.http.sourceIp)}`,
        { capacity: write ? 60 : 600, windowMs: 60_000 }]];
      // Per account as well as per network: the hold limit caps hoarding, this caps hammering.
      const student = event.requestContext.authorizer?.jwt?.claims?.sub;
      if (event.routeKey === 'POST /reservations' && student) buckets.push([`reserve:${digest(student)}`, { capacity: 20, windowMs: 600_000 }]);
      for (const [key, policy] of buckets) if ((wait = await limit(key, policy))) break;
    } catch { return { statusCode: 503, headers: { 'content-type': 'application/json', 'retry-after': '2' }, body: JSON.stringify({ error: 'Shop is temporarily busy. Try again.' }) }; }
    if (wait) return { statusCode: 429, headers: { 'content-type': 'application/json', 'retry-after': String(wait) }, body: JSON.stringify({ error: 'Too many requests. Try again shortly.' }) };
    return shopHandler(event);
  };
  const identities = demoIdentities(config.testUsers);
  if (config.local) {
    await initializeLocalTables(client, db, config.tables);
    await migrateToTenancy(db, config.tables, {
      shopId: config.defaultShopId, name: 'Campus stationery shop', pickupWindow: 'Mon–Sat, 10 am–6 pm', holdMinutes: config.holdMinutes,
    });
    await seedLocalShop(shopHandler, identities, config.defaultShopId);
    await backfillListingWords(store);
    await seedLocalMarketplace(makeMarketplace(store, async () => 0), identities);
  }
  const verify = tokenVerifier(config, identities);
  const readiness = async () => {
    await Promise.all([
      limit.health(), store.get('_health', '_health'),
      ...[config.tables.items, config.tables.reservations].map((TableName) => db.send(new GetCommand({ TableName, Key: { id: '_health' } }))),
      db.send(new GetCommand({ TableName: config.tables.tenancy, Key: { pk: '_health', sk: '_health' } })),
    ]);
  };
  const server = createHttpServer({
    shop, marketplace, verify, readiness, photos,
    publicDir: config.publicDir ?? resolve(import.meta.dirname, '../frontend/dist'),
    publicConfig: config.publicConfig, allowedOrigin: config.allowedOrigin,
    trustProxyHops: config.trustProxyHops, production: !config.local,
  });
  await new Promise((done, fail) => { server.once('error', fail); server.listen(config.port, config.host, done); });
  const expiry = setInterval(() => shop({ source: 'aws.events' }).catch((error) =>
    console.error(JSON.stringify({ event: 'hold_expiry_failed', type: error.name }))), 60_000);
  expiry.unref();
  console.info(JSON.stringify({ event: 'server_started', mode: config.local ? 'local' : 'production', port: config.port }));
  return {
    server,
    async close() {
      clearInterval(expiry);
      const force = setTimeout(() => server.closeAllConnections(), 8000);
      force.unref();
      await new Promise((done) => server.close(done));
      clearTimeout(force);
      limit.close();
      client.destroy();
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const app = await startContainer();
  let stopping = false;
  const stop = async () => { if (!stopping) { stopping = true; await app.close(); } };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}
