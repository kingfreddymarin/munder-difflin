// React binding for a DataProvider. Components read with useFloor(selector) and write with useDispatch().
import * as React from 'react';
import type { Command, DataProvider } from './protocol';
import { applyEvent } from './reducer';
import type { Snapshot } from './types';

type Store = {
  get: () => Snapshot | null;
  getError: () => string | null;
  getActionError: () => string | null;
  clearActionError: () => void;
  retry: () => void;
  start: () => () => void;
  subscribe: (fn: () => void) => () => void;
  dispatch: (c: Command) => Promise<boolean>;
};

const StoreContext = React.createContext<Store | null>(null);

export function FloorProvider({ provider, children, fallback }: { provider: DataProvider; children: React.ReactNode; fallback?: React.ReactNode }) {
  const store = React.useMemo<Store>(() => {
    let state: Snapshot | null = null;
    let error: string | null = null;
    let actionError: string | null = null;
    let active = false;
    let refreshVersion = 0;
    const subs = new Set<() => void>();
    const emit = () => subs.forEach((f) => f());
    const refresh = () => {
      const version = ++refreshVersion;
      provider.snapshot().then((s) => {
        if (!active || version !== refreshVersion) return;
        state = s;
        error = null;
        emit();
      }).catch((cause: unknown) => {
        if (!active || version !== refreshVersion) return;
        state = null;
        error = cause instanceof Error ? cause.message : 'Could not load the floor.';
        emit();
      });
    };
    return {
      get: () => state,
      getError: () => error,
      getActionError: () => actionError,
      clearActionError: () => { actionError = null; emit(); },
      retry: refresh,
      start: () => {
        active = true;
        refresh();
        const offEvents = provider.subscribe((ev) => {
          if (!state) return;
          state = applyEvent(state, ev);
          emit();
        });
        const offRefresh = (provider as DataProvider & { onRefresh?: (listener: () => void) => () => void }).onRefresh?.(refresh);
        return () => { active = false; refreshVersion++; offEvents(); offRefresh?.(); };
      },
      subscribe: (fn) => {
        subs.add(fn);
        return () => subs.delete(fn);
      },
      dispatch: async (c) => {
        try {
          await provider.dispatch(c);
          actionError = null;
          emit();
          return true;
        } catch (cause) {
          actionError = cause instanceof Error ? cause.message : 'The command failed.';
          emit();
          return false;
        }
      },
    };
  }, [provider]);
  React.useEffect(() => store.start(), [store]);
  const status = React.useSyncExternalStore(store.subscribe, () => store.get() ? 'ready' : store.getError() ? 'error' : 'loading');
  const actionError = React.useSyncExternalStore(store.subscribe, store.getActionError);
  return <StoreContext.Provider value={store}>{status === 'ready' ? children : status === 'error' ? (
    <div role="alert" className="p-8 text-sm">
      <p>{store.getError()}</p>
      <button type="button" onClick={store.retry} className="mt-3 rounded border px-3 py-2">Retry connection</button>
    </div>
  ) : fallback}{actionError && <div role="alert" className="fixed bottom-4 right-4 z-50 max-w-sm rounded-lg border border-destructive bg-background p-3 text-sm shadow-lg">
    <span>{actionError}</span>
    <button type="button" onClick={store.clearActionError} className="ml-3 underline">Dismiss</button>
  </div>}</StoreContext.Provider>;
}

function useStore() {
  const s = React.useContext(StoreContext);
  if (!s) throw new Error('useFloor must be used inside <FloorProvider>');
  return s;
}

export function useFloor<T>(select: (s: Snapshot) => T): T {
  const store = useStore();
  return React.useSyncExternalStore(store.subscribe, () => select(store.get() as Snapshot));
}

export function useDispatch() {
  return useStore().dispatch;
}

export function useAgent(id: string | undefined) {
  return useFloor((s) => s.agents.find((a) => a.id === id));
}
