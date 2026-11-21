import { randomUUID } from 'node:crypto';

type Operation = 'profile-create' | 'profile-rename' | 'sign-in-start' | 'sign-in-check';
/** Closed projection: never copy labels, homes, credentials, or provider output. */
export function observeAccountOperation<T>(sink: (event: Record<string, unknown>) => void,
  operation: Operation, identity: { provider?: unknown; accountId?: unknown }, run: () => T): T {
  const cid = randomUUID();
  const provider = identity.provider === 'claude' || identity.provider === 'codex' ? identity.provider : 'unknown';
  const accountId = () => typeof identity.accountId === 'string' && /^(acct_[a-f0-9]{24}|dc|dcm|dcx|dcxm)$/.test(identity.accountId) ? identity.accountId : 'provider-default';
  const emit = (outcome: string, state?: string) => {
    try { sink({ kind: 'paramount-account', cid, operation, provider, accountId: accountId(), scope: 'device', outcome, ...(state ? { state } : {}) }); } catch { /* diagnostic failure cannot change account state */ }
  };
  const finish = (value: unknown) => {
    const result = value && typeof value === 'object' ? value as { ok?: unknown; status?: { state?: unknown } } : undefined;
    const state = result?.status?.state;
    emit(result?.ok === false ? 'fail' : 'ok', typeof state === 'string' && ['signed-in', 'signed-out', 'expired', 'unknown'].includes(state) ? state : undefined);
    return value;
  };
  emit('start');
  try {
    const result = run();
    if (result && typeof (result as { then?: unknown }).then === 'function') {
      return Promise.resolve(result).then(finish, error => { emit('fail'); throw error; }) as T;
    }
    finish(result);
    return result;
  } catch (error) { emit('fail'); throw error; }
}
