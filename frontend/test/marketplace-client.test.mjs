import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = await readFile(new URL('../src/marketplace-api.ts', import.meta.url), 'utf8');
const javascript = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;

async function client(fetch, { production = false, runtime = {}, location = {} } = {}) {
  const entries = new Map();
  const storage = {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, value),
    removeItem: (key) => entries.delete(key),
  };
  const events = new EventTarget();
  const replaced = [];
  const place = { origin: 'https://astrashop.example', hash: '#marketplace', search: '', assign() {}, ...location };
  let time = Date.now();
  const Clock = class extends Date { static now() { return time; } };
  const context = vm.createContext({
    fetch, window: events, sessionStorage: storage, crypto: globalThis.crypto,
    location: place,
    history: { replaceState: (_state, _title, url) => replaced.push(url) }, AbortSignal, Headers, Event, CustomEvent,
    TextEncoder, Uint8Array, URLSearchParams, atob, btoa, Date: Clock,
  });
  const module = new vm.SourceTextModule(javascript, {
    context,
    initializeImportMeta(meta) {
      meta.env = production ? {
        DEV: false, VITE_MARKETPLACE_API_URL: 'https://market.example', VITE_MARKETPLACE_LOGIN_ORIGIN: 'https://login.example',
        VITE_MARKETPLACE_CLIENT_ID: 'client',
      } : { DEV: true };
    },
  });
  await module.link((specifier) => {
    assert.equal(specifier, './runtime');
    return new vm.SyntheticModule(['runtime'], function () { this.setExport('runtime', runtime); }, { context });
  });
  await module.evaluate();
  return { api: module.namespace, storage, events, replaced, place, advance: (ms) => { time += ms; } };
}

test('429 retry delays suppress repeated calls and writes are sent once per user attempt', async () => {
  let requests = 0;
  const { api, advance } = await client(async () => {
    requests++;
    return requests === 1
      ? Response.json({ error: 'Too many requests' }, { status: 429, headers: { 'retry-after': '3' } })
      : Response.json({ saved: true });
  });
  api.setDemoIdentity('asha');
  const call = () => api.marketRequest('/saved/id', { private: true, method: 'PUT', body: { saved: true } });
  await assert.rejects(call(), (error) => error.status === 429);
  await assert.rejects(call(), /Please wait 3s/);
  assert.equal(requests, 1);
  advance(3001);
  assert.deepEqual(JSON.parse(JSON.stringify(await call())), { saved: true });
  assert.equal(requests, 2);
});

test('the same production bundle uses container runtime URLs and an explicit local auth mode', async () => {
  let target;
  const { api } = await client(async (url) => { target = url; return Response.json({ entries: [], next: null }); }, {
    production: true, runtime: { apiUrl: '/api', marketplaceApiUrl: '/api', loginOrigin: '', clientId: '', demoAuth: true },
  });
  assert.equal(api.demoMode, true);
  assert.equal(api.marketplaceEnabled, true);
  api.setDemoIdentity('asha');
  await api.marketRequest('/mine', { private: true });
  assert.equal(target, '/api/marketplace/mine');
});

test('a delayed response from the prior account cannot reach the new account', async () => {
  let resolve;
  const { api } = await client(() => new Promise((finish) => { resolve = finish; }));
  api.setDemoIdentity('asha');
  const response = api.marketRequest('/inbox', { private: true });
  await new Promise((next) => setImmediate(next));
  api.setDemoIdentity('ravi');
  resolve(Response.json({ entries: [{ id: 'private-asha-thread' }], next: null }));
  await assert.rejects(response, /account changed/);
  assert.equal(api.marketplaceAccount(), 'demo-ravi');
});

test('an expired session emits a visible event while keeping the saved listing draft', async () => {
  const { api, events } = await client(async () => Response.json({ error: 'Expired' }, { status: 401 }));
  let notified = 0;
  events.addEventListener('marketplace-auth-expired', () => { notified++; });
  api.setDemoIdentity('asha');
  const key = 'astrashop.marketplace.draft:' + api.marketplaceAccount() + ':new';
  api.storeListingDraft(key, { title: 'Drafter', id: 'pending' });
  await assert.rejects(api.marketRequest('/listings', { private: true, method: 'POST', body: {} }), (error) => error.status === 401);
  assert.equal(notified, 1);
  assert.equal(api.signedIn(), false);
  api.setDemoIdentity('ravi');
  assert.equal(api.readListingDraft('astrashop.marketplace.draft:' + api.marketplaceAccount() + ':new', Boolean), undefined);
  api.setDemoIdentity('asha');
  assert.equal(api.readListingDraft(key, Boolean).title, 'Drafter');
});

test('an aborted private read never starts the network request', async () => {
  let requests = 0;
  const { api } = await client(async () => { requests++; return Response.json({}); });
  api.setDemoIdentity('asha');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(api.marketRequest('/inbox', { private: true, signal: controller.signal }), { name: 'AbortError' });
  assert.equal(requests, 0);
});

test('concurrent expired-token reads share one refresh operation', async () => {
  let refreshes = 0;
  let requests = 0;
  const sub = '00000000-0000-4000-8000-000000000001';
  const token = 'header.' + Buffer.from(JSON.stringify({ sub })).toString('base64url') + '.signature';
  const { api, storage } = await client(async (url) => {
    if (url.endsWith('/oauth2/token')) {
      refreshes++;
      await new Promise((next) => setImmediate(next));
      return Response.json({ access_token: token, expires_in: 900 });
    }
    requests++;
    return Response.json({ entries: [], next: null });
  }, { production: true });
  storage.setItem('astrashop.marketplace.session', JSON.stringify({ access: token, refresh: 'refresh', expires: Date.now() - 1000 }));
  await Promise.all(Array.from({ length: 12 }, () => api.marketRequest('/inbox', { private: true })));
  assert.equal(refreshes, 1);
  assert.equal(requests, 12);
});

test('a rejected refresh clears the session once and preserves an account-bound draft', async () => {
  let refreshes = 0;
  const sub = '00000000-0000-4000-8000-000000000001';
  const token = 'header.' + Buffer.from(JSON.stringify({ sub })).toString('base64url') + '.signature';
  const { api, storage, events } = await client(async (url) => {
    assert.ok(url.endsWith('/oauth2/token'));
    refreshes++;
    await new Promise((next) => setImmediate(next));
    return Response.json({ error: 'invalid_grant' }, { status: 400 });
  }, { production: true });
  storage.setItem('astrashop.marketplace.session', JSON.stringify({ access: token, refresh: 'expired', expires: Date.now() - 1000 }));
  const key = 'astrashop.marketplace.draft:' + api.marketplaceAccount() + ':new';
  api.storeListingDraft(key, { title: 'Saved draft' });
  let notified = 0;
  events.addEventListener('marketplace-auth-expired', () => { notified++; });
  const results = await Promise.allSettled(Array.from({ length: 12 }, () => api.marketRequest('/inbox', { private: true })));
  assert.ok(results.every((result) => result.status === 'rejected' && result.reason.status === 401));
  assert.equal(refreshes, 1);
  assert.equal(notified, 1);
  assert.equal(api.signedIn(), false);
  assert.equal(api.readListingDraft(key, Boolean).title, 'Saved draft');
});

test('campus sign-in returns to the screen it started on', async () => {
  const sub = '00000000-0000-4000-8000-000000000001';
  const token = 'header.' + Buffer.from(JSON.stringify({ sub })).toString('base64url') + '.signature';
  for (const [hash, back] of [['', '/'], ['#shop', '/#shop'], ['#marketplace/listing/abc-123', '/#marketplace/listing/abc-123'], ['#evil', '/#marketplace']]) {
    const { api, storage, replaced, place } = await client(async () => Response.json({ access_token: token, expires_in: 900 }),
      { production: true, location: { hash } });
    await api.startSignIn();
    const { state } = JSON.parse(storage.getItem('astrashop.marketplace.pkce'));
    place.search = `?code=abc&state=${state}`;
    await api.finishSignIn();
    assert.deepEqual(replaced, [back], `signed in from "${hash}"`);
    assert.equal(api.marketplaceAccount(), sub);
  }
});
