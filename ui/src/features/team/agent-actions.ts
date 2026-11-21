import * as React from 'react';
import { findBridge } from '@/data/bridge';
import { useTeamApi } from '@/data/store';
import { useRouter } from '@/app/router';
import { AGENT_VIEW, agentViewParams } from '@/app/agent-view';

export type AgentActionId =
  | 'open-terminal'
  | 'open-profile'
  | 'rename'
  | 'pause'
  | 'restart'
  | 'archive'
  | 'send-note';

export type AgentActionDef = {
  id: AgentActionId;
  label: string;
  disabled: boolean;
};

export type AgentActionsCallbacks = {
  onClose?: () => void;
  onRenameStart?: () => void;
  onNoteStart?: () => void;
  onRestartStart?: () => void;
};

export type AgentActionsResult = {
  actions: AgentActionDef[];
  /** True when the agent is on hold — Michael stops routing work to it. */
  onHold: boolean;
  run: (id: AgentActionId) => Promise<void>;
  /** Call after the user provides a new name. Uses hiveRenameAgent (preload).
   *  Chosen over autoDeliveryPausedAgents because it tells Michael to stop routing
   *  ALL work, not just automatic inbox delivery. */
  renameAgent: (newName: string) => Promise<{ ok: boolean; name?: string; error?: string }>;
};

export function useAgentActions(
  agentId: string,
  callbacks: AgentActionsCallbacks = {},
): AgentActionsResult {
  const teamApi = useTeamApi();
  const { go } = useRouter();
  const [onHold, setOnHold] = React.useState(false);

  const callbacksRef = React.useRef(callbacks);
  callbacksRef.current = callbacks;

  const run = React.useCallback(
    async (id: AgentActionId): Promise<void> => {
      const cb = callbacksRef.current;
      const bridge = findBridge();
      switch (id) {
        case 'open-terminal':
          go(AGENT_VIEW, agentViewParams(agentId));
          cb.onClose?.();
          break;
        case 'open-profile':
          go('team', { agent: agentId });
          cb.onClose?.();
          break;
        case 'pause': {
          if (!bridge?.hiveSetAgentHold) break;
          const next = !onHold;
          const result = await bridge.hiveSetAgentHold(agentId, next);
          if (result.ok) setOnHold(next);
          break;
        }
        case 'rename':
          cb.onRenameStart?.();
          break;
        case 'restart':
          cb.onRestartStart?.();
          break;
        case 'archive':
          if (teamApi?.archiveAgent) {
            await teamApi.archiveAgent(agentId, true);
            cb.onClose?.();
          }
          break;
        case 'send-note':
          cb.onNoteStart?.();
          break;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [agentId, onHold, go, teamApi],
  );

  const renameAgent = React.useCallback(
    async (newName: string) => {
      const bridge = findBridge();
      if (!bridge?.hiveRenameAgent) return { ok: false as const, error: 'Not available' };
      return bridge.hiveRenameAgent(agentId, newName);
    },
    [agentId],
  );

  const actions = React.useMemo(
    (): AgentActionDef[] => [
      { id: 'open-terminal', label: 'Open terminal', disabled: false },
      { id: 'open-profile', label: 'Open profile', disabled: false },
      { id: 'rename', label: 'Rename…', disabled: false },
      { id: 'pause', label: onHold ? 'Resume' : 'Pause', disabled: false },
      { id: 'restart', label: 'Restart…', disabled: false },
      { id: 'archive', label: 'Archive', disabled: !teamApi?.archiveAgent },
      { id: 'send-note', label: 'Send note…', disabled: !teamApi?.sendNote },
    ],
    [onHold, teamApi],
  );

  return { actions, onHold, run, renameAgent };
}
