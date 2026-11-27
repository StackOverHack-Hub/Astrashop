import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ApiError, confirmStock, getShopReservations, getShopStats, holdAction,
  type HoldAction, type Item, type Reservation, type ShopStats,
} from './api';
import { age, duration, groupCode, until } from './format';
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
  const [stats, setStats] = useState<ShopStats>();
  const [statsError, setStatsError] = useState(false);
  const [codeQuery, setCodeQuery] = useState('');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(Boolean(key));
  const [saving, setSaving] = useState<string>();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const inFlight = useRef(false);
  const latestStats = useRef(0);
  const codeInput = useRef<HTMLInputElement>(null);
  const closedIds = useRef(new Set<string>());
  // Stock shown when the shopkeeper started typing a recount, sent back as expectedStock.
  const draftBase = useRef<Record<string, number>>({});

  function signOut() {
    latestStats.current += 1;
    storeShopKey('');
    setKey('');
    setEntry('');
    setUnlocked(false);
    setHeld([]);
    setStats(undefined);
    setStatsError(false);
    setCodeQuery('');
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

  async function fetchStats(candidate: string) {
    const request = ++latestStats.current;
    try {
      const numbers = await getShopStats(candidate);
      if (request !== latestStats.current) return;
      setStats(numbers);
      setStatsError(false);
    } catch {
      if (request === latestStats.current) setStatsError(true);
    }
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
      void fetchStats(candidate);
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

  async function finishHold(reservation: Reservation, action: HoldAction) {
    await write(reservation.id, async () => {
      try {
        await holdAction(reservation.id, action, key);
        if (action !== 'set-aside') { // set aside stays on the list until collected
          closedIds.current.add(reservation.id);
          setHeld((current) => current.filter(({ id }) => id !== reservation.id));
        }
        setNotice({
          'set-aside': `Set aside for code ${groupCode(reservation.code)}. The student's pass now says so.`,
          collect: 'Reservation marked collected.',
          release: 'Hold released. Put the unit back on the shelf if it was set aside.',
          returned: 'Marked back on the shelf.',
        }[action]);
      } catch (error) {
        if (!(error instanceof ApiError && error.status === 409)) throw error;
        void fetchStats(key);
        await Promise.all([fetchHolds(key), catalog.refresh()]);
        throw error;
      }
      void fetchStats(key);
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

  // Holds still waiting to be set aside come first: they need the shopkeeper's hands.
  const active = held.filter(({ status }) => status === 'HELD')
    .sort((a, b) => Number(!!a.setAsideAt) - Number(!!b.setAsideAt));
  const expired = held.filter(({ status }) => status === 'EXPIRED');
  const itemName = (r: Reservation) => catalog.items.find(({ id }) => id === r.itemId)?.name ?? r.itemId;
  const digits = codeQuery;
  const shown = digits ? active.filter((r) => r.code.startsWith(digits)) : active;
  const expiredMatches = digits.length === 6 ? expired.filter((r) => r.code === digits) : [];

  return (
    <>
      <div className="page-header page-header-split">
        <div>
          <h1 className="page-title">Shop counter</h1>
          <p className="hint">Set reserved units aside, hand them over against the code, and keep the shelf count honest.</p>
        </div>
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
        <form className="key-form panel" onSubmit={(event) => {
          event.preventDefault();
          void loadHolds(entry);
        }}>
          <label htmlFor="shop-key">Counter key</label>
          <p className="hint">The key the shop was given when Astrashop was set up.</p>
          <input id="shop-key" className="field-control" type="password" value={entry} required autoComplete="off"
            onChange={(event) => setEntry(event.target.value)} />
          <button className="reserve" disabled={loading || !entry.trim()}>{loading ? 'Checking key…' : 'Open the counter'}</button>
        </form>
      ) : (
        <>
          <div className="shop-layout">
            <section className="panel pickups" aria-labelledby="holds-heading">
              <div className="panel-head">
                <h2 id="holds-heading">Pickups <span className="tally">{active.length}</span></h2>
                <p className="hint">Set each one aside as it comes in. When the student arrives, check their code and hand it over.</p>
              </div>

              <div className="code-check">
                <label htmlFor="code-check">Check a pickup code</label>
                <div className="code-entry">
                  <input id="code-check" className="field-control" ref={codeInput} inputMode="numeric" autoComplete="off" placeholder="123 456"
                    value={groupCode(codeQuery)} onChange={(event) => setCodeQuery(event.target.value.replace(/\D/g, '').slice(0, 6))} />
                  {codeQuery && <button type="button" className="text-button" onClick={() => {
                    setCodeQuery('');
                    codeInput.current?.focus();
                  }}>Clear</button>}
                </div>
                {digits.length === 6 && shown.length === 1 && expiredMatches.length === 0 && (
                  <p className="code-result match" role="status">Matches {itemName(shown[0])}. {shown[0].setAsideAt ? 'Set aside.' : 'Still waiting to be set aside.'}</p>
                )}
                {digits.length === 6 && shown.length > 0 && shown.length + expiredMatches.length > 1 && (
                  <p className="code-result" role="status">This code matches more than one pass. Check the item and pickup deadline on the student’s pass.</p>
                )}
                {digits.length === 6 && shown.length === 0 && (
                  <p className="code-result miss" role="status">
                    {expiredMatches.length > 0
                      ? <>Code {groupCode(digits)} expired. Check the shelf reminder below.</>
                      : <>No active hold has code {groupCode(digits)}. Ask the student to refresh their pass.</>}
                  </p>
                )}
              </div>

              {expired.length > 0 && (
                <div className="putback">
                  <h3>Expired pickups</h3>
                  <p>Return any units that were set aside, then confirm they’re on the shelf before recounting.</p>
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

              {active.length === 0 && <p className="passes-empty">No one is waiting. New reservations show up here with their code.</p>}
              <ul className="pickup-list">
                {shown.map((reservation) => (
                  <li className={`pickup${reservation.setAsideAt ? ' is-set-aside' : ''}`} key={reservation.id}>
                    <p className="pickup-code"><span className="visually-hidden">Pickup code </span>{groupCode(reservation.code)}</p>
                    <div className="pickup-info">
                      <h3>{itemName(reservation)}</h3>
                      <p className={reservation.setAsideAt ? 'state-ready' : 'state-waiting'}>
                        <span className="dot" aria-hidden="true" />
                        {reservation.setAsideAt
                          ? <>Set aside <time dateTime={reservation.setAsideAt}>{age(reservation.setAsideAt)}</time></>
                          : <>Reserved <time dateTime={reservation.createdAt}>{age(reservation.createdAt)}</time>, not set aside yet</>}
                      </p>
                      {reservation.expiresAt && <p>Holds until <time dateTime={reservation.expiresAt}>{until(reservation.expiresAt)}</time></p>}
                    </div>
                    <div className="pickup-actions">
                      {!reservation.setAsideAt && (
                        <button type="button" className="reserve" disabled={loading || !!saving} onClick={() => void finishHold(reservation, 'set-aside')}>Set aside</button>
                      )}
                      <button type="button" className={reservation.setAsideAt ? 'reserve' : 'text-button'}
                        disabled={loading || !!saving} onClick={() => void finishHold(reservation, 'collect')}>Collected</button>
                      <button type="button" className="text-button" disabled={loading || !!saving} onClick={() => void finishHold(reservation, 'release')}>Release</button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>

            <section className="sheet sheet-ruled ledger" aria-labelledby="stock-heading">
              <div className="sheet-head">
                <h2 id="stock-heading">Shelf count</h2>
                <p className="hint">Count only units available to sell. Leave out every active reservation, even if its unit is still on the shelf.</p>
              </div>
              {catalog.error && <p className="notice error" role="alert">{catalog.error}</p>}
              {!catalog.loading && catalog.items.length === 0 && !catalog.error && <p className="passes-empty">No items to count yet.</p>}
              {catalog.loading && catalog.items.length === 0 && <p role="status" className="hint">Loading stock…</p>}
              {catalog.items.map((item) => (
                <form className="ledger-row" key={item.id} onSubmit={(event) => void saveStock(event, item)}>
                  <label className="ledger-item" htmlFor={`stock-${item.id}`}>{item.name}<span className="visually-hidden">, units on the shelf</span></label>
                  <p className="ledger-meta">Counted <time dateTime={item.confirmedAt}>{age(item.confirmedAt)}</time></p>
                  <input id={`stock-${item.id}`} className="field-control" type="number" inputMode="numeric" min="0" step="1" required disabled={!!saving}
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

          <section className="panel panel-tinted stats" aria-labelledby="stats-heading">
            <div className="panel-head">
              <h2 id="stats-heading">Pilot numbers</h2>
              <p className="hint">
                Reservation activity{stats?.since && <> since <time dateTime={stats.since}>{new Date(stats.since).toLocaleDateString('en-IN')}</time></>}.
                Both timers start when the student reserves.
              </p>
            </div>
            {statsError && <p className="notice error" role="alert">Could not refresh pilot numbers. Use Refresh to try again.</p>}
            {!stats && !statsError && <p role="status" className="hint">Loading pilot numbers…</p>}
            {stats && (
              <dl className="stat-grid">
                <div><dt>Reservations</dt><dd>{stats.reservations}</dd></div>
                <div><dt>Waiting to be set aside</dt><dd>{stats.waitingToSetAside}</dd></div>
                <div><dt>Set aside</dt><dd>{stats.setAside}<small> of {stats.reservations}</small></dd></div>
                <div><dt>Median time to set aside</dt><dd>{duration(stats.medianMinutesToSetAside)}</dd></div>
                <div><dt>Collected</dt><dd>{stats.collected}<small> of {stats.reservations}</small></dd></div>
                <div><dt>Median time to collect</dt><dd>{duration(stats.medianMinutesToCollect)}</dd></div>
                <div><dt>No-shows (expired)</dt><dd>{stats.expired}</dd></div>
                <div><dt>Released by the shop</dt><dd>{stats.released}</dd></div>
              </dl>
            )}
          </section>
        </>
      )}
    </>
  );
}
