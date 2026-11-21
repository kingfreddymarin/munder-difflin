export type ExecutionPolicy = 'inherit' | 'workspace-ask' | 'workspace-auto' | 'full-ask' | 'full-auto';
export function ExecutionPolicySelect({ value, onChange }: { value: string; onChange: (value: ExecutionPolicy) => void }) {
  return <div className="space-y-2">
    <label className="text-sm block">Codex execution permissions
      <select className="bg-background w-full rounded-md border p-2 text-sm" value={value} onChange={e => onChange(e.target.value as ExecutionPolicy)}>
        <option value="inherit">Keep launcher permissions</option>
        <option value="workspace-ask">Workspace only · ask for exceptions</option>
        <option value="workspace-auto">Workspace only · deny exceptions</option>
        <option value="full-ask">Full device access · approvals on request</option>
        <option value="full-auto">Full device access · no approval prompts</option>
      </select>
    </label>
    <p className="text-muted-foreground text-xs">Applies to new or restarted local Codex sessions, including temps. Explicit choices replace launcher sandbox and approval flags. Full access allows commands outside the workspace and network access. Managed restrictions still apply. Remote sessions use their server’s permissions; this control cannot change them. Other engines use their own permissions and the auto-mode setting.</p>
  </div>;
}
