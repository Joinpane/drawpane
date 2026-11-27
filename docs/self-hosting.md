# Self-hosting Drawpane

Drawpane runs entirely in your own Cloudflare account: two Workers, a D1 database for accounts and file lists, and an R2 bucket for snapshots and media. The main Worker serves the app and holds a FileRoom (a Durable Object) per file. The agent runner (`<name>-agent-runner`) runs AI agents' tools, with an AgentRunner Durable Object per file, so an agent's heavy call can never disconnect the people editing (decision 0033). It has no route, no address and no secrets: only the main Worker calls it. Nothing runs anywhere else, and an idle instance costs only its storage.

## Install

You need a Cloudflare account and Node 22 or newer. Agent tools need the Workers Paid plan (see [The Workers Free plan](#the-workers-free-plan)). The two Workers count toward your account's limit on Workers (100 on the Free plan). Then:

```sh
npm create drawpane my-design
```

The installer:

1. Signs you in to Cloudflare in your browser (or uses `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` when they're set).
2. Asks which account to use, what to call the Worker, and whether to serve it on your own domain. Leave the domain empty for a free `<name>.<subdomain>.workers.dev` address; a domain has to be on a zone in the same account.
3. Creates a D1 database and an R2 bucket, applies the migrations, and deploys: the agent runner first, then the main Worker with a generated session secret and a one-time setup token. The main Worker binds the runner by its name, so the runner has to exist first.
4. Opens the setup page with the token filled in. Create your account there: you own the first team and can invite everyone else.

To try a version that isn't released yet, run the installer from a clone of this repository: `pnpm install && pnpm build && node packages/create-drawpane/dist/cli.js my-design`.

The folder it makes (`my-design/`) is your instance: `drawpane.json` records what was chosen and what's deployed, `wrangler.jsonc` (the main Worker) and `agent-runner.wrangler.jsonc` (the runner) are generated from it, and `server/` holds the release. Keep it; you upgrade from it. It holds no secrets, so it's safe to commit. If an install is interrupted, run the same command again: it picks up where it stopped and never creates anything twice.

For scripts and CI, every question has a flag: `npm create drawpane my-design -- --yes --account <name or id> --domain design.example.com`. See `--help`.

### The Workers Free plan

Agent tools need Workers Paid: on Free, a Worker can't set the CPU limit they need, and 10 ms of CPU can't build an editor for a real file. The rest of Drawpane works on Free within its limits: without the main Worker's five-minute CPU limit, importing, restoring or merging a very large file (hundreds of thousands of layers) can run out of CPU.

When Cloudflare refuses the first deploy because the account is on Free (its error 100328, "CPU limits are not supported for the Free plan."), the installer says so, records `"plan": "free"` in `drawpane.json`, and deploys again without the runner. If Cloudflare refuses the CPU limit in other words, the installer asks whether the account is on Free, or, when it can't ask, keeps agent tools on and stops with a warning. You can also say so up front with `--plan free`. With `--plan paid`, it never turns agent tools off. On Free, the main Worker is deployed without its CPU limit and without the runner's binding, with `AGENT_TOOLS` set to `off`, and agents connecting over MCP are told that agent tools need Workers Paid.

After moving to Workers Paid, in the instance's folder:

```sh
npm create drawpane@latest upgrade -- --plan paid
```

It deploys the runner, then the main Worker with agent tools on.

## Upgrading

In the instance's folder:

```sh
npm create drawpane@latest upgrade
```

It swaps in the new release, applies new database migrations (additive, so the running version keeps working), and deploys the agent runner, then the main Worker. Secrets and data are left as they are. It won't move an instance to an older version. An instance from before the agent runner gets it on its next upgrade: `drawpane.json` gains `"runner": "<name>-agent-runner"`, and the runner is deployed before the main Worker.

The instance's **Health and cost** page (the bolt beside your name in the dashboard, for whoever set the instance up) shows the version it runs, and says when a newer one is out, with its release notes and this command. To know that, the Worker asks the npm registry for `create-drawpane`'s latest version when the page is opened, at most once every six hours. To turn that off, add `"vars": { "UPDATE_CHECK": "off" }` to `drawpane.json` and run `npm create drawpane@latest upgrade -- --force`.

### Compact copies

Since component copies are stored compactly (decision 0029), each file stored the older way converts the first time it's opened after the upgrade: a version named "Before compact copies" is saved first, then the file converts in steps of a few seconds while it stays open for editing, and everyone in it reloads it when it's done. An instance that can't be converted exactly is detached instead (it looks the same and stops following its component), and the Worker's log says which and why. To stop conversions, and have new files and imports use the older form, add `"vars": { "COMPACT_COPIES": "off" }` to `drawpane.json` and run the upgrade command again; files already converted stay converted. With it off, restoring a file's "Before compact copies" version puts it back as it was stored before.

## Installing by hand

The installer runs these steps; they're here as a reference, or for setups it doesn't cover. They take about ten minutes. You need:

- Node 26 and pnpm 12. With [mise](https://mise.jdx.dev), `mise install` in the repo sets both up.
- An API token with **Workers Scripts**, **Workers Routes**, **D1**, **Workers R2 Storage** and **Zone DNS** edit permissions, exported as `CLOUDFLARE_API_TOKEN`, plus `CLOUDFLARE_ACCOUNT_ID`.
- Workers Paid, for agent tools. On Free, see step 5.

Then:

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

   Put the printed `database_id` into `apps/worker/wrangler.jsonc` and `apps/agent-runner/wrangler.jsonc`. Both Workers use the same database and bucket.

3. **Choose your domain.** You pass it when you deploy (step 5), so it stays out of the repository. Wrangler creates the DNS record and certificate the first time.

4. **Set the two secrets**

   ```sh
   openssl rand -base64 48 | npx wrangler secret put SESSION_SECRET
   openssl rand -base64 24 | tee /dev/stderr | npx wrangler secret put SETUP_TOKEN
   ```

   Keep the setup token: you need it once, to create the first account.

5. **Apply migrations and deploy**, the agent runner first: the main Worker binds it by name (`script_name` in its `AGENT_RUNNER` binding), so it has to exist.

   ```sh
   pnpm --filter @drawpane/worker run db:migrate:remote
   pnpm run deploy --domain design.example.com
   ```

   `pnpm run deploy` builds both Workers, deploys the runner (`pnpm --filter @drawpane/agent-runner run deploy`), then the main Worker (`pnpm --filter @drawpane/worker run deploy`, with your domain). To deploy them one at a time, run those two in that order. The runner is `drawpane-agent-runner` here. To name it otherwise, change `name` in `apps/agent-runner/wrangler.jsonc` and `script_name` in `apps/worker/wrangler.jsonc` to match. On the Workers Free plan, skip the runner, and in `apps/worker/wrangler.jsonc` remove `limits` and the `AGENT_RUNNER` binding and add `"AGENT_TOOLS": "off"` to `vars`.

6. **Create your account.** Open your domain. A fresh instance sends you to **Set up this instance**: enter your name, email and the setup token, then create a passkey. You now own the first team and can invite everyone else from the dashboard.

To upgrade an instance installed by hand, pull the new version and run step 5 again, runner first. Migrations are additive and run before the new Worker takes traffic.

## Fonts

The font picker offers the open-source Google Fonts catalog. The first time someone uses a family, the Worker fetches it from Google and keeps a copy in your R2 bucket (under `fonts/gstatic/`). After that, everyone loads it from your server: browsers never contact Google, and files keep rendering even if Google changes the font or removes it.

Text that sets a variable font's axes (width, slant and so on, beyond weight) needs the family's variable font file. For Google families the Worker finds it in Google's download list for the family (`fonts.google.com/download/list`), then fetches and keeps it like any other font file.

Teams can also upload their own fonts (TrueType, OpenType, WOFF or WOFF2) from **Fonts** in the dashboard. They're kept in your R2 bucket under `fonts/team/`, read on upload for their family, weight and style, and served only to members of the team that uploaded them.

To keep the Worker from contacting Google at all, set `GOOGLE_FONTS` to `off`: in an installed instance, add `"vars": { "GOOGLE_FONTS": "off" }` to `drawpane.json` and run `npm create drawpane@latest upgrade -- --force` in its folder; installed by hand, put it in the `vars` of `wrangler.jsonc`. The picker then offers only the built-in fonts, system fonts and fonts installed on each person's computer.

## Kit store

**Kit store** in the dashboard lists UI kits, libraries and templates from a registry, by default [Joinpane/drawpane-kits](https://github.com/Joinpane/drawpane-kits): Penpot's community hub, passed through as Penpot publishes it, and kits hosted in the registry itself. Adding a kit downloads its file from where the registry says it's hosted (for Penpot's, `penpot.github.io`) and imports it into the team's **Kits** project.

Browsers only ever talk to your server: the Worker fetches the registry's list, covers and kit files for them, only for kits the list names, and never stores a kit's file (it streams through). Your instance therefore contacts `raw.githubusercontent.com` when someone opens the store, and the kit's host when someone adds one.

To use your own registry (a fork of drawpane-kits, say), set `KIT_REGISTRY` to the URL of its `index.json`; to turn the store off, set it to `off`. In an installed instance, add it to the `vars` in `drawpane.json` and run `npm create drawpane@latest upgrade -- --force`; installed by hand, put it in the `vars` of `wrangler.jsonc`.

## Signing in with GitHub or Google

Passkeys work out of the box. To also offer **Continue with GitHub** and **Continue with Google**, create an OAuth app with each provider and give the Worker its client id and secret. Each button appears only once both values for that provider are set.

| Provider | Where to create it | Callback URL to register |
| --- | --- | --- |
| GitHub | GitHub → Settings → Developer settings → OAuth Apps → **New OAuth App** | `https://<your-domain>/api/auth/oauth/github/callback` |
| Google | Google Cloud console → APIs & Services → Credentials → **Create credentials → OAuth client ID** (type "Web application") | `https://<your-domain>/api/auth/oauth/google/callback` |

Then store the values as secrets, from the instance's folder (or `apps/worker`, installed by hand):

```sh
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

Who gets in stays the same: signing in with a provider finds an existing account by the provider account you connected, or by an email address the provider has verified. A new account still needs an invite link, which can then be accepted with **Join with GitHub** or **Join with Google**. Everyone can connect or disconnect providers and add passkeys under **Account** (click your name in the dashboard). The last way to sign in can't be removed.

## Email

Email is optional and off by default. Without it, mentions and replies show up in each person's **Inbox** in Drawpane, and invites are links you share. With it, Drawpane can also email people about them.

The quickest way is the installer, in the instance's folder:

```sh
npm create drawpane@latest email
```

It asks which way to send and what that needs (an API key, or an SMTP server and its login), and saves the answers as the Worker's secrets: they stay through upgrades. Run it again to switch to another provider (the old one's keys are removed) or to turn email off. Cloudflare Email Service also deploys the Worker again, with its `send_email` binding, so the installer has to carry the version the instance runs: upgrade first if it doesn't.

For scripts and CI, `npm create drawpane@latest email -- --yes` reads the same settings from the environment (`EMAIL_PROVIDER`, `EMAIL_FROM` and the provider's, as in the table below), and says everything that's missing at once.

### By hand

Set everything with `npx wrangler secret put`, from the instance's folder (or `apps/worker`, installed by hand): secrets stay through upgrades, and `EMAIL_PROVIDER` and `EMAIL_FROM` aren't sensitive but are kept the same way.

```sh
npx wrangler secret put EMAIL_PROVIDER   # cloudflare, resend, postmark, sendgrid, mailgun, ses or smtp
npx wrangler secret put EMAIL_FROM       # e.g. Drawpane <design@example.com>
```

Then the provider's credentials:

| Provider | Also set | Notes |
| --- | --- | --- |
| Cloudflare Email Service (`cloudflare`) | A `send_email` binding named `EMAIL` on the Worker (the installer adds it; by hand, add `"send_email": [{ "name": "EMAIL" }]` to `wrangler.jsonc`) | No key. Onboard your sending domain in the Cloudflare dashboard first; until then it only reaches verified addresses. Needs Workers Paid. |
| Resend (`resend`) | `EMAIL_API_KEY` | Verify the domain of `EMAIL_FROM` in Resend. |
| Postmark (`postmark`) | `EMAIL_API_KEY` (a server token) | Sends on the server's `outbound` stream. |
| SendGrid (`sendgrid`) | `EMAIL_API_KEY` | Verify the sender or domain in SendGrid. |
| Mailgun (`mailgun`) | `EMAIL_API_KEY`; `MAILGUN_DOMAIN` if it isn't `EMAIL_FROM`'s domain; `MAILGUN_REGION=eu` for the EU region | |
| Amazon SES (`ses`) | `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | An IAM user allowed only `ses:SendEmail`; leave the SES sandbox to email anyone. |
| SMTP (`smtp`) | `SMTP_URL`, like `smtp://user:password@smtp.example.com:587` | Any mail server: Google Workspace, Microsoft 365, Fastmail, your own. Port 587 upgrades with STARTTLS (credentials are never sent unencrypted); use `smtps://` for port 465. URL-encode special characters in the password. |

Open **Instance health** (your name → Instance health and cost) to see how email is set up, or what's missing, and send yourself a test. For mail to land in inboxes rather than spam, set up SPF, DKIM and DMARC for the sending domain as your provider describes.

What it sends:

- **Mentions, replies and resolved comments** someone hasn't seen in Drawpane 10 minutes after they happened: a few minutes later, or in a daily digest at an hour they pick. Each person chooses in Account settings, and every email has a one-click unsubscribe. A Cron Trigger runs this every 5 minutes.
- **Invites**: an owner can send an invite link to an address from Members › Invite people. Replies go to the owner who sent it. A team sends at most 50 invite emails a day; links can always be copied and shared by hand.

To turn email off again: `npx wrangler secret delete EMAIL_PROVIDER`.

## Renderer settings

Sign in as the instance admin and open **Health and cost → Renderer settings**. New instances use Canvas by default. Select **Render engine** to make the engine the default for people who have no browser or tab preference. Select **Drawpane default** to use the default shipped with the release.

For an instance-wide rollback, enable **Use Canvas for everyone** and save. This setting takes precedence over renderer links and browser preferences. People can reload an open file to apply it immediately. Tabs refresh their settings when they return to the foreground or start a new rendering view with settings more than a minute old. Turn it off to restore the instance default and people's preferences. Both settings are stored in D1 and can be changed without deploying.

For a single browser, open the renderer chip in the editor and choose **Use Canvas in this browser**. You can also open a Drawpane URL with `?renderer=canvas` to use Canvas for that tab. A `drawpane:renderer` value of `canvas` in local storage is a browser preference. A URL or tab preference takes precedence over local storage.

The copyable report at `/diagnostics/renderer` shows how the app picked a renderer and the last app backend seen in this tab. Its test scene runs its own backend checks. The app keeps the observation in the tab and sends no renderer telemetry.

## Backups

Every file keeps its own version history. While a file is being edited, its FileRoom saves a gzip snapshot to R2 (`files/<file-id>/snapshots/`) once editing pauses for 10 minutes, and at least once an hour during long sessions. It also saves one whenever someone names a version, and just before anyone restores one, so a restore can always be undone. Each snapshot has a row in D1's `versions` table that says who edited and what changed.

Unnamed versions are deleted after 30 days, except the newest one. Named versions are kept until the file is deleted. People on the team can open, name and restore versions from the History tab in the editor.

D1 also has 30-day point-in-time recovery built in (`wrangler d1 time-travel`).

## Accounts and security

- There are no passwords to leak or reset: people sign in with passkeys, and with GitHub or Google if you set them up (see above). Every account after the first joins through a single-use invite link that expires after 7 days.
- Provider sign-in uses the authorization-code flow with PKCE and a signed, 10-minute state cookie. A provider account is matched to an existing account only through an email address the provider has verified.
- Sessions are random 256-bit tokens in an `HttpOnly`, `Secure`, `SameSite=Lax` cookie; only their SHA-256 hash is stored.
- The Worker checks your role on every request and hands each file socket to its FileRoom with a signed, 60-second claim that the room verifies.
- Personal access tokens, for MCP clients (see [Connecting AI clients](mcp.md)), are shown once and stored only as their SHA-256 hash. They're accepted only by the MCP endpoint, never by the rest of the API, and can be revoked at any time.
- No telemetry. Browsers never contact anyone but your instance. The Worker itself contacts Google Fonts when someone first uses a font or a variable font's axes (see Fonts) and the npm registry when the health page checks for a newer release (see Upgrading); both can be turned off.
