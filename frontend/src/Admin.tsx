import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import {
  acceptInvite, createInvite, createItem, createShop, getAudit, getCatalog, getMe, getStaff, inviteLink, listShops,
  resizePhoto, setShopStatus, setStaffRole, updateItem, updateShop, uploadPhoto,
  type AuditEntry, type Invite, type Item, type Me, type Membership, type Role, type ShopStatus, type ShopSummary, type StaffMember,
} from './api';
import { age, until } from './format';
import { demoIdentity, demoMode, marketRequest, setDemoIdentity, signedIn, signOut, startSignIn, type DemoIdentity } from './marketplace-api';
import { listingHref, messageOf, More, Notice, usePage } from './marketplace-ui';
import { Rupees } from './Rupees';
import { Shop } from './Shop';

type Section = 'counter' | 'catalog' | 'staff' | 'activity' | 'moderation' | 'shops';
const sectionNames: Record<Section, string> = {
  counter: 'Counter', catalog: 'Catalog', staff: 'Staff', activity: 'Activity', moderation: 'Moderation', shops: 'Shops',
};
const shopKey = 'astrashop.admin-shop';
// The end of an account id is enough to tell people apart in a list.
const shortId = (id: string) => id.slice(-6);

// #admin/<section>, #admin/join/<token>, or the old #shop address of the counter.
function readRoute(): { join: string } | { section: Section } {
  const [, first = '', second = ''] = window.location.hash.split('/');
  if (first === 'join' && second) return { join: second };
  return { section: (first in sectionNames ? first : 'counter') as Section };
}

function useSession() {
  const [session, setSession] = useState(0);
  useEffect(() => {
    const bump = () => setSession((n) => n + 1);
    window.addEventListener('marketplace-session-change', bump);
    return () => window.removeEventListener('marketplace-session-change', bump);
  }, []);
  return [session, () => setSession((n) => n + 1)] as const;
}

// Loads something for the console and reloads it on demand, ignoring answers to superseded requests.
function useLoad<T>(load: (() => Promise<T>) | null, deps: unknown[]) {
  const [state, setState] = useState<{ data?: T; error: string; busy: boolean }>({ error: '', busy: false });
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!load) return setState({ error: '', busy: false });
    let current = true;
    setState((old) => ({ ...old, busy: true, error: '' }));
    load().then((data) => { if (current) setState({ data, error: '', busy: false }); })
      .catch((error) => { if (current) setState((old) => ({ ...old, error: messageOf(error), busy: false })); });
    return () => { current = false; };
  }, [...deps, version]);
  return {
    ...state, reload: useCallback(() => setVersion((n) => n + 1), []),
    update: useCallback((change: (data?: T) => T) => setState((old) => ({ ...old, data: change(old.data) })), []),
  };
}

function AccountControl() {
  const [busy, setBusy] = useState(false);
  if (demoMode) return (
    <label>Local demo account
      <select className="field-control" value={demoIdentity()} onChange={(event) => setDemoIdentity(event.target.value as DemoIdentity)}>
        <option value="">Signed out</option>
        <option value="owner">Shop owner</option><option value="staff">Shop staff</option>
        <option value="moderator">Moderator</option><option value="admin">Platform admin</option>
        <option value="asha">Asha</option><option value="ravi">Ravi</option><option value="neha">Neha</option>
      </select>
    </label>
  );
  return (
    <button type="button" className="text-button" disabled={busy} onClick={() => {
      setBusy(true);
      void (signedIn() ? signOut() : startSignIn()).catch(() => setBusy(false));
    }}>{busy ? 'Please wait…' : signedIn() ? 'Sign out' : 'Campus sign-in'}</button>
  );
}

function InviteLink({ invite }: { invite: Invite }) {
  const [copied, setCopied] = useState(false);
  const link = inviteLink(invite.token);
  return (
    <div className="invite-link">
      <input className="field-control" readOnly value={link} aria-label={`${invite.role} invite link`} onFocus={(event) => event.target.select()} />
      <button type="button" className="text-button" onClick={() => void navigator.clipboard?.writeText(link).then(() => setCopied(true))}>
        {copied ? 'Copied' : 'Copy'}
      </button>
      <p className="hint">Works once, for one person, until <time dateTime={invite.expiresAt}>{until(invite.expiresAt)}</time>. Send it however you like.</p>
    </div>
  );
}

// Uploads as soon as a photo is chosen; the browser shrinks it first, so even a phone camera photo is small.
function PhotoField({ item, shopId, onSaved }: { item: Item; shopId: string; onSaved: (saved: Item) => void }) {
  const [state, setState] = useState({ busy: false, error: '' });
  const save = async (data: () => Promise<string | null>) => {
    setState({ busy: true, error: '' });
    try {
      onSaved(await uploadPhoto(shopId, item.id, await data()));
      setState({ busy: false, error: '' });
    } catch (cause) {
      setState({ busy: false, error: messageOf(cause) });
    }
  };
  return (
    <div className="photo-field">
      {item.photoUrl ? <img src={item.photoUrl} alt={`Current photo of ${item.name}`} /> : <p className="hint">No photo yet. Students see the item’s initials instead.</p>}
      <label className="text-button">{state.busy ? 'Uploading…' : item.photoUrl ? 'Replace photo' : 'Add a photo'}
        <input type="file" accept="image/*" className="visually-hidden" disabled={state.busy}
          onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void save(() => resizePhoto(file)); }} />
      </label>
      {item.photoUrl && <button type="button" className="text-button" disabled={state.busy} onClick={() => void save(async () => null)}>Remove photo</button>}
      <Notice error={state.error} />
    </div>
  );
}

function ItemForm({ item, onDone, onPhoto, shopId }: { item?: Item; shopId: string; onDone: (saved?: Item) => void; onPhoto?: (saved: Item) => void }) {
  const [fields, setFields] = useState({
    name: item?.name ?? '', course: item?.course ?? '', price: String(item?.price ?? ''), stock: '0',
    pickupWindow: item?.pickupWindow ?? '', active: item?.active !== false,
  });
  // A new item keeps one id across retries, so a lost response can't create it twice.
  const [newId] = useState(() => window.crypto?.randomUUID?.() ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (name: keyof typeof fields) => (event: { target: { value: string; checked?: boolean; type?: string } }) =>
    setFields((old) => ({ ...old, [name]: event.target.type === 'checkbox' ? event.target.checked : event.target.value }));
  async function save(event: FormEvent) {
    event.preventDefault();
    const price = Number(fields.price);
    const stock = Number(fields.stock);
    if (!item && !newId) {
      setError('Open Astrashop over HTTPS to add items.');
      return;
    }
    if (!Number.isSafeInteger(price) || price < 0 || (!item && (!Number.isSafeInteger(stock) || stock < 0))) {
      setError('Price and stock are whole numbers, zero or more.');
      return;
    }
    setBusy(true);
    setError('');
    const input = { name: fields.name, course: fields.course, price, pickupWindow: fields.pickupWindow };
    try {
      onDone(item
        ? await updateItem(shopId, item.id, { ...input, active: fields.active, expectedVersion: item.version ?? 0 })
        : await createItem(shopId, { ...input, id: newId, stock }));
    } catch (cause) {
      setError(messageOf(cause));
      setBusy(false);
    }
  }
  return (
    <form className="market-form admin-form" onSubmit={(event) => void save(event)}>
      {item && onPhoto && <PhotoField item={item} shopId={shopId} onSaved={onPhoto} />}
      <label>Name<input className="field-control" required minLength={2} maxLength={80} value={fields.name} onChange={set('name')} /></label>
      <label>Course <small>optional</small><input className="field-control" maxLength={40} value={fields.course} onChange={set('course')} /></label>
      <label>Price in rupees<input className="field-control" required inputMode="numeric" value={fields.price} onChange={set('price')} /></label>
      {!item && <label>Units on the shelf<input className="field-control" required inputMode="numeric" value={fields.stock} onChange={set('stock')} /></label>}
      <label>Pickup hours <small>optional, defaults to the shop’s</small><input className="field-control" maxLength={80} value={fields.pickupWindow} onChange={set('pickupWindow')} /></label>
      {item && <label className="checkbox"><input type="checkbox" checked={fields.active} onChange={set('active')} /> On sale (students can see and reserve it)</label>}
      <Notice error={error} />
      <div className="market-actions">
        <button className="reserve" disabled={busy}>{busy ? 'Saving…' : item ? 'Save changes' : 'Add item'}</button>
        <button type="button" className="text-button" disabled={busy} onClick={() => onDone()}>Cancel</button>
      </div>
    </form>
  );
}

function CatalogSection({ shop }: { shop: Membership }) {
  const items = useLoad(() => getCatalog(shop.shopId), [shop.shopId]);
  const [editing, setEditing] = useState<string>();
  // Use the saved item from the response: on AWS a reload through the catalog index can lag a moment
  // behind the write, which would show a stale version or miss a new item.
  const put = (saved: Item) => items.update((list = []) => [...list.filter(({ id }) => id !== saved.id), saved].sort((a, b) => a.name.localeCompare(b.name)));
  const done = (saved?: Item) => {
    setEditing(undefined);
    if (saved) put(saved);
  };
  return (
    <section className="panel" aria-labelledby="catalog-heading">
      <div className="panel-head panel-head-split">
        <div><h2 id="catalog-heading">Catalog</h2><p className="hint">What students can find and reserve. Take an item off sale instead of deleting it, so past pickups keep their name.</p></div>
        {editing !== 'new' && <button type="button" className="reserve" onClick={() => setEditing('new')}>Add an item</button>}
      </div>
      {editing === 'new' && <ItemForm shopId={shop.shopId} onDone={done} />}
      <Notice error={items.error} />
      {items.busy && !items.data && <p role="status" className="hint">Loading the catalog…</p>}
      {items.data?.length === 0 && <p className="passes-empty">Nothing in the catalog yet. Add the first item.</p>}
      <ul className="admin-list">
        {items.data?.map((item) => (
          <li key={item.id}>
            {editing === item.id ? <ItemForm item={item} shopId={shop.shopId} onDone={done} onPhoto={put} /> : (
              <div className="admin-row">
                {item.photoUrl ? <img className="admin-thumb" src={item.photoUrl} alt="" /> : <span className="admin-thumb is-blank" aria-hidden="true" />}
                <div>
                  <p className="admin-name">{item.name}{item.active === false && <span className="tag">Off sale</span>}</p>
                  <p className="hint">{[item.course, `${item.stock} on the shelf`, item.pickupWindow].filter(Boolean).join(' · ')}</p>
                </div>
                <p className="price"><Rupees value={item.price} /></p>
                <button type="button" className="text-button" disabled={!!editing} onClick={() => setEditing(item.id)}>Edit</button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function ShopSettings({ shop, onSaved }: { shop: Membership; onSaved: () => void }) {
  const [name, setName] = useState(shop.name);
  const [pickupWindow, setPickupWindow] = useState(shop.pickupWindow);
  const [state, setState] = useState({ busy: false, error: '', saved: false });
  return (
    <form className="market-form admin-form" onSubmit={(event) => {
      event.preventDefault();
      setState({ busy: true, error: '', saved: false });
      void updateShop(shop.shopId, { name, pickupWindow }).then(() => { setState({ busy: false, error: '', saved: true }); onSaved(); })
        .catch((cause) => setState({ busy: false, error: messageOf(cause), saved: false }));
    }}>
      <label>Shop name<input className="field-control" required minLength={2} maxLength={80} value={name} onChange={(event) => setName(event.target.value)} /></label>
      <label>Opening hours <small>shown on new items, e.g. Mon–Sat, 10 am–6 pm</small>
        <input className="field-control" maxLength={80} value={pickupWindow} onChange={(event) => setPickupWindow(event.target.value)} /></label>
      <Notice error={state.error} />
      {state.saved && <p className="notice success" role="status">Saved.</p>}
      <button className="reserve" disabled={state.busy}>{state.busy ? 'Saving…' : 'Save shop details'}</button>
    </form>
  );
}

function StaffSection({ shop, me, onShopChanged }: { shop: Membership; me: Me; onShopChanged: () => void }) {
  const staff = useLoad(() => getStaff(shop.shopId), [shop.shopId]);
  const [role, setRole] = useState<Role>('staff');
  const [invite, setInvite] = useState<Invite>();
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const act = async (key: string, action: () => Promise<unknown>) => {
    setBusy(key);
    setError('');
    try { await action(); } catch (cause) { setError(messageOf(cause)); } finally { setBusy(''); }
  };
  const change = (member: StaffMember, next: Role | null) => act(member.userId, async () => {
    if (next === null && !window.confirm(`Remove ${member.name || 'this person'} from ${shop.name}? They lose counter access at once.`)) return;
    await setStaffRole(shop.shopId, member.userId, next);
    staff.reload();
  });
  return (
    <>
      <section className="panel" aria-labelledby="staff-heading">
        <div className="panel-head"><h2 id="staff-heading">Staff</h2><p className="hint">Owners manage the catalog, staff and activity. Staff run the counter.</p></div>
        <Notice error={staff.error || error} />
        <ul className="admin-list">
          {staff.data?.map((member) => (
            <li key={member.userId} className="admin-row">
              <div>
                <p className="admin-name">{member.name || 'No name given'}{member.userId === me.id && <span className="tag">You</span>}</p>
                <p className="hint">Account …{shortId(member.userId)}{member.addedAt && <>, added <time dateTime={member.addedAt}>{age(member.addedAt)}</time></>}</p>
              </div>
              {member.userId === me.id ? <p className="hint">{member.role}</p> : (
                <>
                  <select className="field-control" aria-label={`Role for ${member.name || shortId(member.userId)}`} value={member.role} disabled={!!busy}
                    onChange={(event) => void change(member, event.target.value as Role)}>
                    <option value="staff">staff</option><option value="owner">owner</option>
                  </select>
                  <button type="button" className="text-button" disabled={!!busy} onClick={() => void change(member, null)}>Remove</button>
                </>
              )}
            </li>
          ))}
        </ul>
        <div className="invite">
          <h3>Invite someone</h3>
          <p className="hint">They open the link, sign in, and join. You never need their account id.</p>
          <div className="market-actions">
            <select className="field-control" aria-label="Role for the invite" value={role} onChange={(event) => setRole(event.target.value as Role)}>
              <option value="staff">as staff</option><option value="owner">as an owner</option>
            </select>
            <button type="button" className="reserve" disabled={!!busy} onClick={() => void act('invite', async () => setInvite(await createInvite(shop.shopId, role)))}>
              {busy === 'invite' ? 'Creating…' : 'Create invite link'}
            </button>
          </div>
          {invite && <InviteLink invite={invite} />}
        </div>
      </section>
      <section className="panel" aria-labelledby="settings-heading">
        <div className="panel-head"><h2 id="settings-heading">Shop details</h2></div>
        <ShopSettings shop={shop} onSaved={onShopChanged} />
      </section>
    </>
  );
}

const describe = (entry: AuditEntry, itemName: (id: string) => string, who: (id: string) => string): ReactNode => {
  const d = entry.detail as Record<string, any>;
  switch (entry.action) {
    case 'set-aside': return 'set a pickup aside';
    case 'collected': return 'handed over a pickup';
    case 'released': return 'released a hold';
    case 'returned': return 'put an expired unit back on the shelf';
    case 'recount': return <>recounted {itemName(entry.target)}: {d.before} → {d.after}</>;
    case 'item-created': return <>added {d.name}</>;
    case 'item-updated': return <>edited {d.after?.name}{d.before?.active !== d.after?.active ? (d.after?.active ? ', back on sale' : ', took it off sale') : ''}</>;
    case 'staff': return d.role ? <>gave {who(entry.target)} {d.role} access</> : <>removed {who(entry.target)}</>;
    case 'invite': return <>created an invite link for {entry.target}</>;
    case 'joined': return <>joined as {d.role}</>;
    case 'shop-created': return 'opened the shop';
    case 'shop-updated': return <>renamed the shop to {d.name}</>;
    case 'shop-status': return <>set the shop to {d.status}</>;
    default: return entry.action;
  }
};

function ActivitySection({ shop, me }: { shop: Membership; me: Me }) {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [state, setState] = useState({ busy: true, error: '' });
  const staff = useLoad(() => getStaff(shop.shopId), [shop.shopId]);
  const items = useLoad(() => getCatalog(shop.shopId), [shop.shopId]);
  const load = useCallback(async (cursor?: string) => {
    setState({ busy: true, error: '' });
    try {
      const page = await getAudit(shop.shopId, cursor);
      setEntries((old) => cursor ? [...old, ...page.entries] : page.entries);
      setNext(page.next);
      setState({ busy: false, error: '' });
    } catch (cause) {
      setState({ busy: false, error: messageOf(cause) });
    }
  }, [shop.shopId]);
  useEffect(() => { void load(); }, [load]);
  const who = (id: string) => id === me.id ? 'You' : id === 'shop-key' ? 'Counter key'
    : staff.data?.find((member) => member.userId === id)?.name || `Account …${shortId(id)}`;
  const itemName = (id: string) => items.data?.find((item) => item.id === id)?.name ?? 'an item';
  return (
    <section className="panel" aria-labelledby="activity-heading">
      <div className="panel-head"><h2 id="activity-heading">Activity</h2><p className="hint">Everything staff did at this shop, newest first. Kept for a year.</p></div>
      <Notice error={state.error} />
      {!state.busy && entries.length === 0 && !state.error && <p className="passes-empty">Nothing yet.</p>}
      <ul className="admin-list activity">
        {entries.map((entry) => (
          <li key={entry.id}><time dateTime={entry.at}>{age(entry.at)}</time> <strong>{who(entry.actor)}</strong> {describe(entry, itemName, who)}</li>
        ))}
      </ul>
      <More busy={state.busy} available={!!next} load={() => load(next!)} />
    </section>
  );
}

type Report = { id: string; listingId: string; title: string; listingVersion: number; reason: string; when: string };

function ModerationSection() {
  const reports = usePage<Report>('/reports', true);
  const [outcome, setOutcome] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState('');
  async function remove(report: Report) {
    setBusy(report.id);
    try {
      await marketRequest(`/listings/${encodeURIComponent(report.listingId)}/moderate`, { method: 'PUT', body: { version: report.listingVersion }, private: true });
      setOutcome((old) => ({ ...old, [report.id]: 'Listing removed.' }));
    } catch (cause) {
      const message = messageOf(cause);
      setOutcome((old) => ({ ...old, [report.id]: message.includes('changed') ? 'The seller edited this listing after the report. Open it and check before removing.' : message }));
    } finally {
      setBusy('');
    }
  }
  return (
    <section className="panel" aria-labelledby="moderation-heading">
      <div className="panel-head"><h2 id="moderation-heading">Reported listings</h2><p className="hint">Newest reports first. Removing hides the listing from everyone and can’t be undone here.</p></div>
      <Notice error={reports.error} />
      {reports.data?.entries.length === 0 && <p className="passes-empty">No reports. Nothing to review.</p>}
      <ul className="admin-list">
        {reports.data?.entries.map((report) => (
          <li key={report.id} className="admin-row">
            <div>
              <p className="admin-name"><a href={listingHref(report.listingId)}>{report.title}</a></p>
              <p className="report-reason">“{report.reason}”</p>
              <p className="hint">Reported <time dateTime={report.when}>{age(report.when)}</time>{outcome[report.id] && <> · <strong>{outcome[report.id]}</strong></>}</p>
            </div>
            <button type="button" className="text-button" disabled={!!busy || !!outcome[report.id]} onClick={() => void remove(report)}>
              {busy === report.id ? 'Removing…' : 'Remove listing'}
            </button>
          </li>
        ))}
      </ul>
      <More busy={reports.busy} available={!!reports.data?.next} load={reports.more} />
    </section>
  );
}

function ShopsSection() {
  const shops = useLoad(listShops, []);
  const [form, setForm] = useState({ id: '', name: '', pickupWindow: '' });
  const [invites, setInvites] = useState<Record<string, Invite>>({});
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const act = async (key: string, action: () => Promise<unknown>) => {
    setBusy(key);
    setError('');
    try { await action(); } catch (cause) { setError(messageOf(cause)); } finally { setBusy(''); }
  };
  return (
    <section className="panel" aria-labelledby="shops-heading">
      <div className="panel-head"><h2 id="shops-heading">Shops</h2><p className="hint">Open a shop, send its owner an invite link, and pause it if it stops paying. A suspended shop takes no new reservations.</p></div>
      <Notice error={shops.error || error} />
      <ul className="admin-list">
        {shops.data?.map((shop: ShopSummary) => (
          <li key={shop.id}>
            <div className="admin-row">
              <div><p className="admin-name">{shop.name}</p><p className="hint">{shop.id}{shop.pickupWindow && ` · ${shop.pickupWindow}`}</p></div>
              <select className="field-control" aria-label={`Status of ${shop.name}`} value={shop.status} disabled={!!busy}
                onChange={(event) => void act(shop.id, async () => { await setShopStatus(shop.id, event.target.value as ShopStatus); shops.reload(); })}>
                <option value="trial">trial</option><option value="active">active</option><option value="suspended">suspended</option>
              </select>
              <button type="button" className="text-button" disabled={!!busy}
                onClick={() => void act(`invite-${shop.id}`, async () => { const invite = await createInvite(shop.id, 'owner'); setInvites((old) => ({ ...old, [shop.id]: invite })); })}>
                Owner invite link
              </button>
            </div>
            {invites[shop.id] && <InviteLink invite={invites[shop.id]} />}
          </li>
        ))}
      </ul>
      <form className="market-form admin-form" onSubmit={(event) => {
        event.preventDefault();
        void act('create', async () => {
          await createShop(form);
          setForm({ id: '', name: '', pickupWindow: '' });
          shops.reload();
        });
      }}>
        <h3>Open a shop</h3>
        <label>Shop id <small>3-40 lowercase letters, digits and dashes; it never changes</small>
          <input className="field-control" required pattern="[a-z0-9][a-z0-9\-]{1,38}[a-z0-9]" value={form.id} onChange={(event) => setForm({ ...form, id: event.target.value })} /></label>
        <label>Name<input className="field-control" required minLength={2} maxLength={80} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
        <label>Opening hours <small>optional</small><input className="field-control" maxLength={80} value={form.pickupWindow} onChange={(event) => setForm({ ...form, pickupWindow: event.target.value })} /></label>
        <button className="reserve" disabled={!!busy}>{busy === 'create' ? 'Opening…' : 'Open shop'}</button>
      </form>
    </section>
  );
}

function JoinShop({ token, onJoined }: { token: string; onJoined: () => void }) {
  const [name, setName] = useState('');
  const [state, setState] = useState<{ busy: boolean; error: string; joined?: { name: string; role: Role } }>({ busy: false, error: '' });
  return (
    <section className="panel join" aria-labelledby="join-heading">
      <div className="panel-head"><h2 id="join-heading">Join a shop on Astrashop</h2><p className="hint">Someone at the shop sent you this link.</p></div>
      {state.joined ? (
        <>
          <p className="notice success" role="status">You’re now {state.joined.role === 'owner' ? 'an owner' : 'staff'} at {state.joined.name}.</p>
          <a className="reserve" href="#admin">Open the shop admin</a>
        </>
      ) : !signedIn() ? (
        <div className="market-actions"><p>Sign in first. Use the account you’ll work with at the counter.</p><AccountControl /></div>
      ) : (
        <form className="market-form admin-form" onSubmit={(event) => {
          event.preventDefault();
          setState({ busy: true, error: '' });
          void acceptInvite(token, name).then((joined) => { setState({ busy: false, error: '', joined }); onJoined(); })
            .catch((cause) => setState({ busy: false, error: messageOf(cause) }));
        }}>
          <label>Your name <small>as the shop owner will see it</small>
            <input className="field-control" maxLength={60} value={name} onChange={(event) => setName(event.target.value)} /></label>
          <Notice error={state.error} />
          <button className="reserve" disabled={state.busy}>{state.busy ? 'Joining…' : 'Join the shop'}</button>
        </form>
      )}
    </section>
  );
}

export default function Admin() {
  const [route, setRoute] = useState(readRoute);
  const [session, refreshMe] = useSession();
  const me = useLoad<Me | undefined>(signedIn() ? getMe : null, [session]);
  const [chosen, setChosen] = useState(() => { try { return sessionStorage.getItem(shopKey) ?? ''; } catch { return ''; } });
  useEffect(() => {
    const sync = () => setRoute(readRoute());
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);
  if ('join' in route) return <JoinShop token={route.join} onJoined={refreshMe} />;

  const shops = me.data?.shops ?? [];
  const shop = shops.find(({ shopId }) => shopId === chosen) ?? shops[0];
  const available: Section[] = ['counter',
    ...(shop?.role === 'owner' ? ['catalog', 'staff', 'activity'] as const : []),
    ...(me.data?.moderator ? ['moderation'] as const : []),
    ...(me.data?.platformAdmin ? ['shops'] as const : [])];
  const section = available.includes(route.section) ? route.section : 'counter';
  return (
    <>
      <header className="page-header page-header-split">
        <div>
          <h1 className="page-title">Shop admin</h1>
          <p className="hint">{shop ? <>{shop.name}, you’re {shop.role === 'owner' ? 'an owner' : 'staff'}{shop.status === 'suspended' && '. This shop is suspended and takes no new reservations'}.</> : 'Run the counter, the catalog and your team.'}</p>
        </div>
        <div className="admin-account">
          {shops.length > 1 && (
            <label>Shop
              <select className="field-control" value={shop?.shopId ?? ''} onChange={(event) => {
                setChosen(event.target.value);
                try { sessionStorage.setItem(shopKey, event.target.value); } catch { /* this visit only */ }
              }}>{shops.map((entry) => <option key={entry.shopId} value={entry.shopId}>{entry.name}</option>)}</select>
            </label>
          )}
          <AccountControl />
        </div>
      </header>
      <Notice error={me.error} />
      {available.length > 1 && (
        <nav className="text-tabs admin-tabs" aria-label="Shop admin sections">
          {available.map((name) => <a key={name} href={`#admin/${name}`} aria-current={name === section ? 'page' : undefined}>{sectionNames[name]}</a>)}
        </nav>
      )}
      {section === 'counter' && <Shop shop={shop && { shopId: shop.shopId, name: shop.name }} />}
      {section === 'catalog' && shop && <CatalogSection key={shop.shopId} shop={shop} />}
      {section === 'staff' && shop && me.data && <StaffSection key={shop.shopId} shop={shop} me={me.data} onShopChanged={refreshMe} />}
      {section === 'activity' && shop && me.data && <ActivitySection key={shop.shopId} shop={shop} me={me.data} />}
      {section === 'moderation' && <ModerationSection />}
      {section === 'shops' && <ShopsSection />}
    </>
  );
}
