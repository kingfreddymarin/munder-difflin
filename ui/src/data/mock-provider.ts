// In-browser stand-in for the core. Same interface as the real WebSocket provider:
// commands in, events out. Events are kept in localStorage so your changes survive a reload.
import { BackendError } from './errors';
import { agentDiscovery, fixtures } from './fixtures';
import type { Command, DataProvider, FloorEvent } from './protocol';
import { applyEvent, nextCardKey } from './reducer';

import { artifactMaps } from './terminal-fixtures';
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
  const current = () => events.reduce(applyEvent, structuredClone(fixtures));
  return {
    kind: 'mock',
    unsupported: (command) => command.type === 'card.dispatch' ? 'Sending tasks requires the desktop floor.' : null,
    async snapshot(): Promise<Snapshot> {
      return current();
    },
    async dispatch(input: Command) {
      const command: Command = input.type === 'card.create' ? { ...input, key: nextCardKey(current().cards.map((card) => card.key)) } : input;
      if (command.type === 'accounts.create' || command.type === 'accounts.rename' || command.type === 'accounts.list') throw BackendError.local('UNSUPPORTED', 'Managed accounts require the desktop core; sample data cannot create or rename real profiles.', command.type);
      if (command.type === 'card.dispatch') throw BackendError.local('UNSUPPORTED', 'Sending tasks requires the desktop floor.', command.type);
      // The browser cannot open local apps; a stored https link opens in a new tab instead.
      if (command.type === 'card.open') throw BackendError.local('UNSUPPORTED', 'Opening a folder in Warp or VS Code needs the desktop app.', command.type);
      if (command.type === 'card.link') {
        const card = events.reduce(applyEvent, structuredClone(fixtures)).cards.find((item) => item.key === command.key);
        if (!card?.refs.some((ref) => ref.url === command.url)) throw BackendError.local('NOT_FOUND', `Card ${command.key} has no link to that URL.`, command.type);
        window.open(command.url, '_blank', 'noopener');
      }
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
      return { agent: structuredClone(agent), manifest: { spec: 'munder-difflin/hire@1', name: agent.name, ...(agent.description ? { description: agent.description } : {}) }, adjustments: [] };
    },
    async teamModels() {
      const s = current();
      const byName = new Map(s.engines.map((engine) => [engine.name, engine.id]));
      return {
        engines: s.engines.map((engine) => ({ id: engine.id, label: engine.name, models: engine.models.map((model) => ({ id: model, label: model })) })),
        defaultModel: s.engines[0]?.defaultModel,
        agents: Object.fromEntries(s.agents.map((agent) => [agent.id, { engine: byName.get(agent.engine) ?? agent.engine, model: agent.model || undefined, installed: true, accountSelection: 'default' as const }])),
      };
    },
    async hire(manifest, options = {}) {
      const name = typeof manifest.name === 'string' ? manifest.name.trim() : '';
      if (!name) throw BackendError.local('INVALID_INPUT', 'The hire form is not valid: "name" is required', 'agent.hire');
      if (options.confirm) throw BackendError.local('UNSUPPORTED', 'Sample data cannot start an agent; connect the desktop core to hire.', 'agent.hire');
      const engine = typeof manifest.provider === 'string' ? manifest.provider : 'claude';
      const model = typeof manifest.model === 'string' && manifest.model ? manifest.model : undefined;
      return {
        agentId: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name, engine, ...(model ? { model } : {}),
        ...(typeof manifest.description === 'string' ? { role: manifest.description } : {}),
        cwd: options.cwd ?? '(sample folder)', isolate: manifest.isolate === true,
        command: [engine, ...(model ? ['--model', model] : [])].join(' '), engineInstalled: true, confirmed: false, consentRequired: [], ignored: [],
      };
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
    async artifacts(agentId) {
      const map = artifactMaps[agentId];
      if (!map) throw BackendError.local('NOT_FOUND', `No sample artifacts for "${agentId}".`, 'terminal.artifacts');
      return structuredClone(map);
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
