import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  categories, conditions, demoIdentity, demoMode, marketplaceAccount, MarketError, marketRequest, readListingDraft, storeListingDraft, setDemoIdentity,
  signedIn, signOut, startSignIn, type DemoIdentity, type Kind,
  type Listing, type Condition, type ListingInput, type Message, type OwnedListing, type OwnProfile, type SavedEntry, type Thread,
} from './marketplace-api';
import { ListingCard, listingHref, messageOf, Notice, useActiveView, usePage, useResource } from './marketplace-ui';
import { ExchangePanel, ListingDetail, ProfileEditor, SellerDirectory, SellerDetail } from './marketplace-community-ui';

type View = 'browse' | 'mine' | 'inbox' | 'sellers' | 'profile' | 'saved';
type Area = 'buying' | 'selling';
const viewPaths: Record<View, string> = {
  browse: '#marketplace', sellers: '#marketplace/sellers', saved: '#marketplace/saved',
  mine: '#marketplace/selling', inbox: '#marketplace/inbox', profile: '#marketplace/profile',
};
function routeView(hash = location.hash): View {
  return (Object.entries(viewPaths).find(([, path]) => path === hash)?.[0] as View | undefined) ?? 'browse';
}
type Group = Kind | '';
type ListingDraft = {
  id: string; kind: Kind; title: string; description: string; condition: Condition;
  scope: string; availability: string; meetup: string; amount: string;
  attempt?: Record<string, unknown>;
};

function validDraft(value: unknown): value is ListingDraft {
  if (!value || typeof value !== 'object') return false;
  const draft = value as ListingDraft;
  return typeof draft.id === 'string' && /^[a-f0-9-]{36}$/.test(draft.id)
    && Object.hasOwn(categories, draft.kind) && (draft.condition === '' || Object.hasOwn(conditions, draft.condition))
    && ['title', 'description', 'scope', 'availability', 'meetup', 'amount'].every((key) =>
      typeof (draft as unknown as Record<string, unknown>)[key] === 'string');
}

function ListingEditor({ listing, close, saved }: { listing?: OwnedListing; close: () => void; saved: () => void }) {
  const isActive = useActiveView();
  const draftKey = `astrashop.marketplace.draft:${marketplaceAccount()}:${listing?.id ?? 'new'}`;
  const [draft, setDraft] = useState<ListingDraft>(() => readListingDraft(draftKey, validDraft) ?? {
    id: listing?.id ?? crypto.randomUUID(), kind: listing?.kind ?? 'item', title: listing?.title ?? '',
    description: listing?.description ?? '', condition: listing?.condition ?? '', scope: listing?.scope ?? '',
    availability: listing?.availability ?? '', meetup: listing?.meetup ?? '', amount: String((listing?.pricePaise ?? 0) / 100),
  });
  const { id, kind, title, description, condition, scope, availability, meetup, amount } = draft;
  function update(values: Partial<ListingDraft>) {
    const next = { ...draft, ...values };
    setDraft(next);
    storeListingDraft(draftKey, next);
  }
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending.current) return;
    if (!/^\d+(?:\.\d{1,2})?$/.test(amount.trim()) || Number(amount) > 100000) {
      setError('Enter an amount from ₹0 to ₹100,000 with up to two decimal places.');
      return;
    }
    const input: ListingInput = {
      kind, title, description, meetup, pricePaise: Math.round(Number(amount) * 100),
      condition: kind === 'item' ? condition : '', scope: kind === 'item' ? '' : scope, availability,
    };
    const attempt = draft.attempt ?? (listing
      ? { ...input, version: listing.version, status: listing.status, requestId: crypto.randomUUID() }
      : { ...input, id });
    update({ attempt });
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      await marketRequest(listing ? `/listings/${id}` : '/listings', {
        private: true, method: listing ? 'PUT' : 'POST', body: attempt,
      });
      storeListingDraft(draftKey);
      if (isActive()) saved();
    } catch (cause) {
      if (!isActive()) return;
      if (cause instanceof MarketError && cause.status >= 400 && cause.status < 500 && cause.status !== 429) {
        update({ attempt: undefined });
      }
      setError(messageOf(cause));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="panel market-panel" aria-labelledby="listing-editor">
      <p className="section-kicker">Selling</p>
      <h2 id="listing-editor">{listing ? 'Edit listing' : 'Post a listing'}</h2>
      <form className="market-form" onSubmit={(event) => void submit(event)}>
        <fieldset disabled={busy || !!draft.attempt}>
          <label>Category<select className="field-control" value={kind} disabled={!!listing} onChange={(event) => update({ kind: event.target.value as Kind })}>
            {Object.entries(categories).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </select></label>
          <label>Title<input className="field-control" value={title} required minLength={3} maxLength={80} onChange={(event) => update({ title: event.target.value })} /></label>
          <label>Description<textarea className="field-control" value={description} required minLength={5} maxLength={1200} rows={4} onChange={(event) => update({ description: event.target.value })} /></label>
          {kind === 'item' ? <label>Condition<select className="field-control" value={condition} onChange={(event) => update({ condition: event.target.value as Condition })}>
            <option value="">Choose a condition</option>
            {Object.entries(conditions).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
          </select></label> : <label>What’s included<textarea className="field-control" value={scope} maxLength={500} rows={3}
            onChange={(event) => update({ scope: event.target.value })} placeholder="What you’ll do, what to bring, and how long it takes" /></label>}
          <label>Availability<input className="field-control" value={availability} maxLength={100} onChange={(event) => update({ availability: event.target.value })}
            placeholder="For example, weekday afternoons" /></label>
          <label>Campus meetup area<input className="field-control" value={meetup} required minLength={2} maxLength={80} onChange={(event) => update({ meetup: event.target.value })} /></label>
          <label>Amount in rupees<input className="field-control" value={amount} required inputMode="decimal" maxLength={9} onChange={(event) => update({ amount: event.target.value })} /></label>
          <p className="hint">Enter ₹0 for a free listing. Share a public meetup area.</p>
        </fieldset>
        {draft.attempt && <p className="hint" role="status">This save is awaiting confirmation. Retry to check its result.</p>}
        <Notice error={error} />
        <div className="market-actions">
          <button className="reserve" disabled={busy}>{busy ? 'Saving…' : draft.attempt ? 'Retry save' : listing ? 'Save changes' : 'Publish listing'}</button>
          <button className="text-button" type="button" disabled={busy} onClick={close}>Back</button>
        </div>
      </form>
    </section>
  );
}

function ListingAction({ listing, type, close, opened }: {
  listing: Listing; type: 'contact' | 'report'; close: () => void; opened: (thread: Thread) => void;
}) {
  const isActive = useActiveView();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [reported, setReported] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);
  const attempt = useRef<{ id: string; text: string } | null>(null);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      if (attempt.current?.text !== text) attempt.current = { id: crypto.randomUUID(), text };
      const result = await marketRequest<Thread>(`/listings/${listing.id}/${type}`, {
        private: true, method: 'POST', body: type === 'contact' ? attempt.current : { reason: text },
      });
      if (!isActive()) return;
      if (type === 'contact') opened(result);
      else setReported(true);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="panel market-panel">
      <p className="section-kicker">{type === 'contact' ? 'Buying' : 'Listing report'}</p>
      <h2>{type === 'contact' ? 'Contact the seller' : 'Report listing'}</h2>
      <p>{listing.title}</p>
      {reported ? <p role="status">Report sent for review.</p> : (
        <form className="market-form" onSubmit={(event) => void submit(event)}>
          <label>{type === 'contact' ? 'Your message' : 'Reason for reporting'}
            <textarea className="field-control" required minLength={type === 'contact' ? 1 : 5} maxLength={type === 'contact' ? 800 : 400}
              rows={3} disabled={busy} value={text} onChange={(event) => setText(event.target.value)} />
          </label>
          <Notice error={error} />
          <button className="reserve" disabled={busy}>{busy ? 'Sending…' : type === 'contact' ? 'Send message' : 'Send report'}</button>
        </form>
      )}
      <button className="text-button" type="button" disabled={busy} onClick={close}>{reported ? 'Done' : 'Cancel'}</button>
    </section>
  );
}

function Conversation({ thread, close, profile, editProfile }: {
  thread: Thread; close: () => void; profile?: OwnProfile | null; editProfile: () => void;
}) {
  const path = `/threads/${thread.id}`;
  const page = usePage<Message>(path, true);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const attempted = useRef<{ id: string; text: string } | null>(null);
  const lock = useRef(false);
  const refresh = page.refresh;
  useEffect(() => {
    const onFocus = () => { if (!lock.current) void refresh(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);
  async function send(event: FormEvent) {
    event.preventDefault();
    if (lock.current || !draft.trim()) return;
    lock.current = true;
    setSending(true);
    setError('');
    if (attempted.current?.text !== draft) attempted.current = { id: crypto.randomUUID(), text: draft };
    try {
      await marketRequest<Message>(path, { private: true, method: 'POST', body: attempted.current });
      attempted.current = null;
      setDraft('');
      await page.refresh();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      lock.current = false;
      setSending(false);
    }
  }
  return (
    <section className="panel market-panel" aria-labelledby="thread-title">
      <button type="button" className="text-button" onClick={close}>Back to inbox</button>
      <p className="section-kicker">{thread.asSeller ? 'Selling conversation' : 'Buying conversation'}</p>
      <h2 id="thread-title">{thread.title}</h2>
      <div className="market-actions">
        <button type="button" className="text-button" disabled={page.busy} onClick={() => void page.refresh()}>Refresh messages</button>
        {page.data?.next && <button type="button" className="text-button" disabled={page.busy} onClick={() => void page.more()}>Older messages</button>}
      </div>
      <Notice error={page.error} />
      <ol className="market-messages" aria-label="Messages" aria-busy={page.busy}>
        {[...(page.data?.entries ?? [])].reverse().map((message) => (
          <li key={message.id} className={message.mine ? 'mine' : undefined}>
            <p className="hint">{message.mine ? 'You' : thread.asSeller ? 'Buyer' : 'Seller'}</p>
            <p>{message.text}</p>
          </li>
        ))}
      </ol>
      <form className="market-form" onSubmit={(event) => void send(event)}>
        <label>Reply<textarea className="field-control" rows={3} value={draft} required maxLength={800} disabled={sending}
          onChange={(event) => setDraft(event.target.value)} /></label>
        <Notice error={error} />
        <button className="reserve" disabled={sending || !draft.trim()}>{sending ? 'Sending…' : 'Send reply'}</button>
      </form>
      <ExchangePanel id={thread.id} profile={profile} editProfile={editProfile} />
    </section>
  );
}

function currentDetail(hash = location.hash) {
  const route = /^#marketplace\/(listing|seller)\/([a-f0-9-]+)$/.exec(hash);
  return route ? { type: route[1] as 'listing' | 'seller', id: route[2] } : null;
}

function Workspace({ member, login }: { member: boolean; login: () => void }) {
  const [view, setView] = useState<View>(() => routeView());
  const [detail, setDetail] = useState(currentDetail);
  const [filter, setFilter] = useState<Group>('');
  const [query, setQuery] = useState('');
  const [applied, setApplied] = useState('');
  const [editor, setEditor] = useState<OwnedListing | 'new'>();
  const [action, setAction] = useState<{ type: 'contact' | 'report'; listing: Listing }>();
  const [thread, setThread] = useState<Thread>();
  const area: Area = !detail && (editor || view === 'mine') ? 'selling' : 'buying';
  const sharedView = !detail && !editor && !action && ['inbox', 'profile'].includes(view);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [changing, setChanging] = useState(false);
  const mutating = useRef(false);
  const screen = useRef(0);
  const internalHash = useRef<string | null>(null);
  const isActive = useActiveView();
  const listingSave = useRef<{ id: string; version: number; status: string; requestId: string } | null>(null);
  const profileResource = useResource<{ profile: OwnProfile | null }>(member ? '/profile' : null, true);
  const profile = profileResource.data?.profile;
  const params = new URLSearchParams();
  if (filter) params.set('kind', filter);
  if (applied) params.set('q', applied);
  const feed = usePage<Listing>(!detail && view === 'browse' && !editor && !action ? `/listings?${params}` : null);
  const mine = usePage<OwnedListing>(!detail && member && view === 'mine' && !editor ? '/mine' : null, true);
  const inbox = usePage<Thread>(!detail && member && view === 'inbox' && !thread ? '/inbox' : null, true);
  const savedPage = usePage<SavedEntry>(!detail && member && view === 'saved' ? '/saved' : null, true);
  const page = view === 'browse' ? feed : view === 'mine' ? mine : view === 'saved' ? savedPage : inbox;

  useEffect(() => {
    const update = (event: HashChangeEvent) => {
      if (event.newURL && new URL(event.newURL).hash !== location.hash) return;
      if (internalHash.current === location.hash) { internalHash.current = null; return; }
      screen.current += 1;
      const next = currentDetail();
      setDetail(next);
      setAction(undefined);
      setEditor(undefined);
      setThread(undefined);
      setStatus('');
      setError('');
      if (!next) {
        const nextView = routeView();
        setView(nextView);
      }
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);

  function show(next: View) {
    screen.current += 1;
    setDetail(null);
    if (location.hash !== viewPaths[next]) {
      internalHash.current = viewPaths[next];
      location.hash = viewPaths[next];
    }
    setView(next);
    setEditor(undefined);
    setAction(undefined);
    setThread(undefined);
    setError('');
    setStatus('');
    window.scrollTo(0, 0);
  }
  const editProfile = () => show('profile');

  function postListing() {
    if (!member) return login();
    if (!profile) {
      show('profile');
      setStatus('Create your profile so buyers can see who is offering the listing.');
      return;
    }
    show('mine');
    setEditor('new');
  }

  async function removeSaved(id: string) {
    if (mutating.current) return;
    mutating.current = true;
    setChanging(true);
    setError('');
    const currentScreen = screen.current;
    try {
      await marketRequest(`/saved/${id}`, { method: 'PUT', private: true, body: { saved: false } });
      if (!isActive() || currentScreen !== screen.current) return;
      await savedPage.refresh();
    } catch (cause) {
      if (isActive() && currentScreen === screen.current) setError(messageOf(cause));
    } finally {
      setChanging(false);
      mutating.current = false;
    }
  }

  async function toggleListing(listing: OwnedListing) {
    if (mutating.current) return;
    mutating.current = true;
    setChanging(true);
    setError('');
    setStatus('');
    const nextStatus = listing.status === 'active' ? 'closed' : 'active';
    const currentScreen = screen.current;
    const prior = listingSave.current;
    const save = prior && prior.id === listing.id && prior.version === listing.version && prior.status === nextStatus
      ? prior : { id: listing.id, version: listing.version, status: nextStatus, requestId: crypto.randomUUID() };
    listingSave.current = save;
    try {
      await marketRequest(`/listings/${listing.id}`, { method: 'PUT', private: true, body: save });
      listingSave.current = null;
      if (!isActive() || currentScreen !== screen.current) return;
      setStatus(nextStatus === 'closed' ? 'Listing closed.' : 'Listing reopened.');
      await mine.refresh();
    } catch (cause) {
      if (!isActive() || currentScreen !== screen.current) return;
      setError(messageOf(cause));
      await mine.refresh();
    } finally {
      setChanging(false);
      mutating.current = false;
    }
  }

  return (
    <div className={`market-workspace market-${area}`}>
      <nav className="market-mode-nav" aria-label="Buying and selling">
        <button type="button" aria-label="Buying" aria-describedby="buying-purpose"
          aria-pressed={!editor && (Boolean(detail) || ['browse', 'sellers', 'saved'].includes(view))} onClick={() => show('browse')}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h16l-1 13H5L4 8Zm4 0V6a4 4 0 0 1 8 0v2" /></svg>
          <span><strong>Buying</strong><small id="buying-purpose">Browse and save campus offers</small></span>
        </button>
        <button type="button" aria-label="Selling" aria-describedby="selling-purpose"
          aria-pressed={!detail && (view === 'mine' || Boolean(editor))} onClick={() => show('mine')}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 3 8 .1L21 13l-8 8L3.1 11 3 3Z" /><circle cx="7.5" cy="7.5" r="1.2" /></svg>
          <span><strong>Selling</strong><small id="selling-purpose">Post offers and manage your listings</small></span>
        </button>
      </nav>
      <div className={`market-toolbar${sharedView ? ' is-account' : ''}`}>
        {!sharedView && <div className="text-tabs market-tabs" role="group" aria-label={area === 'buying' ? 'Buying pages' : 'Selling pages'}>
          {(area === 'buying' ? [['browse', 'Browse'], ['sellers', 'Sellers'], ['saved', 'Saved offers']] as const
            : [['mine', 'My listings']] as const).map(([value, label]) => (
            <button type="button" key={value} aria-pressed={!detail && view === value} onClick={() => show(value)}>{label}</button>
          ))}
        </div>}
        <div className="text-tabs market-tabs market-account-tabs" role="group" aria-label="Messages and account">
          {([['inbox', 'Inbox'], ['profile', 'My profile']] as const).map(([value, label]) => (
            <button type="button" key={value} aria-pressed={!detail && view === value} onClick={() => show(value)}>{label}</button>
          ))}
        </div>
      </div>
      {status && <p className="notice success" role="status">{status}</p>}
      <Notice error={error} />
      {!detail && !editor && !action && !thread && (['mine', 'saved', 'inbox'].includes(view) || !member && view === 'profile') && (
        <header className="section-head">
          <div>
            <p className="section-kicker">{view === 'mine' ? 'Selling' : view === 'saved' ? 'Buying' : view === 'inbox' ? 'Messages' : 'Your account'}</p>
            <h2>{view === 'mine' ? 'Your listings' : view === 'saved' ? 'Saved offers' : view === 'profile' ? 'Your profile' : 'Your inbox'}</h2>
            <p className="hint">{view === 'mine' ? 'Edit your offers and manage their availability.'
              : view === 'saved' ? 'Offers you kept for later, with their current availability.' : view === 'profile'
                ? 'How you appear to other campus members.' : 'Private conversations, labelled by your role in each exchange.'}</p>
          </div>
          {view === 'mine' && <button type="button" className="reserve" disabled={member && profileResource.busy && profile === undefined} onClick={postListing}>Post a listing</button>}
        </header>
      )}
      {editor ? <ListingEditor key={editor === 'new' ? 'new' : editor.id} listing={editor === 'new' ? undefined : editor}
        close={() => setEditor(undefined)} saved={() => { setEditor(undefined); setStatus('Listing saved.'); }} />
        : action ? <ListingAction key={action.listing.id + action.type} {...action} close={() => setAction(undefined)}
          opened={(opened) => { show('inbox'); setThread(opened); }} />
          : detail?.type === 'listing' ? <ListingDetail key={detail.id} id={detail.id} member={member} login={login}
            profile={profile} editProfile={editProfile} action={(type, listing) => setAction({ type, listing })} />
            : detail?.type === 'seller' ? <SellerDetail key={detail.id} id={detail.id}
              member={member} profile={profile} login={login} contact={(listing) => setAction({ type: 'contact', listing })} />
              : thread ? <Conversation key={thread.id} thread={thread} close={() => setThread(undefined)} profile={profile} editProfile={editProfile} />
            : view === 'sellers' ? <SellerDirectory />
              : view === 'browse' ? (
              <>
                <section className="panel market-discovery" aria-labelledby="market-find">
                <h2 id="market-find">Find an offer</h2>
                <form className="market-search" onSubmit={(event) => { event.preventDefault(); setApplied(query.trim()); }}>
                  <label>Search by title<input className="field-control" type="search" placeholder="Books, drawing tools, tutoring…" value={query} maxLength={80} onChange={(event) => setQuery(event.target.value)} /></label>
                  <button className="text-button">Search</button>
                  {applied && <button type="button" className="text-button" onClick={() => { setApplied(''); setQuery(''); }}>Clear</button>}
                </form>
                <div className="market-filter-row">
                <span className="field-caption">Category</span>
                <div className="text-tabs market-filters" role="group" aria-label="Listing categories">
                  {([['', 'All offers'], ...Object.entries(categories)] as [Group, string][]).map(([value, label]) => (
                    <button type="button" key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</button>
                  ))}
                </div>
                </div>
                </section>
                <header className="section-head">
                  <div><h2>{applied ? 'Search results' : filter ? categories[filter] : 'Latest offers'}</h2>
                    <p className="hint">Offered by students on your campus.</p></div>
                  {feed.data && <span className="count">{feed.data.entries.length}{feed.data.next ? '+' : ''} {feed.data.entries.length === 1 && !feed.data.next ? 'offer' : 'offers'}</span>}
                </header>
                <div className="sheet market-grid" aria-busy={feed.busy}>
                  {feed.data?.entries.map((listing) => <ListingCard key={listing.id} listing={listing}>
                    <a className="text-button" href={listingHref(listing.id)}>View listing</a>
                    {listing.seller?.id !== profile?.id || !profile ? <button type="button" className="text-button"
                      onClick={() => member ? setAction({ type: 'contact', listing }) : login()}>Contact seller</button> : null}
                  </ListingCard>)}
                </div>
              </>
            ) : !member ? (
              <section className="panel market-panel market-empty" aria-label="Campus sign-in required">
                <h3>Sign in to continue</h3>
                <p className="hint">{demoMode ? 'Choose a local demo account above to try this page.' : 'Use your campus account to access your listings, saved offers, profile, and messages.'}</p>
                <button type="button" className="reserve" onClick={login}>{demoMode ? 'Choose an account' : 'Campus sign-in'}</button>
              </section>
            ) : view === 'profile' ? (
              <>
                <Notice error={profileResource.error} />
                {profileResource.error && <button className="text-button" type="button" onClick={() => void profileResource.refresh()}>Retry profile</button>}
                {profile !== undefined && <ProfileEditor key={profile?.version ?? 'new'} profile={profile}
                  saved={async () => {
                    const currentScreen = screen.current;
                    await profileResource.refresh();
                    if (isActive() && currentScreen === screen.current) setStatus('Profile saved.');
                  }} />}
                {profileResource.busy && profile === undefined && <p role="status">Loading your profile…</p>}
              </>
            ) : view === 'saved' ? (
              <div className="sheet market-grid" aria-busy={savedPage.busy}>
                {savedPage.data?.entries.map((entry) => 'unavailable' in entry
                  ? <article className="market-card" key={entry.id}><p>Listing unavailable</p>
                    <button className="text-button" type="button" disabled={changing} onClick={() => void removeSaved(entry.id)}>Remove from saved</button>
                  </article>
                  : <ListingCard key={entry.id} listing={entry}>
                    {entry.status === 'closed' && <span className="hint">Closed</span>}
                    <button className="text-button" type="button" disabled={changing} onClick={() => void removeSaved(entry.id)}>Remove from saved</button>
                  </ListingCard>)}
              </div>
            ) : view === 'mine' ? (
              <div className="sheet market-grid" aria-busy={mine.busy}>
                {mine.data?.entries.map((listing) => <ListingCard key={listing.id} listing={listing}>
                  <span className={`listing-state${listing.status === 'active' ? ' is-active' : ''}`}>{listing.status === 'active' ? 'Active' : listing.status === 'removed' ? 'Removed'
                    : listing.completedAt ? 'Exchange completed' : 'Closed'}</span>
                  {listing.status !== 'removed' && <>
                    <button className="text-button" type="button" onClick={() => setEditor(listing)}>Edit</button>
                    {!listing.completedAt && <button className="text-button" type="button" disabled={changing} onClick={() => void toggleListing(listing)}>
                      {listing.status === 'active' ? 'Close listing' : 'Reopen listing'}
                    </button>}
                  </>}
                </ListingCard>)}
              </div>
            ) : (
              <ul className="sheet market-inbox" aria-busy={inbox.busy}>
                {inbox.data?.entries.map((entry) => <li key={entry.id}>
                  <button type="button" className="text-button" onClick={() => setThread(entry)}>{entry.title}</button>
                  <span className="market-inbox-role">{entry.asSeller ? 'Selling · Your listing' : 'Buying · Contacting seller'}</span>
                </li>)}
              </ul>
            )}
      {!detail && !editor && !thread && !action && view !== 'profile' && view !== 'sellers' && <>
        <Notice error={page.error} />
        {page.busy && !page.data && <p role="status" className="hint">Loading…</p>}
        {!page.busy && page.data?.entries.length === 0 && <p className="hint market-empty">
          {view === 'browse' ? 'No listings match.' : view === 'mine' ? 'You have no listings yet.'
            : view === 'saved' ? 'You have no saved listings yet.' : 'No conversations yet.'}
        </p>}
        <div className="market-actions">
          {page.data?.next && <button type="button" className="text-button" disabled={page.busy} onClick={() => void page.more()}>Load more</button>}
          {(page.error || (view === 'inbox' && member)) &&
            <button type="button" className="text-button" disabled={page.busy} onClick={() => void page.refresh()}>Refresh</button>}
        </div>
      </>}
    </div>
  );
}

export function Marketplace() {
  const [member, setMember] = useState(signedIn);
  const [demo, setDemo] = useState(demoIdentity);
  const [error, setError] = useState('');
  const [authenticating, setAuthenticating] = useState(false);
  useEffect(() => {
    const sync = () => {
      setMember(signedIn());
      setDemo(demoIdentity());
    };
    const expired = () => setError('Your session ended. Sign in again to continue. Your listing draft is saved in this browser tab.');
    window.addEventListener('marketplace-session-change', sync);
    window.addEventListener('marketplace-auth-expired', expired);
    return () => {
      window.removeEventListener('marketplace-session-change', sync);
      window.removeEventListener('marketplace-auth-expired', expired);
    };
  }, []);

  function login() {
    if (demoMode) {
      document.getElementById('market-demo')?.focus();
      return;
    }
    setAuthenticating(true);
    setError('');
    void startSignIn().catch((cause) => {
      setError(messageOf(cause));
      setAuthenticating(false);
    });
  }
  function logout() {
    setAuthenticating(true);
    void signOut().finally(() => setAuthenticating(false));
  }
  return (
    <>
      <header className="market-heading page-header page-header-split">
        <div><h1 className="page-title">Campus marketplace</h1><p className="hint">Buy, sell, or offer a hand to another student.</p></div>
        {demoMode ? (
          <label>Local demo account<select className="field-control" id="market-demo" value={demo} onChange={(event) => {
            const identity = event.target.value as DemoIdentity;
            setDemoIdentity(identity);
            setDemo(identity);
            setMember(Boolean(identity));
          }}>
            <option value="">Guest</option><option value="asha">Asha</option><option value="ravi">Ravi</option><option value="neha">Neha</option>
            <option value="owner">Shop owner</option><option value="staff">Shop staff</option>
          </select></label>
        ) : <button type="button" className="text-button" disabled={authenticating}
          onClick={member && signedIn() ? logout : login}>{authenticating ? 'Please wait…' : member && signedIn() ? 'Sign out' : 'Campus sign-in'}</button>}
      </header>
      <Notice error={error} />
      <Workspace key={demoMode ? demo : String(member)} member={member} login={login} />
    </>
  );
}
