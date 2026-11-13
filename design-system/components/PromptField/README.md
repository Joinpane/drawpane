# PromptField

Where people talk to an agent: the agent pane, @drawpane replies and the skills editor. Context chips show exactly what the agent can see (the selection, a library, an attached file), and the footer shows which model runs and who pays for it.

**Consumer provides:** `value` or `placeholder`, `context` chips, `model` label, and `running` to swap Send for Stop.

- Send is a `signal` button because sending is your action. While the agent runs it becomes Stop, on `surface-inverse`.
- Typing `/` opens skills; `@` adds a layer, file or person as context.
- Enter sends, Shift+Enter adds a line.
