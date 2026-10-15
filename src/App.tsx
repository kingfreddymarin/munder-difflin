import { ThemeProvider } from 'next-themes';
import { TooltipProvider } from '@/components/animate-ui/components/animate/tooltip';
import { FloorProvider } from '@/data/store';
import { createMockProvider } from '@/data/mock-provider';
import { RouterProvider, useRouter } from '@/app/router';
import { AppShell } from '@/app/app-shell';
import { mainNav, footerNav } from '@/config/navigation';
import { HomePage } from '@/pages/home';
import { ChatsPage } from '@/pages/chats';
import { BoardPage } from '@/pages/board';
import { TeamPage } from '@/pages/team';
import { TerminalPage } from '@/pages/terminal';
import { HealthPage } from '@/pages/health';
import { SettingsPage } from '@/pages/settings';

// Swap this for the WebSocket provider when the core is running; nothing else changes.
const provider = createMockProvider();

const pages = { home: HomePage, chats: ChatsPage, board: BoardPage, team: TeamPage, terminal: TerminalPage, health: HealthPage, settings: SettingsPage };

function Routes() {
  const { route } = useRouter();
  const Page = pages[route.id] ?? HomePage;
  const title = [...mainNav, ...footerNav].find((n) => n.id === route.id)?.label ?? 'Home';
  return (
    <AppShell title={title}>
      <Page />
    </AppShell>
  );
}

export default function App() {
  return (
    <ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
      <TooltipProvider>
        <FloorProvider provider={provider} fallback={<div className="text-muted-foreground p-8 text-sm">Connecting to the floor…</div>}>
          <RouterProvider>
            <Routes />
          </RouterProvider>
        </FloorProvider>
      </TooltipProvider>
    </ThemeProvider>
  );
}
