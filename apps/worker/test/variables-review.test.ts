/**
 * The room's side of #186's review (decision 0034): a file stored before
 * variables and styles is served as it is, and its opacity bindings read as
 * they did (F9): a binding says how its value maps onto the property, one
 * without the field means what it meant then, and nothing is converted, in
 * the file, a version or a snapshot. A tab from before reloads at hello; and
 * the MCP tools read values as the canvas shows them (F12: an agent never
 * computes from a value people don't see).
 */
import { env, runInDurableObject } from "cloudflare:test";
import { Doc } from "@drawpane/editor";
import { getProp, type NodeRecord, ROOT_ID, snapshotHeaderLine } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { FileDoc, nodeDetail, resolvedView } from "../src/mcp/document";
import type { FileRoom } from "../src/rooms/file-room";
import { openSocket, signedInUser } from "./helpers";

const roomOf = (fileId: string) => env.FILE_ROOM.get(env.FILE_ROOM.idFromName(fileId));

const node = (id: string, type: NodeRecord["type"], parent: string, props: object = {}) =>
  ({ id, type, parent, key: "a0", props }) as NodeRecord;

/** A file as Drawpane stored one before decision 0034: opacity variables as fractions. */
const legacy = (): NodeRecord[] => [
  node("P1", "page", ROOT_ID, { name: "Page 1" }),
  node("C1", "collection", ROOT_ID, { name: "Theme", modes: [{ id: "m1", name: "Default" }] }),
  node("O1", "variable", "C1", { name: "Half", variableType: "number", values: { m1: 0.5 } }),
  node("W1", "variable", "C1", { name: "Size", variableType: "number", values: { m1: 0.25 } }),
  node("R1", "rect", "P1", { opacity: 0.5, bindings: { opacity: "O1" } }),
  node("R2", "rect", "P1", {
    opacity: 0.25,
    width: 0.25,
    bindings: { opacity: "W1", width: "W1" },
  }),
];

async function newFile() {
  const owner = await signedInUser("Ana");
  const { file } = await owner.browser.json<{ file: { id: string } }>(
    `/api/projects/${owner.projectId}/files`,
    { method: "POST", json: { name: "Tokens" } },
  );
  const socket = await openSocket(owner.browser, file.id);
  socket.send({
    t: "hello",
    protocol: 3,
    clientId: `c-${file.id}`,
    revn: null,
    copies: ["materialized", "compact"],
  });
  await socket.next("welcome");
  socket.ws.close();
  return { ...owner, fileId: file.id };
}

describe("a file stored before variables and styles (F9)", { timeout: 60_000 }, () => {
  it("F9: is served as it is, and opacity looks as it did", async () => {
    const { browser, fileId } = await newFile();
    await roomOf(fileId).storeNodes(legacy());
    // Someone opens it: the room reads it, converting nothing.
    const socket = await openSocket(browser, fileId);
    socket.send({
      t: "hello",
      protocol: 3,
      clientId: "reader",
      revn: null,
      copies: ["materialized", "compact"],
    });
    await socket.next("welcome");
    socket.ws.close();
    const nodes = (await roomOf(fileId).allNodes()) as NodeRecord[];
    const byId = new Map(nodes.map((n) => [n.id, n]));
    for (const want of legacy()) expect(byId.get(want.id)).toEqual(want);
    expect(nodes).toHaveLength(legacy().length);
    const doc = new Doc();
    doc.resetStored(nodes, "materialized");
    expect(doc.get("R1")?.props.opacity).toBe(0.5);
    expect(doc.get("R2")?.props).toMatchObject({ opacity: 0.25, width: 0.25 });
    expect(getProp((doc.get("O1") as NodeRecord).props, "values")).toEqual({ m1: 0.5 });
    // No marker, no system edit: nothing to keep in step, nothing to run twice.
    await runInDurableObject(roomOf(fileId), (_room: FileRoom, state) => {
      expect(state.storage.sql.exec("SELECT v FROM meta WHERE k = 'tokens'").toArray()).toEqual([]);
    });
  });

  it("a snapshot's header says nothing about token semantics: its bindings do", () => {
    expect(JSON.parse(snapshotHeaderLine("F", 3, 0))).not.toHaveProperty("tokens");
  });
});

describe("tabs from before (protocol gate)", { timeout: 60_000 }, () => {
  it("a tab from before variables and styles is told to reload at hello", async () => {
    const { browser, fileId } = await newFile();
    const socket = await openSocket(browser, fileId);
    socket.send({ t: "hello", protocol: 2, clientId: "old-2", revn: null, copies: ["compact"] });
    expect((await socket.next<{ code: string }>("error")).code).toBe("reload");
    // One from before compact copies is shown a page saying so, never the file.
    const older = await openSocket(browser, fileId);
    older.send({ t: "hello", protocol: 1, clientId: "old-1", revn: null });
    expect(await older.next<{ role: string; revn: number }>("welcome")).toMatchObject({
      role: "viewer",
      revn: 0,
    });
    const chunk = await older.next<{ nodes: NodeRecord[] }>("snapshot");
    expect(chunk.nodes.map((n) => n.id)).toEqual(["drawpane-reload-page", "drawpane-reload-text"]);
  });
});

describe("what the MCP tools read (F12)", () => {
  it("F12: a copy in a frame set to Dark reads its Dark values, bound size included", () => {
    const nodes: NodeRecord[] = [
      node("P1", "page", ROOT_ID),
      node("C1", "collection", ROOT_ID, {
        modes: [
          { id: "light", name: "Light" },
          { id: "dark", name: "Dark" },
        ],
      }),
      node("V1", "variable", "C1", {
        variableType: "color",
        values: { light: "#ffffff", dark: "#000000" },
      }),
      node("N1", "variable", "C1", { variableType: "number", values: { light: 20, dark: 40 } }),
      node("D1", "frame", "P1", { variableModes: { C1: "dark" } }),
      node("R1", "rect", "D1", {
        width: 20,
        fills: [{ type: "solid", color: "#ffffff", bind: { color: "V1" } }],
        bindings: { width: "N1" },
      }),
    ];
    const detail = nodeDetail(resolvedView(new FileDoc(nodes)), "R1") as {
      props: { width: number; fills: Array<{ color: string }> };
    };
    expect(detail.props.width).toBe(40);
    expect(detail.props.fills[0]?.color).toBe("#000000");
    // Unresolved, it would read what's stored: the value the canvas doesn't show.
    expect((nodeDetail(new FileDoc(nodes), "R1") as { props: { width: number } }).props.width).toBe(
      20,
    );
  });
});
