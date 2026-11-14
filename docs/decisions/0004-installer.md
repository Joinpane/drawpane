# 0004. `npm create drawpane`: installing and upgrading an instance

- Status: accepted
- Date: 2026-11-14
- Deciders: Ziyang (lead maintainer)

## Context

The PRD makes self-hosting the primary way to run Drawpane, and promises "`npm create drawpane` installer, one-command upgrade" for v0.1. Today a self-hoster clones the monorepo, installs pnpm and Node 26, creates a D1 database and an R2 bucket by hand, pastes an id into `wrangler.jsonc`, generates two secrets, applies migrations and deploys: about ten minutes and nine chances to slip. Upgrading means pulling the repo and repeating the last steps.

Someone running an instance shouldn't need our toolchain, our repository, or to know what D1 is.

## Decision

**One package, `create-drawpane`, carries a built server.** Publishing it bundles the Worker (already a single module from `wrangler deploy --dry-run`), the web app's built assets, and the D1 migrations, all for one exact Drawpane version. Installing needs Node and nothing else: no clone, no pnpm, no build.

**The instance is a folder.** `npm create drawpane my-design` makes `my-design/` with:

- `drawpane.json`: what the installer chose (account, Worker name, database and bucket names, domain) and the Drawpane version deployed. It's the instance's source of truth, small enough to read and commit.
- `wrangler.jsonc`: generated from `drawpane.json` and the release's template, never edited by hand (it says so).
- `server/`: the release's Worker, assets and migrations, replaced on upgrade.

**Wrangler does the Cloudflare work, under the person's own login.** The installer depends on a pinned Wrangler and drives it: `whoami --json` to find accounts (and `login` when there's no session or `CLOUDFLARE_API_TOKEN`), `d1 create` and `d1 list --json` for the database, `r2 bucket create`, `d1 migrations apply --remote`, then `deploy`. Secrets go up with the first deploy through `--secrets-file` (a temporary file, deleted straight after), so they never touch the shell history or the folder.

**A workers.dev address works out of the box.** The domain is optional: without one, the instance lives at `<name>.<subdomain>.workers.dev`, which already has HTTPS, so passkeys work. With one (a hostname on a zone in the account), the installer passes `--domain` and Wrangler makes the DNS record and certificate. Either can be changed later by editing `drawpane.json` and running `upgrade`.

**Every step is safe to run again.** Resources are found by name before being created, and `drawpane.json` records each step as it completes, so an interrupted install continues where it stopped instead of creating duplicates.

**Upgrading is one command in the folder:** `npm create drawpane@latest upgrade`. It refuses to go backwards, swaps in the new `server/`, regenerates `wrangler.jsonc`, applies new migrations, then deploys (migrations are additive, so the old Worker keeps working until the new one takes over). Secrets are left as they are.

**It's scriptable.** Every question has a flag (`--account`, `--name`, `--domain`, `--yes`), and with `--yes` and no TTY it never prompts: CI can install and upgrade.

**The end is the setup page.** The installer waits for `/api/health`, then prints the address and the one-time setup token, and opens `/setup` in the browser.

## Consequences

- One more package to publish with each release, and a release step that builds the server into it. The repo's own dogfood deploy will use the installer, so it's exercised every release.
- The installer pins a Wrangler version; a release bumps it like any dependency.
- `create-drawpane` is large for an npm create package (the web app's assets and the Worker with its source map, about 16 MB), but it's downloaded once per install or upgrade.
- The manual steps in `docs/self-hosting.md` stay, as the reference for what the installer does.
