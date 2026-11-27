import { runtime } from './runtime';
import { accessToken } from './marketplace-api';

export type Item = {
  id: string;
  name: string;
  course?: string;
  price: number;
  stock: number;
  confirmedAt: string;
  pickupWindow: string;
  sample?: boolean;
  version?: number;
};

export type Reservation = {
  id: string;
  itemId: string;
  code: string;
  status: 'HELD' | 'COLLECTED' | 'RELEASED' | 'EXPIRED';
  createdAt: string;
  expiresAt?: string;
  setAsideAt?: string;
  collectedAt?: string;
  endedAt?: string;
};

export type ShopStats = {
  reservations: number;
  waitingToSetAside: number;
  setAside: number;
  collected: number;
  expired: number;
  released: number;
  medianMinutesToSetAside: number | null;
  medianMinutesToCollect: number | null;
  since: string | null;
};

export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) {
    super(message);
  }
}

export type Me = { id: string; platformAdmin: boolean; shops: { shopId: string; name: string; role: 'owner' | 'staff' }[] };
// Staff open the counter with their account; the pilot shop can still use its shared key.
export type Counter = { shopId: string; name: string } | { key: string };

class NetworkError extends Error {}

// In `npm run dev` the API defaults to the local server (backend: npm run local).
const baseUrl = (runtime.apiUrl ?? import.meta.env.VITE_API_URL ?? (import.meta.env.DEV ? 'http://localhost:8787' : ''))
  .trim().replace(/\/+$/, '');

async function request<T>(path: string, { method = 'GET', body, counter, signedIn = false }: {
  method?: 'GET' | 'POST' | 'PUT';
  body?: object;
  counter?: Counter;
  signedIn?: boolean;
} = {}): Promise<T> {
  if (!baseUrl) throw new Error('Set VITE_API_URL to the deployed API URL and rebuild.');

  const headers = new Headers();
  if (body !== undefined) headers.set('content-type', 'application/json');
  if (counter && 'key' in counter) headers.set('x-shop-key', counter.key);
  if (signedIn || (counter && 'shopId' in counter)) {
    try {
      headers.set('authorization', `Bearer ${await accessToken()}`);
    } catch (error) {
      throw new ApiError(401, (error as Error).message);
    }
  }

  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(12_000),
    });
  } catch {
    throw new NetworkError('Could not reach Astrashop. Check your connection and try again.');
  }

  if (!response.ok) {
    const data = await response.json().catch(() => undefined);
    const message = typeof data?.error === 'string' ? data.error : `Request failed (${response.status}).`;
    throw new ApiError(response.status, message, typeof data?.code === 'string' ? data.code : undefined);
  }

  try {
    return await response.json() as T;
  } catch {
    throw new NetworkError('The response was incomplete. Try again.');
  }
}

// The pilot key opens the original /shop routes; an account opens /shops/{its shop}.
const counterPath = (counter: Counter, path: string) =>
  'key' in counter ? `/shop${path}` : `/shops/${encodeURIComponent(counter.shopId)}${path}`;

export const getItems = () => request<Item[]>('/items');
export const getShopItems = (shopId: string) => request<Item[]>(`/shops/${encodeURIComponent(shopId)}/items`);
export const getMe = () => request<Me>('/me', { signedIn: true });
export const getReservation = (id: string) => request<Reservation>(`/reservations/${encodeURIComponent(id)}`);
export const getShopReservations = (counter: Counter) => request<Reservation[]>(counterPath(counter, '/reservations'), { counter });
export const getShopStats = (counter: Counter) => request<ShopStats>(counterPath(counter, '/stats'), { counter });

export async function reserveItem(id: string, itemId: string) {
  const body = { id, itemId };
  const backoff = [250, 750];
  for (let retry = 0; ; retry += 1) {
    try {
      return await request<Reservation>('/reservations', { method: 'POST', body, signedIn: true });
    } catch (error) {
      // 429 = API Gateway throttling: the same id may already hold a unit, so retry rather than give up.
      const retryable = error instanceof NetworkError || (error instanceof ApiError && (error.status >= 500 || error.status === 429));
      if (!retryable || retry === backoff.length) throw error;
      await new Promise((resolve) => setTimeout(resolve, backoff[retry]));
    }
  }
}

// expected is the item as the shopkeeper started counting it; the API rejects the recount (409) if it changed since.
export const confirmStock = (id: string, stock: number, expected: Pick<Item, 'stock' | 'version'>, counter: Counter) =>
  request<Pick<Item, 'id' | 'stock'>>(counterPath(counter, `/items/${encodeURIComponent(id)}`), {
    method: 'PUT', counter,
    body: expected.version === undefined ? { stock, expectedStock: expected.stock } : { stock, expectedVersion: expected.version },
  });

export type HoldAction = 'set-aside' | 'collect' | 'release' | 'returned';

export const holdAction = (id: string, action: HoldAction, counter: Counter) =>
  request<Pick<Reservation, 'id' | 'status'>>(counterPath(counter, `/reservations/${encodeURIComponent(id)}/${action}`), {
    method: 'POST', counter,
  });
