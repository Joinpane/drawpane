// One heavy kit parity step at a time on a machine. Converting a large kit
// and drawing it in a local instance each take several GB; two or three at
// once (several people or agents judging fixes) run the machine out of
// memory and every one of them crawls. The lock is a directory in the temp
// folder holding its owner; one left by a process that's gone is taken over.
// KIT_PARITY_NO_LOCK=1 skips it.
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LOCK = join(tmpdir(), "drawpane-kit-parity.lock");
const OWNER = join(LOCK, "owner.json");

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
};

function owner() {
  try {
    return JSON.parse(readFileSync(OWNER, "utf8"));
  } catch {
    return null;
  }
}

/** Runs `work` holding the machine's kit parity lock, waiting for it first. */
export async function withMachineLock(label, work, log = console.log) {
  if (process.env.KIT_PARITY_NO_LOCK === "1") return work();
  let told = false;
  for (;;) {
    try {
      mkdirSync(LOCK);
      writeFileSync(
        OWNER,
        JSON.stringify({
          pid: process.pid,
          label,
          cwd: process.cwd(),
          since: new Date().toISOString(),
        }),
      );
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const held = owner();
      let stale = held ? !alive(held.pid) : false;
      // Made but its owner not written yet, or never: give it a minute.
      if (!held) {
        try {
          stale = Date.now() - statSync(LOCK).mtimeMs > 60_000;
        } catch {
          continue;
        }
      }
      if (stale) {
        rmSync(LOCK, { recursive: true, force: true });
        continue;
      }
      if (!told) {
        log(
          `Waiting for another kit parity run to finish: ${held?.label ?? "starting"} (pid ${held?.pid ?? "?"}, in ${held?.cwd ?? "?"}).`,
        );
        told = true;
      }
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }
  const release = () => {
    if (owner()?.pid === process.pid) rmSync(LOCK, { recursive: true, force: true });
  };
  process.on("exit", release);
  try {
    return await work();
  } finally {
    release();
    process.off("exit", release);
  }
}
