import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { getItems, type Item } from './api';
import { Shop } from './Shop';
import { Student } from './Student';
import '@fontsource-variable/bricolage-grotesque/opsz.css';
import './styles.css';

export type Catalog = {
  items: Item[];
  loading: boolean;
  error: string;
  refresh: () => Promise<void>;
};

function App() {
  const [shop, setShop] = useState(() => window.location.hash === '#shop');
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const latestRequest = useRef(0);

  useEffect(() => {
    const syncScreen = () => setShop(window.location.hash === '#shop');
    window.addEventListener('hashchange', syncScreen);
    return () => window.removeEventListener('hashchange', syncScreen);
  }, []);

  const refresh = useCallback(async () => {
    const id = ++latestRequest.current;
    setLoading(true);
    try {
      const updated = await getItems();
      if (id !== latestRequest.current) return;
      setItems(updated);
      setError('');
    } catch (error) {
      if (id === latestRequest.current) setError((error as Error).message);
    } finally {
      if (id === latestRequest.current) setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const catalog = { items, loading, error, refresh };
  return (
    <>
      {/* Moves focus instead of changing the hash, which picks the screen. */}
      <a className="skip-link" href="#main" onClick={(event) => {
        event.preventDefault();
        document.getElementById('main')?.focus();
      }}>Skip to content</a>
      <header className="masthead shell">
        <a className="wordmark" href="#" aria-label="Astrashop, find supplies">
          <svg viewBox="0 0 24 24" aria-hidden="true" className="mark">
            <rect x="2.5" y="2.5" width="19" height="19" rx="3" fill="#fff" stroke="currentColor" strokeWidth="1.5" />
            <path d="M3 9h18M3 13h18M3 17h18" stroke="#9fb3d9" strokeWidth="1" />
            <path d="M7.5 3v18" stroke="#c9483f" strokeWidth="1.5" />
          </svg>
          astrashop
        </a>
        <nav aria-label="Main navigation" className="navigation">
          <a href="#" aria-current={!shop ? 'page' : undefined}>Find supplies</a>
          <a href="#shop" aria-current={shop ? 'page' : undefined}>Shop counter</a>
        </nav>
      </header>
      <main id="main" tabIndex={-1} className="shell content">
        <div hidden={shop}><Student catalog={catalog} active={!shop} /></div>
        {shop && <Shop catalog={catalog} />}
      </main>
    </>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
