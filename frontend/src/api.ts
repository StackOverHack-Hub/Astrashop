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
  status: 'HELD' | 'COLLECTED' | 'RELEASED';
  createdAt: string;
  collectedAt?: string;
};

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

class NetworkError extends Error {}

const baseUrl = import.meta.env.VITE_API_URL?.trim().replace(/\/+$/, '');

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
      const retryable = error instanceof NetworkError || (error instanceof ApiError && error.status >= 500);
      if (!retryable || retry === backoff.length) throw error;
      await new Promise((resolve) => setTimeout(resolve, backoff[retry]));
    }
  }
}

export const confirmStock = (id: string, stock: number, shopKey: string) =>
  request<Pick<Item, 'id' | 'stock'>>(`/shop/items/${encodeURIComponent(id)}`, {
    method: 'PUT', body: { stock }, shopKey,
  });

export const closeReservation = (id: string, action: 'collect' | 'release', shopKey: string) =>
  request<Pick<Reservation, 'id' | 'status'>>(`/shop/reservations/${encodeURIComponent(id)}/${action}`, {
    method: 'POST', shopKey,
  });
