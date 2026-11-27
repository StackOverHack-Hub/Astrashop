type Runtime = {
  apiUrl?: string;
  marketplaceApiUrl?: string;
  loginOrigin?: string;
  clientId?: string;
  demoAuth?: boolean;
};

declare global {
  interface Window { __ASTRASHOP_CONFIG__?: Runtime }
}

// The container serves public settings before the application bundle. Vite and
// Amplify builds can still use the existing build-time environment variables.
export const runtime = window.__ASTRASHOP_CONFIG__ ?? {};
