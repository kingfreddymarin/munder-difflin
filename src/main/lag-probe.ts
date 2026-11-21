/** Main-thread lag probe (owner use of 8f574966: "I see the beach ball too much"). A beach ball means
 *  the Electron main thread stopped pumping events. A timer that should fire every `intervalMs`
 *  measures how late it fires; a stall over `thresholdMs` is logged as kind 'paramount-lag' with the
 *  milliseconds lost and the operations that were running during it, so owner use leaves evidence.
 *
 *  Operations report themselves through begin(op), which returns the matching end(). traced() in
 *  paramountObservability.ts calls it for every Paramount command and the snapshot. */

export interface LagProbeDeps {
  now(): number;
  log(event: Record<string, unknown>): void;
  intervalMs?: number;
  thresholdMs?: number;
}

export interface LagProbe {
  begin(op: string): () => void;
  /** One timer tick: logs a stall when this tick came late. */
  tick(): void;
}

const KEEP_OPS = 64;

export function createLagProbe(deps: LagProbeDeps): LagProbe {
  const intervalMs = deps.intervalMs ?? 100;
  const thresholdMs = deps.thresholdMs ?? 200;
  let last = deps.now();
  const ops: Array<{ op: string; start: number; end: number | null }> = [];
  return {
    begin(op) {
      const entry = { op, start: deps.now(), end: null as number | null };
      ops.push(entry);
      if (ops.length > KEEP_OPS) ops.splice(0, ops.length - KEEP_OPS);
      return () => { entry.end = deps.now(); };
    },
    tick() {
      const now = deps.now();
      const due = last + intervalMs;
      const lag = now - due;
      if (lag > thresholdMs) {
        // Every operation that was running at some point while the thread was stuck.
        const during = ops.filter((o) => o.start <= now && (o.end === null || o.end >= due)).map((o) => o.op);
        deps.log({ kind: 'paramount-lag', ms: Math.round(lag), op: [...new Set(during)].join(', ') || 'unknown' });
      }
      last = now;
      // Finished operations older than this tick can no longer overlap a stall.
      for (let i = ops.length - 1; i >= 0; i--) if (ops[i].end !== null && (ops[i].end as number) < now) ops.splice(i, 1);
    },
  };
}

let active: LagProbe | null = null;

/** Start the probe for this process (once). Returns a stop function. */
export function startLagProbe(deps: LagProbeDeps): () => void {
  const probe = createLagProbe(deps);
  active = probe;
  const timer = setInterval(() => probe.tick(), deps.intervalMs ?? 100);
  timer.unref?.();
  return () => { clearInterval(timer); if (active === probe) active = null; };
}

/** Mark an operation as running, for the probe's stall report. A no-op before the probe starts. */
export function lagOp(op: string): () => void {
  return active ? active.begin(op) : () => {};
}
