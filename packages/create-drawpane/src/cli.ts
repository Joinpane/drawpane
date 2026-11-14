#!/usr/bin/env node
/**
 * `npm create drawpane [folder]` installs an instance on your Cloudflare
 * account; `npm create drawpane@latest upgrade [folder]` moves one to this
 * version. See docs/decisions/0004-installer.md.
 */
import { spawn } from "node:child_process";
import { parseCli } from "./args.js";
import { WranglerError, wrangler } from "./cloudflare.js";
import { type Deps, install, Problem, upgrade } from "./flows.js";
import { bundledRelease } from "./release.js";
import { Cancelled, terminalUi } from "./ui.js";

const HELP = `Install Drawpane on your own Cloudflare account, or upgrade an instance.

Usage
  npm create drawpane [folder] [options]          install a new instance
  npm create drawpane@latest upgrade [folder]     upgrade the instance in folder (default: .)

Options
  --account <name or id>   Cloudflare account (asked when you have several)
  --name <worker>          Worker name (default: from the folder)
  --domain <hostname>      serve on your own domain (default: a workers.dev address)
  --yes, -y                take the defaults and ask nothing (for scripts and CI)
  --force                  upgrade: deploy again even when already on this version
  --help, -h               show this
  --version, -v            show the Drawpane version this installer carries

With npm, options go after --:  npm create drawpane my-design -- --domain design.example.com
Signs in with your Wrangler login, or CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.
`;

/** Opens a URL in the default browser, quietly; failing is fine, the URL is printed too. */
function openBrowser(url: string): void {
  const [command, ...args] =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  try {
    spawn(command as string, args, { stdio: "ignore", detached: true })
      .on("error", () => {})
      .unref();
  } catch {
    // No browser here.
  }
}

async function main(argv: readonly string[]): Promise<number> {
  const { values, positionals } = parseCli(argv);
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const release = await bundledRelease();
  if (values.version) {
    process.stdout.write(`${release.version}\n`);
    return 0;
  }

  const ui = terminalUi();
  const deps: Deps = {
    ui,
    cloudflare: wrangler,
    release,
    fetch: (url, init) => fetch(url, init),
    openBrowser,
    env: process.env,
    cwd: process.cwd(),
  };
  const [first, second, ...rest] = positionals;
  if (rest.length > 0) throw new Problem(`Unexpected: ${rest.join(" ")}. See --help.`);
  if (first === "upgrade")
    await upgrade({ dir: second, yes: values.yes, force: values.force }, deps);
  else {
    if (second !== undefined) throw new Problem(`Unexpected: ${second}. See --help.`);
    await install(
      {
        dir: first,
        account: values.account,
        name: values.name,
        domain: values.domain,
        yes: values.yes,
      },
      deps,
    );
  }
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    if (error instanceof Cancelled) {
      process.stderr.write("\nCancelled. Running the same command again continues from here.\n");
      process.exit(130);
    }
    if (error instanceof Problem) {
      // A problem to fix (a mistyped option is one too): the message is the whole story.
      process.stderr.write(`\n${error.message}\n`);
      process.exit(1);
    }
    if (error instanceof WranglerError) {
      process.stderr.write(
        `\nCloudflare refused: wrangler ${error.command}\n\n${error.output.trim()}\n\nRunning the same command again continues from here.\n`,
      );
      process.exit(1);
    }
    process.stderr.write(
      `\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exit(1);
  },
);
