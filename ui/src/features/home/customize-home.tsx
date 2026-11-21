// Home's "Customize": which tiles show, their order and size, and the spacing between them.
// Saved by the core (home.layout) so the layout follows the human across restarts.
import { Popover, PopoverContent, PopoverTrigger } from '@/components/animate-ui/components/radix/popover';
import { Button } from '@/components/animate-ui/components/buttons/button';
import { SlidersHorizontal } from '@/components/animate-ui/icons/sliders-horizontal';
import { cn } from '@/lib/utils';
import type { HomeDensity, HomeLayout, TileSize } from '@/data/types';

export type HomeTileId = 'objectives' | 'asks' | 'activity' | 'closed' | 'wins';
export const HOME_TILES: { id: HomeTileId; label: string; size: TileSize }[] = [
  { id: 'objectives', label: 'Main objectives', size: 'md' },
  { id: 'asks', label: 'Ask me', size: 'md' },
  { id: 'activity', label: 'Agent activity', size: 'md' },
  { id: 'closed', label: 'Recently closed', size: 'sm' },
  { id: 'wins', label: 'What went well', size: 'sm' },
];
const DENSITIES: { value: HomeDensity; label: string }[] = [{ value: 'compact', label: 'Compact' }, { value: 'comfortable', label: 'Comfortable' }, { value: 'spacious', label: 'Spacious' }];
const SIZES: { value: TileSize; label: string }[] = [{ value: 'sm', label: 'S' }, { value: 'md', label: 'M' }, { value: 'lg', label: 'L' }];

/** The tiles in the saved order (unknown ids dropped, new tiles appended), each with its size and visibility. */
export function resolveTiles(layout: HomeLayout | undefined) {
  const known = new Map(HOME_TILES.map((t) => [t.id, t]));
  const order = [...(layout?.order ?? []).filter((id): id is HomeTileId => known.has(id as HomeTileId)), ...HOME_TILES.map((t) => t.id)];
  return [...new Set(order)].map((id) => {
    const saved = layout?.tiles?.[id];
    return { id, label: known.get(id)!.label, size: saved?.size ?? known.get(id)!.size, hidden: saved?.hidden === true };
  });
}

function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="bg-muted inline-flex rounded-md p-0.5">
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} onClick={() => onChange(o.value)}
          className={cn('rounded px-2 py-0.5 text-xs', value === o.value ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function CustomizeHome({ layout, onChange }: { layout: HomeLayout | undefined; onChange: (layout: HomeLayout) => void }) {
  const tiles = resolveTiles(layout);
  const setTile = (id: HomeTileId, patch: { size?: TileSize; hidden?: boolean }) =>
    onChange({ tiles: { ...layout?.tiles, [id]: { ...layout?.tiles?.[id], ...patch } } });
  const move = (index: number, by: -1 | 1) => {
    const order = tiles.map((t) => t.id);
    const j = index + by;
    if (j < 0 || j >= order.length) return;
    [order[index], order[j]] = [order[j], order[index]];
    onChange({ order });
  };
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" className="h-12 gap-2"><SlidersHorizontal className="size-4" />Customize</Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="flex w-80 flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium">Spacing</span>
          <Segmented label="Spacing" value={layout?.density ?? 'comfortable'} options={DENSITIES} onChange={(density) => onChange({ density })} />
        </div>
        <ul className="flex flex-col gap-1.5" aria-label="Tiles">
          {tiles.map((t, i) => (
            <li key={t.id} className="flex items-center gap-2">
              <input type="checkbox" checked={!t.hidden} onChange={(e) => setTile(t.id, { hidden: !e.target.checked })} aria-label={`Show ${t.label}`} className="accent-primary" />
              <span className={cn('flex-1 truncate text-sm', t.hidden && 'text-muted-foreground line-through')}>{t.label}</span>
              <Segmented label={`${t.label} size`} value={t.size} options={SIZES} onChange={(size) => setTile(t.id, { size })} />
              <span className="flex">
                <button type="button" aria-label={`Move ${t.label} up`} disabled={i === 0} onClick={() => move(i, -1)} className="text-muted-foreground hover:text-foreground px-1 disabled:opacity-30">↑</button>
                <button type="button" aria-label={`Move ${t.label} down`} disabled={i === tiles.length - 1} onClick={() => move(i, 1)} className="text-muted-foreground hover:text-foreground px-1 disabled:opacity-30">↓</button>
              </span>
            </li>
          ))}
        </ul>
        <span className="text-muted-foreground text-[11px]">Saved to this floor's preferences; it survives restarts.</span>
      </PopoverContent>
    </Popover>
  );
}
