// React binding for a DataProvider. Components read with useFloor(selector) and write with useDispatch().
// Every backend call has an explicit state: loading, error, disconnected (snapshot) and pending/error (commands).
// Failures are kept as BackendError so the UI always shows {errorId, code, message}.
import * as React from 'react';
import { Button } from '@/components/ui/button';
import { ErrorNotice } from '@/components/app/error-notice';
import { BackendError, toBackendError } from './errors';
import type { Command, DataProvider } from './protocol';
import { applyEvent } from './reducer';
import { share } from './share';
import { record } from '@/lib/perf';
import { exportDiagnostics } from '@/lib/diagnostics-file';
import type { Snapshot } from './types';

export type FloorStatus = 'loading' | 'ready' | 'error' | 'disconnected';
export const LIVE_REFRESH_MS = 4000;
export type DiagnosticsState = { status: 'idle' | 'loading' | 'copied' | 'saved' | 'canceled' | 'error'; error?: BackendError; path?: string };

type Store = {
  provider: DataProvider;
  get: () => Snapshot | null;
  getError: () => BackendError | null;
  getActionError: () => BackendError | null;
  getPending: () => number;
  getUnsupported: () => ReadonlyMap<string, string>;
  /** When the last snapshot arrived (ms); 0 before the first. */
  getRefreshedAt: () => number;
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
    let error: BackendError | null = null;
    let actionError: BackendError | null = null;
    let pending = 0;
    // Command types the core answered UNSUPPORTED to; their controls stay disabled with the core's reason.
    let unsupported: ReadonlyMap<string, string> = new Map();
    let active = false;
    let refreshVersion = 0;
    let refreshedAt = 0;
    // One snapshot request at a time: a burst of invalidations becomes one request now and one after it.
    let inFlight = false;
    let again = false;
    const subs = new Set<() => void>();
    const emit = () => subs.forEach((f) => f());
    const refresh = () => {
      if (inFlight) { again = true; return; }
      inFlight = true;
      const version = ++refreshVersion;
      if (!state) { error = null; emit(); }
      const started = performance.now();
      provider.snapshot().then((s) => {
        if (!active || version !== refreshVersion) return;
        record('snapshot', performance.now() - started);
        const next = state ? share(state, s) : s;
        if (next === state && !error) { refreshedAt = Date.now(); emit(); return; }
        state = next;
        error = null;
        refreshedAt = Date.now();
        emit();
      }).catch((cause: unknown) => {
        if (!active || version !== refreshVersion) return;
        state = null;
        error = toBackendError(cause, 'snapshot');
        emit();
      }).finally(() => {
        inFlight = false;
        if (again && active) { again = false; refresh(); }
      });
    };
    return {
      provider,
      get: () => state,
      getError: () => error,
      getActionError: () => actionError,
      getPending: () => pending,
      getUnsupported: () => unsupported,
      getRefreshedAt: () => refreshedAt,
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
        const offRefresh = provider.onRefresh?.(refresh);
        return () => { active = false; refreshVersion++; offEvents(); offRefresh?.(); };
      },
      subscribe: (fn) => {
        subs.add(fn);
        return () => subs.delete(fn);
      },
      dispatch: async (c) => {
        pending++;
        emit();
        try {
          await provider.dispatch(c);
          actionError = null;
          return true;
        } catch (cause) {
          actionError = toBackendError(cause, c.type);
          if (actionError.code === 'UNSUPPORTED') unsupported = new Map(unsupported).set(unsupportedKey(c), actionError.message);
          if (actionError.code === 'DISCONNECTED') refresh();
          return false;
        } finally {
          pending--;
          emit();
        }
      },
    };
  }, [provider]);
  React.useEffect(() => store.start(), [store]);
  const status = React.useSyncExternalStore(store.subscribe, (): FloorStatus => store.get() ? 'ready' : !store.getError() ? 'loading' : store.getError()?.code === 'DISCONNECTED' ? 'disconnected' : 'error');
  const actionError = React.useSyncExternalStore(store.subscribe, store.getActionError);
  const pending = React.useSyncExternalStore(store.subscribe, store.getPending);
  return <StoreContext.Provider value={store}>{status === 'ready' ? children : status === 'loading' ? fallback : (
    <div className="flex max-w-xl flex-col gap-3 p-8">
      <h1 className="text-lg font-semibold">{status === 'disconnected' ? 'Not connected to the desktop core' : 'Could not load the floor'}</h1>
      <ErrorNotice error={store.getError()} />
      <div className="flex gap-2">
        <Button type="button" variant="outline" onClick={store.retry}>Retry connection</Button>
        <CopyDiagnosticsButton />
      </div>
    </div>
  )}{(actionError || pending > 0) && <div className="fixed bottom-4 right-4 z-50 flex max-w-sm flex-col gap-2">
    {pending > 0 && <span role="status" className="bg-background self-end rounded-lg border px-3 py-1.5 text-xs shadow-lg">Sending to the core…</span>}
    {actionError && <ErrorNotice error={actionError} className="bg-background shadow-lg">
      <div className="flex gap-2 pt-1">
        <Button type="button" size="sm" variant="ghost" onClick={store.clearActionError}>Dismiss</Button>
        <CopyDiagnosticsButton size="sm" />
      </div>
    </ErrorNotice>}
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

/**
 * Re-reads the snapshot every `ms` while the window is visible, for views that must stay live
 * (Home's agent activity). The core only pushes invalidations for mail and spawns, not for every
 * log line, so this is what keeps activity current. Mock data never changes, so it does not poll.
 * Returns when the last snapshot arrived.
 */
export function useLiveRefresh(ms: number) {
  const store = useStore();
  React.useEffect(() => {
    if (store.provider.kind !== 'electron') return;
    const tick = () => { if (document.visibilityState === 'visible') store.retry(); };
    const timer = window.setInterval(tick, ms);
    document.addEventListener('visibilitychange', tick);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', tick); };
  }, [store, ms]);
  return React.useSyncExternalStore(store.subscribe, store.getRefreshedAt);
}

/** Re-runs the core snapshot probes and reports when a response actually arrived. */
export function useSnapshotRefresh() {
  const store = useStore();
  const refreshedAt = React.useSyncExternalStore(store.subscribe, store.getRefreshedAt);
  return { refresh: store.retry, refreshedAt };
}

/** The last command the core refused (code, message, errorId); cleared by the next success. */
export function useActionError() {
  const store = useStore();
  const error = React.useSyncExternalStore(store.subscribe, store.getActionError);
  return { error, clear: store.clearActionError };
}

/** agent.update is learned per field: the core refusing one field must not disable the others. */
function unsupportedKey(c: Command): string {
  return c.type === 'agent.update' ? `agent.update:${Object.keys(c.patch).sort().join(',')}` : c.type;
}

/** Why the core cannot run this command (known up front or learned from an UNSUPPORTED answer), else null. */
export function useUnsupported() {
  const store = useStore();
  const learned = React.useSyncExternalStore(store.subscribe, store.getUnsupported);
  return React.useCallback((command: Command) => learned.get(unsupportedKey(command)) ?? store.provider.unsupported?.(command) ?? null, [learned, store]);
}

/** The provider's agent discovery and import, or null when it has none (the control is then disabled with a reason). */
export function useAgentImport() {
  const { provider } = useStore();
  return React.useMemo(() => provider.discoverAgents && provider.importAgent
    ? { discover: provider.discoverAgents.bind(provider), importAgent: provider.importAgent.bind(provider) }
    : null, [provider]);
}

/** The provider's link and folder openers; each is null when the provider cannot do it (the control then says why). */
export function useOpeners() {
  const { provider } = useStore();
  return React.useMemo(() => ({
    openExternal: provider.openExternal?.bind(provider) ?? null,
    openIn: provider.openIn?.bind(provider) ?? null,
  }), [provider]);
}

/** The provider's Team calls (model catalog, Add-Agent hire), or null when it has none. */
export function useTeamApi() {
  const { provider } = useStore();
  return React.useMemo(() => provider.teamModels && provider.hire
    ? { models: provider.teamModels.bind(provider), hire: provider.hire.bind(provider), organization: provider.organization?.bind(provider), saveOrganization: provider.saveOrganization?.bind(provider), delegate: provider.delegate?.bind(provider), archiveAgent: provider.archiveAgent?.bind(provider), sendNote: provider.sendNote?.bind(provider), startEngineSignIn: provider.startEngineSignIn?.bind(provider), refreshEngineSignIn: provider.refreshEngineSignIn?.bind(provider) }
    : null, [provider]);
}

/** Lane e-terminal: the provider's artifact map and open-in-Warp, or null each when it has none. */
export function useTerminalTools() {
  const { provider } = useStore();
  return React.useMemo(() => ({
    artifacts: provider.artifacts ? provider.artifacts.bind(provider) : null,
    openIn: provider.openIn ? provider.openIn.bind(provider) : null,
  }), [provider]);
}

/** Fetches the redacted `diagnostics.bundle` and puts it on the clipboard. */
export function useDiagnostics() {
  const { provider } = useStore();
  const [state, setState] = React.useState<DiagnosticsState>({ status: 'idle' });
  const available = !!provider.diagnostics;
  const copy = React.useCallback(async () => {
    if (!provider.diagnostics) return;
    setState({ status: 'loading' });
    try {
      const bundle = await provider.diagnostics();
      await navigator.clipboard.writeText(JSON.stringify(bundle, null, 2));
      setState({ status: 'copied' });
    } catch (cause) {
      setState({ status: 'error', error: toBackendError(cause, 'diagnostics.bundle') });
    }
  }, [provider]);
  const save = React.useCallback(async () => {
    if (!provider.saveDiagnostics) return;
    const saveDiagnostics = provider.saveDiagnostics.bind(provider);
    setState({ status: 'loading' });
    try {
      const result = await exportDiagnostics(saveDiagnostics);
      setState(result.status === 'saved' ? { status: 'saved', path: result.path } : { status: 'canceled' });
    } catch (cause) {
      setState({ status: 'error', error: toBackendError(cause, 'diagnostics.save') });
    }
  }, [provider]);
  return { ...state, available, canSave: !!provider.saveDiagnostics, copy, save };
}

export function CopyDiagnosticsButton({ size, variant = 'outline' }: { size?: 'sm'; variant?: 'outline' | 'ghost' }) {
  const diagnostics = useDiagnostics();
  const label = diagnostics.status === 'loading' ? 'Collecting…' : diagnostics.status === 'copied' ? 'Diagnostics copied' : 'Copy diagnostics';
  return <span className="inline-flex flex-col gap-2">
    <Button type="button" size={size} variant={variant} disabled={!diagnostics.available || diagnostics.status === 'loading'}
      title={diagnostics.available ? 'Copy a redacted support bundle (app, OS, config, recent log lines, crashes)' : 'Diagnostics need the desktop core; sample data has none.'}
      onClick={() => void diagnostics.copy()}>{label}</Button>
    {diagnostics.error && <ErrorNotice error={diagnostics.error} />}
  </span>;
}

export function ExportDiagnosticsButton() {
  const diagnostics = useDiagnostics();
  const label = diagnostics.status === 'loading' ? 'Saving…' : diagnostics.status === 'saved' ? 'Diagnostics saved' : 'Export diagnostics';
  return <span className="inline-flex flex-col gap-2">
    <Button type="button" disabled={!diagnostics.canSave || diagnostics.status === 'loading'}
      title={diagnostics.canSave ? 'Save the redacted support bundle as a JSON file' : 'Diagnostics need the desktop core; sample data has none.'}
      onClick={() => void diagnostics.save()}>{label}</Button>
    {diagnostics.status === 'saved' && diagnostics.path && <span role="status" className="text-muted-foreground text-xs break-all">Saved to {diagnostics.path}</span>}
    {diagnostics.status === 'canceled' && <span role="status" className="text-muted-foreground text-xs">Export canceled; nothing was saved.</span>}
    {diagnostics.error && <ErrorNotice error={diagnostics.error} />}
  </span>;
}
