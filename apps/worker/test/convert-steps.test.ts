/**
 * The room's conversion to compact copies, a step at a time
 * (rooms/convert.ts, decision 0029 phase 4b), on a Durable Object's own
 * SQLite: steps bounded by the work they do (the clock doesn't move during
 * a step on Cloudflare), instances made or deleted between steps, and the
 * last step applying only when nothing is left materialized.
 */
import { env, runInDurableObject } from "cloudflare:test";
import { generateKit } from "@drawpane/corpus";
import {
  compactByInstance,
  firstDifference,
  InstanceTooLarge,
  type NodeRecord,
  newId,
} from "@drawpane/model";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyConversion,
  type ConvertTables,
  convertStep,
  createConvertTables,
  markDirty,
  NotAllConverted,
  readyToApply,
  type StepResult,
  tableOf,
} from "../src/rooms/convert";
import { NODE_COLUMNS, type NodeRow, type RoomSql, toRecord } from "../src/rooms/node-tables";

const T: ConvertTables = {
  map: "t_map",
  rows: "t_rows",
  done: "t_done",
  deps: "t_deps",
  roots: "t_roots",
};
const SRC = "t_nodes";

/** Runs `fn` on a fresh Durable Object's SQLite. */
async function inRoom<R>(fn: (room: RoomSql) => R | Promise<R>): Promise<R> {
  const stub = env.FILE_ROOM.get(env.FILE_ROOM.idFromName(`steps-${crypto.randomUUID()}`));
  return runInDurableObject(stub, (_instance, state) =>
    fn({ sql: state.storage.sql, transact: (f) => state.storage.transactionSync(f) }),
  );
}

const all = (room: RoomSql) =>
  room.sql.exec<NodeRow>(`SELECT ${NODE_COLUMNS} FROM ${SRC}`).toArray().map(toRecord);

/** One instance a step: the smallest budget. */
const oneAtATime = (room: RoomSql): StepResult => convertStep(room, SRC, T, 0);
/** Whether the conversion can be applied now. */
const finished = (step: StepResult) => step.done;

/** Instance roots of a live main that still have stored layers: what applying must never leave. */
function strays(room: RoomSql): string[] {
  return room.sql
    .exec<{ id: string }>(
      `SELECT r.id FROM ${SRC} r
        WHERE r.type = 'frame' AND json_extract(r.props, '$.instanceOf') IS NOT NULL
          AND EXISTS (SELECT 1 FROM ${SRC} m WHERE m.id = json_extract(r.props, '$.instanceOf')
                      AND json_extract(m.props, '$.isComponent') = 1)
          AND EXISTS (SELECT 1 FROM ${SRC} c WHERE c.parent = r.id AND c.type != 'override')`,
    )
    .toArray()
    .map((row) => row.id);
}

/** An edit as the room makes one while converting: dirty marking before and after. */
function edit(room: RoomSql, ids: readonly string[], change: () => void) {
  room.transact(() => {
    markDirty(room.sql, SRC, T, ids);
    change();
    markDirty(room.sql, SRC, T, ids);
  });
}

/** A copy of a top-level instance (fresh ids, the same main), as a materialized editor pastes one. */
function cloneInstance(nodes: readonly NodeRecord[], rootId: string): NodeRecord[] {
  const ids = new Map<string, string>([[rootId, newId()]]);
  const out: NodeRecord[] = [];
  const root = nodes.find((n) => n.id === rootId) as NodeRecord;
  out.push({ ...root, id: ids.get(rootId) as string, key: `${root.key}V` });
  for (let grew = true; grew; ) {
    grew = false;
    for (const n of nodes)
      if (!ids.has(n.id) && ids.has(n.parent)) {
        ids.set(n.id, newId());
        out.push({ ...n, id: ids.get(n.id) as string, parent: ids.get(n.parent) as string });
        grew = true;
      }
  }
  return out;
}

function insert(room: RoomSql, nodes: readonly NodeRecord[]) {
  for (const n of nodes)
    room.sql.exec(
      `INSERT INTO ${SRC} (id, parent, key, type, props) VALUES (?, ?, ?, ?, ?)`,
      n.id,
      n.parent,
      n.key,
      n.type,
      JSON.stringify(n.props),
    );
}

const kit = generateKit({ layers: 3_000, seed: 3 });
const byId = new Map(kit.nodes.map((n) => [n.id, n]));
/** An instance on a screen: inside no main and no other instance. */
const onScreen = (node: NodeRecord) => {
  if (node.type !== "frame" || !node.props.instanceOf) return false;
  for (let at = byId.get(node.parent); at; at = byId.get(at.parent))
    if (at.props.isComponent || at.props.instanceOf || at.props.mirrors) return false;
  return true;
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("converting in steps", { timeout: 120_000 }, () => {
  it("doesn't apply until a fresh listing finds nothing left: an instance made meanwhile converts too", async () => {
    await inRoom((room) => {
      tableOf(room.sql, SRC, kit.nodes);
      createConvertTables(room.sql, T);
      // Steps until one listed instance is left.
      for (let i = 0; ; i++) {
        oneAtATime(room);
        const left = room.sql
          .exec<{ n: number }>(
            `SELECT COUNT(*) AS n FROM ${T.roots} r WHERE NOT EXISTS (SELECT 1 FROM ${T.done} d WHERE d.root = r.id)`,
          )
          .one().n;
        if (left === 1) break;
        if (i > 5_000) throw new Error("never down to one");
      }
      // Someone pastes an instance on a screen: it isn't listed yet.
      const source = kit.nodes.find(onScreen) as NodeRecord;
      const pasted = cloneInstance(kit.nodes, source.id);
      edit(
        room,
        pasted.map((n) => n.id),
        () => insert(room, pasted),
      );
      // The step that settles the last listed instance runs out of budget there.
      for (let i = 0; ; i++) {
        if (finished(oneAtATime(room))) break;
        if (i > 100) throw new Error("the conversion didn't finish");
      }
      const before = all(room);
      room.transact(() => applyConversion(room.sql, SRC, T));
      expect(strays(room)).toEqual([]);
      expect(firstDifference(compactByInstance(before).nodes, all(room))).toBeNull();
    });
  });

  it("bounds a step by the work it does, with the clock standing still", async () => {
    // On Cloudflare, Date.now() doesn't move while code runs without I/O.
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    await inRoom((room) => {
      tableOf(room.sql, SRC, kit.nodes);
      createConvertTables(room.sql, T);
      const first = convertStep(room, SRC, T, 2_000);
      expect(first.done).toBe(false);
      expect(first.left).toBeGreaterThan(0);
      expect(first.converted).toBeLessThan(kit.nodes.length / 20);
      let steps = 1;
      for (;;) {
        steps++;
        if (finished(convertStep(room, SRC, T, 2_000))) break;
        if (steps > 10_000) throw new Error("the conversion didn't finish");
      }
      expect(steps).toBeGreaterThan(2);
      room.transact(() => applyConversion(room.sql, SRC, T));
      expect(firstDifference(compactByInstance(kit.nodes).nodes, all(room))).toBeNull();
    });
  });

  it("finishes when an instance listed and not yet converted is deleted, clock standing still", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    await inRoom((room) => {
      tableOf(room.sql, SRC, kit.nodes);
      createConvertTables(room.sql, T);
      oneAtATime(room);
      const listed = room.sql
        .exec<{ id: string }>(
          `SELECT id FROM ${T.roots} r WHERE NOT EXISTS (SELECT 1 FROM ${T.done} d WHERE d.root = r.id)
            ORDER BY seq LIMIT 1`,
        )
        .one().id;
      edit(room, [listed], () =>
        room.sql.exec(
          `WITH RECURSIVE sub(id) AS (SELECT ? UNION ALL SELECT n.id FROM ${SRC} n JOIN sub ON n.parent = sub.id)
           DELETE FROM ${SRC} WHERE id IN (SELECT id FROM sub)`,
          listed,
        ),
      );
      for (let i = 0; ; i++) {
        if (finished(oneAtATime(room))) break;
        if (i > 5_000) throw new Error("the conversion didn't finish");
      }
      const before = all(room);
      room.transact(() => applyConversion(room.sql, SRC, T));
      expect(firstDifference(compactByInstance(before).nodes, all(room))).toBeNull();
    });
  });

  it("refuses to apply while an instance would stay materialized, changing nothing", async () => {
    await inRoom((room) => {
      tableOf(room.sql, SRC, kit.nodes);
      createConvertTables(room.sql, T);
      for (let i = 0; ; i++) {
        if (finished(convertStep(room, SRC, T))) break;
        if (i > 100) throw new Error("the conversion didn't finish");
      }
      // An instance pasted after the last step, as if nothing had listed it.
      const pasted = cloneInstance(kit.nodes, (kit.nodes.find(onScreen) as NodeRecord).id);
      insert(room, pasted);
      const before = all(room);
      expect(() => room.transact(() => applyConversion(room.sql, SRC, T))).toThrow(NotAllConverted);
      expect(firstDifference(before, all(room))).toBeNull();
      // Listing again finds it, and converting goes on.
      expect(room.transact(() => readyToApply(room.sql, SRC, T))).toBe(false);
      for (let i = 0; ; i++) {
        if (finished(convertStep(room, SRC, T))) break;
        if (i > 100) throw new Error("the conversion didn't finish");
      }
      expect(room.transact(() => readyToApply(room.sql, SRC, T))).toBe(true);
      room.transact(() => applyConversion(room.sql, SRC, T));
      expect(strays(room)).toEqual([]);
      expect(firstDifference(compactByInstance(before).nodes, all(room))).toBeNull();
    });
  });

  it("stops at an instance too large to hold, before reading it", async () => {
    await inRoom((room) => {
      tableOf(room.sql, SRC, kit.nodes);
      createConvertTables(room.sql, T);
      // Every instance in the kit has a layer: whichever comes first stops it.
      expect(() => convertStep(room, SRC, T, 0, { maxInstanceLayers: 0 })).toThrow(
        InstanceTooLarge,
      );
    });
  });

  /** A main of `layers` text layers of `chars` characters each, and a materialized instance of it. */
  const heavy = (layers: number, chars: number, instanceChars = chars): NodeRecord[] => {
    const out: NodeRecord[] = [
      { id: "Pg", type: "page", parent: "root", key: "a0", props: { name: "Page" } as never },
      { id: "Main", type: "frame", parent: "Pg", key: "a0", props: { isComponent: true } as never },
      {
        id: "Inst",
        type: "frame",
        parent: "Pg",
        key: "a1",
        props: { instanceOf: "Main" } as never,
      },
    ];
    for (let i = 0; i < layers; i++) {
      const key = `a${i.toString(36).padStart(3, "0")}`;
      out.push(
        {
          id: `M${i}`,
          type: "text",
          parent: "Main",
          key,
          props: { characters: "m".repeat(chars) } as never,
        },
        {
          id: `C${i}`,
          type: "text",
          parent: "Inst",
          key,
          props: { characters: "m".repeat(instanceChars), mirrors: `M${i}` } as never,
        },
      );
    }
    return out;
  };

  it("stops at an instance whose values are too large to hold, before reading it", async () => {
    await inRoom((room) => {
      tableOf(room.sql, SRC, heavy(4, 5_000));
      createConvertTables(room.sql, T);
      // Layers alone would let it through.
      expect(() => convertStep(room, SRC, T, 0, { maxInstanceBytes: 30_000 })).toThrow(
        InstanceTooLarge,
      );
      expect(convertStep(room, SRC, T, 0, { maxInstanceBytes: 50_000 }).converted).toBe(1);
    });
  });

  it("counts the bytes of the mains an instance is built from, not only its own", async () => {
    await inRoom((room) => {
      // Its own layers are small; its main's are large.
      tableOf(room.sql, SRC, heavy(4, 10_000, 10));
      createConvertTables(room.sql, T);
      expect(() => convertStep(room, SRC, T, 0, { maxInstanceBytes: 30_000 })).toThrow(
        InstanceTooLarge,
      );
    });
  });

  it("bounds a step by the bytes it reads, at least one instance a step", async () => {
    await inRoom((room) => {
      const nodes = heavy(2, 2_000);
      // Three more instances of the same main.
      for (const n of ["X", "Y", "Z"])
        for (const node of nodes.filter((x) => x.id === "Inst" || x.parent === "Inst"))
          nodes.push({
            ...node,
            id: node.id === "Inst" ? `Inst${n}` : `${node.id}${n}`,
            parent: node.id === "Inst" ? "Pg" : `Inst${n}`,
            key: node.id === "Inst" ? `a${n}` : node.key,
          });
      tableOf(room.sql, SRC, nodes);
      createConvertTables(room.sql, T);
      const step = convertStep(room, SRC, T, Number.POSITIVE_INFINITY, { stepBytes: 1 });
      expect(step.converted).toBe(1);
      let steps = 1;
      while (!convertStep(room, SRC, T, Number.POSITIVE_INFINITY, { stepBytes: 1 }).done) steps++;
      expect(steps).toBeGreaterThanOrEqual(4);
    });
  });
});
