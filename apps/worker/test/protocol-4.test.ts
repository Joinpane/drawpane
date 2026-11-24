// biome-ignore-all lint/style/noNonNullAssertion: Complete fixtures in review reproductions.
/**
 * Protocol 4 (PR 286): every writer refuses taking an instance's auto layout away (as Figma does),
 * and keeps a frame a file from before left that way frozen. A tab from before (3 or older) takes
 * it away, and writes derived values over frozen layers. It doesn't write: it's told to reload at
 * hello, and a tab welcomed before the release has its edits refused. So the removals PR 286's
 * eighth and ninth re-checks sent from such a tab, and every repro built on one, can't reach a
 * room.
 */
import { env, runInDurableObject } from "cloudflare:test";
import { copyId, type NodeRecord, type Op, ROOT_ID } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { AGENT_RUNNER_V } from "../src/agent/runner-api";
import { openSocket, signedInUser } from "./helpers";

const roomOf = (id: string) => env.FILE_ROOM.get(env.FILE_ROOM.idFromName(id));
const n = (
  id: string,
  type: NodeRecord["type"],
  parent: string,
  props: NodeRecord["props"] = {},
  key = "a0",
): NodeRecord => ({ id, type, parent, key, props });

/**
 * The reviewers' fixture: a row component with two fixed rects, and an instance of it whose own
 * Stretch makes both 93 tall, stored in the form the file keeps.
 */
function fixture(copies: "materialized" | "compact"): NodeRecord[] {
  const nodes = [
    n("P", "page", ROOT_ID),
    n("Main", "frame", "P", {
      isComponent: true,
      width: 160,
      height: 80,
      layoutMode: "row",
      paddingTop: 7,
      paddingLeft: 13,
      gap: 5,
    }),
    n("R", "rect", "Main", { x: 13, y: 7, width: 60, height: 20, constraintH: "stretch" }),
    n("S", "rect", "Main", { x: 78, y: 7, width: 12, height: 10 }, "a1"),
    n(
      "Inst",
      "frame",
      "P",
      {
        x: 420,
        y: 460,
        width: 120,
        height: 100,
        layoutMode: "row",
        paddingTop: 7,
        paddingLeft: 13,
        gap: 5,
        alignItems: "stretch",
        instanceOf: "Main",
        overrides: ["alignItems", "height", "width"],
      },
      "a1",
    ),
  ];
  if (copies === "materialized")
    nodes.push(
      n("CR", "rect", "Inst", { x: 13, y: 7, width: 60, height: 93, mirrors: "R" }),
      n("CS", "rect", "Inst", { x: 78, y: 7, width: 12, height: 93, mirrors: "S" }, "a1"),
    );
  return nodes;
}

/** Taking the instance's auto layout away as a client before protocol 4 sent it. */
const olderRemoval = (copies: "materialized" | "compact"): Op[] => [
  copies === "compact"
    ? { op: "set", id: "Inst", prop: "unset", value: ["layoutMode"] }
    : { op: "set", id: "Inst", prop: "layoutMode", value: null },
  {
    op: "set",
    id: "Inst",
    prop: "overrides",
    value: ["alignItems", "height", "layoutMode", "width"],
  },
];

async function file() {
  const owner = await signedInUser("Reviewer");
  const { file } = await owner.browser.json<{ file: { id: string } }>(
    `/api/projects/${owner.projectId}/files`,
    { method: "POST", json: { name: "protocol 4" } },
  );
  const room = roomOf(file.id);
  const socket = await openSocket(owner.browser, file.id);
  socket.send({
    t: "hello",
    protocol: 4,
    clientId: "older",
    revn: null,
    copies: ["materialized", "compact"],
  });
  await socket.next("welcome");
  await socket.next("snapshot");
  const { copies } = await room.copiesFormat();
  await room.storeNodes(fixture(copies));
  return { ...owner, fileId: file.id, room, socket, copies };
}

/** The socket as a tab welcomed at protocol 3, before the release, left it (hibernation). */
async function welcomedAt3(room: ReturnType<typeof roomOf>, clientId: string) {
  await runInDurableObject(room, (_room, state) => {
    const ws = state.getWebSockets().find((w) => w.deserializeAttachment()?.clientId === clientId)!;
    const attachment = ws.deserializeAttachment();
    expect(attachment.protocol).toBe(4);
    attachment.protocol = 3;
    ws.serializeAttachment(attachment);
  });
}

describe("protocol 4: a tab from before can't take an instance's auto layout away", {
  timeout: 60_000,
}, () => {
  it("tells a tab at protocol 3 to reload at hello", async () => {
    const { browser, fileId } = await file();
    const socket = await openSocket(browser, fileId);
    socket.send({ t: "hello", protocol: 3, clientId: "old-3", revn: null, copies: ["compact"] });
    expect((await socket.next<{ code: string }>("error")).code).toBe("reload");
  });

  // Each repro of PR 286's eighth and ninth re-checks starts with this transaction reaching a
  // room; what each did after it can't happen.
  it.each([
    "round 8: the removal, then the main turning to a column",
    "round 9 P1: the removal, then one client's main edit and another's copy edit",
    "round 9 P1: the removal, then a resize of the instance",
    "round 9 P1: the removal arriving while a column edit is pending",
  ])("refuses an older tab's removal (%s)", async () => {
    const f = await file();
    const before = await f.room.allNodes();
    await welcomedAt3(f.room, "older");
    f.socket.send({ t: "txn", seq: 1, ops: olderRemoval(f.copies) });
    expect(await f.socket.next("reject")).toMatchObject({ seq: 1, code: "format" });
    expect((await f.socket.next<{ code: string }>("error")).code).toBe("reload");
    // Nothing of it was stored: the instance keeps its row, and its layers what it gave them.
    const after = await f.room.allNodes();
    expect(after).toEqual(before);
    const inst = after.find((x) => x.id === "Inst")!;
    expect(inst.props.unset).toBeUndefined();
    expect(inst.props.layoutMode).toBe("row");
  });

  it("refuses any edit from a tab welcomed at protocol 3", async () => {
    const f = await file();
    await welcomedAt3(f.room, "older");
    f.socket.send({
      t: "txn",
      seq: 1,
      ops: [{ op: "set", id: "Main", prop: "layoutMode", value: "column" }],
    });
    expect(await f.socket.next("reject")).toMatchObject({ seq: 1, code: "format" });
    const main = (await f.room.allNodes()).find((x) => x.id === "Main")!;
    expect(main.props.layoutMode).toBe("row");
  });

  // The room checks who writes, not what: a protocol 4 tab's editor never sends this (it refuses
  // the removal), and the room takes what such a tab sends.
  it("takes the same operations from a protocol 4 tab", async () => {
    const f = await file();
    const marks: Op[] =
      f.copies === "compact"
        ? [
            {
              op: "create",
              id: copyId("Inst", ["R"]),
              parent: "Inst",
              key: "a0",
              type: "override",
              props: { path: ["R"], height: 93, x: 13, y: 7, overrides: ["x", "y", "height"] },
            },
          ]
        : [{ op: "set", id: "CR", prop: "overrides", value: ["x", "y", "height"] }];
    f.socket.send({ t: "txn", seq: 1, ops: [...olderRemoval(f.copies), ...marks] });
    expect(await f.socket.next("ack")).toMatchObject({ seq: 1 });
  });
});

// PR 286's tenth re-check: an agent's undo history replays the operations an editor worked out,
// and the runner that worked them out can be one from before.
describe("protocol 4: agent calls from before can't take an instance's auto layout away", {
  timeout: 60_000,
}, () => {
  const setup = async () => {
    const f = await file();
    const by = { userId: f.userId, name: "Reviewer" };
    const session = { id: "history", fileId: f.fileId, name: "Review agent" };
    const call = (callId: string, v = AGENT_RUNNER_V) =>
      f.room.stats().then(({ revn }) =>
        f.room.commitAgentRun({
          v,
          by,
          session,
          callId,
          tool: "set_props",
          label: "Remove layout",
          baseRevn: revn,
          ops: olderRemoval(f.copies),
          reads: null,
          result: null,
        }),
      );
    const step = (callId: string, direction: "undo" | "redo") =>
      f.room.stepAgentCall(by, session, callId, direction);
    // As if this release first ran in the room now: what its ledger holds is from before.
    const release = () =>
      runInDurableObject(f.room, (_room, state) => {
        state.storage.sql.exec(
          "UPDATE meta SET v = (SELECT v FROM meta WHERE k = 'revn') WHERE k = 'agent_history_from'",
        );
      });
    return { ...f, call, step, release };
  };

  it("refuses a run from a runner of the version before", async () => {
    const f = await setup();
    const before = await f.room.allNodes();
    expect(AGENT_RUNNER_V).toBe(3);
    expect(await f.call("old", 2)).toMatchObject({ ok: false });
    expect(await f.room.allNodes()).toEqual(before);
  });

  it("won't redo, after the release, a call from before that was undone (the reviewer's replay)", async () => {
    const f = await setup();
    const before = await f.room.allNodes();
    expect(await f.call("remove")).toMatchObject({ ok: true });
    expect(await f.step("undo", "undo")).toMatchObject({ ok: true });
    expect(await f.room.allNodes()).toEqual(before);
    await f.release();
    const redo = await f.step("redo", "redo");
    expect(redo).toMatchObject({ ok: false });
    expect((redo as { message: string }).message).toContain("before Drawpane was updated");
    // Nothing of it reached the file: the instance keeps its row.
    expect(await f.room.allNodes()).toEqual(before);
  });

  it("won't undo, after the release, a call from before", async () => {
    const f = await setup();
    expect(await f.call("remove")).toMatchObject({ ok: true });
    const after = await f.room.allNodes();
    await f.release();
    expect(await f.step("undo", "undo")).toMatchObject({ ok: false });
    expect(await f.room.allNodes()).toEqual(after);
  });

  it("undoes and redoes a call made since", async () => {
    const f = await setup();
    await f.release();
    expect(await f.call("remove")).toMatchObject({ ok: true });
    const after = await f.room.allNodes();
    expect(await f.step("undo", "undo")).toMatchObject({ ok: true });
    expect(await f.step("redo", "redo")).toMatchObject({ ok: true });
    expect(await f.room.allNodes()).toEqual(after);
  });
});

// A file or saved version from before holds removals with no marks: stored state, which the room
// takes as it is (no migration), and editors read as any layer nothing marked (the editor test
// "re-check 10").
describe("protocol 4: a snapshot from before", { timeout: 60_000 }, () => {
  it("is imported as it is, unmarked removal and all", async () => {
    const owner = await signedInUser("Reviewer");
    const { file } = await owner.browser.json<{ file: { id: string } }>(
      `/api/projects/${owner.projectId}/files`,
      { method: "POST", json: { name: "from before" } },
    );
    const legacy = fixture("materialized").map((node) =>
      node.id === "Inst"
        ? {
            ...node,
            props: {
              ...node.props,
              layoutMode: "none",
              overrides: ["alignItems", "height", "layoutMode", "width"],
            },
          }
        : node,
    );
    const result = await owner.browser.json<{ nodes: number }>(`/api/files/${file.id}/import`, {
      method: "POST",
      json: { nodes: legacy },
    });
    expect(result.nodes).toBe(legacy.length);
    const stored = await roomOf(file.id).allNodes();
    const inst = stored.find((node) => node.id === "Inst")!;
    expect(inst.props.layoutMode).toBe("none");
    // Its layers as the flow left them, with nothing marked: copy layers, or override records
    // when the file is stored compact.
    for (const main of ["R", "S"]) {
      const copy = stored.find(
        (node) =>
          node.props.mirrors === main ||
          (Array.isArray(node.props.path) && node.props.path.join("/") === main),
      );
      expect(copy?.props.height).toBe(93);
      expect(copy?.props.overrides ?? []).toEqual([]);
    }
  });
});
