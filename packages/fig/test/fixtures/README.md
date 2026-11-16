# Fixtures

Real `.fig` files saved by Figma, each with its licence beside it. They're read only as bytes.

| File | What it covers | Source | Licence |
| --- | --- | --- | --- |
| `pattern.fig` | A zipped file (format version 95, zstd): ten pages, components, variant sets, text styles | [Pattern-Design/Figma](https://github.com/Pattern-Design/Figma) at `9b05977e`, `Pattern.fig` | MIT, `pattern.LICENSE` |
| `tailwind-ecklf.fig` | An older raw file (version 4, deflate, no zip): instances nested in instances, styles linked the old way, images among the file's blobs | [ecklf/tailwindcss-figma-kit](https://github.com/ecklf/tailwindcss-figma-kit) at `cc5cf150`, `Tailwind CSS UI.fig` | MIT, `tailwind-ecklf.LICENSE` |
| `medianova.fig` | A zipped file (version 52) with images in `images/`, adjusted images, components and instances, boolean groups, polygons and DesignCompose widgets | [google/automotive-design-compose](https://github.com/google/automotive-design-compose) at `64e7595c`, `reference-apps/aaos-unbundled/mediacompose/figma_files/MediaNova_V2.fig` | Apache-2.0, `medianova.LICENSE` |

`test/fig-compat.test.ts` runs larger files from a folder of your own (`FIG_FILES`); those aren't committed.
