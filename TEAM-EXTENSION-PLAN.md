# NSC-193 editable teams extension plan

1. Persist a versioned `council/extensions/teams.json` with team ids/names, lead ids, member ids, and per-agent `reportsTo` edges. Reject unknown agents, duplicate ids, self-reporting, and reporting cycles before an atomic write. The existing graph projection will read these edges.
2. Add Team commands and an editor for creating/renaming teams, selecting existing leads/members, and assigning reporting lines. No hire, budget, or concurrency settings are exposed or changed.
3. Add a bounded delegation command: one parent board task assigned to the selected team's lead, up to eight child tasks with explicit existing-member owners and dependency edges, atomically added to the task ledger. Send each owner a request through existing hive messaging; include prerequisite task keys in the task instructions. Do not create agents or increase budgets.
4. Project team and parent-task ownership onto board cards. Show each agent's team memberships and open/blocked task counts in the existing reporting tree.
5. Verify validation, persistence, dependency mapping, and message recipients with focused tests and typechecks. Package and interactive acceptance remain a separate recovery-build blocker already recorded.
