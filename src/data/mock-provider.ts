// In-browser stand-in for the core. Same interface as the real WebSocket provider:
// commands in, events out. Events are kept in localStorage so your changes survive a reload.
import { fixtures } from './fixtures';
import type { Command, DataProvider, FloorEvent } from './protocol';
import { applyEvent } from './reducer';
import type { Snapshot } from './types';

const KEY = 'paramount.mock.events.v1';

function loadEvents(): FloorEvent[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '[]') as FloorEvent[];
  } catch {
    return [];
  }
}
function saveEvents(events: FloorEvent[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(events.slice(-500)));
  } catch {
    /* storage unavailable: changes stay in memory for this session */
  }
}

export function createMockProvider(): DataProvider {
  const listeners = new Set<(e: FloorEvent) => void>();
  let events = loadEvents();
  let seq = events.length;
  return {
    kind: 'mock',
    async snapshot(): Promise<Snapshot> {
      return events.reduce(applyEvent, structuredClone(fixtures));
    },
    async dispatch(command: Command) {
      const event: FloorEvent = { id: `ev-${Date.now()}-${++seq}`, at: new Date().toISOString(), actor: 'you', command };
      events = [...events, event];
      saveEvents(events);
      listeners.forEach((l) => l(event));
      return event;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function resetMockData() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
