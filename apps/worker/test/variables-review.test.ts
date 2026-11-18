/**
 * The room's side of #186's review (decision 0034): a file stored before
 * variables and styles is migrated as its room loads it, so an opacity
 * variable holding 0.5 still reads as 50% (F9); a table read aside (a
 * version, a branch's base) is migrated the same way; a tab from before
 * reloads at hello; and the MCP tools read values as the canvas shows them
 * (F12: an agent never computes from a value people don't see).
 */
import { env, runInDurableObject } from "cloudflare:test";
import { Doc } from "@drawpane/editor";
import {
  getProp,
  type NodeRecord,
  ROOT_ID,
  snapshotHeaderLine,
  snapshotTokens,
  TOKENS_VERSION,
} from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { FileDoc, nodeDetail, resolvedView } from "../src/mcp/document";
import type { FileRoom } from "../src/rooms/file-room";
import {
  createNodeTable,
  insertNodes,
  NODE_COLUMNS,
  type NodeRow,
  toRecord,
} from "../src/rooms/node-tables";
import { migrateTable } from "../src/rooms/token-migration";
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
  it("F9: is migrated as its room loads it, and opacity looks as it did", async () => {
    const { fileId } = await newFile();
    await roomOf(fileId).loadFromBeforeTokens(legacy());
    const nodes = (await roomOf(fileId).allNodes()) as NodeRecord[];
    const doc = new Doc();
    doc.resetStored(nodes, "materialized");
    expect(doc.get("R1")?.props.opacity).toBe(0.5);
    expect(doc.get("R2")?.props).toMatchObject({ opacity: 0.25, width: 0.25 });
    // Bound only to opacity: its fraction is now the percentage it read as.
    expect(getProp((doc.get("O1") as NodeRecord).props, "values")).toEqual({ m1: 50 });
    // Shared with a width: left as it is; opacity has a variable of its own.
    expect(getProp((doc.get("W1") as NodeRecord).props, "values")).toEqual({ m1: 0.25 });
    // Noted as done: it isn't migrated again.
    const count = nodes.length;
    await runInDurableObject(roomOf(fileId), (_room: FileRoom, state) => {
      const row = state.storage.sql
        .exec<{ v: string }>("SELECT v FROM meta WHERE k = 'tokens'")
        .toArray()[0];
      expect(Number(row?.v)).toBe(TOKENS_VERSION);
    });
    expect(((await roomOf(fileId).allNodes()) as NodeRecord[]).length).toBe(count);
  });

  it("F9: a version or a branch's base read aside is migrated in its table", async () => {
    const stub = env.FILE_ROOM.get(env.FILE_ROOM.idFromName(`tokens-${crypto.randomUUID()}`));
    await runInDurableObject(stub, (_room, state) => {
      const sql = state.storage.sql;
      createNodeTable(sql, "t_version");
      insertNodes(sql, "t_version", legacy());
      sql.exec("UPDATE t_version SET depth = 1 WHERE parent = ?", ROOT_ID);
      sql.exec("UPDATE t_version SET depth = 2 WHERE parent != ?", ROOT_ID);
      expect(migrateTable(sql, "t_version")).toBeGreaterThan(0);
      const rows = sql
        .exec<NodeRow & { depth: number }>(`SELECT ${NODE_COLUMNS}, depth FROM t_version`)
        .toArray();
      const doc = new Doc();
      doc.resetStored(rows.map(toRecord), "materialized");
      expect(doc.get("R1")?.props.opacity).toBe(0.5);
      expect(doc.get("R2")?.props.opacity).toBe(0.25);
      // The opacity variable made beside a shared one sits under its collection.
      const fork = rows.find((r) => r.type === "variable" && !["O1", "W1"].includes(r.id));
      expect(fork?.depth).toBe(2);
    });
  });

  it("a snapshot says which semantics it's in; one that doesn't is from before", () => {
    const line = snapshotHeaderLine("F", 3, 0);
    expect(snapshotTokens(JSON.parse(line))).toBe(TOKENS_VERSION);
    expect(snapshotTokens(JSON.parse('{"format":"drawpane.snapshot","version":2}'))).toBe(0);
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
