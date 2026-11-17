/**
 * The room's conversion to compact copies (rooms/convert.ts), run in Node
 * against node:sqlite: a kit stored materialized, converted in many short
 * steps with edits landing between them, gives what converting the edited
 * file in one go gives.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKit } from "@drawpane/corpus";
import {
  applyTransaction,
  compactByInstance,
  firstDifference,
  type NodeRecord,
  type Op,
} from "@drawpane/model";
import { describe, expect, it } from "vitest";
import {
  applyConversion,
  convertStep,
  createConvertTables,
  LIVE_CONVERSION,
  markDirty,
} from "../src/rooms/convert";
import { NODE_COLUMNS, type NodeRow, toRecord } from "../src/rooms/node-tables";
import { NODE_SCHEMA, SqlNodeStore } from "../src/rooms/sql-store";
import { sqlDouble } from "./doubles";

function load(room: ReturnType<typeof sqlDouble>, nodes: readonly NodeRecord[]) {
  room.sql.exec(NODE_SCHEMA);
  const store = new SqlNodeStore(room.sql);
  room.transact(() => {
    for (const node of nodes) store.insert(node);
  });
  return store;
}

const all = (room: ReturnType<typeof sqlDouble>) =>
  room.sql.exec<NodeRow>(`SELECT ${NODE_COLUMNS} FROM nodes`).toArray().map(toRecord);

describe("converting a stored file an instance at a time", { timeout: 600_000 }, () => {
  it("gives the stored form converting it whole gives, in steps", () => {
    const room = sqlDouble(join(tmpdir(), `convert-${process.pid}.db`), () => {});
    const kit = generateKit({ layers: 3_000, seed: 4 });
    load(room, kit.nodes);
    createConvertTables(room.sql, LIVE_CONVERSION);
    let steps = 0;
    for (;;) {
      steps++;
      // A tiny budget: an instance a step.
      const step = convertStep(room, "nodes", LIVE_CONVERSION, 0);
      if (step.done) break;
    }
    const applied = room.transact(() => applyConversion(room.sql, "nodes", LIVE_CONVERSION));
    expect(applied.detached).toBe(0);
    const expected = compactByInstance(kit.nodes);
    expect(firstDifference(expected.nodes, all(room))).toBeNull();
    expect(steps).toBeGreaterThan(10);
    room.close();
  });

  it("follows edits made while it converts", () => {
    const room = sqlDouble(join(tmpdir(), `convert-edit-${process.pid}.db`), () => {});
    const kit = generateKit({ layers: 3_000, seed: 5 });
    const store = load(room, kit.nodes);
    createConvertTables(room.sql, LIVE_CONVERSION);
    // Edits as the materialized editor makes them: a main's fill and every copy of it.
    const mains = kit.nodes.filter((n) => n.type === "frame" && n.props.isComponent);
    const copiesOf = (id: string) => kit.nodes.filter((n) => n.props.mirrors === id);
    let edits = 0;
    for (let i = 0; ; i++) {
      const step = convertStep(room, "nodes", LIVE_CONVERSION, 0);
      if (step.done && edits >= 6) break;
      // Six edits, a few steps apart, then it's left to finish.
      if (edits >= 6 || i % 3 !== 0) continue;
      const main = mains[(i * 7) % mains.length] as NodeRecord;
      const fill = [{ type: "solid", color: `#${(i % 10).toString().repeat(6)}` }];
      const ops: Op[] = [{ op: "set", id: main.id, prop: "fills", value: fill } as Op];
      for (const copy of copiesOf(main.id))
        if (!(copy.props.overrides ?? []).includes("fills"))
          ops.push({ op: "set", id: copy.id, prop: "fills", value: fill } as Op);
      room.transact(() => {
        const ids = ops.map((op) => op.id);
        markDirty(room.sql, "nodes", LIVE_CONVERSION, ids);
        applyTransaction(store, ops, { rollback: false });
        markDirty(room.sql, "nodes", LIVE_CONVERSION, ids);
      });
      store.clearCache();
      edits++;
    }
    const materialized = all(room);
    room.transact(() => applyConversion(room.sql, "nodes", LIVE_CONVERSION));
    const expected = compactByInstance(materialized);
    expect(firstDifference(expected.nodes, all(room))).toBeNull();
    room.close();
  });
});
