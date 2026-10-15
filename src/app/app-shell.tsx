import * as React from 'react';
import { Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarHeader, SidebarInset, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarRail, SidebarTrigger, useSidebar } from '@/components/animate-ui/components/radix/sidebar';
import { ThemeTogglerButton } from '@/components/animate-ui/components/buttons/theme-toggler';
import { Separator } from '@/components/ui/separator';
import { footerNav, mainNav, type RouteId } from '@/config/navigation';
import { useFloor } from '@/data/store';
import { useRouter } from './router';
import { NotificationsMenu } from './notifications-menu';
import { AccountMenu } from './account-menu';
import { YoloBanner } from './yolo-banner';
import { SetupGate } from './setup-gate';
import { cn } from '@/lib/utils';

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
      <ThemeTogglerButton variant="ghost" size="sm" aria-label="Toggle theme" />
      <NotificationsMenu />
      <AccountMenu />
    </header>
  );
}

export function AppShell({ children, title }: { children: React.ReactNode; title: string }) {
  const { route, go } = useRouter();
  const badges = useBadges();
  return (
    <SidebarProvider>
      <Sidebar collapsible="icon">
        {/* Drag strip under the macOS traffic lights; the window has no title bar of its own. */}
        <div aria-hidden className="app-drag hidden h-7 shrink-0 desktop-mac:block" />
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton size="lg" onClick={() => go('home')}>
                <span className="bg-primary text-primary-foreground flex size-8 items-center justify-center rounded-lg font-mono text-xs font-bold">PM</span>
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
        <YoloBanner />
        <SetupGate />
        <main className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-hidden p-4">{children}</main>
      </SidebarInset>
    </SidebarProvider>
  );
}
