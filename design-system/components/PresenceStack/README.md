# PresenceStack

Avatars of everyone in the file, each ringed in their presence color. The same color marks their cursor, name tag and selected layers, so one color identifies one person everywhere.

**Consumer provides:** `people` (`name`, optional `initials`, `color` slot 1–8, `where`), and `max` before the stack collapses into a "+n" chip (default 4).

- Clicking an avatar enters follow mode; the ring then thickens to 3px.
- Presence never uses `signal`, which is reserved for your own selection.
- Fill avatars with initials on `surface-raised`, not photos, in dense chrome. Photos are fine on the dashboard.
