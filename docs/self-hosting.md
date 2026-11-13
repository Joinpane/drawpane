# Self-hosting Drawpane

Drawpane runs entirely in your own Cloudflare account: one Worker, one Durable Object class (a FileRoom per file), a D1 database for accounts and file lists, and an R2 bucket for snapshots and media. Nothing runs anywhere else, and an idle instance costs only its storage.

A one-command installer (`npm create drawpane`) is on the roadmap for v0.1. Until then, these steps take about ten minutes.

## What you need

- A Cloudflare account on the Workers Paid plan (Durable Objects with SQLite storage need it), and a domain on Cloudflare.
- Node 26 and pnpm 12. With [mise](https://mise.jdx.dev), `mise install` in the repo sets both up.
- An API token with **Workers Scripts**, **Workers Routes**, **D1**, **Workers R2 Storage** and **Zone DNS** edit permissions, exported as `CLOUDFLARE_API_TOKEN`, plus `CLOUDFLARE_ACCOUNT_ID`.

## Steps

1. **Install dependencies**

   ```sh
   pnpm install
   ```

2. **Create the database and bucket**

   ```sh
   cd apps/worker
   npx wrangler d1 create drawpane
   npx wrangler r2 bucket create drawpane-files
   ```

   Put the printed `database_id` into `apps/worker/wrangler.jsonc`.

3. **Point it at your domain.** In `apps/worker/wrangler.jsonc`, set `routes[0].pattern` to your hostname, for example `design.example.com`. Wrangler creates the DNS record and certificate on deploy.

4. **Set the two secrets**

   ```sh
   openssl rand -base64 48 | npx wrangler secret put SESSION_SECRET
   openssl rand -base64 24 | tee /dev/stderr | npx wrangler secret put SETUP_TOKEN
   ```

   Keep the setup token: you need it once, to create the first account.

5. **Apply migrations and deploy**

   ```sh
   pnpm --filter @drawpane/worker run db:migrate:remote
   pnpm deploy
   ```

6. **Create your account.** Open your domain. A fresh instance sends you to **Set up this instance**: enter your name, email and the setup token, then create a passkey. You now own the first team and can invite everyone else from the dashboard.

## Upgrading

Pull the new version, then run step 5 again. Migrations are additive and run before the new Worker takes traffic.

## Backups

Every file keeps its own version history. While a file is being edited, its FileRoom saves a gzip snapshot to R2 (`files/<file-id>/snapshots/`) once editing pauses for 10 minutes, and at least once an hour during long sessions. It also saves one whenever someone names a version, and just before anyone restores one, so a restore can always be undone. Each snapshot has a row in D1's `versions` table that says who edited and what changed.

Unnamed versions are deleted after 30 days, except the newest one. Named versions are kept until the file is deleted. People on the team can open, name and restore versions from the History tab in the editor.

D1 also has 30-day point-in-time recovery built in (`wrangler d1 time-travel`).

## Accounts and security

- Sign-in is passkey-only, so there are no passwords to leak or reset. Every account after the first joins through a single-use invite link that expires after 7 days.
- Sessions are random 256-bit tokens in an `HttpOnly`, `Secure`, `SameSite=Lax` cookie; only their SHA-256 hash is stored.
- The Worker checks your role on every request and hands each file socket to its FileRoom with a signed, 60-second claim that the room verifies.
- No telemetry. Fonts are bundled, so the app makes no third-party requests.
