import { useEffect, useRef, useState } from 'react';
import { ApiError, getReservation, reserveItem, type Item, type Reservation } from './api';
import { age, amount, availability, groupCode, until } from './format';
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
const statusLabel = { HELD: 'Ready at the counter', COLLECTED: 'Collected', RELEASED: 'Released by the shop', EXPIRED: 'Expired' };

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
  const [course, setCourse] = useState<string>();
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
    setNotice(''); // a "held" banner from earlier may no longer be true
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
        ? `${item.name} is held. Pickup code ${groupCode(reservation.code)}.`
        : `${item.name} reservation is ${statusLabel[reservation.status].toLowerCase()}.`);
      void catalog.refresh();
    } catch (error) {
      // Only a definite rejection drops the attempt; a throttled one keeps its id for "Retry reservation".
      if (error instanceof ApiError && error.status < 500 && error.status !== 429) {
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
  const courses = [...new Set(catalog.items.map((item) => item.course).filter((c): c is string => !!c))].sort();
  const visibleItems = catalog.items.filter((item) => (!course || item.course === course)
    && `${item.name} ${item.course ?? ''}`.toLowerCase().includes(search));
  const windows = new Set(catalog.items.map((item) => item.pickupWindow));
  const sharedWindow = windows.size === 1 ? [...windows][0] : undefined;
  const sampleStock = catalog.items.some((item) => item.sample);

  return (
    <>
      <div className="find">
        <h1><label htmlFor="item-search">What do you need for class?</label></h1>
        <input id="item-search" type="search" placeholder="Lab record book, drafter, graph paper" autoComplete="off"
          value={query} onChange={(event) => setQuery(event.target.value)} />
        <div className="courses" role="group" aria-label="Filter by course">
          <button type="button" aria-pressed={!course} onClick={() => setCourse(undefined)}>all</button>
          {courses.map((name) => (
            <button type="button" key={name} aria-pressed={course === name} onClick={() => setCourse(name)}>
              {name.toLowerCase()}
            </button>
          ))}
          <span className="count" aria-live="polite">{visibleItems.length} {visibleItems.length === 1 ? 'item' : 'items'}</span>
        </div>
      </div>

      {/* The new pass is the visible confirmation; announce it without shifting the page. */}
      <p className="visually-hidden" role="status">{notice}</p>
      {reserveError && <p className="notice error" role="alert">{reserveError}</p>}

      <div className="student-layout">
        <section className="sheet" aria-label="Campus shop items">
          <div className="sheet-head">
            <p className="sheet-title">Campus stationery shop{sharedWindow && <span className="hours">, open {sharedWindow}</span>}</p>
            {sampleStock && <span className="sample-flag">Sample stock</span>}
            <button type="button" className="text-button" disabled={catalog.loading} onClick={() => void catalog.refresh()}>
              {catalog.loading ? 'Refreshing…' : 'Refresh stock'}
            </button>
          </div>
          {catalog.error && <p className="notice error" role="alert">{catalog.error}</p>}
          {catalog.loading && catalog.items.length === 0 && (
            <ul className="entries" aria-busy="true" aria-label="Loading items">
              {[0, 1, 2, 3].map((n) => <li className="entry skeleton" key={n}><span /><span /><span /></li>)}
            </ul>
          )}
          {!catalog.loading && !catalog.error && visibleItems.length === 0 && (
            <div className="empty">
              <p>{search || course ? 'Nothing here matches.' : 'The shop hasn’t listed anything yet.'}</p>
              {(search || course) && (
                <button type="button" className="text-button" onClick={() => { setQuery(''); setCourse(undefined); }}>Show everything</button>
              )}
            </div>
          )}
          <ul className="entries">
            {visibleItems.map((item) => {
              const pending = attempts.some((entry) => entry.itemId === item.id && !entry.reservation);
              const held = attempts.find((entry) => entry.itemId === item.id && entry.reservation?.status === 'HELD')?.reservation;
              const stock = availability(item.stock);
              return (
                <li className="entry" key={item.id}>
                  {item.course && <p className="entry-course">{item.course}</p>}
                  <h2 className="entry-name">{item.name}</h2>
                  <p className="entry-price"><span className="rupee">₹</span>{amount(item.price)}</p>
                  {(item.stock > 0 || pending) && (
                    <button type="button" className="reserve" disabled={!!reserving} onClick={() => void reserve(item)}>
                      {reserving === item.id ? 'Reserving…' : pending ? 'Retry' : held ? 'Reserve another' : 'Reserve'}
                    </button>
                  )}
                  <p className={`availability ${stock.level}`}><span className="dot" aria-hidden="true" />{stock.text}</p>
                  <p className="entry-meta">
                    {held ? <>Held for you, code {groupCode(held.code)}</> : <>Counted <time dateTime={item.confirmedAt}>{age(item.confirmedAt)}</time></>}
                    {!sharedWindow && <>, open {item.pickupWindow}</>}
                  </p>
                </li>
              );
            })}
          </ul>
        </section>

        <aside className="passes" aria-labelledby="passes-heading">
          <div className="passes-head">
            <h2 id="passes-heading">Pickup passes</h2>
            {attempts.length > 0 && (
              <button type="button" className="text-button" disabled={refreshing} onClick={() => void refreshReservations()}>
                {refreshing ? 'Checking…' : 'Refresh'}
              </button>
            )}
          </div>
          {refreshError && <p className="notice error" role="alert">{refreshError}</p>}
          {attempts.length === 0 && (
            <p className="passes-empty">Reserve something and its pickup code appears here. Show it at the counter to collect.</p>
          )}
          <div className="pass-stack">
            {attempts.map((entry) => {
              const { reservation } = entry;
              const state = (reservation?.status ?? 'PENDING').toLowerCase();
              return (
                <article className={`pass pass-${state}`} key={entry.id}>
                  <div className="pass-head">
                    <p className="pass-status">{reservation ? statusLabel[reservation.status] : 'Not confirmed yet'}</p>
                    {reservation ? (
                      <p className="pass-code"><span className="visually-hidden">Pickup code </span>{groupCode(reservation.code)}</p>
                    ) : (
                      <button type="button" className="reserve" disabled={!!reserving} onClick={() => void reserve({
                        id: entry.itemId, name: entry.itemName, pickupWindow: entry.pickupWindow, sample: entry.sample,
                      })}>{reserving === entry.itemId ? 'Reserving…' : 'Retry reservation'}</button>
                    )}
                  </div>
                  <div className="pass-body">
                    <h3>{entry.itemName}</h3>
                    {reservation?.status === 'HELD' && (
                      <dl className="pass-fields">
                        {reservation.expiresAt && (
                          <div><dt>Collect by</dt><dd><time dateTime={reservation.expiresAt}>{until(reservation.expiresAt)}</time></dd></div>
                        )}
                        <div><dt>Counter hours</dt><dd>{entry.pickupWindow}</dd></div>
                      </dl>
                    )}
                    {entry.sample && <p className="pass-sample">Sample stock, not a real hold</p>}
                  </div>
                </article>
              );
            })}
          </div>
        </aside>
      </div>
    </>
  );
}
