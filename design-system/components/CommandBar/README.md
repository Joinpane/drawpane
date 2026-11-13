# CommandBar

The spine of Drawpane. `⌘K` opens one bar that runs any command, jumps to any layer or page, and sets properties with short syntax: `w 320`, `gap 16`, `fill brand/500`, `radius sm`. Property commands preview the change as a diff (old value struck, new value in `signal-ink`) and apply to the current selection.

**Consumer provides:** `query`, `groups` of items (`label`, `icon`, `hint`, `shortcut`, `active`, `from` and `to` for property changes), and `scope`, a short description of what the command will act on.

- The first result is always active, so Enter does the obvious thing.
- Tab completes a property or token name; Enter runs the command.
- Results are grouped as Set property, Layers, Components, Actions and Help, in that order, and only non-empty groups show.
- The command bar never opens a dialog to ask for a value it could have taken as syntax.
