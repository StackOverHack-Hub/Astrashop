import { readFileSync } from 'node:fs';
import { SHOP_ID } from './app.mjs';

const bool = (value, fallback = false) => value === undefined ? fallback : value === 'true';
function integer(value, fallback, min, max, name) {
  const n = Number(value ?? fallback);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`Invalid ${name}`);
  return n;
}
function secret(env, key) {
  return env[`${key}_FILE`] ? readFileSync(env[`${key}_FILE`], 'utf8').trim() : env[key];
}
function setting(value, label) {
  if (!value || value.length > 512 || /[\r\n]/.test(value)) throw new Error(`${label} is required`);
  return value;
}
function origin(value, name, local) {
  const url = new URL(setting(value, name));
  if ((!local && url.protocol !== 'https:') || !['http:', 'https:'].includes(url.protocol)
    || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error(`Invalid ${name}`);
  return url.origin;
}

export function containerConfig(env = process.env) {
  const mode = env.APP_ENV ?? 'production';
  if (!['local', 'production'].includes(mode)) throw new Error('APP_ENV must be local or production');
  const local = mode === 'local';
  const authMode = env.AUTH_MODE ?? (local ? 'demo' : 'cognito');
  if (authMode !== (local ? 'demo' : 'cognito')) throw new Error('Use demo auth locally and Cognito in production');
  if (!local && env.DYNAMO_ENDPOINT) throw new Error('Production must use managed DynamoDB');
  const region = env.AWS_REGION ?? (local ? 'us-east-1' : undefined);
  // The pilot's shared counter key is optional: leave it unset once every shop signs in with accounts.
  const shopKey = secret(env, 'SHOP_KEY') ?? (local ? 'local-shop-key' : undefined);
  setting(region, 'AWS_REGION');
  if (shopKey !== undefined) setting(shopKey, 'SHOP_KEY');
  if (!local && shopKey !== undefined && shopKey.length < 16) throw new Error('SHOP_KEY must be at least 16 characters');
  const defaultShopId = env.DEFAULT_SHOP_ID ?? 'campus-shop';
  if (!SHOP_ID.test(defaultShopId)) throw new Error('Invalid DEFAULT_SHOP_ID');
  const redisTls = bool(env.REDIS_TLS, !local);
  if (!local && !redisTls) throw new Error('Production Redis requires TLS');
  const allowedOrigin = origin(env.ALLOWED_ORIGIN ?? (local ? 'http://localhost:8080' : ''), 'ALLOWED_ORIGIN', local);
  const loginOrigin = local ? '' : origin(env.COGNITO_LOGIN_ORIGIN, 'COGNITO_LOGIN_ORIGIN', false);
  const clientId = local ? '' : setting(env.COGNITO_CLIENT_ID, 'COGNITO_CLIENT_ID');
  const poolId = local ? '' : setting(env.COGNITO_USER_POOL_ID, 'COGNITO_USER_POOL_ID');
  const tables = {
    items: env.ITEMS_TABLE ?? (local ? 'astrashop-items' : ''),
    reservations: env.RESERVATIONS_TABLE ?? (local ? 'astrashop-reservations' : ''),
    marketplace: env.MARKETPLACE_TABLE ?? (local ? 'astrashop-marketplace' : ''),
    tenancy: env.TENANCY_TABLE ?? (local ? 'astrashop-tenancy' : ''),
  };
  for (const [name, value] of Object.entries(tables)) {
    if (!/^[\w.-]{3,255}$/.test(value)) throw new Error(`Invalid ${name} table name`);
  }
  return {
    local, authMode, region, shopKey, defaultShopId, tables, allowedOrigin, loginOrigin, clientId, poolId,
    port: integer(env.PORT, 8080, 1, 65535, 'PORT'), host: env.HOST ?? '0.0.0.0',
    holdMinutes: integer(env.HOLD_MINUTES, 1440, 1, 525600, 'HOLD_MINUTES'),
    testUsers: local ? integer(env.LOCAL_TEST_USERS, 0, 0, 128, 'LOCAL_TEST_USERS') : 0,
    trustProxyHops: integer(env.TRUST_PROXY_HOPS, 0, 0, 3, 'TRUST_PROXY_HOPS'),
    endpoint: local ? setting(env.DYNAMO_ENDPOINT, 'DYNAMO_ENDPOINT') : undefined,
    redis: {
      host: setting(env.REDIS_HOST, 'REDIS_HOST'), port: integer(env.REDIS_PORT, 6379, 1, 65535, 'REDIS_PORT'),
      password: secret(env, 'REDIS_PASSWORD'), tls: redisTls, cluster: bool(env.REDIS_CLUSTER, !local),
    },
    publicDir: env.PUBLIC_DIR,
    publicConfig: { apiUrl: '/api', marketplaceApiUrl: '/api', loginOrigin, clientId, demoAuth: local },
  };
}
