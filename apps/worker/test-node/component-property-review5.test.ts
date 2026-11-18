/**
 * The fifth review of #187 against the room's SQL conversion, in Node (the
 * memory suite, `pnpm --filter @drawpane/worker memory`), P1 #1: a record
 * that exists decides every key, so a reset key stays reset through the
 * automatic conversion, its stale layer showing the main's value, never
 * folded back in as a value from before records.
 */
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Doc } from "@drawpane/editor";
import { applyTransaction, getProp, type NodeRecord, ROOT_ID } from "@drawpane/model";
import { expect, it } from "vitest";
import {
  applyConversion,
  convertStep,
  createConvertTables,
  LIVE_CONVERSION,
} from "../src/rooms/convert";
import { insertNodes } from "../src/rooms/node-tables";
import { NODE_SCHEMA, SqlNodeStore } from "../src/rooms/sql-store";
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

it("keeps a reset key reset through the SQL conversion, the stale layer showing the main's", () => {
  const { room, close } = database(true);
  try {
    // The accepted reset and variant switch stale state: Label reset, another key kept, the text
    // still linked and showing the value from before the reset.
    const store = new SqlNodeStore(room.sql);
    for (let i = 0; i < 3; i++)
      applyTransaction(store, [
        { op: "set", id: `i${i}`, prop: "propValues", key: "label", value: null },
        { op: "set", id: `i${i}`, prop: "propValues", key: "other", value: true },
        { op: "set", id: `it${i}`, prop: "overrides", value: null },
      ]);
    const doc = new Doc();
    doc.resetStored(finish(room), "compact");
    for (let i = 0; i < 3; i++) {
      expect(getProp(doc.get(`i${i}`)?.props ?? {}, "instanceOf")).toBe("m");
      expect(doc.get(`i${i}`)?.props.propValues).toEqual({ other: true });
      expect(doc.get(doc.childIds(`i${i}`)[0] as string)?.props.characters).toBe("Base");
    }
  } finally {
    close();
  }
});
