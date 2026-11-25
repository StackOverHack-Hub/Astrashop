import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, closeReservation, confirmStock, getShopReservations, type Item, type Reservation } from './api';
import { age, groupCode, until } from './format';
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
  // Stock shown when the shopkeeper started typing a recount, sent back as expectedStock.
  const draftBase = useRef<Record<string, number>>({});

  function signOut() {
    storeShopKey('');
    setKey('');
    setEntry('');
    setUnlocked(false);
    setHeld([]);
    setDrafts({});
    draftBase.current = {};
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

  async function finishHold(reservation: Reservation, action: 'collect' | 'release' | 'returned') {
    await write(reservation.id, async () => {
      try {
        await closeReservation(reservation.id, action, key);
        closedIds.current.add(reservation.id);
        setHeld((current) => current.filter(({ id }) => id !== reservation.id));
        setNotice({
          collect: 'Reservation marked collected.',
          release: 'Hold released. One unit returned to stock.',
          returned: 'Marked back on the shelf.',
        }[action]);
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
    const clearDraft = () => {
      delete draftBase.current[item.id];
      setDrafts(({ [item.id]: _confirmed, ...remaining }) => remaining);
    };
    await write(item.id, async () => {
      try {
        await confirmStock(item.id, stock, draftBase.current[item.id] ?? item.stock, key);
      } catch (error) {
        // A reservation or release landed since the count started: show the new number and recount.
        if (error instanceof ApiError && error.status === 409) {
          clearDraft();
          await Promise.all([catalog.refresh(), fetchHolds(key)]);
        }
        throw error;
      }
      await catalog.refresh();
      clearDraft();
      setNotice(`Stock confirmed for ${item.name}.`);
    });
  }

  const active = held.filter(({ status }) => status === 'HELD');
  const expired = held.filter(({ status }) => status === 'EXPIRED');
  const itemName = (r: Reservation) => catalog.items.find(({ id }) => id === r.itemId)?.name ?? r.itemId;

  return (
    <>
      <div className="counter-head">
        <h1>Shop counter</h1>
        {unlocked && (
          <div className="counter-actions">
            <button type="button" className="text-button" disabled={loading || !!saving} onClick={() => void loadHolds(key)}>
              {loading ? 'Checking…' : 'Refresh'}
            </button>
            <button type="button" className="text-button" disabled={loading || !!saving} onClick={signOut}>Lock counter</button>
          </div>
        )}
      </div>
      {error && <p className="notice error" role="alert">{error}</p>}
      {notice && <p className="notice success" role="status">{notice}</p>}
      {!unlocked ? (
        <form className="key-form" onSubmit={(event) => {
          event.preventDefault();
          void loadHolds(entry);
        }}>
          <label htmlFor="shop-key">Counter key</label>
          <p className="hint">The key the shop was given when Astrashop was set up.</p>
          <input id="shop-key" type="password" value={entry} required autoComplete="off"
            onChange={(event) => setEntry(event.target.value)} />
          <button className="reserve" disabled={loading || !entry.trim()}>{loading ? 'Checking key…' : 'Open the counter'}</button>
        </form>
      ) : (
        <div className="shop-layout">
          <section className="pickups" aria-labelledby="holds-heading">
            {expired.length > 0 && (
              <div className="putback" role="status">
                <h2 id="expired-heading">Put these back on the shelf</h2>
                <p>Nobody came for them in time, so they count as shelf stock again. Return each one before you recount.</p>
                <ul>
                  {expired.map((reservation) => (
                    <li key={reservation.id}>
                      <span className="putback-code">{groupCode(reservation.code)}</span>
                      <span className="putback-item">
                        {itemName(reservation)}
                        {reservation.endedAt && <small>Expired <time dateTime={reservation.endedAt}>{age(reservation.endedAt)}</time></small>}
                      </span>
                      <button type="button" className="text-button" disabled={loading || !!saving}
                        onClick={() => void finishHold(reservation, 'returned')}>Back on shelf</button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <h2 id="holds-heading" className="column-title">Waiting for pickup <span className="tally">{active.length}</span></h2>
            {active.length === 0 && <p className="passes-empty">No one is waiting. New reservations show up here with their code.</p>}
            <ul className="pickup-list">
              {active.map((reservation) => (
                <li className="pickup" key={reservation.id}>
                  <p className="pickup-code"><span className="visually-hidden">Pickup code </span>{groupCode(reservation.code)}</p>
                  <div className="pickup-info">
                    <h3>{itemName(reservation)}</h3>
                    <p>
                      Reserved <time dateTime={reservation.createdAt}>{age(reservation.createdAt)}</time>
                      {reservation.expiresAt && <>, holds until <time dateTime={reservation.expiresAt}>{until(reservation.expiresAt)}</time></>}
                    </p>
                  </div>
                  <div className="pickup-actions">
                    <button type="button" className="reserve" disabled={loading || !!saving} onClick={() => void finishHold(reservation, 'collect')}>Collected</button>
                    <button type="button" className="text-button" disabled={loading || !!saving} onClick={() => void finishHold(reservation, 'release')}>Release</button>
                  </div>
                </li>
              ))}
            </ul>
          </section>

          <section className="sheet ledger" aria-labelledby="stock-heading">
            <div className="sheet-head">
              <h2 id="stock-heading">Shelf count</h2>
              <p className="hint">Count what’s on the shelf. Leave out anything set aside for a pickup.</p>
            </div>
            {catalog.error && <p className="notice error" role="alert">{catalog.error}</p>}
            {!catalog.loading && catalog.items.length === 0 && !catalog.error && <p className="passes-empty">No items to count yet.</p>}
            {catalog.loading && catalog.items.length === 0 && <p role="status" className="hint">Loading stock…</p>}
            {catalog.items.map((item) => (
              <form className="ledger-row" key={item.id} onSubmit={(event) => void saveStock(event, item)}>
                <label className="ledger-item" htmlFor={`stock-${item.id}`}>{item.name}<span className="visually-hidden">, units on the shelf</span></label>
                <p className="ledger-meta">Counted <time dateTime={item.confirmedAt}>{age(item.confirmedAt)}</time></p>
                <input id={`stock-${item.id}`} type="number" inputMode="numeric" min="0" step="1" required disabled={!!saving}
                  value={drafts[item.id] ?? item.stock} onChange={(event) => {
                    const value = event.target.value;
                    draftBase.current[item.id] ??= item.stock;
                    setDrafts((current) => ({ ...current, [item.id]: value }));
                  }} />
                <button className="text-button" disabled={loading || !!saving}>{saving === item.id ? 'Saving…' : 'Confirm'}</button>
              </form>
            ))}
          </section>
        </div>
      )}
    </>
  );
}
