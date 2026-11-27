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
  active?: boolean;
  photoUrl?: string;
  shopId?: string;
};

export type ShopInfo = { id: string; name: string; pickupWindow: string; default: boolean };
// A hold as the student's account sees it, on any device.
export type MyReservation = Reservation & { itemName: string; pickupWindow: string; sample?: boolean };

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

export type Role = 'owner' | 'staff';
export type ShopStatus = 'trial' | 'active' | 'suspended';
export type Membership = { shopId: string; name: string; role: Role; status: ShopStatus; pickupWindow: string };
export type Me = { id: string; platformAdmin: boolean; moderator: boolean; shops: Membership[] };
export type StaffMember = { userId: string; role: Role; name: string; addedAt?: string };
export type Invite = { token: string; role: Role; expiresAt: string };
export type AuditEntry = { id: string; at: string; actor: string; action: string; target: string; detail: Record<string, unknown> };
export type ShopSummary = {
  id: string; name: string; pickupWindow: string; status: ShopStatus; plan: string; createdAt: string;
  // Who set the status last: a platform admin by hand, or Razorpay billing.
  statusSource: 'admin' | 'billing'; billingSubscription: string; usage: { month: string; collected: number }[];
};
export type ItemInput = { name: string; course: string; price: number; pickupWindow: string };
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
export const getShops = () => request<ShopInfo[]>('/shops');
export const getShopItems = (shopId: string) => request<Item[]>(`/shops/${encodeURIComponent(shopId)}/items`);
export const getMyReservations = () => request<MyReservation[]>('/me/reservations', { signedIn: true });
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

// Shop admin: catalog, staff, invites, activity, and platform shops. All need a signed-in account.
const shopPath = (shopId: string, path = '') => `/shops/${encodeURIComponent(shopId)}${path}`;
const signed = <T>(path: string, method?: 'POST' | 'PUT', body?: object) => request<T>(path, { method, body, signedIn: true });
export const getCatalog = (shopId: string) => signed<Item[]>(shopPath(shopId, '/catalog'));
export const createItem = (shopId: string, item: ItemInput & { id: string; stock: number }) => signed<Item>(shopPath(shopId, '/items'), 'POST', item);
export const updateItem = (shopId: string, id: string, item: ItemInput & { active: boolean; expectedVersion: number }) =>
  signed<Item>(shopPath(shopId, `/items/${encodeURIComponent(id)}/details`), 'PUT', item);
export const updateShop = (shopId: string, shop: { name: string; pickupWindow: string }) => signed<ShopSummary>(shopPath(shopId), 'PUT', shop);
export const getStaff = (shopId: string) => signed<StaffMember[]>(shopPath(shopId, '/staff'));
export const setStaffRole = (shopId: string, userId: string, role: Role | null) =>
  signed<StaffMember>(shopPath(shopId, `/staff/${encodeURIComponent(userId)}`), 'PUT', { role });
export const createInvite = (shopId: string, role: Role) => signed<Invite>(shopPath(shopId, '/invites'), 'POST', { role });
export const acceptInvite = (token: string, name: string) => signed<{ shopId: string; name: string; role: Role }>('/invites/accept', 'POST', { token, name });
export const getAudit = (shopId: string, cursor?: string) =>
  signed<{ entries: AuditEntry[]; next: string | null }>(shopPath(shopId, `/audit${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`));
export const listShops = () => signed<ShopSummary[]>('/admin/shops');
export const createShop = (shop: { id: string; name: string; pickupWindow: string }) => signed<ShopSummary>('/admin/shops', 'POST', shop);
export const updateShopAdmin = (shopId: string, change: { status?: ShopStatus; plan?: string }) =>
  signed<{ id: string; status?: ShopStatus; plan?: string }>(`/admin/shops/${encodeURIComponent(shopId)}`, 'PUT', change);
export const inviteLink = (token: string) => `${location.origin}/#admin/join/${token}`;
// data is the photo as base64 (resized in the browser first), or null to remove it.
export const uploadPhoto = (shopId: string, id: string, data: string | null) =>
  signed<Item>(shopPath(shopId, `/items/${encodeURIComponent(id)}/photo`), 'PUT', { data });

// Shrinks a photo to at most 1200 px on its long side, as a JPEG of about 100-250 KB, and returns it as base64.
export async function resizePhoto(file: File) {
  // Some Safari versions reject the options argument; the plain call still reads the photo.
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => createImageBitmap(file)).catch(() => {
    throw new Error('This file could not be read as a photo. Try a JPEG or PNG.');
  });
  const scale = Math.min(1, 1200 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const context = canvas.getContext('2d')!;
  context.fillStyle = '#fff'; // transparent PNGs get a white background instead of black
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((done) => canvas.toBlob(done, 'image/jpeg', 0.82));
  if (!blob) throw new Error('This photo could not be prepared. Try another one.');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
