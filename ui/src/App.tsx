import * as React from 'react';
import { ThemeProvider } from 'next-themes';
import { TooltipProvider } from '@/components/animate-ui/components/animate/tooltip';
import { FloorProvider, useFloor } from '@/data/store';
import { createMockProvider } from '@/data/mock-provider';
import { createElectronProvider } from '@/data/electron-provider';
import { findBridge } from '@/data/bridge';
import { RouterProvider, useRouter } from '@/app/router';
import { AppShell } from '@/app/app-shell';
import { mainNav, footerNav } from '@/config/navigation';
import { record } from '@/lib/perf';
import { useOrchestratorStartup } from '@/app/use-orchestrator-startup';
import { SetupFlow } from '@/app/setup-flow';

// The real core when the Electron preload is present (window.paramount, or the fork's window.cth); fixtures otherwise.
const provider = findBridge() ? createElectronProvider() : createMockProvider();

// Each page is its own chunk (the terminal page alone pulls in xterm), so the first paint parses only the
// shell and the open page. The rest load while the app is idle, so switching pages never waits on a fetch.
const loaders = {
  home: () => import('@/pages/home').then((m) => ({ default: m.HomePage })),
  chats: () => import('@/pages/chats').then((m) => ({ default: m.ChatsPage })),
  board: () => import('@/pages/board').then((m) => ({ default: m.BoardPage })),
  team: () => import('@/pages/team').then((m) => ({ default: m.TeamPage })),
  terminal: () => import('@/pages/terminal').then((m) => ({ default: m.TerminalPage })),
  health: () => import('@/pages/health').then((m) => ({ default: m.HealthPage })),
  settings: () => import('@/pages/settings').then((m) => ({ default: m.SettingsPage })),
};
const pages: Record<string, React.LazyExoticComponent<React.ComponentType>> = Object.fromEntries(Object.entries(loaders).map(([id, load]) => [id, React.lazy(load)]));

function preloadPages() {
  const run = () => Object.values(loaders).forEach((load) => void load());
  if ('requestIdleCallback' in window) window.requestIdleCallback(run, { timeout: 2000 });
  else setTimeout(run, 500);
}

const onRender: React.ProfilerOnRenderCallback = (id, _phase, actualDuration) => record(`render:${id}`, actualDuration);

function Routes() {
  const { route } = useRouter();
  const Page = pages[route.id] ?? pages.home;
  const title = [...mainNav, ...footerNav].find((n) => n.id === route.id)?.label ?? 'Home';
  React.useEffect(preloadPages, []);
  return (
    <AppShell title={title}>
      <React.Suspense fallback={<div className="text-muted-foreground p-6 text-sm">Loading {title}…</div>}>
        <React.Profiler id={route.id} onRender={onRender}>
          <Page />
        </React.Profiler>
      </React.Suspense>
    </AppShell>
  );
}

/** Munder parity: until the core reports a set-up floor, only first-run setup is shown. */
function SetupGateOrApp() {
  const setup = useFloor((s) => s.floorSetup);
  useOrchestratorStartup(setup);
  if (setup && !setup.complete) return <SetupFlow setup={setup} />;
  return (
    <RouterProvider>
      <Routes />
    </RouterProvider>
  );
}

export default function App() {
  return (
    <ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
      <TooltipProvider>
        <FloorProvider provider={provider} fallback={<div className="text-muted-foreground p-8 text-sm">Connecting to the floor…</div>}>
          <SetupGateOrApp />
        </FloorProvider>
      </TooltipProvider>
    </ThemeProvider>
  );
}
