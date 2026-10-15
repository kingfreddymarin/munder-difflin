// Sample `terminal.artifacts` answers for the mock provider (lane e-terminal).
import type { ParamountArtifactMap } from './paramount-api';

const root = '/Users/you/worktrees/compute-lead/NSC-30';

export const artifactMaps: Record<string, ParamountArtifactMap> = {
  cl: {
    agentId: 'cl', cwd: root,
    repo: { root, branch: 'compute-lead/NSC-30', head: 'a41c9e2' },
    artifacts: [
      { kind: 'changed', label: 'packaging/macos/sign.sh', path: `${root}/packaging/macos/sign.sh`, dir: `${root}/packaging/macos`, status: 'M' },
      { kind: 'changed', label: 'packaging/macos/notes.md', path: `${root}/packaging/macos/notes.md`, dir: `${root}/packaging/macos`, status: '??' },
      { kind: 'commit', label: 'Sign the DMG with the release identity', commit: 'a41c9e2', at: '2026-10-14T23:35:00-06:00', dir: root },
      { kind: 'committed', label: 'pipelines/def-435.yml', path: `${root}/pipelines/def-435.yml`, dir: `${root}/pipelines`, commit: 'a41c9e2', at: '2026-10-14T23:35:00-06:00' },
      { kind: 'link', label: 'https://github.com/varium/compute/pull/23572', url: 'https://github.com/varium/compute/pull/23572', at: '2026-10-14T23:38:00-06:00', messageId: 'm5' },
      { kind: 'mentioned', label: '/Users/you/worktrees/compute-lead/NSC-30/build/out.log', path: '/Users/you/worktrees/compute-lead/NSC-30/build/out.log', at: '2026-10-14T23:37:00-06:00' },
    ],
    warnings: [],
  },
  pw: {
    agentId: 'pw', cwd: '/Users/you/worktrees/pipeline-worker/ADO-19876', repo: null, artifacts: [],
    warnings: [{ errorId: 'term-5c1d02', source: 'git', message: 'Not a git working tree (fatal: not a git repository)' }],
  },
};
