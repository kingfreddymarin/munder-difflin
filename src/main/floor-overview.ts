// Presentation across Paramount processes. A peer only projects the floor it
// still owns. In shared app data we publish endpoint metadata, never floor rows.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { constants, mkdirSync, openSync, closeSync, fstatSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { basename, isAbsolute, join, resolve } from 'node:path';
import type { FloorOverview, FloorOverviewRow } from '../shared/floor-overview';
import { pidAlive, readFloorLock } from './floor-lock';
import { floorDataDirFor } from './floors';

const HOST = '127.0.0.1';
const MAX_ROWS = 2_000;
const MAX_REPLY = 8 * 1024 * 1024;
const TIMEOUT = 1_250;
const ENTRY = /^\d+-[a-f0-9]{32}\.json$/;

interface Marker { pid: number; profile: string; port: number; token: string }
interface Owner { home: string; since: string }
interface WireOverview extends Owner { agents: FloorOverviewRow[]; tasks: FloorOverviewRow[] }

function asRecord(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
}

export function projectFloorRows(
  registry: unknown,
  ledger: unknown,
  activityFor: (id: string) => { status: 'offline' | 'working' | 'idle'; breaker?: string },
  rosterAgents: readonly unknown[]
) {
  const rosterStatuses = new Map(rosterAgents.map(raw => {
    const agent = asRecord(raw);
    return [agent.id, agent.status] as const;
  }));
  const agents = Object.entries(asRecord(asRecord(registry).agents))
    .filter(([id, agent]) => id && asRecord(agent).archived !== true)
    .slice(0, MAX_ROWS)
    .map(([id, raw]) => {
      const agent = asRecord(raw);
      const recorded = typeof agent.status === 'string' ? agent.status : rosterStatuses.get(id);
      const live = activityFor(id);
      // Match the regular floor's exceptional states before applying terminal recency.
      const breaker = live.breaker || agent.breaker;
      if (breaker === 'constrain' || breaker === 'constrained' || breaker === 'stop' || breaker === 'stopped') {
        return toRow(id, agent.name, 'constrained');
      }
      if (recorded === 'blocked' || recorded === 'waiting') return toRow(id, agent.name, 'waiting');
      if (recorded === 'crashed' || recorded === 'error') return toRow(id, agent.name, 'crashed');
      return toRow(id, agent.name, live.status);
    });
  const tasks: FloorOverviewRow[] = [];
  const entries = asRecord(ledger).tasks;
  if (Array.isArray(entries)) {
    // The ledger appends new cards. Prefer active work and preserve its order.
    const current: FloorOverviewRow[] = [];
    const done: FloorOverviewRow[] = [];
    for (const raw of entries) {
      const task = asRecord(raw);
      if (typeof task.id !== 'string' || !task.id) continue;
      const group = task.status === 'done' ? done : current;
      if (group.length < MAX_ROWS) group.push(toRow(task.id, task.title, task.status));
    }
    tasks.push(...current, ...done.slice(0, MAX_ROWS - current.length));
  }
  return { agents, tasks };
}

function toRow(id: string, label: unknown, status: unknown): FloorOverviewRow {
  return {
    id,
    label: typeof label === 'string' && label ? label.slice(0, 400) : id.slice(0, 400),
    status: typeof status === 'string' && status ? status.slice(0, 32) : 'unknown'
  };
}

function remove(path: string): void {
  try { unlinkSync(path); } catch { /* already gone or unavailable */ }
}

function readMarker(path: string): Marker | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > 4096 || (process.getuid && (info.uid !== process.getuid() || (info.mode & 0o077) !== 0))) return null;
    const m = asRecord(JSON.parse(readFileSync(fd, 'utf8')));
    if (typeof m.pid !== 'number' || !Number.isSafeInteger(m.pid) || m.pid <= 0 ||
        typeof m.port !== 'number' || !Number.isInteger(m.port) || m.port < 1 || m.port > 65535 ||
        typeof m.profile !== 'string' || !isAbsolute(m.profile) ||
        typeof m.token !== 'string' || !/^[a-f0-9]{64}$/.test(m.token)) return null;
    return { pid: m.pid, port: m.port, token: m.token, profile: m.profile };
  } catch { return null; }
  finally { if (fd !== undefined) closeSync(fd); }
}

function ask(peer: Marker, action: 'overview' | 'focus', owner?: Owner): Promise<unknown> {
  return new Promise((done) => {
    const req = request({
      host: HOST, port: peer.port, agent: false, method: action === 'focus' ? 'POST' : 'GET',
      path: '/' + action, headers: {
        Authorization: 'Bearer ' + peer.token,
        ...(owner ? { 'X-Floor-Owner': ownerKey(owner) } : {}),
      }
    }, (res) => {
      if (res.statusCode !== 200) { res.destroy(); done(null); return; }
      let bytes = 0;
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_REPLY) { req.destroy(); done(null); }
        else chunks.push(chunk);
      });
      res.on('error', () => done(null));
      res.on('end', () => {
        try { done(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { done(null); }
      });
    });
    const timeout = setTimeout(() => { req.destroy(); done(null); }, TIMEOUT);
    req.on('close', () => { clearTimeout(timeout); done(null); });
    req.on('error', () => done(null));
    req.end();
  });
}

function ownerKey(owner: Owner): string {
  return createHash('sha256').update(JSON.stringify([owner.home, owner.since])).digest('hex');
}

function validateOverview(raw: unknown): WireOverview | null {
  const r = asRecord(raw);
  if (typeof r.home !== 'string' || !isAbsolute(r.home) || typeof r.since !== 'string' ||
      !Array.isArray(r.agents) || !Array.isArray(r.tasks)) return null;
  const rows = (entries: unknown[]) => entries.slice(0, MAX_ROWS).flatMap((entry) => {
    const row = asRecord(entry);
    return typeof row.id === 'string' && row.id ? [toRow(row.id, row.label, row.status)] : [];
  });
  return { home: resolve(r.home), since: r.since, agents: rows(r.agents), tasks: rows(r.tasks) };
}

export function createFloorOverview(options: {
  shared: string;
  profile: string;
  home: () => string | null;
  rows: () => Pick<FloorOverview, 'agents' | 'tasks'>;
  focus: () => boolean;
}) {
  const dir = join(options.shared, 'floor-overview-v1');
  const marker = join(dir, process.pid + '-' + randomBytes(16).toString('hex') + '.json');
  const token = randomBytes(32).toString('hex');
  const auth = Buffer.from('Bearer ' + token);
  let server: ReturnType<typeof createServer> | undefined;
  let peersById = new Map<string, { marker: Marker; owner: Owner }>();
  let listing: Promise<FloorOverview[]> | undefined;

  function owns(peer: Pick<Marker, 'pid' | 'profile'>, owner: Owner): boolean {
    if (peer.profile !== options.shared && peer.profile !== floorDataDirFor(options.shared, owner.home)) return false;
    const lock = readFloorLock(join(owner.home, 'hive'));
    return !!lock && lock !== 'unreadable' && lock.pid === peer.pid &&
      lock.userData === peer.profile && lock.since === owner.since && pidAlive(peer.pid);
  }

  function localOwner(): Owner | null {
    const home = options.home();
    if (!home) return null;
    const lock = readFloorLock(join(home, 'hive'));
    if (!lock || lock === 'unreadable') return null;
    const owner = { home: resolve(home), since: lock.since };
    return owns({ pid: process.pid, profile: options.profile }, owner) ? owner : null;
  }

  async function collect(): Promise<FloorOverview[]> {
    let entries: string[];
    try { entries = readdirSync(dir); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const views = await Promise.all(entries.filter((name) => ENTRY.test(name)).map(async (name) => {
      const path = join(dir, name);
      const peer = readMarker(path);
      if (!peer || !name.startsWith(peer.pid + '-')) return null;
      if (!pidAlive(peer.pid)) { remove(path); return null; }
      const data = validateOverview(await ask(peer, 'overview'));
      if (!data || !owns(peer, data)) return null;
      const owner = { home: data.home, since: data.since };
      const id = createHash('sha256').update(data.home).digest('hex');
      const floor = {
        id, name: basename(data.home) || data.home, home: data.home,
        current: peer.pid === process.pid && peer.profile === options.profile,
        agents: data.agents, tasks: data.tasks
      };
      return { floor, owner, marker: peer };
    }));
    peersById = new Map();
    const floors: FloorOverview[] = [];
    for (const entry of views) {
      if (!entry || peersById.has(entry.floor.id)) continue;
      peersById.set(entry.floor.id, { marker: entry.marker, owner: entry.owner });
      floors.push(entry.floor);
    }
    return floors.sort((a, b) => Number(b.current) - Number(a.current) || a.name.localeCompare(b.name) || a.home.localeCompare(b.home));
  }

  return {
    start() {
      if (server) return;
      const listener = createServer({ requestTimeout: TIMEOUT, headersTimeout: TIMEOUT, connectionsCheckingInterval: 1_000 }, (req, res) => {
        const supplied = Buffer.from(req.headers.authorization ?? '');
        if (supplied.length !== auth.length || !timingSafeEqual(supplied, auth)) { res.writeHead(403).end(); return; }
        const owner = localOwner();
        if (!owner) { res.writeHead(404).end(); return; }
        try {
          if (req.method === 'GET' && req.url === '/overview') {
            const body = JSON.stringify({ ...owner, ...options.rows() });
            if (Buffer.byteLength(body) > MAX_REPLY) { res.writeHead(413).end(); return; }
            res.writeHead(200, { 'Content-Type': 'application/json' }).end(body);
          } else if (req.method === 'POST' && req.url === '/focus' && req.headers['x-floor-owner'] === ownerKey(owner)) {
            const focused = options.focus();
            res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(focused));
          } else res.writeHead(404).end();
        } catch { res.writeHead(503).end(); }
      });
      server = listener;
      listener.maxConnections = 32;
      listener.setTimeout(TIMEOUT, (socket) => socket.destroy());
      listener.on('error', () => { if (server === listener) server = undefined; remove(marker); });
      listener.listen(0, HOST, () => {
        const address = listener.address();
        if (server !== listener || !address || typeof address === 'string') return;
        const temp = marker + '.tmp';
        try {
          mkdirSync(dir, { mode: 0o700, recursive: true });
          writeFileSync(temp, JSON.stringify({ pid: process.pid, profile: options.profile, port: address.port, token }), { mode: 0o600, flag: 'wx' });
          renameSync(temp, marker);
        } catch { remove(temp); }
      }).unref();
    },
    stop() {
      const listener = server;
      server = undefined;
      listener?.close();
      listener?.closeAllConnections();
      remove(marker);
    },
    list(): Promise<FloorOverview[]> {
      if (!localOwner()) return Promise.resolve([]);
      return listing ??= collect().then(floors => localOwner() ? floors : []).finally(() => { listing = undefined; });
    },
    async focus(id: string): Promise<boolean> {
      const peer = peersById.get(id);
      return !!peer && !!localOwner() && owns(peer.marker, peer.owner) && await ask(peer.marker, 'focus', peer.owner) === true;
    }
  };
}
