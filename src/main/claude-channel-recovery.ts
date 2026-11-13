import { createHash } from 'node:crypto';

export const TELEGRAM_CHANNEL = 'plugin:telegram@claude-plugins-official';
export interface ClaudeChannelPlan { original: string; updated: string; changed: string[]; sha256: string }

/** Prepare a narrowly scoped edit to the three documented Claude launcher functions. */
export function prepareClaudeTelegramChannel(original: string, syntaxCheck: (text: string) => boolean): ClaudeChannelPlan {
  let updated = original;
  const changed: string[] = [];
  for (const name of ['claude', 'dc', 'dcm']) {
    const pattern = new RegExp(`^function ${name}\\(\\)\\s*\\{[\\s\\S]*?^\\}`, 'm');
    const match = pattern.exec(updated);
    if (!match) throw new Error(`Missing launcher ${name}; no changes made.`);
    const body = match[0];
    if (body.includes(`--channels ${TELEGRAM_CHANNEL}`)) continue;
    if (body.includes('--channels')) throw new Error(`${name} already configures channels; no changes made.`);
    const line = /^(\s*(?:CLAUDE_CONFIG_DIR="\$HOME\/\.claude-minion"\s+)?command claude[^\n]*?)\s+"\$@"\s*$/m;
    const replacement = body.replace(line, (_all, prefix: string) => `${prefix} --channels ${TELEGRAM_CHANNEL} "$@"`);
    if (replacement === body) throw new Error(`Unexpected ${name} definition; no changes made.`);
    updated = updated.slice(0, match.index) + replacement + updated.slice(match.index + body.length);
    changed.push(name);
  }
  if (!syntaxCheck(updated)) throw new Error('The proposed shell configuration failed syntax checking; no changes made.');
  return { original, updated, changed, sha256: createHash('sha256').update(original).digest('hex') };
}
