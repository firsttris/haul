import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MutationCache, QueryCache, QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { Outlet, RouterProvider, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './styles.css';
import { ApiError, api, type AuthState } from './api';
import { useLiveEvents } from './live';
import { Layout } from './components/Layout';
import { Login } from './routes/Login';
import { DownloadsPage } from './routes/Downloads';
import { CollectorPage } from './routes/Collector';
import { AccountsPage } from './routes/Accounts';
import { SettingsPage } from './routes/Settings';
import { DonePage } from './routes/Done';

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
  useLiveEvents(loggedIn);
  if (auth.isPending) return null;
  if (auth.isError) return <div className="login"><div className="notice">Server nicht erreichbar: {auth.error.message}</div></div>;
  if (!loggedIn) return <Login setup={!!auth.data?.setupRequired} />;
  return (
    <Layout>
      <Outlet />
    </Layout>
  );
}

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
