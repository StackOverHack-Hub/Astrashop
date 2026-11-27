import assert from 'node:assert/strict';
import { request } from 'node:http';
import test from 'node:test';
import { createHttpServer } from '../src/http-server.mjs';
import { containerConfig } from '../src/container-config.mjs';

async function fixture(context, options = {}) {
  const handler = async (event) => ({ statusCode: 200, body: JSON.stringify({ route: event.routeKey, ip: event.requestContext.http.sourceIp, claims: event.requestContext.authorizer?.jwt?.claims }) });
  const server = createHttpServer({ shop: handler, marketplace: handler, verify: async () => { throw new Error('Invalid token'); },
    allowedOrigin: 'http://localhost:8080', ...options });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  context.after(() => new Promise((done) => { server.closeAllConnections(); server.close(done); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  const call = (path, options = {}) => fetch(url + path, { ...options, signal: AbortSignal.timeout(3000) });
  return { call, url };
}

test('HTTP transport bounds bodies, rejects malformed encodings and methods, and ignores spoofed IP headers', async (context) => {
  const { call, url } = await fixture(context);
  const ip = await (await call('/api/items', { headers: { 'x-forwarded-for': '1.2.3.4' } })).json();
  assert.equal(ip.ip, '127.0.0.1');
  assert.equal(ip.route, 'GET /items');
  assert.equal((await call('/api/items', { method: 'DELETE' })).status, 405);
  assert.equal((await call('/api/reservations/%ZZ')).status, 400);
  assert.equal((await call('/api/reservations', { method: 'POST', body: 'x'.repeat(8193) })).status, 413);
  assert.equal((await call('/api/items?' + 'x'.repeat(2100))).status, 414);
  assert.equal((await call('/api/marketplace/profile', { headers: { authorization: 'Bearer invalid' } })).status, 401);
  const encoding = await call('/api/reservations', { method: 'POST', body: new Uint8Array([0xc3, 0x28]) });
  assert.equal(encoding.status, 400);
  const chunked = await new Promise((done, fail) => {
    const req = request(url + '/api/reservations', { method: 'POST' }, (res) => { res.resume(); done(res.statusCode); });
    req.on('error', fail);
    req.write('x'.repeat(5000));
    req.end('x'.repeat(5000));
  });
  assert.equal(chunked, 413);
  assert.equal((await call('/health/live')).status, 200);
});

test('HTTP startup settings contain no secrets and CORS only permits the configured origin', async (context) => {
  const { call } = await fixture(context, { publicConfig: { apiUrl: '/api', demoAuth: true } });
  const settings = await call('/config.js');
  assert.equal(settings.headers.get('cache-control'), 'no-store');
  assert.match(await settings.text(), /"apiUrl":"\/api"/);
  const allowed = await call('/api/items', { method: 'OPTIONS', headers: { origin: 'http://localhost:8080' } });
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'http://localhost:8080');
  assert.equal((await call('/api/items', { method: 'OPTIONS', headers: { origin: 'https://outside.example' } })).status, 403);
  assert.equal((await call('/.env')).status, 404);
});

test('HTTP readiness recovers from an unavailable service and active requests stay bounded', async (context) => {
  let available = false;
  let finish;
  const blocked = new Promise((done) => { finish = done; });
  const { call } = await fixture(context, {
    maxActive: 2,
    readiness: async () => { if (!available) throw new Error('Unavailable'); },
    shop: async () => { await blocked; return { statusCode: 200, body: '{}' }; },
  });
  assert.equal((await call('/health/ready')).status, 503);
  const requests = [call('/items'), call('/items')];
  await new Promise((done) => setTimeout(done, 30));
  assert.equal((await call('/items')).status, 503);
  finish();
  assert.ok((await Promise.all(requests)).every((response) => response.ok));
  available = true;
  await new Promise((done) => setTimeout(done, 1050));
  assert.equal((await call('/health/ready')).status, 200);
});

test('clients that stall mid-upload do not use up the active request limit', async (context) => {
  const { connect } = await import('node:net');
  const { call, url } = await fixture(context, { maxActive: 2 });
  const { port } = new URL(url);
  const stalled = await Promise.all(Array.from({ length: 3 }, () => new Promise((done) => {
    const socket = connect(Number(port), '127.0.0.1', () => {
      socket.write('POST /api/reservations HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 50\r\n\r\n{"id":');
      done(socket);
    });
    socket.on('error', () => {});
  })));
  context.after(() => stalled.forEach((socket) => socket.destroy()));
  await new Promise((done) => setTimeout(done, 50));
  assert.equal((await call('/api/items')).status, 200);
});

test('production configuration rejects demo auth, local persistence and unencrypted Redis', () => {
  const local = { APP_ENV: 'local', DYNAMO_ENDPOINT: 'http://dynamodb:8000', REDIS_HOST: 'redis' };
  assert.equal(containerConfig(local).publicConfig.demoAuth, true);
  const production = {
    APP_ENV: 'production', AWS_REGION: 'ap-south-1', SHOP_KEY: 'a-long-shop-key-for-testing',
    ITEMS_TABLE: 'items', RESERVATIONS_TABLE: 'reservations', MARKETPLACE_TABLE: 'marketplace', TENANCY_TABLE: 'tenancy',
    REDIS_HOST: 'redis.example', ALLOWED_ORIGIN: 'https://shop.example',
    COGNITO_LOGIN_ORIGIN: 'https://login.example', COGNITO_CLIENT_ID: 'client', COGNITO_USER_POOL_ID: 'ap-south-1_pool',
  };
  assert.equal(containerConfig(production).publicConfig.demoAuth, false);
  assert.equal(containerConfig(production).testUsers, 0);
  assert.equal(containerConfig(production).endpoint, undefined);
  for (const change of [{ AUTH_MODE: 'demo' }, { DYNAMO_ENDPOINT: 'http://dynamodb:8000' }, { REDIS_TLS: 'false' }, { SHOP_KEY: 'short' },
    { ALLOWED_ORIGIN: 'http://shop.example' }, { TENANCY_TABLE: undefined }, { DEFAULT_SHOP_ID: 'Not A Shop' }]) {
    assert.throws(() => containerConfig({ ...production, ...change }));
  }
  // The pilot counter key is optional: without it, staff open the counter only with accounts.
  const { SHOP_KEY: _key, ...accountsOnly } = production;
  assert.equal(containerConfig(accountsOnly).shopKey, undefined);
  assert.throws(() => containerConfig({ ...local, LOCAL_TEST_USERS: '999' }));
});

test('a sign-in provider outage is retryable and does not expire the browser session', async (context) => {
  const { call } = await fixture(context, { verify: async () => { throw Object.assign(new Error('Unavailable'), { code: 'AUTH_UNAVAILABLE' }); } });
  const response = await call('/api/marketplace/profile', { headers: { authorization: 'Bearer token' } });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('retry-after'), '2');
});
