# NSC-230 More menu report

The global **More** button is in the Paramount top bar. Its Radix dropdown supports standard keyboard menu navigation and Escape dismissal/focus restoration; the content is width-constrained for narrow windows. It links into current screens and invokes the existing floor picker. No lifecycle or runtime command was added.

| Supported action | Council entry point | Existing UI/runtime handler | Result |
| --- | --- | --- | --- |
| Open another floor | More → Open another floor | `floor.picker` → `FloorChooser`; selected floor uses `floor.open` | Available; existing confirmation/lock handling retained |
| Hire/import and agent/temp controls | More → Agents & temps | Team page; hire/import sheets; agent contextual menu uses existing archive, restart, rename, note APIs/commands | Available; agent-specific actions remain contextual |
| Automations | More → Automations | Team page `AutomationsPanel`; `automation.toggle` | Available in existing Team screen |
| Engine and model selection | More → Engines & models | Settings → AI engines; Team & models and agent sheets retain model controls | Available; existing validation retained |
| Live sessions | More → Terminal | Terminal page and existing PTY/session handlers | Available |
| Connections | More → Connections | Settings → Connections; `account.connection` | Available; existing unsupported-state handling retained |
| Preferences | More → Settings | Settings page tabs; existing settings commands | Available |
| Diagnostics | More → Diagnostics | Health page; refresh, copy and export diagnostics actions | Available; diagnostics bundle/save use existing commands |

The menu deliberately does not duplicate contextual agent lifecycle actions or add unsupported controls. Existing screen-level confirmation and validation remain authoritative.

## Verification

- Added a source-level test for menu entries and their route/command targets.
- `npm test`: 46 passed, 10 failed because this checkout has no `ui/node_modules/.bin/tsc`; the failing test files invoke that missing compiler. The new menu test passes.
- `npm run typecheck`: blocked by missing dependencies in this checkout (including `lucide-react`, `radix-ui`, `motion`, and `next-themes`); dependent inferred-type errors follow from the missing packages.
- Build could not be run successfully for the same missing-dependency reason. No packages were installed.
- No running-app interaction was possible in this source-only checkout.
