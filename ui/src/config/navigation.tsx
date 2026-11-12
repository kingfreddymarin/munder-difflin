// Navigation is data: add, remove or reorder screens here.
import { LayoutDashboard } from '@/components/animate-ui/icons/layout-dashboard';
import { Kanban } from '@/components/animate-ui/icons/kanban';
import { Users } from '@/components/animate-ui/icons/users';
import { Terminal } from '@/components/animate-ui/icons/terminal';
import { Activity } from '@/components/animate-ui/icons/activity';
import { Settings } from '@/components/animate-ui/icons/settings';

export type RouteId = 'home' | 'chats' | 'board' | 'team' | 'terminal' | 'health' | 'settings';

export const mainNav: { id: RouteId; label: string; icon: React.ComponentType<{ className?: string; animateOnHover?: boolean }> }[] = [
  // Agents are talked to in their live terminal (Munder parity). The chats page stays
  // reachable by link (notifications, messages) but is not primary navigation.
  { id: 'home', label: 'Home', icon: LayoutDashboard },
  { id: 'terminal', label: 'Terminal', icon: Terminal },
  { id: 'board', label: 'Board', icon: Kanban },
  { id: 'team', label: 'Team', icon: Users },
  { id: 'health', label: 'Health', icon: Activity },
];
export const footerNav = [{ id: 'settings' as RouteId, label: 'Settings', icon: Settings }];
