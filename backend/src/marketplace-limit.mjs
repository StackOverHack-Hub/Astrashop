import Redis, { Cluster } from 'ioredis';

// Redis TIME gives all Lambda instances a common clock. One key keeps each
// evaluation within a single cluster slot and expires inactive buckets.
export const tokenBucket = `
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local capacity = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local previous = redis.call('HMGET', KEYS[1], 'tokens', 'time')
local at = tonumber(previous[2]) or now
now = math.max(now, at)
local tokens = math.min(capacity, (tonumber(previous[1]) or capacity) + (now - at) * capacity / window)
if tokens < 1 then
  return math.ceil((1 - tokens) * window / capacity / 1000)
end
redis.call('HSET', KEYS[1], 'tokens', tokens - 1, 'time', now)
redis.call('PEXPIRE', KEYS[1], window)
return 0
`;

export function redisLimiter({ host, port, password, cluster = true, tls = true }) {
  let client;
  let connecting;
  async function connect() {
    if (client?.status === 'ready') return client;
    if (!connecting) {
      client?.disconnect();
      const redisOptions = {
        password: password || undefined,
        ...(tls ? { tls: {} } : {}),
        connectTimeout: 1000, commandTimeout: 1000,
        maxRetriesPerRequest: 0, enableOfflineQueue: false,
        enableReadyCheck: false, retryStrategy: () => null,
      };
      client = cluster ? new Cluster([{ host, port }], {
        lazyConnect: true,
        enableReadyCheck: false,
        enableOfflineQueue: false,
        clusterRetryStrategy: () => null,
        slotsRefreshTimeout: 1000,
        maxRedirections: 2,
        dnsLookup: (address, callback) => callback(null, address),
        redisOptions,
      }) : new Redis({ host, port, lazyConnect: true, ...redisOptions });
      client.on('error', () => {}); // The route logs one bounded failure per failed request.
      const candidate = client;
      connecting = candidate.connect().then(() => candidate).finally(() => { connecting = undefined; });
    }
    return connecting;
  }
  const limit = async (key, { capacity, windowMs }) => {
    const redis = await connect();
    return Number(await redis.eval(tokenBucket, 1, `astrashop:marketplace:${key}`, capacity, windowMs));
  };
  limit.health = async () => { await (await connect()).ping(); };
  limit.close = () => client?.disconnect();
  return limit;
}
