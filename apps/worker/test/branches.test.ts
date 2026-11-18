import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import {
  type BranchInfo,
  branchChanges,
  changeKey,
  type NodeRecord,
  nodeReader,
  type Op,
  parseBranchReview,
  type VersionInfo,
} from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { thumbnailKey } from "../src/api/media";
import type { FileRoom } from "../src/rooms/file-room";
import { branchBaseKey } from "../src/rooms/snapshots";
import { type Browser, openSocket, signedInUser } from "./helpers";

const roomOf = (fileId: string) => env.FILE_ROOM.get(env.FILE_ROOM.idFromName(fileId));

/** What review reads, streamed as lines of JSON. */
async function readReview(browser: Browser, branchId: string) {
  const response = await browser.fetch(`/api/files/${branchId}/branch/review`);
  expect(response.status).toBe(200);
  return parseBranchReview(await response.text());
}

async function join(browser: Browser, fileId: string, clientId: string) {
  const socket = await openSocket(browser, fileId);
  socket.send({
    t: "hello",
    protocol: 3,
    clientId,
    revn: null,
    copies: ["materialized", "compact"],
  });
  const welcome = await socket.next<{ role: string; revn: number }>("welcome");
  const nodes: NodeRecord[] = [];
  for (;;) {
    const chunk = await socket.next<{ nodes: NodeRecord[]; done: boolean }>("snapshot");
    nodes.push(...chunk.nodes);
    if (chunk.done) break;
  }
  let seq = 0;
  /** Sends a transaction and waits for the room to accept it. */
  const edit = async (ops: Op[]) => {
    socket.send({ t: "txn", seq: ++seq, ops });
    return (await socket.next<{ revn: number }>("ack")).revn;
  };
  const page = nodes.find((n) => n.type === "page") as NodeRecord;
  return { ...socket, welcome, nodes, page, edit };
}

const rect = (id: string, parent: string, props = {}): Op => ({
  op: "create",
  id,
  type: "rect",
  parent,
  key: "a0",
  props: { x: 0, y: 0, width: 100, height: 50, ...props },
});

/** A team's main file with one rectangle, and a branch of it. */
async function mainWithBranch() {
  const owner = await signedInUser("Ana");
  const { file } = await owner.browser.json<{ file: { id: string } }>(
    `/api/projects/${owner.projectId}/files`,
    { method: "POST", json: { name: "Checkout" } },
  );
  const main = await join(owner.browser, file.id, "clientM");
  await main.edit([rect("r1", main.page.id, { name: "Pay button" })]);
  const { branch } = await owner.browser.json<{ branch: BranchInfo }>(
    `/api/files/${file.id}/branches`,
    { method: "POST", json: { name: "Bigger button" } },
  );
  return { ...owner, mainId: file.id, main, branch };
}

describe("making a branch", () => {
  it("copies the main file at its revision and keeps that as the base", async () => {
    const { browser, mainId, branch } = await mainWithBranch();
    const { revn } = await roomOf(mainId).stats();
    expect(branch).toMatchObject({
      name: "Bigger button",
      mainId,
      baseRevn: revn,
      merged: null,
      createdBy: { name: "Ana" },
    });
    const copied = (await roomOf(branch.id).allNodes()) as NodeRecord[];
    expect(copied.find((n) => n.id === "r1")?.props.name).toBe("Pay button");
    expect(await env.FILES.head(branchBaseKey(branch.id))).not.toBeNull();

    // The branch says what it branches; the main file lists it.
    const meta = await browser.json<{
      file: { branchOf: string };
      branch: BranchInfo;
      main: { id: string; name: string };
    }>(`/api/files/${branch.id}`);
    expect(meta.file.branchOf).toBe(mainId);
    expect(meta.main).toEqual({ id: mainId, name: "Checkout" });
    expect(meta.branch.id).toBe(branch.id);
    const listed = await browser.json<{ branches: BranchInfo[] }>(`/api/files/${mainId}/branches`);
    expect(listed.branches.map((b) => b.id)).toEqual([branch.id]);
    // From the branch, the same list.
    const fromBranch = await browser.json<{ mainId: string }>(`/api/files/${branch.id}/branches`);
    expect(fromBranch.mainId).toBe(mainId);
  });

  it("keeps branches out of file lists and search", async () => {
    const { browser, teamId, projectId, mainId, branch } = await mainWithBranch();
    const team = await browser.json<{ files: Array<{ id: string }> }>(`/api/teams/${teamId}/files`);
    expect(team.files.map((f) => f.id)).toEqual([mainId]);
    const project = await browser.json<{ files: Array<{ id: string }> }>(
      `/api/projects/${projectId}/files`,
    );
    expect(project.files.map((f) => f.id)).toEqual([mainId]);
    const search = await browser.json<{ files: Array<{ id: string }> }>(
      `/api/teams/${teamId}/files?q=bigger`,
    );
    expect(search.files.map((f) => f.id)).not.toContain(branch.id);
    const { projects } = await browser.json<{ projects: Array<{ fileCount: number }> }>(
      `/api/teams/${teamId}/projects`,
    );
    expect(projects[0]?.fileCount).toBe(1);
  });

  it("is for editors, and only of main files", async () => {
    const { browser, teamId, mainId, branch } = await mainWithBranch();
    const viewer = await signedInUser("Vi", "viewer", teamId);
    const denied = await viewer.browser.fetch(`/api/files/${mainId}/branches`, {
      method: "POST",
      json: { name: "Mine" },
    });
    expect(denied.status).toBe(403);
    const nested = await browser.fetch(`/api/files/${branch.id}/branches`, {
      method: "POST",
      json: { name: "Deeper" },
    });
    expect(nested.status).toBe(400);
    const outsider = await signedInUser("Bo");
    const hidden = await outsider.browser.fetch(`/api/files/${mainId}/branches`);
    expect(hidden.status).toBe(404);
  });
});

describe("reviewing and merging", () => {
  it("merges the branch's changes into main as one revision, after a restore point", async () => {
    const { browser, mainId, main, branch } = await mainWithBranch();
    const onBranch = await join(browser, branch.id, "clientB");
    await onBranch.edit([{ op: "set", id: "r1", prop: "width", value: 240 }]);
    await onBranch.edit([rect("r2", onBranch.page.id, { name: "Note" })]);
    // Meanwhile on main: a change of its own, which the merge keeps.
    await main.edit([{ op: "set", id: "r1", prop: "name", value: "Pay now" }]);

    const review = await readReview(browser, branch.id);
    const changes = branchChanges(
      nodeReader(review.base),
      nodeReader(review.branch),
      nodeReader(review.main),
    );
    expect(changes.map((c) => c.kind).sort()).toEqual(["added", "changed"]);
    expect(changes.some((c) => c.conflict)).toBe(false);

    const merged = await browser.json<{ branch: BranchInfo; revn: number; restorePoint: string }>(
      `/api/files/${branch.id}/branch/merge`,
      { method: "POST", json: {} },
    );
    expect(merged.revn).toBe(review.mainRevn + 1);
    expect(merged.branch.merged).toMatchObject({
      revn: merged.revn,
      changes: 2,
      by: { name: "Ana" },
    });
    const arrived = await main.next<{ t: string; branch: { name: string }; changes: number }>(
      "merged-in",
    );
    expect(arrived).toMatchObject({ branch: { name: "Bigger button" }, changes: 2 });
    const after = (await roomOf(mainId).allNodes()) as NodeRecord[];
    expect(after.find((n) => n.id === "r1")?.props).toMatchObject({ name: "Pay now", width: 240 });
    expect(after.some((n) => n.id === "r2")).toBe(true);
    // Undone from History: the restore point is a named version.
    const { versions } = await browser.json<{ versions: VersionInfo[] }>(
      `/api/files/${mainId}/versions`,
    );
    const point = versions.find((v) => v.id === merged.restorePoint);
    expect(point?.name).toBe("Before merging “Bigger button”");
  });

  it("asks for a decision on each conflict, and takes the side chosen", async () => {
    const { browser, mainId, main, branch } = await mainWithBranch();
    const onBranch = await join(browser, branch.id, "clientB");
    await onBranch.edit([{ op: "set", id: "r1", prop: "width", value: 240 }]);
    await main.edit([{ op: "set", id: "r1", prop: "width", value: 300 }]);
    const undecided = await browser.fetch(`/api/files/${branch.id}/branch/merge`, {
      method: "POST",
      json: {},
    });
    expect(undecided.status).toBe(409);
    // Nothing happened: it can still be merged.
    const review = await readReview(browser, branch.id);
    const [conflict] = branchChanges(
      nodeReader(review.base),
      nodeReader(review.branch),
      nodeReader(review.main),
    );
    expect(conflict?.conflict).toBe(true);
    await browser.json(`/api/files/${branch.id}/branch/merge`, {
      method: "POST",
      json: { resolutions: { [changeKey(conflict as never)]: "branch" } },
    });
    const after = (await roomOf(mainId).allNodes()) as NodeRecord[];
    expect(after.find((n) => n.id === "r1")?.props.width).toBe(240);
  });

  it("deletes what the branch deleted even where main moved one inside the other", async () => {
    const owner = await signedInUser("Ana");
    const { file } = await owner.browser.json<{ file: { id: string } }>(
      `/api/projects/${owner.projectId}/files`,
      { method: "POST", json: { name: "Nested" } },
    );
    const main = await join(owner.browser, file.id, "clientM");
    const frame = (id: string, key: string): Op => ({
      op: "create",
      id,
      type: "frame",
      parent: main.page.id,
      key,
      props: { width: 100, height: 100 },
    });
    // Z comes before A on the page, A after it by id.
    await main.edit([frame("Z", "a0"), frame("A", "a1")]);
    const { branch } = await owner.browser.json<{ branch: BranchInfo }>(
      `/api/files/${file.id}/branches`,
      { method: "POST", json: { name: "Tidy" } },
    );
    const onBranch = await join(owner.browser, branch.id, "clientB");
    await onBranch.edit([
      { op: "delete", id: "Z" },
      { op: "delete", id: "A" },
    ]);
    // Meanwhile main moves Z inside A.
    await main.edit([{ op: "move", id: "Z", parent: "A", key: "a0" }]);

    const review = await readReview(owner.browser, branch.id);
    const changes = branchChanges(
      nodeReader(review.base),
      nodeReader(review.branch),
      nodeReader(review.main),
    );
    const resolutions = Object.fromEntries(changes.map((c) => [changeKey(c), "branch"]));
    const response = await owner.browser.fetch(`/api/files/${branch.id}/branch/merge`, {
      method: "POST",
      json: { resolutions },
    });
    expect(response.status).toBe(200);
    const after = (await roomOf(file.id).allNodes()) as NodeRecord[];
    expect(after.some((n) => n.id === "A" || n.id === "Z")).toBe(false);
  });

  it("refuses to combine two sides' changes into layers deeper than the limit", async () => {
    const owner = await signedInUser("Ana");
    const { file } = await owner.browser.json<{ file: { id: string } }>(
      `/api/projects/${owner.projectId}/files`,
      { method: "POST", json: { name: "Deep" } },
    );
    const main = await join(owner.browser, file.id, "clientM");
    const group = (id: string, parent: string, key = "a0"): Op => ({
      op: "create",
      id,
      type: "group",
      parent,
      key,
      props: {},
    });
    // A chain of groups whose last is 127 levels down (the page is the first), and a group A
    // beside it near the top.
    const chain: Op[] = [];
    for (let i = 1; i <= 126; i++) chain.push(group(`C${i}`, i === 1 ? main.page.id : `C${i - 1}`));
    await main.edit([...chain, group("A", main.page.id, "a1")]);
    const { branch } = await owner.browser.json<{ branch: BranchInfo }>(
      `/api/files/${file.id}/branches`,
      { method: "POST", json: { name: "Inside A" } },
    );
    const onBranch = await join(owner.browser, branch.id, "clientB");
    // Each side's change is legal on its own: the branch puts B in A near the top, main moves
    // the empty A to the bottom of the chain, 128 levels down.
    await onBranch.edit([group("B", "A")]);
    await main.edit([{ op: "move", id: "A", parent: "C126", key: "a0" }]);

    // Merged, B would be 129 levels down in main.
    const merged = await owner.browser.fetch(`/api/files/${branch.id}/branch/merge`, {
      method: "POST",
      json: { resolutions: {} },
    });
    expect(merged.status).toBe(409);
    expect(await merged.text()).toContain("deeper than 128 levels");
    const mainAfter = (await roomOf(file.id).allNodes()) as NodeRecord[];
    expect(mainAfter.some((n) => n.id === "B")).toBe(false);

    // Brought into the branch, main's move would take B down with A, 129 levels down.
    const updated = await owner.browser.fetch(`/api/files/${branch.id}/branch/update`, {
      method: "POST",
    });
    expect(updated.status).toBe(409);
    expect(await updated.text()).toContain("deeper than 128 levels");
    const branchAfter = (await roomOf(branch.id).allNodes()) as NodeRecord[];
    expect(branchAfter.find((n) => n.id === "A")?.parent).toBe(main.page.id);
    expect(branchAfter.find((n) => n.id === "B")?.parent).toBe("A");
  });

  it("merges when the branch deleted something main has edited since, either way it's decided", async () => {
    for (const side of ["main", "branch"] as const) {
      const { browser, mainId, main, branch } = await mainWithBranch();
      const onBranch = await join(browser, branch.id, "clientB");
      await onBranch.edit([{ op: "delete", id: "r1" }]);
      await main.edit([{ op: "set", id: "r1", prop: "width", value: 300 }]);
      const review = await readReview(browser, branch.id);
      const [removed] = branchChanges(
        nodeReader(review.base),
        nodeReader(review.branch),
        nodeReader(review.main),
      );
      expect(removed).toMatchObject({ kind: "removed", conflict: "changed-on-main" });
      const response = await browser.fetch(`/api/files/${branch.id}/branch/merge`, {
        method: "POST",
        json: { resolutions: { [changeKey(removed as never)]: side } },
      });
      expect(response.status).toBe(200);
      const after = (await roomOf(mainId).allNodes()) as NodeRecord[];
      expect(after.some((n) => n.id === "r1")).toBe(side === "main");
    }
  });

  it("leaves out the changes skipped", async () => {
    const { browser, mainId, branch } = await mainWithBranch();
    const onBranch = await join(browser, branch.id, "clientB");
    await onBranch.edit([{ op: "set", id: "r1", prop: "width", value: 240 }]);
    await onBranch.edit([rect("r2", onBranch.page.id)]);
    const merged = await browser.json<{ branch: BranchInfo }>(
      `/api/files/${branch.id}/branch/merge`,
      { method: "POST", json: { skip: ["r1:width"] } },
    );
    expect(merged.branch.merged?.changes).toBe(1);
    const after = (await roomOf(mainId).allNodes()) as NodeRecord[];
    expect(after.find((n) => n.id === "r1")?.props.width).toBe(100);
    expect(after.some((n) => n.id === "r2")).toBe(true);
  });

  it("makes a merged branch read-only, at once and from then on", async () => {
    const { browser, branch } = await mainWithBranch();
    const onBranch = await join(browser, branch.id, "clientB");
    expect(onBranch.welcome.role).toBe("owner");
    await browser.json(`/api/files/${branch.id}/branch/merge`, { method: "POST", json: {} });
    await onBranch.next("merged");
    onBranch.send({ t: "txn", seq: 1, ops: [{ op: "set", id: "r1", prop: "width", value: 1 }] });
    const reject = await onBranch.next<{ code: string }>("reject");
    expect(reject.code).toBeTruthy();

    const again = await join(browser, branch.id, "clientC");
    expect(again.welcome.role).toBe("viewer");
    const rename = await browser.fetch(`/api/files/${branch.id}`, {
      method: "PATCH",
      json: { name: "Renamed" },
    });
    expect(rename.status).toBe(403);
    const twice = await browser.fetch(`/api/files/${branch.id}/branch/merge`, {
      method: "POST",
      json: {},
    });
    expect(twice.status).toBe(409);
    const { branches } = await browser.json<{ branches: BranchInfo[] }>(
      `/api/files/${branch.mainId}/branches`,
    );
    expect(branches[0]?.merged).not.toBeNull();
  });

  it("takes an editor on the main file to merge", async () => {
    const { teamId, branch } = await mainWithBranch();
    const viewer = await signedInUser("Vi", "viewer", teamId);
    // Viewers can review…
    const review = await viewer.browser.fetch(`/api/files/${branch.id}/branch/review`);
    expect(review.status).toBe(200);
    // …but not merge.
    const merge = await viewer.browser.fetch(`/api/files/${branch.id}/branch/merge`, {
      method: "POST",
      json: {},
    });
    expect(merge.status).toBe(403);
  });
});

describe("branches and their main file", () => {
  it("deletes a branch for good, with everything it stored", async () => {
    const { browser, mainId, branch } = await mainWithBranch();
    await env.FILES.put(thumbnailKey(branch.id), new Uint8Array([1]));
    // Not through the file route: branches don't go to trash.
    const viaFile = await browser.fetch(`/api/files/${branch.id}`, { method: "DELETE" });
    expect(viaFile.status).toBe(400);
    await browser.json(`/api/files/${branch.id}/branch`, { method: "DELETE" });
    expect(await env.FILES.head(branchBaseKey(branch.id))).toBeNull();
    expect(await env.FILES.head(thumbnailKey(branch.id))).toBeNull();
    const { branches } = await browser.json<{ branches: BranchInfo[] }>(
      `/api/files/${mainId}/branches`,
    );
    expect(branches).toEqual([]);
  });

  it("moves with its main file, and goes when it's deleted for good", async () => {
    const { browser, teamId, mainId, branch } = await mainWithBranch();
    const { project } = await browser.json<{ project: { id: string } }>(
      `/api/teams/${teamId}/projects`,
      { method: "POST", json: { name: "Archive" } },
    );
    const own = await browser.fetch(`/api/files/${branch.id}`, {
      method: "PATCH",
      json: { projectId: project.id },
    });
    expect(own.status).toBe(400);
    await browser.json(`/api/files/${mainId}`, {
      method: "PATCH",
      json: { projectId: project.id },
    });
    const moved = await browser.json<{ file: { projectId: string } }>(`/api/files/${branch.id}`);
    expect(moved.file.projectId).toBe(project.id);

    await browser.json(`/api/files/${mainId}`, { method: "DELETE" });
    await browser.json(`/api/files/${mainId}?permanent=1`, { method: "DELETE" });
    expect((await browser.fetch(`/api/files/${branch.id}`)).status).toBe(404);
    expect(await env.FILES.head(branchBaseKey(branch.id))).toBeNull();
  });
});

describe("file lists", () => {
  it("count each file's open branches", async () => {
    const { browser, teamId, mainId, branch } = await mainWithBranch();
    const count = async () =>
      (
        await browser.json<{ files: Array<{ id: string; openBranches: number }> }>(
          `/api/teams/${teamId}/files`,
        )
      ).files.find((f) => f.id === mainId)?.openBranches;
    expect(await count()).toBe(1);
    // Merged branches are history, not open work.
    await browser.json(`/api/files/${branch.id}/branch/merge`, { method: "POST", json: {} });
    expect(await count()).toBe(0);
  });
});

describe("updating a branch from main", () => {
  it("brings in main's changes, keeps the branch's, and starts review from main as it is", async () => {
    const { browser, mainId, main, branch } = await mainWithBranch();
    const onBranch = await join(browser, branch.id, "clientB");
    await onBranch.edit([{ op: "set", id: "r1", prop: "width", value: 240 }]);
    await main.edit([{ op: "set", id: "r1", prop: "name", value: "Pay now" }]);
    await main.edit([rect("r3", main.page.id, { name: "Footer" })]);

    const updated = await browser.json<{ branch: BranchInfo; changes: number; kept: number }>(
      `/api/files/${branch.id}/branch/update`,
      { method: "POST", json: {} },
    );
    expect(updated).toMatchObject({ changes: 2, kept: 0 });
    expect(updated.branch.baseRevn).toBe((await roomOf(mainId).stats()).revn);
    await onBranch.next("updated-from-main");
    const nodes = (await roomOf(branch.id).allNodes()) as NodeRecord[];
    expect(nodes.find((n) => n.id === "r1")?.props).toMatchObject({ name: "Pay now", width: 240 });
    expect(nodes.some((n) => n.id === "r3")).toBe(true);

    // Only the branch's own change is left to review.
    const review = await readReview(browser, branch.id);
    const changes = branchChanges(
      nodeReader(review.base),
      nodeReader(review.branch),
      nodeReader(review.main),
    );
    expect(changes).toEqual([
      expect.objectContaining({ kind: "changed", field: "width", conflict: false }),
    ]);
  });

  it("keeps the branch's side where both changed the same thing, as a change against main", async () => {
    const { browser, main, branch } = await mainWithBranch();
    const onBranch = await join(browser, branch.id, "clientB");
    await onBranch.edit([{ op: "set", id: "r1", prop: "width", value: 240 }]);
    await main.edit([{ op: "set", id: "r1", prop: "width", value: 300 }]);
    const updated = await browser.json<{ changes: number; kept: number }>(
      `/api/files/${branch.id}/branch/update`,
      { method: "POST", json: {} },
    );
    expect(updated).toMatchObject({ changes: 0, kept: 1 });
    const review = await readReview(browser, branch.id);
    const [change] = branchChanges(
      nodeReader(review.base),
      nodeReader(review.branch),
      nodeReader(review.main),
    );
    // No longer a conflict: review shows main's value going to the branch's.
    expect(change).toMatchObject({ field: "width", base: 300, branch: 240, conflict: false });
  });

  it("changes neither the branch nor its base when the new base can't be stored, so a retry works", async () => {
    const { browser, mainId, main, branch } = await mainWithBranch();
    await main.edit([rect("r3", main.page.id, { name: "Footer" })]);
    const stub = roomOf(branch.id);
    const before = await stub.stats();
    // R2 refuses writes for a moment.
    await runInDurableObject(stub, (room: FileRoom) => {
      const real = (room as unknown as { env: { FILES: R2Bucket } }).env;
      const failing = new Proxy(real.FILES, {
        get(target, prop) {
          if (prop === "put" || prop === "createMultipartUpload")
            return () => Promise.reject(new Error("R2 is down"));
          const value = Reflect.get(target, prop);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      (room as unknown as { env: object }).env = { ...real, FILES: failing, realEnv: real };
    });
    const failed = await browser.fetch(`/api/files/${branch.id}/branch/update`, {
      method: "POST",
      json: {},
    });
    expect(failed.ok).toBe(false);
    expect((await stub.stats()).revn).toBe(before.revn);
    expect(((await stub.allNodes()) as NodeRecord[]).some((n) => n.id === "r3")).toBe(false);
    await runInDurableObject(stub, (room: FileRoom) => {
      const env = (room as unknown as { env: { realEnv: object } }).env;
      (room as unknown as { env: object }).env = env.realEnv;
    });

    // Tried again, it goes through, and review starts from main as it is.
    const updated = await browser.json<{ changes: number; branch: BranchInfo }>(
      `/api/files/${branch.id}/branch/update`,
      { method: "POST", json: {} },
    );
    expect(updated.changes).toBe(1);
    expect(updated.branch.baseRevn).toBe((await roomOf(mainId).stats()).revn);
    const review = await readReview(browser, branch.id);
    expect(review.base.some((n) => n.id === "r3")).toBe(true);
    expect(
      branchChanges(nodeReader(review.base), nodeReader(review.branch), nodeReader(review.main)),
    ).toEqual([]);
  });

  it("runs one update at a time, each from the base the last one left", async () => {
    const { browser, mainId, main, branch } = await mainWithBranch();
    await main.edit([rect("r3", main.page.id, { name: "Footer" })]);
    const update = () =>
      browser.fetch(`/api/files/${branch.id}/branch/update`, { method: "POST", json: {} });
    const responses = await Promise.all([update(), update(), update()]);
    expect(responses.map((r) => r.status)).toEqual([200, 200, 200]);
    const bodies = (await Promise.all(responses.map((r) => r.json()))) as Array<{
      changes: number;
    }>;
    expect(bodies.map((b) => b.changes).sort()).toEqual([0, 0, 1]);
    const nodes = (await roomOf(branch.id).allNodes()) as NodeRecord[];
    expect(nodes.filter((n) => n.id === "r3")).toHaveLength(1);
    const review = await readReview(browser, branch.id);
    expect(review.mainRevn).toBe((await roomOf(mainId).stats()).revn);
    expect(
      branchChanges(nodeReader(review.base), nodeReader(review.branch), nodeReader(review.main)),
    ).toEqual([]);

    // The base it replaced stays an hour (a review may be reading it), then goes.
    const bases = async () =>
      (await env.FILES.list({ prefix: `files/${branch.id}/` })).objects
        .map((o) => o.key)
        .filter((key) => key.includes("branch-base"));
    expect(await bases()).toHaveLength(2);
    await runInDurableObject(roomOf(branch.id), (_room, state) => {
      state.storage.sql.exec("UPDATE stale_objects SET at = at - 61 * 60_000");
    });
    await runDurableObjectAlarm(roomOf(branch.id));
    const left = await bases();
    expect(left).toHaveLength(1);
    expect(left[0]).toContain("branch-bases/");
  });

  it("is for editors of an open branch", async () => {
    const { browser, teamId, branch } = await mainWithBranch();
    const viewer = await signedInUser("Vi", "viewer", teamId);
    const denied = await viewer.browser.fetch(`/api/files/${branch.id}/branch/update`, {
      method: "POST",
      json: {},
    });
    expect(denied.status).toBe(403);
    await browser.json(`/api/files/${branch.id}/branch/merge`, { method: "POST", json: {} });
    const merged = await browser.fetch(`/api/files/${branch.id}/branch/update`, {
      method: "POST",
      json: {},
    });
    expect(merged.status).toBe(403);
  });
});
