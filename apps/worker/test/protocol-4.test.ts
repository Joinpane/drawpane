// biome-ignore-all lint/style/noNonNullAssertion: Complete fixtures in review reproductions.
/**
 * Protocol 4 (PR 286): the client taking an instance's auto layout away marks what that flow left
 * as the layers' own, in the same transaction. A tab from before (3 or older) takes it away
 * without those marks, and the client that receives an edit lays nothing out, so nothing would
 * mark them after. It doesn't write: it's told to reload at hello, and a tab welcomed before the
 * release has its edits refused. So the removals PR 286's eighth and ninth re-checks sent from
 * such a tab, and every repro built on one, can't reach a room.
 */
import { env, runInDurableObject } from "cloudflare:test";
import { copyId, type NodeRecord, type Op, ROOT_ID } from "@drawpane/model";
import { describe, expect, it } from "vitest";
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

/** Taking the instance's auto layout away as a client before protocol 4 sent it: no marks. */
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

  it("takes the same removal from a protocol 4 tab, with its marks", async () => {
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
