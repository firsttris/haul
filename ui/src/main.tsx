import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MutationCache, QueryCache, QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { Outlet, RouterProvider, createRootRoute, createRoute, createRouter, lazyRouteComponent } from '@tanstack/react-router';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './styles.css';
import { ApiError, api, type AuthState } from './api';
import { useLiveEvents } from './live';
import { Layout } from './components/Layout';
import { Login } from './routes/Login';
import { useLang } from './i18n';
import * as m from './paraglide/messages';

const onAuthError = (err: unknown) => {
  if (err instanceof ApiError && err.status === 401) queryClient.invalidateQueries({ queryKey: ['auth'] });
};

const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: onAuthError }),
  mutationCache: new MutationCache({ onError: onAuthError }),
  defaultOptions: { queries: { staleTime: 5_000, retry: (n, err) => !(err instanceof ApiError && err.status === 401) && n < 2 } },
});

function Root() {
  const auth = useQuery({ queryKey: ['auth'], queryFn: () => api<AuthState>('/auth/state'), staleTime: Infinity });
  const loggedIn = !!auth.data?.loggedIn;
  // Remounting on a language change re-renders every text, also those only formatted (numbers, dates).
  const lang = useLang();
  useLiveEvents(loggedIn);
  if (auth.isPending) return null;
  if (auth.isError) return <div className="login"><div className="notice">{m.app_serverUnreachable({ error: auth.error.message })}</div></div>;
  if (!loggedIn) return <Login setup={!!auth.data?.setupRequired} />;
  return (
    <Layout key={lang}>
      <Outlet />
    </Layout>
  );
}

// Each page is its own chunk (the table code only comes with the pages that use it); the router
// loads it before it renders the route.
const DownloadsPage = lazyRouteComponent(() => import('./routes/Downloads'), 'DownloadsPage');
const CollectorPage = lazyRouteComponent(() => import('./routes/Collector'), 'CollectorPage');
const AccountsPage = lazyRouteComponent(() => import('./routes/Accounts'), 'AccountsPage');
const SettingsPage = lazyRouteComponent(() => import('./routes/Settings'), 'SettingsPage');
const DonePage = lazyRouteComponent(() => import('./routes/Done'), 'DonePage');

const rootRoute = createRootRoute({ component: Root });
const routeTree = rootRoute.addChildren([
  createRoute({ getParentRoute: () => rootRoute, path: '/', component: DownloadsPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/linksammler', component: CollectorPage }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/fertig',
    component: DonePage,
    validateSearch: (s: Record<string, unknown>) => ({ path: typeof s.path === 'string' ? s.path : '' }),
  }),
  createRoute({ getParentRoute: () => rootRoute, path: '/accounts', component: AccountsPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/einstellungen', component: SettingsPage }),
]);
const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
