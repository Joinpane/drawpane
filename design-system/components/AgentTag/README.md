# AgentTag

Names an AI agent wherever it appears: in the PresenceStack, on its cursor, in history and in reviews. The chip is always the `agent` color with `on-agent` text, so an agent is never mistaken for a person.

**Consumer provides:** `name` (the agent or MCP client), `status` (`working`, `waiting`, `idle`, `stopped`), and `onBehalfOf`, the person who started it.

- Always show who the agent works for when there's room: "Claude, for Ana".
- An agent on the canvas uses a dashed 1.5px `agent` outline for its selection and the same tag on its cursor.
- Never use the `agent` color for people or for your own selection.
