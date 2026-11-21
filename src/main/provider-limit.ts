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

/** Returns true if `tail` (the last N bytes of a live PTY session) contains a
 *  recognised provider-limit message. ANSI escape codes are ignored because the
 *  tail is raw terminal output; the target strings are plain ASCII and appear
 *  unescaped in the output stream. */
export function detectProviderLimit(tail: string): boolean {
  return PROVIDER_LIMIT_NEEDLES.some((needle) => tail.includes(needle));
}
