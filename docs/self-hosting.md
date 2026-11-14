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

3. **Choose your domain.** You pass it when you deploy (step 5), so it stays out of the repository. Wrangler creates the DNS record and certificate the first time.

4. **Set the two secrets**

   ```sh
   openssl rand -base64 48 | npx wrangler secret put SESSION_SECRET
   openssl rand -base64 24 | tee /dev/stderr | npx wrangler secret put SETUP_TOKEN
   ```

   Keep the setup token: you need it once, to create the first account.

5. **Apply migrations and deploy**

   ```sh
   pnpm --filter @drawpane/worker run db:migrate:remote
   pnpm run deploy --domain design.example.com
   ```

6. **Create your account.** Open your domain. A fresh instance sends you to **Set up this instance**: enter your name, email and the setup token, then create a passkey. You now own the first team and can invite everyone else from the dashboard.

## Upgrading

Pull the new version, then run step 5 again. Migrations are additive and run before the new Worker takes traffic.

## Fonts

The font picker offers the open-source Google Fonts catalog. The first time someone uses a family, the Worker fetches it from Google and keeps a copy in your R2 bucket (under `fonts/gstatic/`). After that, everyone loads it from your server: browsers never contact Google, and files keep rendering even if Google changes the font or removes it.

Teams can also upload their own fonts (TrueType, OpenType, WOFF or WOFF2) from **Fonts** in the dashboard. They're kept in your R2 bucket under `fonts/team/`, read on upload for their family, weight and style, and served only to members of the team that uploaded them.

To keep the Worker from contacting Google at all, set `GOOGLE_FONTS` to `off` in the `vars` of `wrangler.jsonc`. The picker then offers only the built-in fonts, system fonts and fonts installed on each person's computer.

## Signing in with GitHub or Google

Passkeys work out of the box. To also offer **Continue with GitHub** and **Continue with Google**, create an OAuth app with each provider and give the Worker its client id and secret. Each button appears only once both values for that provider are set.

| Provider | Where to create it | Callback URL to register |
| --- | --- | --- |
| GitHub | GitHub → Settings → Developer settings → OAuth Apps → **New OAuth App** | `https://<your-domain>/api/auth/oauth/github/callback` |
| Google | Google Cloud console → APIs & Services → Credentials → **Create credentials → OAuth client ID** (type "Web application") | `https://<your-domain>/api/auth/oauth/google/callback` |

Then store the values as secrets:

```sh
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

Who gets in stays the same: signing in with a provider finds an existing account by the provider account you connected, or by an email address the provider has verified. A new account still needs an invite link, which can then be accepted with **Join with GitHub** or **Join with Google**. Everyone can connect or disconnect providers and add passkeys under **Account** (click your name in the dashboard). The last way to sign in can't be removed.

## Backups

Every file keeps its own version history. While a file is being edited, its FileRoom saves a gzip snapshot to R2 (`files/<file-id>/snapshots/`) once editing pauses for 10 minutes, and at least once an hour during long sessions. It also saves one whenever someone names a version, and just before anyone restores one, so a restore can always be undone. Each snapshot has a row in D1's `versions` table that says who edited and what changed.

Unnamed versions are deleted after 30 days, except the newest one. Named versions are kept until the file is deleted. People on the team can open, name and restore versions from the History tab in the editor.

D1 also has 30-day point-in-time recovery built in (`wrangler d1 time-travel`).

## Accounts and security

- There are no passwords to leak or reset: people sign in with passkeys, and with GitHub or Google if you set them up (see above). Every account after the first joins through a single-use invite link that expires after 7 days.
- Provider sign-in uses the authorization-code flow with PKCE and a signed, 10-minute state cookie. A provider account is matched to an existing account only through an email address the provider has verified.
- Sessions are random 256-bit tokens in an `HttpOnly`, `Secure`, `SameSite=Lax` cookie; only their SHA-256 hash is stored.
- The Worker checks your role on every request and hands each file socket to its FileRoom with a signed, 60-second claim that the room verifies.
- No telemetry. Fonts are bundled, so the app makes no third-party requests.
