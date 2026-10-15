// In-browser stand-in for the core. Same interface as the real WebSocket provider:
// commands in, events out. Events are kept in localStorage so your changes survive a reload.
import { BackendError } from './errors';
import { agentDiscovery, fixtures } from './fixtures';
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
    async discoverAgents(options = {}) {
      const wanted = options.sources;
      return { ...structuredClone(agentDiscovery), agents: agentDiscovery.agents.filter((agent) => !wanted || wanted.includes(agent.source)) };
    },
    async importAgent(source, id) {
      const agent = agentDiscovery.agents.find((item) => item.source === source && item.id === id);
      if (!agent) throw BackendError.local('NOT_FOUND', `No ${source} agent "${id}" in the sample data.`, 'agents.import');
      return { agent: structuredClone(agent), manifest: { schema: 'munder-difflin/hire@1', name: agent.name, role: agent.description }, adjustments: [] };
    },
    async openExternal(url) {
      // The browser preview has no allow-list of its own; it only refuses what is not a web link.
      if (!/^https?:\/\//i.test(url)) throw BackendError.local('INVALID_INPUT', `Only http and https links open; refused "${url}".`, 'shell.openExternal');
      // With noopener, window.open always returns null, so there is no success signal to check.
      window.open(url, '_blank', 'noopener,noreferrer');
    },
    async openIn() {
      throw BackendError.local('UNSUPPORTED', 'Opening a folder in Warp or VS Code needs the desktop core; sample data has none.', 'shell.openIn');
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
