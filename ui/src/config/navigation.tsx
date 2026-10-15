// Navigation is data: add, remove or reorder screens here.
import { LayoutDashboard } from '@/components/animate-ui/icons/layout-dashboard';
import { MessageSquare } from '@/components/animate-ui/icons/message-square';
import { Kanban } from '@/components/animate-ui/icons/kanban';
import { Users } from '@/components/animate-ui/icons/users';
import { Terminal } from '@/components/animate-ui/icons/terminal';
import { Activity } from '@/components/animate-ui/icons/activity';
import { Settings } from '@/components/animate-ui/icons/settings';

export type RouteId = 'home' | 'chats' | 'board' | 'team' | 'terminal' | 'health' | 'settings';

export const mainNav: { id: RouteId; label: string; icon: React.ComponentType<{ className?: string; animateOnHover?: boolean }> }[] = [
  { id: 'home', label: 'Home', icon: LayoutDashboard },
  { id: 'chats', label: 'Chats', icon: MessageSquare },
  { id: 'board', label: 'Board', icon: Kanban },
  { id: 'team', label: 'Team', icon: Users },
  { id: 'terminal', label: 'Terminal', icon: Terminal },
  { id: 'health', label: 'Health', icon: Activity },
];
export const footerNav = [{ id: 'settings' as RouteId, label: 'Settings', icon: Settings }];
