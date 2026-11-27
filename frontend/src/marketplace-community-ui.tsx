import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Rupees } from './Rupees';
import {
  categories, conditions, marketRequest, type Exchange, type Listing, type ListingComment, type ListingDetails,
  type OwnProfile, type SellerProfile, type SellerReview,
} from './marketplace-api';
import { ListingCard, messageOf, More, Notice, Retry, SellerLink, sellerHref, shortDate, useActiveView, usePage, useResource } from './marketplace-ui';

type ListAction = (type: 'contact' | 'report', listing: Listing) => void;

export function ProfileEditor({ profile, saved }: { profile: OwnProfile | null; saved: () => Promise<void> }) {
  const isActive = useActiveView();
  const [draft, setDraft] = useState({ name: profile?.name ?? '', programme: profile?.programme ?? '', about: profile?.about ?? '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      await marketRequest('/profile', { method: 'PUT', private: true, body: { ...draft, version: profile?.version } });
      if (isActive()) await saved();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  return (
    <section className="panel market-panel" aria-labelledby="edit-market-profile">
      <p className="section-kicker">Your account</p>
      <h2 id="edit-market-profile">{profile ? 'Edit your profile' : 'Create your profile'}</h2>
      <p className="hint">Your display name, programme, and About me appear on your public marketplace profile.</p>
      <form className="market-form" onSubmit={(event) => void submit(event)}>
        <fieldset disabled={busy}>
          <label>Display name<input className="field-control" required minLength={2} maxLength={48} value={draft.name}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
          <label><span>Programme <small>Optional</small></span><input className="field-control" maxLength={80} value={draft.programme}
            onChange={(event) => setDraft({ ...draft, programme: event.target.value })} /></label>
          <label>About me<textarea className="field-control" rows={4} maxLength={800} value={draft.about}
            onChange={(event) => setDraft({ ...draft, about: event.target.value })} /></label>
          <p className="hint">Use private messages to share contact or meetup details.</p>
        </fieldset>
        <Notice error={error} />
        <div className="market-actions">
          <button className="reserve" disabled={busy}>{busy ? 'Saving…' : 'Save profile'}</button>
          {profile && <a className="text-button" href={sellerHref(profile.id)}>View public profile</a>}
        </div>
      </form>
    </section>
  );
}

function Reputation({ profile }: { profile: SellerProfile }) {
  return <p className="market-rating">{profile.ratingCount ? (
    <><strong>{profile.averageRating} / 5</strong> · {profile.ratingCount} {profile.ratingCount === 1 ? 'review' : 'reviews'}</>
  ) : 'No reviews yet'}</p>;
}

export function SellerDirectory() {
  const page = usePage<SellerProfile>('/sellers');
  return (
    <section className="market-section" aria-labelledby="market-sellers">
      <header className="section-head"><div><h2 id="market-sellers">Explore sellers</h2>
        <p className="hint">Meet the students behind the offers.</p></div></header>
      <Notice error={page.error} />
      {page.busy && !page.data && <p role="status">Loading sellers…</p>}
      {page.data?.entries.length === 0 && <p className="hint">No public profiles yet.</p>}
      <div className="sheet market-grid" aria-busy={page.busy}>
        {page.data?.entries.map((profile) => <article key={profile.id} className="market-card">
          <h3><SellerLink seller={profile} fallback="Campus seller" /></h3>
          {profile.programme && <p className="hint">{profile.programme}</p>}
          {profile.about && <p className="market-card-description">{profile.about}</p>}
          <Reputation profile={profile} />
        </article>)}
      </div>
      <More busy={page.busy} available={Boolean(page.data?.next)} load={page.more} />
      {page.error && <button type="button" className="text-button" onClick={() => void page.refresh()}>Retry sellers</button>}
    </section>
  );
}

export function SellerDetail({ id, member, profile: ownProfile, login, contact }: {
  id: string; member: boolean; profile?: OwnProfile | null; login: () => void; contact: (listing: Listing) => void;
}) {
  const profile = useResource<SellerProfile>(`/sellers/${id}`);
  const offers = usePage<Listing>(profile.data ? `/sellers/${id}/listings` : null);
  const reviews = usePage<SellerReview>(profile.data ? `/sellers/${id}/reviews` : null);
  const seller = profile.data;
  return (
    <div className="market-section">
      <a className="text-button" href="#marketplace">Back to marketplace</a>
      {profile.error && <section className={seller ? 'market-section' : 'panel market-panel market-empty'} aria-label="Seller profile error">
        {!seller && <h2>Seller unavailable</h2>}
        <Notice error={profile.error} />
        <Retry busy={profile.busy} retry={profile.refresh} label="Retry profile" />
      </section>}
      {profile.busy && !seller && <p role="status">Loading profile…</p>}
      {seller && <>
        <section className="panel market-panel market-seller" aria-labelledby="seller-name">
          <h2 id="seller-name">{seller.name}</h2>
          {seller.programme && <p className="hint">{seller.programme}</p>}
          <Reputation profile={seller} />
          <h3>About me</h3>
          <p className="market-description">{seller.about || 'This seller has not added an introduction yet.'}</p>
        </section>
        <section className="market-section" aria-labelledby="seller-offers">
          <header className="section-head"><h3 id="seller-offers">Active listings</h3></header>
          <Notice error={offers.error} />
          {offers.error && <Retry busy={offers.busy} retry={offers.refresh} label="Retry listings" />}
          {offers.data?.entries.length === 0 && !offers.data.next && <p className="hint">No active listings on this page.</p>}
          <div className="sheet market-grid" aria-busy={offers.busy}>
            {offers.data?.entries.map((listing) => <ListingCard key={listing.id} listing={listing}>
              {ownProfile?.id !== id && <button type="button" className="text-button"
                onClick={() => member ? contact(listing) : login()}>Contact seller</button>}
            </ListingCard>)}
          </div>
          <More busy={offers.busy} available={Boolean(offers.data?.next)} load={offers.more} />
        </section>
        <section className="panel market-panel market-section" aria-labelledby="seller-reviews">
          <h3 id="seller-reviews">Reviews</h3>
          <Notice error={reviews.error} />
          {reviews.error && <Retry busy={reviews.busy} retry={reviews.refresh} label="Retry reviews" />}
          {reviews.data?.entries.length === 0 && <p className="hint">No reviews yet.</p>}
          <ul className="market-feedback" aria-busy={reviews.busy}>
            {reviews.data?.entries.map((review) => <li key={review.id}>
              <div className="market-feedback-head">
                <strong>{review.rating} / 5</strong>
                <SellerLink seller={review.author} fallback="Campus member" />
                <time dateTime={review.createdAt}>{shortDate.format(new Date(review.createdAt))}</time>
              </div>
              <p className="hint">Exchange confirmed · {review.listingTitle}</p>
              <p className="market-description">{review.text}</p>
            </li>)}
          </ul>
          <More busy={reviews.busy} available={Boolean(reviews.data?.next)} load={reviews.more} />
        </section>
      </>}
    </div>
  );
}

function ListingComments({ listing, member, login, profile, editProfile }: {
  listing: ListingDetails; member: boolean; login: () => void; profile?: OwnProfile | null; editProfile: () => void;
}) {
  const path = `/listings/${listing.id}/comments`;
  const comments = usePage<ListingComment>(path);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const pending = useRef(false);
  const request = useRef<{ id: string; text: string } | null>(null);
  async function change(comment?: ListingComment) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    setStatus('');
    try {
      if (comment) {
        await marketRequest(`${path}/${encodeURIComponent(comment.id)}`, { method: 'PUT', private: true, body: {} });
        setStatus('Comment removed.');
      } else {
        if (request.current?.text !== draft) request.current = { id: crypto.randomUUID(), text: draft };
        await marketRequest(path, { method: 'POST', private: true, body: request.current });
        request.current = null;
        setDraft('');
        setStatus('Comment posted.');
      }
      await comments.refresh();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="panel market-panel market-section" aria-labelledby="listing-comments">
      <h3 id="listing-comments">Public comments</h3>
      <p className="hint">Ask about the listing here. Arrange pickup or share contact details in a private message.</p>
      <Notice error={comments.error || error} />
      {status && <p role="status">{status}</p>}
      {comments.data?.entries.length === 0 && <p className="hint">No comments yet.</p>}
      <ul className="market-feedback" aria-busy={comments.busy}>
        {comments.data?.entries.map((comment) => <li key={comment.id}>
          <div className="market-feedback-head">
            <SellerLink seller={comment.author} fallback="Campus member" />
            {comment.sellerReply && <span className="market-rating">Seller</span>}
            <time dateTime={comment.createdAt}>{shortDate.format(new Date(comment.createdAt))}</time>
          </div>
          <p className="market-description">{comment.text}</p>
          {profile && profile.id === comment.author?.id &&
            <button type="button" className="text-button" disabled={busy} onClick={() => void change(comment)}>Remove comment</button>}
        </li>)}
      </ul>
      <More busy={comments.busy} available={Boolean(comments.data?.next)} load={comments.more} />
      {listing.status === 'active' && (!member ? <button type="button" className="text-button" onClick={login}>Sign in to comment</button>
        : profile === null ? <button type="button" className="text-button" onClick={editProfile}>Create a profile to comment</button>
          : profile && <form className="market-form" onSubmit={(event) => { event.preventDefault(); void change(); }}>
            <label>Your public comment<textarea className="field-control" value={draft} required maxLength={600} rows={3} disabled={busy}
              onChange={(event) => setDraft(event.target.value)} /></label>
            <button className="reserve" disabled={busy || !draft.trim()}>Post comment</button>
          </form>)}
    </section>
  );
}

export function ListingDetail({ id, member, login, profile, editProfile, action }: {
  id: string; member: boolean; login: () => void; profile?: OwnProfile | null; editProfile: () => void; action: ListAction;
}) {
  const resource = useResource<ListingDetails>(`/listings/${id}`);
  const saved = useResource<{ saved: boolean }>(member && resource.data ? `/saved/${id}` : null, true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);
  const listing = resource.data;
  const own = Boolean(profile && listing?.seller?.id === profile.id);

  async function toggleSave() {
    if (!member) return login();
    if (pending.current || !saved.data) return;
    pending.current = true;
    setSaving(true);
    setError('');
    try {
      await marketRequest(`/saved/${id}`, { method: 'PUT', private: true, body: { saved: !saved.data.saved } });
      await saved.refresh();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      pending.current = false;
      setSaving(false);
    }
  }

  return (
    <div className="market-section">
      <a className="text-button" href="#marketplace">Back to marketplace</a>
      {resource.error && <section className={listing ? 'market-section' : 'panel market-panel market-empty'} aria-label="Listing error">
        {!listing && <h2>Listing unavailable</h2>}
        <Notice error={resource.error} />
        <Retry busy={resource.busy} retry={resource.refresh} label="Retry listing" />
      </section>}
      {resource.busy && !listing && <p role="status">Loading listing…</p>}
      {listing && <>
        <article className="panel market-panel market-listing-detail">
          <p className="market-kind">{categories[listing.kind]}</p>
          <h2>{listing.title}</h2>
          <p className="price">{listing.pricePaise ? <Rupees value={listing.pricePaise / 100} /> : 'Free'}</p>
          <p>Listed by <SellerLink seller={listing.seller} fallback="Campus seller" /></p>
          {listing.status === 'closed' && <p className="market-rating">{listing.completedAt ? 'Exchange completed' : 'Listing closed'}</p>}
          <section aria-labelledby="listing-description">
            <h3 id="listing-description">Description</h3>
            <p className="market-description">{listing.description}</p>
          </section>
          <dl className="market-facts">
            {listing.scope && <div><dt>What’s included</dt><dd className="market-description">{listing.scope}</dd></div>}
            {listing.condition && <div><dt>Condition</dt><dd>{conditions[listing.condition]}</dd></div>}
            <div><dt>Campus meetup area</dt><dd>{listing.meetup}</dd></div>
            {listing.availability && <div><dt>Availability</dt><dd>{listing.availability}</dd></div>}
          </dl>
          <Notice error={saved.error || error} />
          <div className="market-actions">
            {listing.status === 'active' && !own && <button type="button" className="reserve"
              onClick={() => member ? action('contact', listing) : login()}>Contact seller</button>}
            {(listing.status === 'active' || saved.data?.saved) && <button type="button" className="text-button"
              disabled={member && (!saved.data || saved.busy || saving)} onClick={() => void toggleSave()}>
              {saved.data?.saved ? 'Remove from saved' : 'Save listing'}
            </button>}
            {listing.status === 'active' && !own && <button type="button" className="text-button"
              onClick={() => member ? action('report', listing) : login()}>Report listing</button>}
          </div>
          {saved.error && <button type="button" className="text-button" onClick={() => void saved.refresh()}>Retry saved status</button>}
        </article>
        <ListingComments listing={listing} member={member} login={login} profile={profile} editProfile={editProfile} />
      </>}
    </div>
  );
}

export function ExchangePanel({ id, profile, editProfile }: { id: string; profile?: OwnProfile | null; editProfile: () => void }) {
  const path = `/threads/${id}`;
  const exchange = useResource<Exchange>(`${path}/exchange`, true);
  const [rating, setRating] = useState('');
  const [review, setReview] = useState('');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const refresh = exchange.refresh;
  useEffect(() => {
    const onFocus = () => { if (!pending.current) void refresh(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);
  async function submit(postReview = false) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    setStatus('');
    try {
      await marketRequest(`${path}/${postReview ? 'review' : 'exchange'}`, {
        private: true, method: postReview ? 'POST' : 'PUT',
        body: postReview ? { rating: Number(rating), text: review } : {},
      });
      setStatus(postReview ? 'Review published.' : 'Completion confirmed.');
      if (postReview) setReview('');
      await exchange.refresh();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  const state = exchange.data;
  return (
    <section className="market-exchange" aria-label="Exchange completion">
      <h3>Exchange completion</h3>
      <Notice error={exchange.error || error} />
      {status && <p role="status">{status}</p>}
      {state && <>
        <p className="hint">{!state.available ? 'This listing is unavailable.' : state.completed ? 'Both participants confirmed.' :
          state.confirmedByYou ? 'Waiting for the other participant.' : state.confirmedByOther ? 'The other participant confirmed.' :
            'Confirm once you have finished the exchange.'}</p>
        <div className="market-actions">
          {state.available && !state.confirmedByYou && <button type="button" className="text-button" disabled={busy}
            onClick={() => void submit()}>Confirm completed exchange</button>}
          {state.reviewed && <a className="text-button" href={sellerHref(state.seller)}>See seller reviews</a>}
        </div>
        {state.canReview && (profile === null ? <button type="button" className="text-button" onClick={editProfile}>Create a profile to review</button>
          : profile && <form className="market-form" onSubmit={(event) => { event.preventDefault(); void submit(true); }}>
            <label>Rating<select className="field-control" required value={rating} disabled={busy} onChange={(event) => setRating(event.target.value)}>
              <option value="">Choose a rating</option>
              {[5, 4, 3, 2, 1].map((value) => <option key={value} value={value}>{value} / 5</option>)}
            </select></label>
            <label>Public review<textarea className="field-control" required minLength={5} maxLength={800} rows={3} value={review} disabled={busy}
              onChange={(event) => setReview(event.target.value)} /></label>
            <button className="reserve" disabled={busy || !rating || review.trim().length < 5}>Publish review</button>
          </form>)}
      </>}
      <button type="button" className="text-button" disabled={busy || exchange.busy} onClick={() => void exchange.refresh()}>Refresh exchange</button>
    </section>
  );
}
