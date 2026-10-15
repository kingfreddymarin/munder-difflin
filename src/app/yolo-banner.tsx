import { motion, AnimatePresence } from 'motion/react';
import { Button } from '@/components/animate-ui/components/buttons/button';
import { useDispatch, useFloor } from '@/data/store';
import { clock } from '@/components/app/format';

export function YoloBanner() {
  const yolo = useFloor((s) => s.me.yolo);
  const dispatch = useDispatch();
  return (
    <AnimatePresence>
      {yolo.on && (
        <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
          <div className="flex flex-wrap items-center gap-3 border-b border-fuchsia-500/30 bg-fuchsia-500/10 px-4 py-2 text-sm">
            <span className="font-semibold text-fuchsia-300">YOLO mode</span>
            <span className="text-muted-foreground flex-1">
              No token caps · approvals auto-granted · breaker only steers{yolo.keepHardRules ? ' · your hard rules still apply' : ' · hard rules off'}
              {yolo.since ? ` · since ${clock(yolo.since)}` : ''}
              {yolo.autoOffHours ? ` · auto-off after ${yolo.autoOffHours} h` : ''}
            </span>
            <Button size="sm" variant="outline" onClick={() => dispatch({ type: 'floor.yolo', patch: { on: false } })}>
              Turn off
            </Button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
