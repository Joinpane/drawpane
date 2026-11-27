# vello_common 0.4.0, vendored

Decision 0040 pins Vello and lets the engine carry patches to it. This is `vello_common` 0.4.0
from crates.io, unchanged except:

- `assets/` (the `probe` feature's reference images) and `Cargo.toml.orig` are left out: the
  engine never enables `probe`.

Patches are marked `Drawpane:` in the code. Upgrading Vello means taking the new release and
carrying the patches again.
