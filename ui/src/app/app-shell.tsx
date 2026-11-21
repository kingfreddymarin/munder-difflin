import paramountMark from '@/assets/nasstro-mark.png';
import * as React from 'react';
import { Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader, SidebarInset, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarRail, SidebarTrigger, useSidebar } from '@/components/animate-ui/components/radix/sidebar';
import { ThemeTogglerButton } from '@/components/animate-ui/components/buttons/theme-toggler';
import { Separator } from '@/components/ui/separator';
import { footerNav, mainNav, type RouteId } from '@/config/navigation';
import { useFloor } from '@/data/store';
import { useRouter } from './router';
import { NotificationsMenu } from './notifications-menu';
import { AccountMenu } from './account-menu';
import { YoloBanner } from './yolo-banner';
import { HookSocketBanner, OrchestratorFailureBanner } from './hook-socket-banner';
import { SetupGate } from './setup-gate';
import { cn } from '@/lib/utils';
import { AgentAvatar } from '@/components/app/agent-avatar';
import { agentStatusColour } from '@/components/app/agent-status-colour';
import { AGENT_VIEW, agentViewParams, terminalRoster } from './agent-view';
import { findBridge } from '@/data/bridge';
import { disposeTerminal, prewarmTerminals } from '@/components/app/terminal/terminal-pool';
import { TERMINAL_THEMES } from '@/components/app/terminal/terminal-themes';
import { getTerminalFontSize } from '@/components/app/terminal/terminalFontSize';
import { Button } from '@/components/animate-ui/components/buttons/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/animate-ui/components/radix/dropdown-menu';
import { MoreHorizontal } from 'lucide-react';
import { useDispatch } from '@/data/store';
import { useFloorViewMode } from './floor-view-mode';
import { AgentActionMenuProvider, useAgentActionTargets } from '@/features/team/agent-action-menu';

/** Buffer every live agent's output from spawn, as Munder's App does (terminal-pool prewarmTerminals). */
function usePrewarmTerminals() {
  const terminals = useFloor((s) => s.terminals);
  React.useEffect(() => findBridge()?.onSideAgentChanged?.((disposedPtyId) => {
    if (disposedPtyId) disposeTerminal(disposedPtyId);
  }), []);
  React.useEffect(() => {
    const theme = document.documentElement.classList.contains('dark') ? 'dark' : 'light';
    prewarmTerminals(terminals.map((t) => t.ptyId), TERMINAL_THEMES[theme], getTerminalFontSize());
  }, [terminals]);
}

/** Every agent, the orchestrator first; a click opens its live terminal (Munder's agent list). */
function SidebarAgents() {
  const { route, go } = useRouter();
  const agents = useFloor((s) => s.agents);
  const terminals = useFloor((s) => s.terminals);
  const roster = React.useMemo(() => terminalRoster(agents, terminals), [agents, terminals]);
  const actionTargets = useAgentActionTargets(React.useMemo(() => roster.map((r) => r.agent.id), [roster]));
  if (roster.length === 0) return null;
  const current = route.id === AGENT_VIEW ? route.params.get('a') : null;
  return (
    <SidebarGroup>
      <SidebarGroupLabel>Agents</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {roster.map(({ agent, live }) => {
            const colour = live ? agentStatusColour(agent) : null;
            return (
              <SidebarMenuItem key={agent.id}>
                <SidebarMenuButton
                  isActive={current === agent.id}
                  tooltip={`${agent.name}${live ? '' : ' (not running)'}`}
                  onClick={() => go(AGENT_VIEW, agentViewParams(agent.id))}
                  {...actionTargets[agent.id]}
                >
                  <AgentAvatar agent={agent} size="sm" tooltip={false} />
                  <span className={cn('truncate', !live && 'text-muted-foreground')}>{agent.name}</span>
                  <span
                    aria-label={colour ? agent.status : 'not running'}
                    className={cn('ml-auto size-1.5 shrink-0 rounded-full',
                      colour ? colour.dot : 'bg-muted-foreground/40',
                      colour?.blink && 'motion-safe:animate-pulse',
                    )}
                  />
                </SidebarMenuButton>
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

function useBadges(): Partial<Record<RouteId, number>> {
  const messages = useFloor((s) => s.messages);
  const cards = useFloor((s) => s.cards);
  const services = useFloor((s) => s.services);
  return React.useMemo(
    () => ({
      chats: new Set(messages.filter((m) => m.from !== 'you' && !m.read && !['context', 'route'].includes(m.kind)).map((m) => m.chatId)).size,
      board: cards.filter((c) => c.status === 'blocked').length,
      health: services.filter((s) => s.state !== 'ok').length,
    }),
    [messages, cards, services],
  );
}

/** The window's title bar: drags the window, controls inside it stay clickable. When the sidebar does not
 *  sit under the macOS traffic lights (collapsed or offcanvas), the bar leaves room for them. */
function TopBar({ title }: { title: string }) {
  const { state, isMobile } = useSidebar();
  const clearLights = isMobile || state === 'collapsed';
  return (
    <header className={cn('app-drag bg-background/80 sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 border-b px-4 backdrop-blur', clearLights && 'desktop-mac:pl-20')}>
      <SidebarTrigger />
      <Separator orientation="vertical" className="mx-1 !h-5" />
      <span className="flex-1 truncate font-medium">{title}</span>
      <MoreMenu />
      <ThemeTogglerButton variant="ghost" size="sm" aria-label="Toggle theme" />
      <NotificationsMenu />
      <AccountMenu />
    </header>
  );
}

/** Secondary app actions stay in their existing screens; this menu makes them discoverable globally. */
function MoreMenu() {
  const views = useFloorViewMode();
  const { go } = useRouter();
  const dispatch = useDispatch();
  const item = (label: string, detail: string, action: () => void) => (
    <DropdownMenuItem onSelect={action} className="items-start py-2">
      <span className="flex min-w-0 flex-col gap-0.5">
        <span>{label}</span>
        <span className="text-muted-foreground text-xs font-normal">{detail}</span>
      </span>
    </DropdownMenuItem>
  );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" aria-label="More app actions" title="More app actions"><MoreHorizontal aria-hidden="true" /><span>More</span></Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" collisionPadding={8} className="w-[min(18rem,calc(100vw-1rem))]">
        <DropdownMenuLabel>More actions</DropdownMenuLabel>
        {views?.enabled && item('Floor views', 'See the open Paramount floors in this window', () => views.setVisible(true))}
        {item('Open another floor…', 'Choose a recent floor or folder', () => { void dispatch({ type: 'floor.picker', open: true }); })}
        <DropdownMenuSeparator />
        {item('Agents & temps', 'Hire, import, configure and manage agents', () => go('team'))}
        {item('Automations', 'Schedules, triggers and team activity', () => go('team', { panel: 'automations' }))}
        {item('Team configuration', 'Orchestrator, teams and temp-worker defaults', () => go('settings', { tab: 'team' }))}
        {item('Engines & models', 'Provider and model settings', () => go('settings', { tab: 'providers' }))}
        {item('Terminal', 'Live agent sessions', () => go('terminal'))}
        <DropdownMenuSeparator />
        {item('Connections', 'Integrations available to this floor', () => go('settings', { tab: 'connections' }))}
        {item('Settings', 'Floor, account and app preferences', () => go('settings'))}
        {item('Diagnostics', 'Service checks, event log and support bundle', () => go('health'))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function AppShell({ children, title }: { children: React.ReactNode; title: string }) {
  const { route, go } = useRouter();
  const badges = useBadges();
  usePrewarmTerminals();
  return (
    <AgentActionMenuProvider>
    <SidebarProvider>
      <Sidebar collapsible="icon">
        {/* Drag strip under the macOS traffic lights; the window has no title bar of its own. */}
        <div aria-hidden className="app-drag hidden h-7 shrink-0 desktop-mac:block" />
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton size="lg" onClick={() => go('home')}>
                <img src={paramountMark} alt="" aria-hidden="true" className="size-8 rounded-lg" />
                <span className="flex flex-col leading-tight">
                  <span className="font-semibold">Paramount</span>
                  <span className="text-muted-foreground text-xs">Agent command center</span>
                </span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                {mainNav.map((n) => (
                  <SidebarMenuItem key={n.id}>
                    <SidebarMenuButton isActive={route.id === n.id} tooltip={n.label} onClick={() => go(n.id)}>
                      <n.icon animateOnHover />
                      <span>{n.label}</span>
                      {!!badges[n.id] && <span className="bg-sidebar-accent text-sidebar-accent-foreground ml-auto rounded-full px-1.5 text-[11px] tabular-nums">{badges[n.id]}</span>}
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
          <SidebarAgents />
        </SidebarContent>
        <SidebarFooter>
          <SidebarMenu>
            {footerNav.map((n) => (
              <SidebarMenuItem key={n.id}>
                <SidebarMenuButton isActive={route.id === n.id} tooltip={n.label} onClick={() => go(n.id)}>
                  <n.icon animateOnHover />
                  <span>{n.label}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>
      <SidebarInset className="h-svh min-w-0 overflow-hidden">
        <TopBar title={title} />
        <HookSocketBanner />
        <OrchestratorFailureBanner />
        <YoloBanner />
        <SetupGate />
        <main className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain p-4">{children}</main>
      </SidebarInset>
    </SidebarProvider>
    </AgentActionMenuProvider>
  );
}
