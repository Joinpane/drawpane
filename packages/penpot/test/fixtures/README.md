# Fixtures

Real `.penpot` exports (binfile v3) from Penpot's own test suite
(`backend/test/backend_tests/test_files/` in penpot/penpot, MPL-2.0):

- `file-with-library.penpot`: two files, one using the other as a library.
- `svg-attrs-camel-case.penpot`: icons drawn as paths, with images and thumbnails.
- `showcase.penpot`: written by `make-showcase.py` (not by Penpot) to the v3 format, covering what
  the real samples lack: text with styled runs, an image fill, flex layout, a rotated layer,
  gradients, a dashed path with an arrow, a masked group, a component and a copy, library colours
  and typographies, two pages and a prototype link.
