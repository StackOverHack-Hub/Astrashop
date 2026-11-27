import { runtime } from './runtime';

export const categories = { item: 'Items', service: 'Services', favor: 'Favors' } as const;
export const conditions = { new: 'New', 'like-new': 'Like new', good: 'Good', fair: 'Fair' } as const;
export type Kind = keyof typeof categories;
export type Condition = keyof typeof conditions | '';
export type ListingInput = {
  kind: Kind; title: string; description: string; meetup: string; pricePaise: number;
  condition: Condition; scope: string; availability: string;
};
export type SellerIdentity = { id: string; name: string };
export type SellerProfile = SellerIdentity & { about: string; programme: string; joinedAt: string; ratingCount: number; averageRating: number | null };
export type OwnProfile = SellerProfile & { version: number };
export type Listing = ListingInput & { id: string; createdAt: string; updatedAt: string; completedAt?: string; seller?: SellerIdentity | null };
export type ListingDetails = Listing & { status: 'active' | 'closed' };
export type SavedEntry = ListingDetails | { id: string; unavailable: true };
export type OwnedListing = Listing & { status: 'active' | 'closed' | 'removed'; version: number };
export type Thread = { id: string; listingId: string; title: string; createdAt: string; asSeller: boolean };
export type Message = { id: string; text: string; createdAt: string; mine: boolean };
export type ListingComment = { id: string; text: string; createdAt: string; author: SellerIdentity | null; sellerReply: boolean };
export type SellerReview = { id: string; listingTitle: string; text: string; createdAt: string; author: SellerIdentity | null; rating: number };
export type Exchange = {
  confirmedByYou: boolean; confirmedByOther: boolean; completed: boolean; reviewed: boolean;
  available: boolean; canReview: boolean; seller: string;
};
export type Page<T> = { entries: T[]; next: string | null };

const explicitApi = (runtime.marketplaceApiUrl ?? import.meta.env.VITE_MARKETPLACE_API_URL)?.trim();
const loginOrigin = (runtime.loginOrigin ?? import.meta.env.VITE_MARKETPLACE_LOGIN_ORIGIN)?.trim().replace(/\/+$/, '');
const clientId = (runtime.clientId ?? import.meta.env.VITE_MARKETPLACE_CLIENT_ID)?.trim();
export const demoMode = runtime.demoAuth ?? (import.meta.env.DEV && !explicitApi && !loginOrigin && !clientId);
const api = (explicitApi || (demoMode ? import.meta.env.VITE_API_URL || 'http://127.0.0.1:8787' : '')).replace(/\/+$/, '');
export const marketplaceEnabled = Boolean(api && (demoMode || (loginOrigin && clientId)));
const returnTo = `${location.origin}/`;
const sessionKey = 'astrashop.marketplace.session';
const pendingKey = 'astrashop.marketplace.pkce';
const scope = 'openid astrashop/marketplace';
type Session = { access: string; expires: number; refresh?: string };
// Local demo accounts: three students, a marketplace moderator, and the demo shop's owner and staff.
const demoAccounts = ['asha', 'ravi', 'neha', 'moderator', 'owner', 'staff'] as const;
export type DemoIdentity = '' | typeof demoAccounts[number];
// Where a sign-in may return to: the item list, the counter, or a marketplace page.
const destinations = /^(#marketplace(\/(listing|seller)\/[a-f0-9-]+)?|#shop|)$/;
let cached: Session | undefined;
let refreshInFlight: Promise<Session> | undefined;
const retryWindows = new Map<string, number>();

function stored(key: string): unknown {
  try { return JSON.parse(sessionStorage.getItem(key) ?? 'null'); } catch { return null; }
}

function saveSession(session?: Session) {
  cached = session;
  try {
    if (session) sessionStorage.setItem(sessionKey, JSON.stringify(session));
    else sessionStorage.removeItem(sessionKey);
  } catch {
    // The current page can keep using its in-memory session.
  }
  window.dispatchEvent(new Event('marketplace-session-change'));
}

function expireSession() {
  window.dispatchEvent(new Event('marketplace-auth-expired'));
  saveSession();
}

export function signedIn() {
  if (cached) return true;
  const saved = stored(sessionKey) as Session | null;
  if (saved && typeof saved.access === 'string' && Number.isFinite(saved.expires) &&
    (saved.expires > Date.now() || typeof saved.refresh === 'string') &&
    (!demoMode || demoAccounts.some((name) => saved.access === `demo-${name}`))) {
    cached = saved;
    return true;
  }
  return false;
}

export function demoIdentity(): DemoIdentity {
  return demoMode && signedIn() ? cached!.access.slice(5) as DemoIdentity : '';
}

export function marketplaceAccount(): string {
  if (!signedIn()) return 'guest';
  if (demoMode) return cached!.access;
  try {
    const payload = cached!.access.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const { sub } = JSON.parse(atob(payload));
    if (typeof sub === 'string' && /^[a-f0-9-]{36}$/.test(sub)) return sub;
  } catch {
    // An unrecognised token cannot share another account's drafts.
  }
  return 'unrecognised';
}

export function readListingDraft<T>(key: string, validate: (value: unknown) => value is T): T | undefined {
  const value = stored(key);
  return validate(value) ? value : undefined;
}

export function storeListingDraft(key: string, value?: unknown) {
  try {
    if (value === undefined) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // The form still works in this tab when browser storage is unavailable.
  }
}

export function setDemoIdentity(identity: DemoIdentity) {
  if (!demoMode) return;
  if (identity) saveSession({ access: `demo-${identity}`, expires: Number.MAX_SAFE_INTEGER });
  else saveSession();
}

function base64url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function startSignIn() {
  if (!loginOrigin || !clientId) throw new Error('Campus sign-in is unavailable.');
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(48)));
  const state = base64url(crypto.getRandomValues(new Uint8Array(24)));
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const destination = destinations.test(location.hash) ? location.hash : '#marketplace';
  sessionStorage.setItem(pendingKey, JSON.stringify({ verifier, state, destination, expires: Date.now() + 15 * 60_000 }));
  const params = new URLSearchParams({
    client_id: clientId, response_type: 'code', redirect_uri: returnTo, scope, state,
    code_challenge_method: 'S256', code_challenge: challenge,
  });
  location.assign(`${loginOrigin}/oauth2/authorize?${params}`);
}

export function isLoginCallback() {
  const query = new URLSearchParams(location.search);
  return marketplaceEnabled && !demoMode && query.has('state') && (query.has('code') || query.has('error'));
}

async function exchange(params: Record<string, string>, fallbackRefresh?: string): Promise<Session> {
  const response = await fetch(`${loginOrigin}/oauth2/token`, {
    method: 'POST', credentials: 'omit', signal: AbortSignal.timeout(10_000),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...params, client_id: clientId! }),
  });
  if (response.status === 400 || response.status === 401) throw new MarketError(401, 'Sign in again to continue.');
  if (!response.ok) throw new Error('Campus sign-in is temporarily unavailable.');
  const data = await response.json();
  if (typeof data.access_token !== 'string' || !Number.isFinite(data.expires_in)) throw new Error('Invalid sign-in response.');
  return {
    access: data.access_token, expires: Date.now() + data.expires_in * 1000,
    refresh: typeof data.refresh_token === 'string' ? data.refresh_token : fallbackRefresh,
  };
}

export async function finishSignIn() {
  const params = new URLSearchParams(location.search);
  const pending = stored(pendingKey) as { state?: string; verifier?: string; destination?: string; expires?: number } | null;
  const back = pending?.destination;
  history.replaceState(null, '', `/${typeof back === 'string' && destinations.test(back) ? back : '#marketplace'}`);
  sessionStorage.removeItem(pendingKey);
  const code = params.get('code');
  if (!code || !pending?.verifier || pending.state !== params.get('state') || (pending.expires ?? 0) < Date.now()) {
    throw new Error('Sign-in expired or was cancelled. Try again.');
  }
  saveSession(await exchange({ grant_type: 'authorization_code', code, redirect_uri: returnTo, code_verifier: pending.verifier }));
}

export async function signOut() {
  const refresh = cached?.refresh;
  saveSession();
  if (demoMode || !loginOrigin || !clientId) return;
  if (refresh) {
    try {
      await fetch(`${loginOrigin}/oauth2/revoke`, {
        method: 'POST', credentials: 'omit', signal: AbortSignal.timeout(2000),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: refresh, client_id: clientId }),
      });
    } catch {
      // Clear the browser session even if the token endpoint is unavailable.
    }
  }
  const params = new URLSearchParams({ client_id: clientId, logout_uri: returnTo });
  location.assign(`${loginOrigin}/logout?${params}`);
}

export async function accessToken() {
  if (!signedIn() || !cached) throw new MarketError(401, 'Sign in to continue.');
  const current = cached;
  if (current.expires > Date.now() + 30_000) return current.access;
  if (!current.refresh) {
    expireSession();
    throw new MarketError(401, 'Your session ended. Sign in again.');
  }
  refreshInFlight ??= exchange({ grant_type: 'refresh_token', refresh_token: current.refresh }, current.refresh)
    .then((updated) => {
      if (cached !== current) throw new MarketError(401, 'Your session changed. Sign in again.');
      saveSession(updated);
      return updated;
    })
    .catch((error) => {
      if (cached === current && error instanceof MarketError && error.status === 401) expireSession();
      throw error;
    })
    .finally(() => { refreshInFlight = undefined; });
  return (await refreshInFlight).access;
}

export class MarketError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export async function marketRequest<T>(path: string, options: {
  method?: 'POST' | 'PUT'; body?: unknown; private?: boolean; signal?: AbortSignal;
} = {}): Promise<T> {
  const headers = new Headers();
  const identity = marketplaceAccount();
  const token = options.private ? await accessToken() : undefined;
  if (options.private && marketplaceAccount() !== identity) throw new MarketError(401, 'Your account changed. Try again.');
  const bucket = `${identity}:${options.private ? options.method ? 'write' : 'read' : 'public'}`;
  const retryAt = retryWindows.get(bucket) ?? 0;
  if (retryAt > Date.now()) throw new MarketError(429, `Please wait ${Math.ceil((retryAt - Date.now()) / 1000)}s before trying again.`);
  options.signal?.throwIfAborted();
  if (token) headers.set('authorization', `Bearer ${token}`);
  if (options.body !== undefined) headers.set('content-type', 'application/json');
  const deadline = AbortSignal.timeout(10_000);
  let out;
  try {
    out = await fetch(`${api}/marketplace${path}`, {
      headers, method: options.method, body: options.body === undefined ? undefined : JSON.stringify(options.body),
      credentials: 'omit', signal: options.signal ? AbortSignal.any([deadline, options.signal]) : deadline,
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new Error('Could not reach the marketplace. Try again.');
  }
  if (options.private && marketplaceAccount() !== identity) throw new MarketError(401, 'Your account changed. Try again.');
  const data = await out.json().catch(() => null);
  if (options.private && marketplaceAccount() !== identity) throw new MarketError(401, 'Your account changed. Try again.');
  if (out.ok && data !== null) return data as T;
  if (out.status === 429 || out.status === 503) {
    const hint = out.headers.get('retry-after');
    const seconds = hint === null ? 1 : /^\d+$/.test(hint) ? Number(hint) : (Date.parse(hint) - Date.now()) / 1000;
    const wait = Number.isFinite(seconds) ? Math.min(300, Math.max(1, Math.ceil(seconds))) : 1;
    retryWindows.set(bucket, Date.now() + wait * 1000);
  }
  if (out.status === 401 && token && cached?.access === token) {
    expireSession();
  }
  throw new MarketError(out.status, typeof data?.error === 'string' ? data.error
    : out.status === 429 ? 'Too many requests. Wait a moment and try again.' : 'Could not complete the request.');
}
