// React binding for a DataProvider. Components read with useFloor(selector) and write with useDispatch().
import * as React from 'react';
import type { Command, DataProvider } from './protocol';
import { applyEvent } from './reducer';
import type { Snapshot } from './types';

type Store = {
  get: () => Snapshot | null;
  subscribe: (fn: () => void) => () => void;
  dispatch: (c: Command) => Promise<void>;
};

const StoreContext = React.createContext<Store | null>(null);

export function FloorProvider({ provider, children, fallback }: { provider: DataProvider; children: React.ReactNode; fallback?: React.ReactNode }) {
  const store = React.useMemo<Store>(() => {
    let state: Snapshot | null = null;
    const subs = new Set<() => void>();
    const emit = () => subs.forEach((f) => f());
    provider.snapshot().then((s) => {
      state = s;
      emit();
    });
    provider.subscribe((ev) => {
      if (!state) return;
      state = applyEvent(state, ev);
      emit();
    });
    return {
      get: () => state,
      subscribe: (fn) => {
        subs.add(fn);
        return () => subs.delete(fn);
      },
      dispatch: async (c) => {
        await provider.dispatch(c);
      },
    };
  }, [provider]);
  const ready = React.useSyncExternalStore(store.subscribe, () => store.get() !== null);
  return <StoreContext.Provider value={store}>{ready ? children : fallback}</StoreContext.Provider>;
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
