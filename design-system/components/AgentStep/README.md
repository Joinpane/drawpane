# AgentStep

One step in an agent's plan, shown in the agent pane, in review and in history. Only one step runs at a time and it is highlighted on `agent-soft`; finished steps show a check in `success`.

**Consumer provides:** `label`, `status` (`done`, `running`, `queued`, `failed`, `review`), optional `detail`, `ops` (the typed operations applied, in command syntax) and `meta` (time or cost).

- Write labels as what the agent is doing, present tense, in sentence case: "Adding empty state to Upcoming".
- Show `ops` for the running step and on hover for done steps, so people can see exactly what changed.
- A failed step says what failed and what the agent will do next.
