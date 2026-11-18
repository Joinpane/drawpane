# create-drawpane

Install [Drawpane](https://github.com/Joinpane/drawpane), the open design tool you own, on your own Cloudflare account, and keep it up to date.

```sh
npm create drawpane my-design
```

You need Node 22 or newer and a Cloudflare account. The installer signs you in to Cloudflare, creates a D1 database and an R2 bucket, deploys Drawpane, and opens the page where you create the first account. With no domain, the instance gets a free `workers.dev` address.

Drawpane is two Workers: the main one (named after your instance, say `my-design`) and its agent runner (`my-design-agent-runner`), where AI agents' tools run. The runner has no address and no secrets: only the main Worker calls it. The installer deploys the runner first, then the main Worker, every time. It counts toward your account's Workers (100 on the Free plan).

Agent tools need the Workers Paid plan. On the Free plan, the installer says so, leaves the runner out and turns agent tools off; everything else works. It finds out when Cloudflare refuses the first deploy, or you can say so with `--plan free`. After moving to Workers Paid, run `npm create drawpane@latest upgrade -- --plan paid` to turn them on.

The `my-design/` folder is your instance. Keep it: `drawpane.json` records what was chosen and deployed, and it holds no secrets. To upgrade, run this in that folder:

```sh
npm create drawpane@latest upgrade
```

## Options

| Option | |
| --- | --- |
| `--account <name or id>` | The Cloudflare account, when your login has several. |
| `--name <worker>` | The Worker's name. Defaults to one made from the folder name. |
| `--domain <hostname>` | Serve on your own domain, on a zone in the same account. |
| `--plan <paid or free>` | Your Workers plan. `free` turns agent tools off. Found out on the first deploy when not given; with `upgrade`, `--plan paid` turns agent tools back on. |
| `--yes`, `-y` | Take the defaults and ask nothing, for scripts and CI. |
| `--force` | With `upgrade`: deploy again even when already on this version. |

With npm, options go after `--`: `npm create drawpane my-design -- --domain design.example.com`. Without a browser, sign in with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

Running the same command again after an interruption continues where it stopped, and never creates anything twice.

More in the [self-hosting guide](https://github.com/Joinpane/drawpane/blob/main/docs/self-hosting.md) and the [design notes](https://github.com/Joinpane/drawpane/blob/main/docs/decisions/0004-installer.md).

License: MPL-2.0.
