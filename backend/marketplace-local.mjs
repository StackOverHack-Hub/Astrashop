// Local and test stand-ins for the marketplace repository and rate limiter.
export function memoryMarketplace() {
  const rows = new Map();
  const key = (pk, sk) => JSON.stringify([pk, sk]);
  const compare = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
  return {
    async get(pk, sk) {
      return structuredClone(rows.get(key(pk, sk)));
    },
    async getMany(keys) {
      return structuredClone(keys.map(([pk, sk]) => rows.get(key(pk, sk))));
    },
    async query(pk, { lower, upper, ascending = false, limit }) {
      return structuredClone([...rows.values()].filter((row) => row.pk === pk &&
        (lower === undefined || compare(row.sk, lower) >= 0) &&
        (upper === undefined || (lower === undefined ? compare(row.sk, upper) < 0 : compare(row.sk, upper) <= 0)))
        .sort((a, b) => compare(a.sk, b.sk) * (ascending ? 1 : -1)).slice(0, limit));
    },
    async transact(writes) {
      for (const { kind, row, version } of writes) {
        if (!['guard', 'check', 'guardDelete'].includes(kind)) continue;
        const current = rows.get(key(row.pk, row.sk));
        if (version === undefined ? current : !current || (current.version ?? 0) !== version) return false;
      }
      for (const { kind, row } of writes) {
        if (kind === 'check') continue;
        const id = key(row.pk, row.sk);
        if (kind === 'delete' || kind === 'guardDelete') rows.delete(id);
        else if (kind === 'rating') {
          const previous = rows.get(id);
          rows.set(id, { pk: row.pk, sk: row.sk, count: (previous?.count ?? 0) + 1, sum: (previous?.sum ?? 0) + row.rating });
        }
        else rows.set(id, structuredClone(row));
      }
      return true;
    },
  };
}

export function memoryLimiter(now = Date.now) {
  const buckets = new Map();
  return async (key, { capacity, windowMs }) => {
    const time = now();
    const old = buckets.get(key);
    const refill = capacity / windowMs;
    const available = Math.min(capacity, old ? old.available + (time - old.time) * refill : capacity);
    if (available < 1) return Math.ceil((1 - available) / refill / 1000);
    buckets.set(key, { available: available - 1, time });
    if (buckets.size > 1000) {
      for (const [name, value] of buckets) if (time - value.time > 300_000) buckets.delete(name);
    }
    return 0;
  };
}
