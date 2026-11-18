/**
 * Review 6 of #187 against the room's SQL merge and restore, in Node (the
 * memory suite), finding 2: the base is from before records, main folded it
 * as it set Show, and the branch edited Label then reset it. As the room
 * merges, both sides' tables are migrated first (`migrateTable`), so the
 * planner compares records and takes the branch's reset; without that, a
 * record made on both sides is a conflict, never main's silently kept. A
 * restore keeps an empty record.
 */
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Doc } from "@drawpane/editor";
import {
  applyTransaction,
  compactByInstance,
  migrateRecords,
  type NodeRecord,
  ROOT_ID,
} from "@drawpane/model";
import { expect, it } from "vitest";
import { createNodeTable, fillDepths, insertNodes } from "../src/rooms/node-tables";
import { OpChunks } from "../src/rooms/op-chunks";
import { migrateTable } from "../src/rooms/records";
import { restoreFromTable } from "../src/rooms/restore";
import { NODE_SCHEMA, SqlNodeStore } from "../src/rooms/sql-store";
import { applyThreeWay, planThreeWay } from "../src/rooms/three-way";
import { sqlDouble } from "./doubles";

const base: NodeRecord[] = [
  { id: "p", type: "page", parent: ROOT_ID, key: "a0", props: {} },
  {
    id: "m",
    type: "frame",
    parent: "p",
    key: "a0",
    props: {
      isComponent: true,
      componentProps: [
        { id: "label", name: "Label", type: "text" },
        { id: "show", name: "Show", type: "boolean" },
      ],
    },
  },
  {
    id: "t",
    type: "text",
    parent: "m",
    key: "a0",
    props: { characters: "Base", propRefs: { characters: "label" } },
  },
  { id: "v", type: "rect", parent: "m", key: "a1", props: { propRefs: { visible: "show" } } },
  { id: "i", type: "frame", parent: "p", key: "a1", props: { instanceOf: "m" } },
  {
    id: "it",
    type: "text",
    parent: "i",
    key: "a0",
    props: {
      mirrors: "t",
      characters: "Before",
      propRefs: { characters: "label" },
      overrides: ["characters"],
    },
  },
  {
    id: "iv",
    type: "rect",
    parent: "i",
    key: "a1",
    props: { mirrors: "v", propRefs: { visible: "show" } },
  },
];
const branch = base.map((n) =>
  n.id === "i"
    ? { ...n, props: { ...n.props, propValues: {} } }
    : n.id === "it"
      ? { ...n, props: { ...n.props, characters: "Base" } }
      : n,
);
const current = base.map((n) =>
  n.id === "i"
    ? { ...n, props: { ...n.props, propValues: { label: "Before", show: false } } }
    : n.id === "iv"
      ? { ...n, props: { ...n.props, visible: false } }
      : n,
);
function database() {
  const path = join(tmpdir(), `pr187-review6-${process.pid}-${Math.random()}.sqlite`);
  const room = sqlDouble(path, () => {});
  room.sql.exec(NODE_SCHEMA);
  insertNodes(room.sql, "nodes", current);
  createNodeTable(room.sql, "review6_base");
  insertNodes(room.sql, "review6_base", base);
  createNodeTable(room.sql, "review6_branch");
  insertNodes(room.sql, "review6_branch", branch);
  fillDepths(room.sql, "review6_branch");
  const store = new SqlNodeStore(room.sql);
  const out = new OpChunks((ops) =>
    applyTransaction(store, ops, { inverse: false, rollback: false }),
  );
  const close = () => {
    room.close();
    for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
  };
  return { room, store, out, close };
}
it("merges a branch reset against main's first record, both sides migrated as the room does", () => {
  const { room, store, out, close } = database();
  try {
    const tables = { base: "review6_base", other: "review6_branch", removals: "review6_remove" };
    const choices = { resolutions: new Map(), skip: new Set<string>() };
    // Unmigrated, the record both sides made is a conflict: main's kept until it's resolved.
    expect(planThreeWay(room.sql, tables, choices)).toMatchObject({ conflicts: 1, undecided: 1 });
    // As the room merges: both sides from before records migrated first.
    room.transact(() => {
      migrateTable(room.sql, tables.base);
      migrateTable(room.sql, tables.other);
    });
    const plan = planThreeWay(room.sql, tables, choices);
    expect(plan.undecided).toBe(0);
    room.transact(() => applyThreeWay(room.sql, tables, choices, out));
    store.clearCache();
    const rows = room.sql
      .exec<{ id: string; parent: string; key: string; type: NodeRecord["type"]; props: string }>(
        "SELECT * FROM nodes",
      )
      .toArray()
      .map((n) => ({ ...n, props: JSON.parse(n.props) }));
    const converted = compactByInstance(rows);
    const doc = new Doc({ compactCopies: true });
    doc.resetStored(converted.nodes, "compact");
    expect(doc.get(converted.ids.get("it") as string)?.props.characters).toBe("Base");
  } finally {
    close();
  }
});
it("restores an empty record as it is", () => {
  const { room, store, out, close } = database();
  try {
    room.transact(() => restoreFromTable(room.sql, "review6_branch", out));
    store.clearCache();
    expect(store.get("i")?.props.propValues).toEqual({});
  } finally {
    close();
  }
});

for (const branchMigrated of [false, true])
  it(`never reads migrating as an edit: an unchanged instance merges as no change (branch ${branchMigrated ? "migrated in its room" : "from before records"})`, () => {
    const path = join(tmpdir(), `pr187-review6-norm-${process.pid}-${Math.random()}.sqlite`);
    const room = sqlDouble(path, () => {});
    try {
      // Main migrated as its room loaded; the base, a snapshot from before; the branch either.
      const migrated = migrateRecords(base).nodes;
      room.sql.exec(NODE_SCHEMA);
      insertNodes(room.sql, "nodes", migrated);
      createNodeTable(room.sql, "norm_base");
      insertNodes(room.sql, "norm_base", base);
      createNodeTable(room.sql, "norm_branch");
      insertNodes(room.sql, "norm_branch", branchMigrated ? migrated : base);
      fillDepths(room.sql, "norm_branch");
      const tables = { base: "norm_base", other: "norm_branch", removals: "norm_remove" };
      room.transact(() => {
        migrateTable(room.sql, tables.base);
        migrateTable(room.sql, tables.other);
      });
      const choices = { resolutions: new Map(), skip: new Set<string>() };
      expect(planThreeWay(room.sql, tables, choices)).toEqual({
        changes: 0,
        conflicts: 0,
        undecided: 0,
      });
    } finally {
      room.close();
      for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
    }
  });
