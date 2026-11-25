import { useEffect, useRef, useState } from 'react';
import { ApiError, getReservation, reserveItem, type Item, type Reservation } from './api';
import { age, price } from './format';
import type { Catalog } from './main';

type Attempt = {
  id: string;
  itemId: string;
  itemName: string;
  pickupWindow: string;
  sample?: boolean;
  reservation?: Reservation;
};

const storageKey = 'astrashop.reservations';
const statusLabel = { HELD: 'Held', COLLECTED: 'Collected', RELEASED: 'Released' };

function restoreAttempts(): Attempt[] {
  try {
    const records = JSON.parse(localStorage.getItem(storageKey) ?? '[]');
    return Array.isArray(records) ? records.filter((record) => (
      typeof record?.id === 'string' && typeof record.itemId === 'string' && typeof record.itemName === 'string' &&
      typeof record.pickupWindow === 'string' && (!record.reservation || (
        typeof record.reservation.code === 'string' && Object.hasOwn(statusLabel, record.reservation.status)
      ))
    )) : [];
  } catch {
    return [];
  }
}

export function Student({ catalog, active }: { catalog: Catalog; active: boolean }) {
  const [query, setQuery] = useState('');
  const [attempts, setAttempts] = useState(restoreAttempts);
  const saved = useRef(attempts);
  const submitting = useRef(false);
  const checking = useRef(false);
  const [reserving, setReserving] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState('');
  const [reserveError, setReserveError] = useState('');
  const [refreshError, setRefreshError] = useState('');

  function save(next: Attempt[]) {
    saved.current = next;
    setAttempts(next);
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      // The current tab can still show and retry reservations when storage is unavailable.
    }
  }

  function update(attempt: Attempt) {
    const current = saved.current.find(({ id }) => attempt.id === id);
    if (!current) {
      save([attempt, ...saved.current]);
      return;
    }
    if (current.reservation && current.reservation.status !== 'HELD' && attempt.reservation?.status === 'HELD') return;
    save(saved.current.map((entry) => entry.id === attempt.id ? attempt : entry));
  }

  async function refreshReservations() {
    if (checking.current || saved.current.length === 0) return;
    checking.current = true;
    setRefreshing(true);
    setRefreshError('');
    const snapshot = saved.current;
    const results = await Promise.allSettled(snapshot.map(({ id }) => getReservation(id)));
    results.forEach((result, index) => {
      const entry = saved.current.find(({ id }) => id === snapshot[index].id);
      if (!entry) return;
      if (result.status === 'fulfilled') {
        update({ ...entry, reservation: result.value });
      } else if (entry.reservation || !(result.reason instanceof ApiError && result.reason.status === 404)) {
        setRefreshError('Some statuses could not be refreshed. Showing the last known status.');
      }
    });
    checking.current = false;
    setRefreshing(false);
  }

  useEffect(() => {
    if (active) void refreshReservations();
  }, [active]);

  async function reserve(item: Pick<Item, 'id' | 'name' | 'pickupWindow' | 'sample'>) {
    if (submitting.current) return;
    setReserveError('');
    setNotice('');
    let attempt = saved.current.find((entry) => entry.itemId === item.id && !entry.reservation);
    if (!attempt) {
      if (!window.crypto?.randomUUID) {
        setReserveError('Open Astrashop over HTTPS to reserve an item.');
        return;
      }
      attempt = {
        id: window.crypto.randomUUID(), itemId: item.id, itemName: item.name,
        pickupWindow: item.pickupWindow, sample: item.sample,
      };
    }
    submitting.current = true;
    setReserving(item.id);
    update(attempt);

    try {
      const reservation = await reserveItem(attempt.id, attempt.itemId);
      update({ ...attempt, reservation });
      setNotice(reservation.status === 'HELD'
        ? `${item.name} is held. Pickup code ${reservation.code}.`
        : `${item.name} reservation is ${statusLabel[reservation.status].toLowerCase()}.`);
      void catalog.refresh();
    } catch (error) {
      if (error instanceof ApiError && error.status < 500) {
        const id = attempt.id;
        save(saved.current.filter((entry) => entry.id !== id || entry.reservation));
        setReserveError(error.status === 409 ? 'Just sold out' : error.message);
        if (error.status === 409) void catalog.refresh();
      } else {
        setReserveError('Reservation confirmation is pending. Retry it from My reservations.');
      }
    } finally {
      submitting.current = false;
      setReserving(undefined);
    }
  }

  const search = query.trim().toLowerCase();
  const visibleItems = catalog.items.filter((item) => `${item.name} ${item.course ?? ''}`.toLowerCase().includes(search));

  return (
    <>
      <div className="screen-heading">
        <h1>Find course supplies</h1>
        <p>Check campus shop stock and reserve an item for pickup.</p>
      </div>
      {notice && <p className="notice success" role="status">{notice}</p>}
      {reserveError && <p className="notice error" role="alert">{reserveError}</p>}
      <div className="student-layout">
        <section aria-label="Course supplies" className="catalog">
          <div className="catalog-toolbar">
            <div className="search-field">
              <label htmlFor="item-search">Search items or courses</label>
              <input id="item-search" type="search" placeholder="e.g. Lab record book" value={query} onChange={(event) => setQuery(event.target.value)} />
            </div>
            <button type="button" className="secondary" disabled={catalog.loading} onClick={() => void catalog.refresh()}>Refresh stock</button>
          </div>
          {catalog.error && <p className="notice error" role="alert">{catalog.error}</p>}
          {catalog.loading && catalog.items.length === 0 && <p role="status">Loading supplies…</p>}
          {!catalog.loading && !catalog.error && visibleItems.length === 0 && (
            <p className="empty">{search ? 'No supplies match your search.' : 'The shop has no listed supplies yet.'}</p>
          )}
          <div className="item-grid">
            {visibleItems.map((item) => {
              const pending = attempts.some((entry) => entry.itemId === item.id && !entry.reservation);
              const held = attempts.find((entry) => entry.itemId === item.id && entry.reservation?.status === 'HELD')?.reservation;
              return (
                <article className="card item-card" key={item.id}>
                  <div className="card-head">
                    <div>
                      {item.course && <p className="course">{item.course}</p>}
                      <h2>{item.name}</h2>
                    </div>
                    <span className="price">{price(item.price)}</span>
                  </div>
                  <div className="badges">
                    <span className={`badge ${item.stock > 0 ? 'available' : 'unavailable'}`}>
                      {item.stock > 0 ? `${item.stock} in stock` : 'Out of stock'}
                    </span>
                    {item.sample && <span className="badge sample">Sample data</span>}
                  </div>
                  <dl className="item-details">
                    <div><dt>Stock confirmed</dt><dd><time dateTime={item.confirmedAt}>{age(item.confirmedAt)}</time></dd></div>
                    <div><dt>Pickup window</dt><dd>{item.pickupWindow}</dd></div>
                  </dl>
                  {held && <div className="pickup-code"><span>Pickup code</span><strong>{held.code}</strong></div>}
                  <button type="button" disabled={!!reserving || (item.stock < 1 && !pending)} onClick={() => void reserve(item)}>
                    {reserving === item.id ? 'Reserving…' : pending ? 'Retry reservation' : held ? 'Reserve another' : 'Reserve'}
                  </button>
                </article>
              );
            })}
          </div>
        </section>

        <section className="card reservations" aria-labelledby="reservations-heading">
          <div className="section-head">
            <h2 id="reservations-heading">My reservations</h2>
            <button type="button" className="secondary" disabled={refreshing || attempts.length === 0} onClick={() => void refreshReservations()}>
              {refreshing ? 'Checking…' : 'Refresh status'}
            </button>
          </div>
          {refreshError && <p className="notice error" role="alert">{refreshError}</p>}
          {attempts.length === 0 && <p className="muted">Pickup codes for items you reserve appear here.</p>}
          {attempts.map((entry) => {
            const { reservation } = entry;
            return (
              <article className="reservation" key={entry.id}>
                <h3>{entry.itemName}</h3>
                <div className="badges">
                  <span className={`badge ${reservation?.status === 'HELD' ? 'available' : 'unavailable'}`}>
                    {reservation ? statusLabel[reservation.status] : 'Confirmation pending'}
                  </span>
                  {entry.sample && <span className="badge sample">Sample data</span>}
                </div>
                {reservation ? (
                  <>
                    <div className="pickup-code"><span>Pickup code</span><strong>{reservation.code}</strong></div>
                    {reservation.status === 'HELD' && <p className="muted">{entry.pickupWindow}</p>}
                  </>
                ) : (
                  <button type="button" className="secondary" disabled={!!reserving} onClick={() => void reserve({
                    id: entry.itemId, name: entry.itemName, pickupWindow: entry.pickupWindow, sample: entry.sample,
                  })}>{reserving === entry.itemId ? 'Reserving…' : 'Retry reservation'}</button>
                )}
              </article>
            );
          })}
        </section>
      </div>
    </>
  );
}
