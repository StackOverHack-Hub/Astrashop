import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { getItems, type Item } from './api';
import { Shop } from './Shop';
import { Student } from './Student';
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
      <header className="masthead">
        <div className="shell masthead-inner">
          <a className="wordmark" href="#" aria-label="Astrashop home"><span aria-hidden="true">A</span>Astrashop</a>
          <nav aria-label="Main navigation" className="navigation">
            <a href="#" aria-current={!shop ? 'page' : undefined}>Student</a>
            <a href="#shop" aria-current={shop ? 'page' : undefined}>Shop</a>
          </nav>
        </div>
      </header>
      <main className="shell content">
        <div hidden={shop}><Student catalog={catalog} active={!shop} /></div>
        {shop && <Shop catalog={catalog} />}
      </main>
    </>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
