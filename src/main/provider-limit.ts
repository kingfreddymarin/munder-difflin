/**
 * Detect provider-side usage-limit messages in raw PTY terminal output.
 *
 * These strings are what Claude Code prints to the terminal when the user's
 * claude.ai plan is exhausted. They were confirmed from the installed binary
 * at /opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe.
 *
 * Keep the strings here as single exported constants so tests can reference
 * them as fixtures without hard-coding them twice.
 */

/** "Usage limit reached" — the primary provider-limit message in Claude Code. */
export const PROVIDER_LIMIT_USAGE_REACHED = 'Usage limit reached';

/** "You've hit your monthly spend limit" — monthly spend cap. */
export const PROVIDER_LIMIT_MONTHLY_SPEND = "You've hit your monthly spend limit";

const PROVIDER_LIMIT_NEEDLES = [PROVIDER_LIMIT_USAGE_REACHED, PROVIDER_LIMIT_MONTHLY_SPEND];

/** Minimum PTY idle time (ms) before we trust a tail scan.
 *  An active PTY whose output happens to contain the needle text is not limited. */
export const PROVIDER_LIMIT_IDLE_MS = 10_000;

/** How many trailing non-empty lines to scan. The usage-limit message is at the
 *  bottom of the terminal; older output scrolled away must not trigger a false positive. */
const TAIL_SCAN_LINES = 10;

/** Strip ANSI/VT escape sequences from raw terminal output (CSI, OSC, simple ESC codes). */
function stripAnsi(raw: string): string {
  // CSI sequences:   ESC [ <params> <intermediate> <final>
  // OSC sequences:   ESC ] ... ST  (ST = BEL or ESC \)
  // Simple escapes:  ESC <single char in 0x40–0x5F>
  return raw.replace(
    /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g,
    '',
  );
}

/**
 * Returns true when:
 *   (a) a recognised provider-limit needle appears in the last few non-empty
 *       lines of `tail` (ANSI codes stripped), AND
 *   (b) the PTY has been silent for at least PROVIDER_LIMIT_IDLE_MS milliseconds
 *       (`idleMs` is the value of `ptyManager.idleFor(ptyId)`).
 *
 * Passing both conditions prevents two false-positive sources:
 *   • An agent that merely *prints* the needle string while working (PTY is busy).
 *   • A needle that scrolled past — later output covers it.
 */
export function detectProviderLimit(tail: string, idleMs: number): boolean {
  if (!tail || idleMs < PROVIDER_LIMIT_IDLE_MS) return false;
  const stripped = stripAnsi(tail);
  const lastLines = stripped.split('\n').filter((l) => l.trim()).slice(-TAIL_SCAN_LINES).join('\n');
  return PROVIDER_LIMIT_NEEDLES.some((needle) => lastLines.includes(needle));
}
