# Releasing

A Drawpane release is a version of [`create-drawpane`](https://www.npmjs.com/package/create-drawpane) on npm. The installer carries the built Worker, web app and migrations for that version, so publishing it is what makes the version installable (`npm create drawpane`) and upgradable (`npm create drawpane@latest upgrade`).

## Cutting a release

1. **Bump the version** in `packages/create-drawpane/package.json`, in a pull request like any other change ("Release 0.1.1"). Follow semver: a patch for fixes, a minor for features, a major when an upgrade needs something from the person running the instance.
2. **Once it's merged, tag `main`** with the same version and push the tag:

   ```sh
   git checkout main && git pull
   git tag v0.1.1
   git push origin v0.1.1
   ```

3. The [Release workflow](.github/workflows/release.yml) does the rest:
   - checks the tag matches the package's version;
   - runs lint, typecheck, tests and the build;
   - dry-runs a deploy of the release;
   - packs it and checks the packed installer runs from a clean folder;
   - publishes it to npm with provenance;
   - creates a GitHub release with notes and the tarball.

   Nothing is published if any step fails. Fix it, delete the tag (`git push origin :v0.1.1`), and tag again.

## How publishing is authorized

The workflow publishes with npm's [trusted publishing](https://docs.npmjs.com/trusted-publishers): npm accepts a short-lived identity from GitHub Actions for this repository and workflow, so no npm token is stored anywhere, and each version records the commit and workflow that built it.

This needs a one-time setup on npmjs.com, by a maintainer of the package:

1. Open [create-drawpane's settings](https://www.npmjs.com/package/create-drawpane/access) and choose **Trusted Publisher → GitHub Actions**.
2. Enter organization `Joinpane`, repository `drawpane`, workflow `release.yml`, environment `npm`.
3. Once a release has published this way, set **Publishing access** to "Require two-factor authentication and disallow tokens", so trusted publishing is the only way in.

The workflow's `npm` environment can also require a reviewer's approval before publishing (repository Settings → Environments → npm).
