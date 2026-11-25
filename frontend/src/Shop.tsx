import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, closeReservation, confirmStock, getShopReservations, type Item, type Reservation } from './api';
import { age } from './format';
import type { Catalog } from './main';

const storageKey = 'astrashop.shop-key';

function readShopKey() {
  try {
    return sessionStorage.getItem(storageKey) ?? '';
  } catch {
    return '';
  }
}

function storeShopKey(key: string) {
  try {
    if (key) sessionStorage.setItem(storageKey, key);
    else sessionStorage.removeItem(storageKey);
  } catch {
    // The current tab can still use the key for this visit.
  }
}

export function Shop({ catalog }: { catalog: Catalog }) {
  const [key, setKey] = useState(readShopKey);
  const [entry, setEntry] = useState('');
  const [unlocked, setUnlocked] = useState(false);
  const [held, setHeld] = useState<Reservation[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(Boolean(key));
  const [saving, setSaving] = useState<string>();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const inFlight = useRef(false);
  const closedIds = useRef(new Set<string>());

  function signOut() {
    storeShopKey('');
    setKey('');
    setEntry('');
    setUnlocked(false);
    setHeld([]);
    setDrafts({});
    setNotice('');
    setError('');
  }

  function report(error: unknown) {
    if (error instanceof ApiError && error.status === 401) {
      signOut();
      setError('Shop key not accepted. Enter the key again.');
    } else {
      setError((error as Error).message);
    }
  }

  async function fetchHolds(candidate: string) {
    const holds = await getShopReservations(candidate);
    setHeld(holds.filter(({ id }) => !closedIds.current.has(id)));
  }

  async function loadHolds(candidate: string) {
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    setError('');
    try {
      await fetchHolds(candidate);
      storeShopKey(candidate);
      setKey(candidate);
      setEntry('');
      setUnlocked(true);
    } catch (error) {
      report(error);
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }

  useEffect(() => {
    if (key) void loadHolds(key);
  }, []);

  async function write(id: string, action: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setSaving(id);
    setError('');
    setNotice('');
    try {
      await action();
    } catch (error) {
      report(error);
    } finally {
      inFlight.current = false;
      setSaving(undefined);
    }
  }

  async function finishHold(reservation: Reservation, action: 'collect' | 'release') {
    await write(reservation.id, async () => {
      try {
        await closeReservation(reservation.id, action, key);
        closedIds.current.add(reservation.id);
        setHeld((current) => current.filter(({ id }) => id !== reservation.id));
        setNotice(action === 'collect' ? 'Reservation marked collected.' : 'Hold released. One unit returned to stock.');
      } catch (error) {
        if (!(error instanceof ApiError && error.status === 409)) throw error;
        await fetchHolds(key);
        throw error;
      }
      await Promise.all([fetchHolds(key), catalog.refresh()]);
    });
  }

  async function saveStock(event: FormEvent<HTMLFormElement>, item: Item) {
    event.preventDefault();
    const value = drafts[item.id] ?? String(item.stock);
    const stock = Number(value);
    if (!value.trim() || !Number.isSafeInteger(stock) || stock < 0) {
      setNotice('');
      setError('Enter a whole number of units, zero or more.');
      return;
    }
    await write(item.id, async () => {
      await confirmStock(item.id, stock, key);
      await catalog.refresh();
      setDrafts(({ [item.id]: _confirmed, ...remaining }) => remaining);
      setNotice(`Stock confirmed for ${item.name}.`);
    });
  }

  return (
    <>
      <div className="screen-heading">
        <h1>Shop counter</h1>
        <p>Confirm shelf stock and manage pickups.</p>
      </div>
      {error && <p className="notice error" role="alert">{error}</p>}
      {notice && <p className="notice success" role="status">{notice}</p>}
      {!unlocked ? (
        <form className="card key-form" onSubmit={(event) => {
          event.preventDefault();
          void loadHolds(entry);
        }}>
          <label htmlFor="shop-key">Shop key</label>
          <input id="shop-key" type="password" value={entry} required autoComplete="off"
            onChange={(event) => setEntry(event.target.value)} />
          <button disabled={loading || !entry.trim()}>{loading ? 'Checking key…' : 'Open shop counter'}</button>
        </form>
      ) : (
        <>
          <div className="shop-controls">
            <button type="button" className="secondary" disabled={loading || !!saving} onClick={() => void loadHolds(key)}>
              {loading ? 'Checking…' : 'Refresh holds'}
            </button>
            <button type="button" className="secondary" disabled={loading || !!saving} onClick={signOut}>Lock counter</button>
          </div>
          <div className="shop-layout">
            <section className="card reservations" aria-labelledby="holds-heading">
              <div className="section-head"><h2 id="holds-heading">Held reservations</h2></div>
              {held.length === 0 && <p className="muted">No items are currently on hold.</p>}
              {held.map((reservation) => (
                <article className="reservation" key={reservation.id}>
                  <h3>{catalog.items.find(({ id }) => id === reservation.itemId)?.name ?? reservation.itemId}</h3>
                  <p className="muted">Held <time dateTime={reservation.createdAt}>{age(reservation.createdAt)}</time></p>
                  <div className="pickup-code"><span>Pickup code</span><strong>{reservation.code}</strong></div>
                  <div className="actions">
                    <button type="button" disabled={loading || !!saving} onClick={() => void finishHold(reservation, 'collect')}>Collected</button>
                    <button type="button" className="secondary" disabled={loading || !!saving} onClick={() => void finishHold(reservation, 'release')}>Release</button>
                  </div>
                </article>
              ))}
            </section>

            <section className="card reservations" aria-labelledby="stock-heading">
              <div className="section-head"><h2 id="stock-heading">Shelf stock</h2></div>
              {catalog.error && <p className="notice error" role="alert">{catalog.error}</p>}
              {!catalog.loading && catalog.items.length === 0 && !catalog.error && <p className="muted">No items to update.</p>}
              {catalog.loading && catalog.items.length === 0 && <p role="status">Loading stock…</p>}
              {catalog.items.map((item) => (
                <form className="stock-row" key={item.id} onSubmit={(event) => void saveStock(event, item)}>
                  <h3>{item.name}</h3>
                  <p className="muted">Stock confirmed <time dateTime={item.confirmedAt}>{age(item.confirmedAt)}</time></p>
                  <label htmlFor={`stock-${item.id}`}>Units on shelf, not counting set-aside items</label>
                  <div className="actions">
                    <input id={`stock-${item.id}`} type="number" inputMode="numeric" min="0" step="1" required disabled={!!saving}
                      value={drafts[item.id] ?? item.stock} onChange={(event) => {
                        const value = event.target.value;
                        setDrafts((current) => ({ ...current, [item.id]: value }));
                      }} />
                    <button disabled={loading || !!saving}>{saving === item.id ? 'Confirming…' : 'Confirm stock'}</button>
                  </div>
                </form>
              ))}
            </section>
          </div>
        </>
      )}
    </>
  );
}
