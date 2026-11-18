/**
 * The fourth review of #187 against the room's SQL paths, in Node (the
 * memory suite, `pnpm --filter @drawpane/worker memory`):
 * - P1 #4: the automatic conversion keeps an instance whose materialized
 *   layer is stale with respect to its record, showing the record's value;
 * - P2 #6: a branch merge's SQL planner conflicts on a first override both
 *   sides made differently, and applying it leaves main's until resolved;
 * - the review's control: an interrupted fold resumes and folds once.
 */
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Doc } from "@drawpane/editor";
import {
  applyTransaction,
  copyId,
  getProp,
  type NodeRecord,
  OVERRIDE_KEY,
  ROOT_ID,
} from "@drawpane/model";
import { expect, it } from "vitest";
import {
  applyConversion,
  convertStep,
  createConvertTables,
  LIVE_CONVERSION,
} from "../src/rooms/convert";
import { createNodeTable, fillDepths, insertNodes } from "../src/rooms/node-tables";
import { OpChunks } from "../src/rooms/op-chunks";
import { NODE_SCHEMA, SqlNodeStore } from "../src/rooms/sql-store";
import { applyThreeWay, planThreeWay } from "../src/rooms/three-way";
import { sqlDouble } from "./doubles";

const node = (
  id: string,
  type: NodeRecord["type"],
  parent: string,
  key: string,
  props: NodeRecord["props"],
): NodeRecord => ({ id, type, parent, key, props });

/** Three instances of a main with a text property, their layers showing Before. */
function fixture(record = false): NodeRecord[] {
  return [
    node("p", "page", ROOT_ID, "a0", {}),
    node("m", "frame", "p", "a0", {
      isComponent: true,
      componentProps: [{ id: "label", name: "Label", type: "text" }],
    }),
    node("t", "text", "m", "a0", { characters: "Base", propRefs: { characters: "label" } }),
    ...[0, 1, 2].flatMap((i) => [
      node(`i${i}`, "frame", "p", `a${i + 1}`, {
        instanceOf: "m",
        ...(record ? { propValues: { label: "Winning" } } : {}),
      }),
      node(`it${i}`, "text", `i${i}`, "a0", {
        mirrors: "t",
        characters: "Before",
        propRefs: { characters: "label" },
        overrides: ["characters"],
      }),
    ]),
  ];
}

function database(record = false) {
  const path = join(tmpdir(), `drawpane-review4-${process.pid}-${Math.random()}.sqlite`);
  const room = sqlDouble(path, () => {});
  room.sql.exec(NODE_SCHEMA);
  room.transact(() => insertNodes(room.sql, "nodes", fixture(record)));
  createConvertTables(room.sql, LIVE_CONVERSION);
  const close = () => {
    room.close();
    for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
  };
  return { room, close };
}

function finish(room: ReturnType<typeof database>["room"]): NodeRecord[] {
  for (let i = 0; i < 10; i++) if (convertStep(room, "nodes", LIVE_CONVERSION, 1).done) break;
  room.transact(() => applyConversion(room.sql, "nodes", LIVE_CONVERSION));
  return room.sql
    .exec<{ id: string; parent: string; key: string; type: NodeRecord["type"]; props: string }>(
      "SELECT * FROM nodes ORDER BY id",
    )
    .toArray()
    .map((n) => ({ ...n, props: JSON.parse(n.props) }));
}

it("folds a file from before records once, resuming after an interrupted step", () => {
  const { room, close } = database();
  try {
    convertStep(room, "nodes", LIVE_CONVERSION, 1);
    const rows = () => room.sql.exec(`SELECT * FROM ${LIVE_CONVERSION.rows} ORDER BY id`).toArray();
    const before = rows();
    expect(() =>
      room.transact(() => {
        convertStep(room, "nodes", LIVE_CONVERSION, 1);
        throw new Error("cut");
      }),
    ).toThrow("cut");
    expect(rows()).toEqual(before);
    const doc = new Doc();
    doc.resetStored(finish(room), "compact");
    for (let i = 0; i < 3; i++) {
      expect(getProp(doc.get(`i${i}`)?.props ?? {}, "instanceOf")).toBe("m");
      expect(doc.get(`i${i}`)?.props.propValues).toEqual({ label: "Before" });
    }
  } finally {
    close();
  }
});

it("converts an instance whose layer is stale against its record, showing the record's value", () => {
  const { room, close } = database(true);
  try {
    const doc = new Doc();
    doc.resetStored(finish(room), "compact");
    for (let i = 0; i < 3; i++) {
      expect(getProp(doc.get(`i${i}`)?.props ?? {}, "instanceOf")).toBe("m");
      expect(doc.get(doc.childIds(`i${i}`)[0] as string)?.props.characters).toBe("Winning");
    }
  } finally {
    close();
  }
});

it("plans a conflict for first overrides both sides made differently, and keeps main's", () => {
  const { room, close } = database();
  try {
    const { sql } = room;
    createNodeTable(sql, "r4_base");
    createNodeTable(sql, "r4_other");
    insertNodes(sql, "r4_base", fixture());
    const id = copyId("i0", ["t"]);
    const record = (opacity: number) =>
      node(id, "override", "i0", OVERRIDE_KEY, { path: ["t"], opacity, overrides: ["opacity"] });
    insertNodes(sql, "nodes", [record(0.4)]);
    insertNodes(sql, "r4_other", [...fixture(), record(0.7)]);
    fillDepths(sql, "r4_other");
    const tables = { base: "r4_base", other: "r4_other", removals: "r4_removals" };
    const store = new SqlNodeStore(sql);
    const apply = (choices: Parameters<typeof planThreeWay>[2]) =>
      room.transact(() =>
        applyThreeWay(
          sql,
          tables,
          choices,
          new OpChunks((ops) => {
            applyTransaction(store, ops, { rollback: false, inverse: false });
          }),
        ),
      );
    const undecided = { resolutions: new Map(), skip: new Set<string>() };
    expect(planThreeWay(sql, tables, undecided)).toEqual({
      changes: 1,
      conflicts: 1,
      undecided: 1,
    });
    apply(undecided);
    expect(store.get(id)?.props.opacity).toBe(0.4);
    const branch = {
      resolutions: new Map([[`${id}:opacity`, "branch" as const]]),
      skip: new Set<string>(),
    };
    expect(planThreeWay(sql, tables, branch)).toEqual({ changes: 1, conflicts: 1, undecided: 0 });
    apply(branch);
    store.clearCache();
    expect(store.get(id)?.props.opacity).toBe(0.7);
  } finally {
    close();
  }
});
