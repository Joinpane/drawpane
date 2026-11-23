// biome-ignore-all lint/style/noNonNullAssertion: Complete fixtures and asserted records in review reproductions.
import { env, runInDurableObject } from "cloudflare:test";
import { Doc } from "@drawpane/editor";
import { copyId, type NodeRecord, ROOT_ID, snapshotHeaderLine } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { agentDeps, callReadTool } from "../src/agent/call";
import type { FileRoom } from "../src/rooms/file-room";
import { snapshotKey } from "../src/rooms/snapshots";
import { openSocket, signedInUser } from "./helpers";

const roomOf = (id: string) => env.FILE_ROOM.get(env.FILE_ROOM.idFromName(id));
const n = (
  id: string,
  type: NodeRecord["type"],
  parent: string,
  props: NodeRecord["props"] = {},
): NodeRecord => ({ id, type, parent, key: "a0", props });
const legacy = (): NodeRecord[] => [
  n("P", "page", ROOT_ID),
  n("C", "collection", ROOT_ID, { modes: [{ id: "m", name: "M" }] }),
  n("V", "variable", "C", { name: "Half", variableType: "number", values: { m: 0.5 } }),
  n("R", "rect", "P", { opacity: 0.5, bindings: { opacity: "V" } }),
];
const doc = (nodes: unknown, copies: "materialized" | "compact" = "materialized") => {
  const d = new Doc();
  d.resetStored(nodes as NodeRecord[], copies);
  return d;
};
async function file() {
  const owner = await signedInUser("Reviewer");
  const { file } = await owner.browser.json<{ file: { id: string } }>(
    `/api/projects/${owner.projectId}/files`,
    { method: "POST", json: { name: "recheck" } },
  );
  const socket = await openSocket(owner.browser, file.id);
  socket.send({
    t: "hello",
    protocol: 4,
    clientId: "existing",
    revn: null,
    copies: ["materialized", "compact"],
  });
  await socket.next("welcome");
  await socket.next("snapshot");
  return {
    ...owner,
    fileId: file.id,
    room: roomOf(file.id),
    socket,
    by: { userId: owner.userId, name: "Reviewer" },
  };
}
const gzip = (text: string) => new Response(text).body!.pipeThrough(new CompressionStream("gzip"));

// #186's re-check (decision 0034). The opacity migration these blockers were in is gone: a
// binding says how its value maps onto the property, and one stored before 0034 (a plain variable
// id) reads as it did, so legacy files, imports, versions, branches and their bases need no
// conversion and none happens. Tabs from before 0034 still can't write: an old tab would strip
// the bindings it doesn't know from what it rewrites (B1).
describe("PR 186 data preservation", { timeout: 60_000 }, () => {
  it("preserves a saved tracking unit when a materialized file is copied to compact storage", async () => {
    const source = await file();
    const target = await file();
    source.socket.ws.close();
    target.socket.ws.close();
    await runInDurableObject(source.room, (room: FileRoom) => {
      room.compactCopiesOff = true;
    });
    const nodes = [
      ...legacy(),
      n("Track", "variable", "C", { variableType: "number", values: { m: 5 } }),
      n("Main", "frame", "P", { isComponent: true }),
      n("Label", "text", "Main", {
        characters: "Label",
        letterSpacing: { unit: "px", value: 5 },
        bindings: { letterSpacing: "Track" },
      }),
      n("Instance", "frame", "P", { instanceOf: "Main" }),
      n("InstanceLabel", "text", "Instance", {
        mirrors: "Label",
        characters: "Label",
        letterSpacing: { unit: "percent", value: 5 },
        bindings: { letterSpacing: "Track" },
      }),
    ];
    const snapshot =
      snapshotHeaderLine(source.fileId, 1, 0, "materialized") +
      nodes.map((node) => JSON.stringify(node)).join("\n") +
      "\n";
    expect((await source.room.importSnapshot(source.by, source.fileId, gzip(snapshot))).ok).toBe(
      true,
    );
    expect((await source.room.copiesFormat()).copies).toBe("materialized");
    const want = { unit: "percent", value: 5 };
    const original = doc(await source.room.allNodes());
    expect(original.get("InstanceLabel")?.props.letterSpacing).toEqual(want);

    const copied = await target.room.importSnapshot(
      target.by,
      target.fileId,
      await source.room.exportSnapshot(),
    );
    expect(copied.ok).toBe(true);
    expect((await target.room.copiesFormat()).copies).toBe("compact");
    const compact = doc(await target.room.allNodes(), "compact");
    const children = compact.childIds("Instance");
    const id = copyId("Instance", ["Label"]);
    expect(children).toContain(id);
    expect(compact.get(id)?.props.letterSpacing).toEqual(want);
  });

  it("does not let a pre-0034 attachment replace a tagged binding with a bare id", async () => {
    const f = await file();
    const nodes = legacy();
    const layer = nodes.find((node) => node.id === "R")!;
    nodes[nodes.indexOf(layer)] = {
      ...layer,
      props: { opacity: 0.005, bindings: { opacity: { variable: "V", unit: "percent" } } },
    };
    await f.room.storeNodes(nodes);
    await runInDurableObject(f.room, (_room, state) => {
      const ws = state
        .getWebSockets()
        .find((ws) => ws.deserializeAttachment()?.clientId === "existing")!;
      const old = ws.deserializeAttachment();
      delete old.protocol;
      ws.serializeAttachment(old);
    });
    f.socket.send({
      t: "txn",
      seq: 1,
      ops: [{ op: "set", id: "R", prop: "bindings", value: { opacity: "V" } }],
    });
    const reject = await f.socket.next("reject");
    expect(reject).toMatchObject({ seq: 1, code: "format" });
    const stored = await f.room.allNodes();
    expect(stored.find((node) => node.id === "R")?.props.bindings).toEqual({
      opacity: { variable: "V", unit: "percent" },
    });
    expect(doc(stored).get("R")?.props.opacity).toBe(0.005);
    f.socket.ws.close();
  });

  it("B1: a hibernated main-era socket, its attachment saying no protocol, can't write", async () => {
    const f = await file();
    await f.room.storeNodes(legacy());
    // Main's accepted attachment has no protocol marker. Reuse its exact existing shape;
    // no hello occurs when a Durable Object adopts the new class.
    await runInDurableObject(f.room, (_room, state) => {
      const ws = state
        .getWebSockets()
        .find((ws) => ws.deserializeAttachment()?.clientId === "existing")!;
      const a = ws.deserializeAttachment();
      delete a.protocol;
      ws.serializeAttachment(a);
      expect(a.clientId).toBe("existing");
      expect(a.viewing).toBe(false);
    });
    f.socket.send({
      t: "txn",
      seq: 1,
      ops: [{ op: "set", id: "V", prop: "values", value: { m: 0.25 } }],
    });
    const result = await Promise.race([
      f.socket.next("ack"),
      f.socket.next("reject"),
      f.socket.next("error"),
    ]);
    const stored = await f.room.allNodes();
    // An attachment that doesn't say its protocol is a tab from before: refused, told to reload.
    expect(result).not.toHaveProperty("revn");
    expect(doc(stored).get("R")?.props.opacity).toBe(0.5);
    expect(stored.find((x) => x.id === "V")?.props.values).toEqual({ m: 0.5 });
    f.socket.ws.close();
  });
  it("B1 variant: a main-era socket cannot replace paints while stripping new bindings", async () => {
    const f = await file();
    const nodes = legacy();
    nodes.push(n("Color", "variable", "C", { variableType: "color", values: { m: "#ffffff" } }));
    nodes[nodes.findIndex((x) => x.id === "R")] = {
      ...nodes.find((x) => x.id === "R")!,
      props: {
        fills: [{ type: "solid", color: "#ffffff", bind: { color: "Color" } }],
      },
    };
    await f.room.storeNodes(nodes);
    // A tab welcomed before the release: its attachment says no protocol.
    await runInDurableObject(f.room, (_room, state) => {
      const ws = state
        .getWebSockets()
        .find((ws) => ws.deserializeAttachment()?.clientId === "existing")!;
      const a = ws.deserializeAttachment();
      delete a.protocol;
      ws.serializeAttachment(a);
    });
    f.socket.send({
      t: "txn",
      seq: 1,
      ops: [
        {
          op: "set",
          id: "R",
          prop: "fills",
          value: [{ type: "solid", color: "#ffffff", opacity: 0.5 }],
        },
      ],
    });
    const result = await Promise.race([f.socket.next("ack"), f.socket.next("reject")]);
    expect(result).not.toHaveProperty("revn");
    expect((await f.room.allNodes()).find((x) => x.id === "R")?.props.fills?.[0]?.bind?.color).toBe(
      "Color",
    );
    f.socket.ws.close();
  });
  it("B2: a legacy saved snapshot imported reads as it did, unconverted", async () => {
    const f = await file();
    f.socket.ws.close();
    const text =
      snapshotHeaderLine("source", 2, 0, "materialized") +
      legacy()
        .map((x) => JSON.stringify(x))
        .join("\n") +
      "\n";
    const imported = await f.room.importSnapshot(f.by, f.fileId, gzip(text));
    expect(imported.ok).toBe(true);
    const stored = await f.room.allNodes();
    expect(doc(stored).get("R")?.props.opacity).toBe(0.5);
    expect(stored.find((x) => x.id === "V")?.props.values).toEqual({ m: 0.5 });
  });
  it("B5: nothing is made beside a variable, so a node already there is left alone", async () => {
    const f = await file();
    f.socket.ws.close();
    const nodes = legacy();
    nodes.push(n("Width", "rect", "P", { width: 0.5, bindings: { width: "V" } }));
    nodes.push(
      n("V_opacity", "variable", "C", {
        name: "Existing",
        variableType: "number",
        values: { m: 88 },
      }),
    );
    await f.room.storeNodes(nodes);
    const stored = await f.room.allNodes();
    expect(doc(stored).get("R")?.props.opacity).toBe(0.5);
    expect(doc(stored).get("Width")?.props.width).toBe(0.5);
    expect(stored.find((x) => x.id === "V_opacity")?.props.values).toEqual({ m: 88 });
    expect(stored).toHaveLength(nodes.length);
    const stream = await f.room.exportSnapshot();
    const exported = await new Response(stream.pipeThrough(new DecompressionStream("gzip"))).text();
    expect(JSON.parse(exported.split("\n")[0]!)).not.toHaveProperty("tokens");
  });
  it("B5 variant: a large file binding one number both ways is served as it is", async () => {
    const f = await file();
    f.socket.ws.close();
    const nodes = legacy();
    nodes.push(
      ...Array.from({ length: 25_000 }, (_, i) =>
        n(`Bound${i}`, "rect", "P", {
          opacity: 0.5,
          width: 0.5,
          bindings: { opacity: "V", width: "V" },
        }),
      ),
    );
    await f.room.storeNodes(nodes);
    await runInDurableObject(f.room, (_room, state) => {
      const props = (id: string) =>
        JSON.parse(
          state.storage.sql
            .exec<{ props: string }>("SELECT props FROM nodes WHERE id = ?", id)
            .one().props,
        );
      expect(props("V").values.m).toBe(0.5);
      expect(props("R").bindings.opacity).toBe("V");
      expect(props("Bound24999").bindings).toEqual({ opacity: "V", width: "V" });
      expect(
        state.storage.sql
          .exec<{ n: number }>("SELECT COUNT(*) AS n FROM nodes WHERE type = 'variable'")
          .one().n,
      ).toBe(1);
      expect(state.storage.sql.exec("SELECT v FROM meta WHERE k = 'tokens'").toArray()).toEqual([]);
    });
  });
  it("B5 variant: restoring a legacy version keeps its bindings where they were", async () => {
    const f = await file();
    f.socket.ws.close();
    const nodes = legacy();
    const revn = 49;
    nodes.push(n("Width", "rect", "P", { width: 0.5, bindings: { width: "V" } }));
    nodes.push(
      n("V_opacity", "variable", "C", {
        name: "Existing",
        variableType: "number",
        values: { m: 88 },
      }),
    );
    const text =
      snapshotHeaderLine(f.fileId, revn, 0, "materialized") +
      nodes.map((x) => JSON.stringify(x)).join("\n") +
      "\n";
    await env.FILES.put(snapshotKey(f.fileId, revn), await new Response(gzip(text)).arrayBuffer());
    const restored = await f.room.restoreVersion(
      f.by,
      { id: "collision", revn, name: "Collision", at: 0 },
      null,
    );
    expect(restored.ok).toBe(true);
    const after = await f.room.allNodes();
    expect(doc(after).get("R")?.props.opacity).toBe(0.5);
    expect(after.find((x) => x.id === "R")?.props.bindings).toEqual({ opacity: "V" });
    expect(after.find((x) => x.id === "V_opacity")?.props.values).toEqual({ m: 88 });
  });
  it("B7: a tiny fraction is never converted, however often the file is read", async () => {
    const f = await file();
    f.socket.ws.close();
    const nodes = legacy();
    nodes[nodes.findIndex((x) => x.id === "V")] = n("V", "variable", "C", {
      variableType: "number",
      values: { m: 0.005 },
    });
    await f.room.storeNodes(nodes);
    const once = await f.room.allNodes();
    expect(doc(once).get("R")?.props.opacity).toBe(0.005);
    // As the next load sees them: the same rows, read again.
    await f.room.storeNodes(once as NodeRecord[]);
    const twice = await f.room.allNodes();
    expect(doc(twice).get("R")?.props.opacity).toBe(0.005);
    expect(twice.find((x) => x.id === "V")?.props.values).toEqual({ m: 0.005 });
  });
  it("N1: a legacy file is never rewritten when it's opened, so there's nothing to back up", async () => {
    const f = await file();
    f.socket.ws.close();
    await f.room.storeNodes(legacy());
    const before = await runInDurableObject(
      f.room,
      (_room, state) =>
        state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM log").one().n,
    );
    const reader = await openSocket(f.browser, f.fileId);
    reader.send({
      t: "hello",
      protocol: 4,
      clientId: "reader",
      revn: null,
      copies: ["materialized", "compact"],
    });
    await reader.next("welcome");
    reader.ws.close();
    const after = await runInDurableObject(
      f.room,
      (_room, state) =>
        state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM log").one().n,
    );
    expect(after).toBe(before);
    const stored = new Map((await f.room.allNodes()).map((x) => [x.id, x]));
    for (const want of legacy()) expect(stored.get(want.id)).toEqual(want);
  });
  it("B6: a legacy branch merges into main with nothing invented on either side", async () => {
    const f = await file();
    await f.room.storeNodes(legacy());
    // Main adds another bound layer. The old branch merely removed R.
    f.socket.send({
      t: "txn",
      seq: 1,
      ops: [
        {
          op: "create",
          id: "New",
          type: "rect",
          parent: "P",
          key: "a1",
          props: { opacity: 0.5, bindings: { opacity: "V" } },
        },
      ],
    });
    await f.socket.next("ack");
    f.socket.ws.close();
    const baseKey = `files/${f.fileId}/test-legacy-base.gz`;
    const text = (nodes: NodeRecord[]) =>
      snapshotHeaderLine("legacy", 1, 0, "materialized") +
      nodes.map((x) => JSON.stringify(x)).join("\n") +
      "\n";
    await env.FILES.put(baseKey, await new Response(gzip(text(legacy()))).arrayBuffer());
    const branch = legacy().filter((x) => x.id !== "R");
    const result = await f.room.mergeBranch(
      f.by,
      f.fileId,
      { id: "branch", name: "Deleted old layer" },
      { baseKey, nodes: gzip(text(branch)) },
      { resolutions: {}, skip: [] },
    );
    expect(result.ok).toBe(true);
    const after = doc(await f.room.allNodes());
    expect(after.get("R")).toBeUndefined();
    expect(after.get("New")?.props.opacity).toBe(0.5);
    expect(after.get("V")?.props.values).toEqual({ m: 0.5 });
  });
  it("current compact copy reads agree between client, SQL MCP and cold/warm agent runner", async () => {
    const f = await file();
    const nodes = [
      n("P", "page", ROOT_ID),
      n("C", "collection", ROOT_ID, {
        modes: [
          { id: "light", name: "Light" },
          { id: "dark", name: "Dark" },
        ],
      }),
      n("V", "variable", "C", {
        variableType: "color",
        values: { light: "#ffffff", dark: "#000000" },
      }),
      n("N", "variable", "C", { variableType: "number", values: { light: 20, dark: 40 } }),
      n("S", "paintStyle", ROOT_ID, {
        fills: [{ type: "solid", color: "#ffffff", bind: { color: "V" } }],
      }),
      n("M", "frame", "P", { isComponent: true }),
      n("R", "rect", "M", { width: 20, height: 10, fillStyle: "S", bindings: { width: "N" } }),
      n("F", "frame", "P", { variableModes: { C: "dark" } }),
      n("I", "frame", "F", { instanceOf: "M" }),
    ];
    await f.room.storeNodes(nodes);
    const client = doc(await f.room.allNodes(), "compact");
    const child = client.childIds("I")[0]!;
    expect(client.get(child)?.props.width).toBe(40);
    expect(await f.room.readDocument(f.fileId, { kind: "node", nodeId: child })).toMatchObject({
      props: { width: 40, fills: [{ color: "#000000" }] },
    });
    const read = () =>
      callReadTool(agentDeps(env, f.fileId), {
        fileId: f.fileId,
        tool: "get_jsx",
        input: { id: child },
      });
    const cold = await read();
    expect(cold.ok).toBe(true);
    expect(cold.ok && JSON.stringify(cold.result)).toContain("w={40}");
    expect(cold.ok && JSON.stringify(cold.result)).toContain("#000000");
    f.socket.send({
      t: "txn",
      seq: 1,
      ops: [{ op: "set", id: "N", prop: "values", value: { light: 20, dark: 60 } }],
    });
    await f.socket.next("ack");
    const warm = await read();
    expect(warm.ok).toBe(true);
    expect(warm.ok && JSON.stringify(warm.result)).toContain("w={60}");
    expect(await f.room.readDocument(f.fileId, { kind: "node", nodeId: child })).toMatchObject({
      props: { width: 60 },
    });
    f.socket.ws.close();
  });
  it("protocol 1 placeholder rejects edits and protocols 2 and 3 reload", async () => {
    const f = await file();
    f.socket.ws.close();
    const old = await openSocket(f.browser, f.fileId);
    old.send({ t: "hello", protocol: 1, clientId: "old1", revn: null });
    expect(await old.next("welcome")).toMatchObject({ role: "viewer", revn: 0 });
    await old.next("snapshot");
    old.send({
      t: "txn",
      seq: 1,
      ops: [{ op: "create", id: "oldwrite", type: "page", parent: ROOT_ID, key: "a1", props: {} }],
    });
    await old.next("reject");
    expect((await f.room.allNodes()).some((x) => x.id === "oldwrite")).toBe(false);
    old.ws.close();
    const newer = await openSocket(f.browser, f.fileId);
    newer.send({ t: "hello", protocol: 2, clientId: "old2", revn: null, copies: ["compact"] });
    expect(await newer.next("error")).toMatchObject({ code: "reload" });
    const three = await openSocket(f.browser, f.fileId);
    three.send({ t: "hello", protocol: 3, clientId: "old3", revn: null, copies: ["compact"] });
    expect(await three.next("error")).toMatchObject({ code: "reload" });
  });
  it("restoring a legacy version reads its opacity as it did", async () => {
    const f = await file();
    f.socket.ws.close();
    const revn = 50;
    const text =
      snapshotHeaderLine(f.fileId, revn, 0, "materialized") +
      legacy()
        .map((x) => JSON.stringify(x))
        .join("\n") +
      "\n";
    await env.FILES.put(snapshotKey(f.fileId, revn), await new Response(gzip(text)).arrayBuffer());
    const restored = await f.room.restoreVersion(
      f.by,
      { id: "legacy", revn, name: "Legacy", at: 0 },
      null,
    );
    expect(restored.ok).toBe(true);
    expect(doc(await f.room.allNodes()).get("R")?.props.opacity).toBe(0.5);
  });
});
