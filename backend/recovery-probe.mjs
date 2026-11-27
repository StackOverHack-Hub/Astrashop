import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const phase = process.argv[2];
assert.ok(/^(outage-(redis|database)|restored-(redis|database|app))$/.test(phase));
const expected = phase.startsWith('outage') ? 503 : 200;
const start = Date.now();
const statuses = {};
async function call(path, status, headers) {
  const response = await fetch('http://127.0.0.1:8080' + path, { headers, signal: AbortSignal.timeout(7000) });
  assert.equal(response.status, status, path);
  statuses[path] = response.status;
  return response.json();
}
let ready = false;
while (Date.now() - start < 90_000) {
  try {
    const response = await fetch('http://127.0.0.1:8080/health/ready', { signal: AbortSignal.timeout(7000) });
    if (response.status === expected) { ready = true; break; }
  } catch { /* A restarted process can take a moment to listen. */ }
  await delay(500);
}
assert.ok(ready, `Readiness did not reach ${expected} during ${phase}`);
await call('/health/live', 200);
await call('/health/ready', expected);
const profile = await call('/api/marketplace/profile', expected, { authorization: 'Bearer demo-stress-0' });
const items = await call('/api/items', expected);
if (expected === 200) {
  assert.equal(profile.profile.ratingCount, 1);
  assert.equal(profile.profile.averageRating, 5);
  assert.equal(items.find(({ id }) => id === 'item-08').stock, 0);
  assert.equal(items.find(({ id }) => id === 'item-01').stock, 40);
  const mine = await call('/api/marketplace/mine', 200, { authorization: 'Bearer demo-stress-0' });
  assert.equal(mine.entries.filter(({ completedAt }) => completedAt).length, 2);
}
const report = { phase, passed: true, elapsedMs: Date.now() - start, statuses };
await writeFile('/tmp/recovery-report.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
