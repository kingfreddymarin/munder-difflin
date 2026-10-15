// Paramount shell: this fork runs only the Munder Difflin BACKEND (main +
// preload). The UI is the separate Paramount repo (00-new/apps/paramount, a
// Vite app). This module gives the shell its own identity so it never shares
// Munder Difflin's userData, single-instance lock, config or hive, and decides
// where the window's UI comes from.
//
// It is imported FIRST in index.ts: ES imports evaluate in order, so the
// setName/setPath below land before any other module can read userData.
import { app, net, protocol } from 'electron';
import { join, resolve, sep } from 'node:path';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const PARAMOUNT_NAME = 'Paramount';
/** Custom scheme the packaged UI is served from. A file:// load would break
 *  Vite's default absolute asset paths (`/assets/…`); a standard scheme with a
 *  host keeps them resolving against the bundle root. */
const SCHEME = 'paramount';
const HOST = 'app';
const DEFAULT_DEV_URL = 'http://127.0.0.1:5173';

app.setName(PARAMOUNT_NAME);
// ~/Library/Application Support/Paramount on macOS. Config, the window DB and
// (by default) the hive all live under here, apart from Munder Difflin's.
// setPath throws for a missing directory, so create it first: on a clean
// profile it does not exist yet and the shell would die before any window.
const userDataDir = join(app.getPath('appData'), PARAMOUNT_NAME);
mkdirSync(userDataDir, { recursive: true });
app.setPath('userData', userDataDir);

protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }
]);

/** The default harnessHome: the hive root is `<this>/hive`. */
export function paramountHome(): string {
  return app.getPath('userData');
}

/** The bundled Paramount `dist`, copied in by electron-builder extraResources. */
function uiDistDir(): string {
  return join(process.resourcesPath, 'paramount-ui');
}

/** Serve the bundled UI over paramount://app/. Unknown paths fall back to
 *  index.html so client-side routes survive a reload. Call once, after ready. */
export function registerParamountProtocol(): void {
  if (!app.isPackaged) return;
  const root = resolve(uiDistDir());
  protocol.handle(SCHEME, (req) => {
    const { pathname } = new URL(req.url);
    const target = resolve(root, '.' + decodeURIComponent(pathname));
    // Never serve outside the bundle (`..` or an encoded separator).
    if (target !== root && !target.startsWith(root + sep)) {
      return new Response('forbidden', { status: 403 });
    }
    const isFile = existsSync(target) && statSync(target).isFile();
    return net.fetch(pathToFileURL(isFile ? target : join(root, 'index.html')).toString());
  });
}

/** Where the main window loads its UI from: the Paramount Vite dev server in
 *  development (PARAMOUNT_UI_URL overrides), the bundled dist when packaged. */
export function paramountUiUrl(): string {
  if (app.isPackaged) return `${SCHEME}://${HOST}/index.html`;
  return process.env.PARAMOUNT_UI_URL || DEFAULT_DEV_URL;
}
