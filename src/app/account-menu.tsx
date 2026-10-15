import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger, DropdownMenuCheckboxItem } from '@/components/animate-ui/components/radix/dropdown-menu';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { useDispatch, useFloor, useUnsupported } from '@/data/store';
import { useRouter } from './router';

export function AccountMenu() {
  const me = useFloor((s) => s.me);
  const dispatch = useDispatch();
  const yoloReason = useUnsupported()({ type: 'floor.yolo', patch: { on: true } });
  const { go } = useRouter();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="rounded-full outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50" aria-label="Account">
        <Avatar className="size-8">
          <AvatarFallback className="bg-primary/20 text-primary text-xs font-semibold">{me.name.slice(0, 2).toUpperCase()}</AvatarFallback>
        </Avatar>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className="flex flex-col">
          <span>{me.name}</span>
          <span className="text-muted-foreground text-xs font-normal">{me.workEmail}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => go('settings', { tab: 'account' })}>Account settings</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => go('settings', { tab: 'connections' })}>Connections</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => go('settings', { tab: 'audit' })}>My changes (audit log)</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem checked={me.yolo.on} disabled={!!yoloReason} title={yoloReason ?? undefined} onCheckedChange={(v) => dispatch({ type: 'floor.yolo', patch: { on: !!v } })}>
          YOLO mode
        </DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
