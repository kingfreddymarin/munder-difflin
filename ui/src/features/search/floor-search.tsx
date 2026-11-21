import * as React from 'react';
import { useFloor } from '@/data/store';
import { useRouter } from '@/app/router';
import { buildSearchIndex, filterResults, groupResults } from './search-index';
import type { SearchResult } from './search-index';
import { Dialog, DialogContent, DialogTitle } from '@/components/animate-ui/components/radix/dialog';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import type { RouteId } from '@/config/navigation';

interface FloorSearchProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function FloorSearch({ open, onOpenChange }: FloorSearchProps) {
  const { go } = useRouter();
  const agents = useFloor((s) => s.agents);
  const cards = useFloor((s) => s.cards);
  const automations = useFloor((s) => s.automations);

  const [query, setQuery] = React.useState('');
  const [cursor, setCursor] = React.useState(0);
  const listRef = React.useRef<HTMLDivElement>(null);

  const index = React.useMemo(
    () => buildSearchIndex(agents, cards, automations),
    [agents, cards, automations],
  );

  const results = React.useMemo(() => filterResults(index, query), [index, query]);
  const groups = React.useMemo(() => groupResults(results), [results]);

  const select = React.useCallback(
    (item: SearchResult) => {
      go(item.route as RouteId, item.params);
      onOpenChange(false);
    },
    [go, onOpenChange],
  );

  React.useEffect(() => {
    if (open) {
      setQuery('');
      setCursor(0);
    }
  }, [open]);

  React.useEffect(() => {
    setCursor((c) => Math.max(0, Math.min(c, results.length - 1)));
  }, [results.length]);

  // Scroll active item into view
  React.useEffect(() => {
    const el = listRef.current?.querySelector('[data-active="true"]');
    el?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (e.key === 'Enter') {
      const item = results[cursor];
      if (item) select(item);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="top-[15%] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-xl"
        aria-label="Search the floor"
      >
        <DialogTitle className="sr-only">Search the floor</DialogTitle>
        <div className="border-b px-3 py-2">
          <Input
            autoFocus
            placeholder="Search agents, tasks, automations, settings…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setCursor(0);
            }}
            onKeyDown={onKeyDown}
            className="border-0 shadow-none focus-visible:ring-0"
            aria-label="Search"
            aria-controls="floor-search-results"
            aria-activedescendant={results[cursor] ? `fsr-${results[cursor].id}` : undefined}
          />
        </div>

        <div
          id="floor-search-results"
          role="listbox"
          aria-label="Search results"
          ref={listRef}
          className="max-h-96 overflow-y-auto overscroll-contain"
        >
          {results.length === 0 ? (
            <p className="text-muted-foreground px-4 py-8 text-center text-sm">
              {query.trim() ? 'No results.' : 'Start typing to search…'}
            </p>
          ) : (
            groups.map((group) => {
              let flatOffset = results.indexOf(group.results[0]);
              return (
                <div key={group.kind} role="group" aria-label={group.label}>
                  <div className="text-muted-foreground sticky top-0 bg-background/95 px-3 py-1.5 text-xs font-medium backdrop-blur">
                    {group.label}
                  </div>
                  {group.results.map((item) => {
                    const idx = flatOffset++;
                    const active = idx === cursor;
                    return (
                      <button
                        key={item.id}
                        id={`fsr-${item.id}`}
                        role="option"
                        aria-selected={active}
                        data-active={active}
                        onClick={() => select(item)}
                        onMouseEnter={() => setCursor(idx)}
                        className={cn(
                          'flex w-full cursor-default items-center gap-3 px-3 py-2 text-left text-sm',
                          active ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
                        )}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium">{item.label}</span>
                          {item.detail && (
                            <span className="text-muted-foreground block truncate text-xs">
                              {item.detail}
                            </span>
                          )}
                        </span>
                      </button>
                    );
                  })}
                </div>
              );
            })
          )}
        </div>

        <div className="text-muted-foreground border-t px-3 py-1.5 text-xs">
          <span className="mr-3">↑↓ navigate</span>
          <span className="mr-3">↵ open</span>
          <span>Esc close</span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
