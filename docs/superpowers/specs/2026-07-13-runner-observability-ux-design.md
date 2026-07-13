# Runner Observability UX Design

## Goal

Replace the default Runner V2 diagnostic grids with information an end user can act on, without removing the durable audit data developers need.

## Default presentation

The panel is titled **Build activity** and contains three sections:

1. **Progress** — summarize completed versus total tasks, show the current lifecycle state in plain language, and list task objectives with human-readable statuses.
2. **Verification** — collapse evidence into task-level categories such as tests, browser checks, and source-control checks. Prefer the newest fact in each category so a successful rerun replaces an earlier failure in the default view.
3. **Problems requiring attention** — show only active blockers: provider cooldowns, suspended agents, unanswered blocking guidance, failed/rejected tasks, integration conflicts, or a paused/failed run without a more specific problem. When none exist, explicitly say that no active blockers remain.

Internal IDs, raw event names, sequence numbers, tool call names, skill inventories, process commands, and historical failures do not appear in the default view.

## Advanced diagnostics

All existing raw information remains available in a collapsed native `<details>` section named **Advanced diagnostics**. Search and **Download audit** live inside this section. The drawer retains technical counters and the current raw lists for agents, tools, evidence, context resources, providers, events, guidance, Git/integration, and background processes.

The drawer is collapsed by default, keyboard accessible through native disclosure semantics, and requires no new persistence or Runner events.

## Interpretation rules

- Task statuses are translated into plain language; objectives are more prominent than task IDs.
- Evidence is grouped by task and category, keeping the newest record per group.
- Exit code `0` means passed, a non-zero exit code means failed, and `null` means evidence captured without a command verdict.
- Historical tool errors are audit data, not active blockers.
- Provider health appears in the default view only when a provider is in cooldown.
- An unanswered blocking guidance request is an active blocker; answered guidance remains audit data.
- Project handoff is expressed as “Ready for your decision,” never as an internal event name.

## Visual direction

Keep the existing AI Board dark visual language. Use three quiet, readable cards with semantic icon/color accents rather than another metrics dashboard. The signature element is a compact lifecycle sentence at the top of Progress that translates durable Runner state into human language. Technical monospace styling is confined to Advanced diagnostics.

## Testing

Extend the existing source-level observability contract to cover:

- user-facing section names and the collapsed Advanced diagnostics disclosure;
- absence of raw diagnostic lists outside the disclosure;
- friendly lifecycle and task status labels;
- newest-per-category evidence selection;
- active-problem detection and the no-blockers state;
- preservation of search, audit download, and raw diagnostic sections inside Advanced diagnostics.
