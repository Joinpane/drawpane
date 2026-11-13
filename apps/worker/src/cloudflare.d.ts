// Tells workers-types what this Worker exports, which types `ctx.exports`
// and `import { exports } from "cloudflare:workers"`.
declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./index");
    durableNamespaces: "FileRoom";
  }
}
