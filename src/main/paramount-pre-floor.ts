import type { ParamountEvent } from '../preload/paramount';

/** Commands first-run Setup sends before any floor exists (no harnessHome), traced from
 *  ui/src/app/setup-flow.tsx and the error panel's diagnostics buttons. `setup.complete`
 *  is absent because it creates the floor before it audits. Add a command here only when
 *  Setup really sends it and it writes nothing to a floor. */
export const PRE_FLOOR_SETUP_COMMANDS: ReadonlySet<string> = new Set(['diagnostics.bundle', 'diagnostics.save', 'launchers.refresh']);

export interface FloorAudit {
  appendEvent(event: ParamountEvent): void;
  /** False while no floor is chosen; absent means a floor is assumed. */
  floorLogAvailable?(): boolean;
}

/** Writes the audit line to the floor log, except for a pre-floor Setup command while no
 *  floor exists. Every other command still needs the floor log and fails without it. */
export function auditOnFloor(deps: FloorAudit, event: ParamountEvent, commandType: string): void {
  if (PRE_FLOOR_SETUP_COMMANDS.has(commandType) && deps.floorLogAvailable?.() === false) return;
  deps.appendEvent(event);
}
