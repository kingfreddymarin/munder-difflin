import * as React from 'react';
import { Button } from '@/components/animate-ui/components/buttons/button';
import { Badge } from '@/components/ui/badge';
import { useDispatch } from '@/data/store';
import { findBridge } from '@/data/bridge';
import type { FloorOverview, FloorOverviewRow } from '../../../src/shared/floor-overview';

const REFRESH_MS = 3_000;

export function FloorOverviewPage({ back }: { back: () => void }) {
  const dispatch = useDispatch();
  const [floors, setFloors] = React.useState<FloorOverview[] | null>(null);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [loadError, setLoadError] = React.useState(false);
  const [focusError, setFocusError] = React.useState(false);
  const [focusing, setFocusing] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    let pending = false;
    const update = async () => {
      if (pending || document.visibilityState === 'hidden') return;
      pending = true;
      try {
        const next = await findBridge()?.listFloorViews?.();
        if (cancelled) return;
        if (!next) throw new Error('Floor views are unavailable');
        setFloors(next);
        setSelected(previous => previous && next.some(floor => floor.id === previous) ? previous : null);
        setLoadError(false);
      } catch {
        if (!cancelled) { setFloors(null); setLoadError(true); }
      } finally { pending = false; }
    };
    void update();
    const timer = window.setInterval(() => void update(), REFRESH_MS);
    document.addEventListener('visibilitychange', update);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', update);
    };
  }, []);

  const openControls = async (floor: FloorOverview) => {
    if (floor.current) { back(); return; }
    setFocusError(false);
    setFocusing(true);
    try { setFocusError(!await findBridge()?.focusFloorView?.(floor.id)); }
    catch { setFocusError(true); }
    finally { setFocusing(false); }
  };

  return <FloorOverviewContent floors={floors} selected={selected}
    select={id => { setFocusError(false); setSelected(id); }} back={back}
    newFloor={() => void dispatch({ type: 'floor.picker', open: true })}
    openControls={floor => void openControls(floor)} loadError={loadError} focusError={focusError} focusing={focusing} />;
}

export function FloorOverviewContent({ floors, selected, select, back, newFloor, openControls, loadError, focusError, focusing }: {
  floors: FloorOverview[] | null;
  selected: string | null;
  select(id: string | null): void;
  back(): void;
  newFloor(): void;
  openControls(floor: FloorOverview): void;
  loadError: boolean;
  focusError: boolean;
  focusing: boolean;
}) {
  const active = floors?.find(floor => floor.id === selected);
  const shown = active ? [active] : floors ?? [];
  const nameCounts = new Map<string, number>();
  for (const floor of floors ?? []) nameCounts.set(floor.name, (nameCounts.get(floor.name) ?? 0) + 1);
  return <main className="bg-background text-foreground min-h-[calc(100vh-2rem)] px-6 pb-5">
    <div aria-hidden className="app-drag h-8" />
    <div className="mx-auto max-w-6xl space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{active?.name ?? 'All floors'}</h1>
          <p className="text-muted-foreground break-all text-sm">{active?.home ?? 'Agents and tasks across open Paramount floors.'}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={back}>Back to this floor</Button>
          <Button onClick={newFloor}>New floor…</Button>
        </div>
      </header>
      <nav aria-label="Floor views" className="flex flex-wrap gap-2 border-b pb-3">
        <Button variant={active ? 'ghost' : 'secondary'} aria-current={active ? undefined : 'page'} onClick={() => select(null)}>All floors</Button>
        {floors?.map(floor => <Button key={floor.id} title={floor.home} aria-label={floor.name + ' — ' + floor.home}
          variant={floor.id === active?.id ? 'secondary' : 'ghost'}
          aria-current={floor.id === active?.id ? 'page' : undefined}
          className="h-auto max-w-full whitespace-normal"
          onClick={() => select(floor.id)}>
          <span className="min-w-0 break-all">{(nameCounts.get(floor.name) ?? 0) > 1 ? floor.home : floor.name}{floor.current && ' (this window)'}</span>
        </Button>)}
      </nav>
      {loadError ? <p role="alert" className="text-sm">Floor views are unavailable. Retrying…</p>
        : !floors ? <p role="status" className="text-sm">Loading floors…</p>
        : !shown.length && <p className="text-muted-foreground text-sm">No open Paramount floors are available yet.</p>}
      {focusError && <p role="alert" className="text-destructive text-sm">Could not open that floor’s window. It may have closed.</p>}
      {shown.map(floor => <section key={floor.id} aria-label={'Floor ' + floor.home} className="bg-card space-y-4 rounded-xl border p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          {!active && <div className="min-w-0">
            <h2 className="font-semibold">{floor.name}</h2>
            <p className="text-muted-foreground break-all text-xs">{floor.home}</p>
          </div>}
          <Button variant="outline" size="sm" disabled={focusing} onClick={() => openControls(floor)}>Open floor controls</Button>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <FloorRows rows={floor.agents} title="Agents" />
          <FloorRows rows={floor.tasks} title="Tasks" showId />
        </div>
      </section>)}
    </div>
  </main>;
}

function FloorRows({ rows, title, showId = false }: { rows: FloorOverviewRow[]; title: string; showId?: boolean }) {
  return <div className="min-w-0 rounded-lg border p-3">
    <h3 className="mb-2 font-medium">{title} <span className="text-muted-foreground text-sm">{rows.length}</span></h3>
    {rows.length ? <ul className="max-h-96 divide-y overflow-auto">
      {rows.map(row => <li key={row.id} className="flex items-start justify-between gap-3 py-2 text-sm">
        <span className="min-w-0 break-words">{showId && <span className="text-muted-foreground mr-2 text-xs">{row.id}</span>}{row.label}</span>
        <Badge variant="outline" className="capitalize">{row.status}</Badge>
      </li>)}
    </ul> : <p className="text-muted-foreground text-sm">No {title.toLowerCase()}.</p>}
  </div>;
}
