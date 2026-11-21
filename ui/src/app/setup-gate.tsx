// Shown at start whenever a required prerequisite is not ready (Skidbladnir first).
// You can fix it here or continue in degraded mode; either choice is logged.
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/animate-ui/components/radix/dialog';
import { Button } from '@/components/animate-ui/components/buttons/button';
import { PrereqList, useSetupBlockers } from '@/components/app/prereq-list';
import { useDispatch, useFloor } from '@/data/store';

export function SetupGate() {
  const blockers = useSetupBlockers();
  const dismissed = useFloor((s) => s.setupDismissed);
  const dispatch = useDispatch();
  const open = blockers.length > 0 && !dismissed;
  return (
    <Dialog open={open} onOpenChange={(o) => !o && dispatch({ type: 'setup.dismiss', degraded: blockers.map((b) => b.name) })}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Set up this Mac for Paramount</DialogTitle>
          <DialogDescription>
            {blockers.length} required {blockers.length === 1 ? 'piece is' : 'pieces are'} not ready on this Mac. Each line says what is missing and what it is for.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <PrereqList compact />
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => dispatch({ type: 'setup.dismiss', degraded: blockers.map((b) => b.name) })}>
            Continue anyway
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
