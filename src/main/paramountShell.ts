// Paramount shell: this fork runs only the Munder Difflin BACKEND (main +
// preload). The UI is the separate Paramount repo (00-new/apps/paramount, a
// Vite app). This module gives the shell its own identity so it never shares
// Munder Difflin's userData, single-instance lock, config or hive, and decides
// where the window's UI comes from.
//
// It is imported FIRST in index.ts: ES imports evaluate in order, so the
// setName/setPath below land before any other module can read userData.
import { app, net, protocol, session, type Session } from 'electron';
import { join, resolve, sep } from 'node:path';
import { existsSync, mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseFloorArgs, readSharedConfig, seedFloorConfig } from './floors';

export const PARAMOUNT_NAME = 'Paramount';
/** Custom scheme the packaged UI is served from. A file:// load would break
 *  Vite's default absolute asset paths (`/assets/…`); a standard scheme with a
 *  host keeps them resolving against the bundle root. */
const SCHEME = 'paramount';
const HOST = 'app';
const DEFAULT_DEV_URL = 'http://127.0.0.1:5173';

app.setName(PARAMOUNT_NAME);
// ~/Library/Application Support/Paramount on macOS. Config and the window DB live
// under here, apart from Munder Difflin's. A floor never does (floors.ts dataFolderRefusal).
// setPath throws for a missing directory, so create it first: on a clean
// profile it does not exist yet and the shell would die before any window.
// An explicit --user-data-dir (a disposable test profile) wins. Without this
// the forced path below silently points every run at the real profile.
const explicitUserData = app.commandLine.getSwitchValue('user-data-dir');
// Several floors at once (floors.ts, Munder 0.5.7 parity): a floor process is started with
// --floor-data/--floor-shared/--floor-home and uses its own data folder, so its single-instance
// lock, config and window state are its own. Its first config is the shared one without the
// per-floor settings.
const floorArgs = parseFloorArgs(process.argv);
const userDataDir = floorArgs ? floorArgs.dataDir : explicitUserData ? resolve(explicitUserData) : join(app.getPath('appData'), PARAMOUNT_NAME);
mkdirSync(userDataDir, { recursive: true });
app.setPath('userData', userDataDir);
if (floorArgs?.home && !existsSync(join(floorArgs.dataDir, 'config.json'))) {
  writeFileSync(join(floorArgs.dataDir, 'config.json'), JSON.stringify(seedFloorConfig(readSharedConfig(floorArgs.sharedDir), floorArgs.home), null, 2), { encoding: 'utf8', mode: 0o600 });
}
/** The main process's data folder; every floor's data folder sits under it. */
export function sharedDataDir(): string { return floorArgs ? floorArgs.sharedDir : userDataDir; }
/** True in a floor process (started by floor.open for one home folder). */
export function isFloorProcess(): boolean { return floorArgs !== null; }
/** The home a floor process was started for; null in the main process. */
export function floorProcessHome(): string | null { return floorArgs?.home ?? null; }

protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }
]);

/** The folder setup suggests for a first floor. Never the data folder: a floor there mixes its
 *  hive with config and every floor's data (owner report 2026-11-12). */
export function paramountHome(): string {
  return join(app.getPath('home'), PARAMOUNT_NAME);
}

/** The bundled Paramount `dist`, copied in by electron-builder extraResources. */
function uiDistDir(): string {
  return join(process.resourcesPath, 'paramount-ui');
}

/** The file to serve for a paramount:// pathname: the asset when it exists,
 *  index.html for unknown paths (client-side routes survive a reload), or null
 *  when the request escapes `root` lexically (`..`, an encoded separator) or
 *  through a symlink inside the bundle. */
export function resolveUiAsset(root: string, pathname: string): string | null {
  const inside = (p: string, base: string): boolean => p === base || p.startsWith(base + sep);
  const target = resolve(root, '.' + decodeURIComponent(pathname));
  if (!inside(target, root)) return null;
  if (!existsSync(target)) return join(root, 'index.html');
  if (!inside(realpathSync(target), realpathSync(root))) return null;
  return statSync(target).isFile() ? target : join(root, 'index.html');
}

/** Sessions that already serve paramount://. A handler belongs to one session,
 *  and a second protocol.handle on the same session throws. */
const servedSessions = new WeakSet<Session>();

/** Serve the bundled UI over paramount://app/ on `ses`. Call for every session
 *  that loads the UI (each floor has its own partition); repeat calls are no-ops. */
export function registerParamountProtocol(ses: Session = session.defaultSession): void {
  if (!app.isPackaged || servedSessions.has(ses)) return;
  const root = resolve(uiDistDir());
  ses.protocol.handle(SCHEME, (req) => {
    const file = resolveUiAsset(root, new URL(req.url).pathname);
    if (!file) return new Response('forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });
  servedSessions.add(ses);
}

/** Where the main window loads its UI from: the Paramount Vite dev server in
 *  development (PARAMOUNT_UI_URL overrides), the bundled dist when packaged. */
export function paramountUiUrl(): string {
  if (app.isPackaged) return `${SCHEME}://${HOST}/index.html`;
  return process.env.PARAMOUNT_UI_URL || DEFAULT_DEV_URL;
}
