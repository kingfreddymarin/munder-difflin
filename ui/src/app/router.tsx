// Tiny hash router: #/chats?c=c-pm. Keeps deep links working in a desktop shell.
import * as React from 'react';
import type { RouteId } from '@/config/navigation';

type Route = { id: RouteId; params: URLSearchParams };

function parse(): Route {
  const [path, query] = window.location.hash.replace(/^#\/?/, '').split('?');
  const id = (path || 'home') as RouteId;
  return { id, params: new URLSearchParams(query ?? '') };
}

const RouterContext = React.createContext<{ route: Route; go: (id: RouteId, params?: Record<string, string>) => void } | null>(null);

export function RouterProvider({ children }: { children: React.ReactNode }) {
  const [route, setRoute] = React.useState(parse);
  React.useEffect(() => {
    const on = () => setRoute(parse());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const go = React.useCallback((id: RouteId, params?: Record<string, string>) => {
    const q = params ? `?${new URLSearchParams(params)}` : '';
    window.location.hash = `/${id}${q}`;
  }, []);
  return <RouterContext.Provider value={{ route, go }}>{children}</RouterContext.Provider>;
}

export function useRouter() {
  const r = React.useContext(RouterContext);
  if (!r) throw new Error('useRouter outside RouterProvider');
  return r;
}
