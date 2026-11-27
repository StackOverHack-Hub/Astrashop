import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Rupees } from './Rupees';
import { categories, marketRequest, type Listing, type Page, type SellerIdentity } from './marketplace-api';

export const listingHref = (id: string) => `#marketplace/listing/${id}`;
export const sellerHref = (id: string) => `#marketplace/seller/${id}`;

export function SellerLink({ seller, fallback }: { seller?: SellerIdentity | null; fallback: string }) {
  return seller ? <a href={sellerHref(seller.id)}>{seller.name}</a> : <>{fallback}</>;
}

export const shortDate = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short' });
export const messageOf = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong. Try again.';
export function useActiveView() {
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);
  return () => active.current;
}

export function Retry({ busy, retry, label = 'Try again' }: { busy: boolean; retry: () => Promise<void>; label?: string }) {
  return <button type="button" className="text-button" disabled={busy} onClick={() => void retry()}>{label}</button>;
}
export function usePage<T extends { id: string }>(path: string | null, isPrivate = false) {
  const [state, setState] = useState<{ path: string | null; data?: Page<T>; error?: string; busy: boolean }>({ path, busy: !!path });
  const request = useRef<AbortController | null>(null);
  const load = useCallback(async (previous?: Page<T>) => {
    if (!path) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setState((current) => ({ path, data: previous ?? (current.path === path ? current.data : undefined), busy: true }));
    const suffix = previous?.next ? `${path.includes('?') ? '&' : '?'}cursor=${encodeURIComponent(previous.next)}` : '';
    try {
      const next = await marketRequest<Page<T>>(`${path}${suffix}`, { private: isPrivate, signal: controller.signal });
      if (!next || !Array.isArray(next.entries) || !next.entries.every((entry) => entry && typeof entry.id === 'string')
        || (next.next !== null && typeof next.next !== 'string')) throw new Error('The response was incomplete. Try again.');
      if (!controller.signal.aborted) setState({
        path, busy: false, data: {
          next: next.next,
          entries: [...new Map([...(previous?.entries ?? []), ...next.entries].map((entry) => [entry.id, entry])).values()],
        },
      });
    } catch (error) {
      if (!controller.signal.aborted) setState((current) => ({ ...current, busy: false, error: messageOf(error) }));
    }
  }, [path, isPrivate]);
  useEffect(() => {
    void load();
    return () => request.current?.abort();
  }, [load]);
  const current: typeof state = path === state.path ? state : { path, busy: !!path };
  return { ...current, refresh: load, more: () => load(current.data) };
}

export function Notice({ error }: { error?: string }) {
  return error ? <p className="notice error" role="alert">{error}</p> : null;
}

export function ListingCard({ listing, children }: { listing: Listing; children?: ReactNode }) {
  return (
    <article className="market-card">
      <p className="market-kind">{categories[listing.kind]}</p>
      <h3><a href={listingHref(listing.id)}>{listing.title}</a></h3>
      <p className="price">{listing.pricePaise ? <Rupees value={listing.pricePaise / 100} /> : 'Free'}</p>
      <p className="market-card-description">{listing.description}</p>
      <p className="market-byline"><SellerLink seller={listing.seller} fallback="Campus seller" /></p>
      <p className="hint">{listing.meetup} · <time dateTime={listing.createdAt}>{shortDate.format(new Date(listing.createdAt))}</time></p>
      {children && <div className="market-actions">{children}</div>}
    </article>
  );
}

export function useResource<T>(path: string | null, isPrivate = false) {
  const [state, setState] = useState<{ path: string | null; data?: T; error?: string; busy: boolean }>({ path, busy: !!path });
  const current = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    if (!path) return;
    current.current?.abort();
    const controller = new AbortController();
    current.current = controller;
    setState((old) => ({ path, data: old.path === path ? old.data : undefined, busy: true }));
    try {
      const data = await marketRequest<T>(path, { private: isPrivate, signal: controller.signal });
      if (!controller.signal.aborted) setState({ path, data, busy: false });
    } catch (error) {
      if (!controller.signal.aborted) setState((old) => ({ ...old, busy: false, error: messageOf(error) }));
    }
  }, [path, isPrivate]);
  useEffect(() => {
    void refresh();
    return () => current.current?.abort();
  }, [refresh]);
  const result: typeof state = state.path === path ? state : { path, busy: !!path };
  return { ...result, refresh };
}

export function More({ busy, available, load }: { busy: boolean; available: boolean; load: () => Promise<void> }) {
  return available ? <button type="button" className="text-button" disabled={busy} onClick={() => void load()}>Load more</button> : null;
}
