export type Item = {
  id: string;
  name: string;
  course?: string;
  price: number;
  stock: number;
  confirmedAt: string;
  pickupWindow: string;
  sample?: boolean;
};

export type Reservation = {
  id: string;
  itemId: string;
  code: string;
  status: 'HELD' | 'COLLECTED' | 'RELEASED' | 'EXPIRED';
  createdAt: string;
  expiresAt?: string;
  collectedAt?: string;
  endedAt?: string;
};

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

class NetworkError extends Error {}

// In `npm run dev` the API defaults to the local server (backend: npm run local).
const baseUrl = (import.meta.env.VITE_API_URL ?? (import.meta.env.DEV ? 'http://localhost:8787' : ''))
  .trim().replace(/\/+$/, '');

async function request<T>(path: string, { method = 'GET', body, shopKey }: {
  method?: 'GET' | 'POST' | 'PUT';
  body?: object;
  shopKey?: string;
} = {}): Promise<T> {
  if (!baseUrl) throw new Error('Set VITE_API_URL to the deployed API URL and rebuild.');

  const headers = new Headers();
  if (body !== undefined) headers.set('content-type', 'application/json');
  if (shopKey !== undefined) headers.set('x-shop-key', shopKey);

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
    throw new ApiError(response.status, message);
  }

  try {
    return await response.json() as T;
  } catch {
    throw new NetworkError('The response was incomplete. Try again.');
  }
}

export const getItems = () => request<Item[]>('/items');
export const getReservation = (id: string) => request<Reservation>(`/reservations/${encodeURIComponent(id)}`);
export const getShopReservations = (shopKey: string) => request<Reservation[]>('/shop/reservations', { shopKey });

export async function reserveItem(id: string, itemId: string) {
  const body = { id, itemId };
  const backoff = [250, 750];
  for (let retry = 0; ; retry += 1) {
    try {
      return await request<Reservation>('/reservations', { method: 'POST', body });
    } catch (error) {
      // 429 = API Gateway throttling: the same id may already hold a unit, so retry rather than give up.
      const retryable = error instanceof NetworkError || (error instanceof ApiError && (error.status >= 500 || error.status === 429));
      if (!retryable || retry === backoff.length) throw error;
      await new Promise((resolve) => setTimeout(resolve, backoff[retry]));
    }
  }
}

// expectedStock is the count the shopkeeper started from; the API rejects the recount (409) if it changed since.
export const confirmStock = (id: string, stock: number, expectedStock: number, shopKey: string) =>
  request<Pick<Item, 'id' | 'stock'>>(`/shop/items/${encodeURIComponent(id)}`, {
    method: 'PUT', body: { stock, expectedStock }, shopKey,
  });

export const closeReservation = (id: string, action: 'collect' | 'release' | 'returned', shopKey: string) =>
  request<Pick<Reservation, 'id' | 'status'>>(`/shop/reservations/${encodeURIComponent(id)}/${action}`, {
    method: 'POST', shopKey,
  });
