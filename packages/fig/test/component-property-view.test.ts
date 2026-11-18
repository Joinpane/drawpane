/**
 * Decision 0035's rule for values, under collaboration: an instance's value
 * for a property is the value of the layers it drives, kept as ordinary
 * overrides (review 7 of #187). An edit writes those layers in one
 * transaction, a reset clears their overrides of the field, and layers that
 * disagree show "Mixed" until an edit sets them all. So concurrent edits,
 * variant switches, detach, branch merges and tabs from before properties
 * are what they are for any override. Each case runs with copies stored both
 * ways, through real sync engines and a room stand-in (property-rooms.ts).
 */
import { instanceProperties } from "@drawpane/editor";
import {
  applyTransaction,
  branchChanges,
  getProp,
  MemoryStore,
  mergeOps,
  type Op,
} from "@drawpane/model";
import { describe, expect, it } from "vitest";
import {
  buttonKit,
  type Client,
  expectAgreement,
  expectConverged,
  expectRowsMatchLayers,
  FORMS,
  opened,
  Room,
  simple,
} from "./property-rooms";

/** What every client and the room's file say the row is. */
const rowsEverywhere = (room: Room, instance: string, property: string) => [
  ...room.clients.map((c) => c.row(instance, property)),
  instanceProperties(opened(room), instance)?.rows.find((r) => r.id === property),
];

for (const form of FORMS)
  describe(`property values are their layers' values (${form})`, () => {
    it("writes an edit as overrides on every layer the property drives, in one transaction", () => {
      const room = new Room(buttonKit(), form);
      const a = room.join("a");
      room.join("b");
      const sentBefore = a.editor.sync.pendingCount;
      a.editor.setInstanceProperty("i", "label", "Mine");
      expect(a.editor.sync.pendingCount - sentBefore).toBe(1);
      room.settle();
      expectConverged(room);
      for (const row of rowsEverywhere(room, "i", "label"))
        expect(row).toMatchObject({ value: "Mine", changed: true });
      const target = a.row("i", "label")?.targets[0] as string;
      expect(getProp(a.editor.doc.get(target)?.props ?? {}, "overrides")).toContain("characters");
    });

    describe("an edit and a reset at once", () => {
      /** An edit and a reset of Label made without seeing each other, the reset reaching the room last or first. */
      const race = (resetLast: boolean) => {
        const room = new Room(simple(), form);
        const a = room.join("a");
        const b = room.join("b");
        a.editor.setInstanceProperty("i", "label", "Mine");
        b.editor.resetInstanceProperty("i", "label");
        const [first, second] = resetLast ? [a, b] : [b, a];
        first.editor.sync.flush();
        second.editor.sync.flush();
        room.settle();
        expectConverged(room);
        return room;
      };

      it("is the later one's value, everywhere, whichever reaches the room last", () => {
        for (const row of rowsEverywhere(race(true), "i", "label"))
          expect(row).toMatchObject({ value: "Base", changed: false });
        for (const row of rowsEverywhere(race(false), "i", "label"))
          expect(row).toMatchObject({ value: "Mine" });
      });

      // Follow-up, as on main for any override: the edit's layer was marked already, so the edit
      // sends no marks of its own, and a reset reaching the room first leaves its value unmarked
      // (a later sync of a materialized copy puts the main's back).
      it.fails("keeps the later edit marked as an override (follow-up, main's overrides)", () => {
        for (const row of rowsEverywhere(race(false), "i", "label"))
          expect(row).toMatchObject({ value: "Mine", changed: true });
      });

      it("keeps both when they're of different properties", () => {
        const room = new Room(simple(), form);
        const a = room.join("a");
        const b = room.join("b");
        a.editor.setInstanceProperty("i", "show", false);
        b.editor.resetInstanceProperty("i", "label");
        room.settle();
        expectConverged(room);
        for (const row of rowsEverywhere(room, "i", "show"))
          expect(row).toMatchObject({ value: false, changed: true });
        for (const row of rowsEverywhere(room, "i", "label"))
          expect(row).toMatchObject({ value: "Base", changed: false });
      });
    });

    it("carries a value across a variant switch by property id, its label named differently", () => {
      const room = new Room(buttonKit(), form);
      const a = room.join("a");
      room.join("b");
      a.editor.setInstanceProperty("i", "label", "Keep");
      a.editor.setInstanceProperty("i", "icon", "iconB");
      // Variant B's label layer is "Title", not "Label": a name path doesn't carry it.
      a.editor.setInstanceVariant("i", "State", "B");
      room.settle();
      expectConverged(room);
      for (const row of rowsEverywhere(room, "i", "label"))
        expect(row).toMatchObject({ value: "Keep", changed: true });
      for (const row of rowsEverywhere(room, "i", "icon"))
        expect(row).toMatchObject({ value: "iconB", changed: true });
      // One undo step takes the switch back, with what it carried.
      a.editor.undo();
      room.settle();
      expect(a.row("i", "State")?.value).toBe("A");
      expect(a.row("i", "label")).toMatchObject({ value: "Keep", changed: true });
      expectAgreement(room, "i");
    });

    it("keeps what a detached instance's layers show, as plain values", () => {
      const room = new Room(buttonKit(), form);
      const a = room.join("a");
      const b = room.join("b");
      a.editor.setInstanceProperty("i", "label", "Kept");
      a.editor.setInstanceProperty("i", "show", false);
      room.settle();
      const label = a.row("i", "label")?.targets[0] as string;
      const icon = a.row("i", "show")?.targets[0] as string;
      b.editor.select(["i"]);
      b.editor.detachInstances();
      room.settle();
      expectConverged(room);
      for (const client of room.clients) {
        expect(instanceProperties(client.editor.doc, "i")).toBeNull();
        expect(client.field(label, "characters")).toBe("Kept");
        expect(client.field(icon, "visible")).toBe(false);
      }
      const file = opened(room);
      expect(getProp(file.get(label)?.props ?? {}, "characters")).toBe("Kept");
      expect(getProp(file.get(icon)?.props ?? {}, "visible")).toBe(false);
    });

    it("merges a branch's value as any override, and says when main set another", () => {
      const main = new Room(buttonKit(), form);
      const base = new MemoryStore(structuredClone([...main.store.nodes()]));
      const branch = Room.stored([...main.store.nodes()], form);
      const onMain = main.join("main");
      const onBranch = branch.join("branch");
      onBranch.editor.setInstanceProperty("i", "label", "From branch");
      onMain.editor.setInstanceProperty("i", "show", false);
      main.settle();
      branch.settle();
      // Different properties: the branch's value merges, main's stays.
      const changes = branchChanges(base, branch.store, main.store);
      expect(changes.filter((c) => c.conflict)).toEqual([]);
      main.commit(mergeOpsOf(main, branch, changes));
      main.settle();
      expectConverged(main);
      for (const row of rowsEverywhere(main, "i", "label"))
        expect(row).toMatchObject({ value: "From branch", changed: true });
      for (const row of rowsEverywhere(main, "i", "show"))
        expect(row).toMatchObject({ value: false, changed: true });
      expectRowsMatchLayers(opened(main), "i");

      // The same property on both sides: a conflict, and main's value until it's resolved.
      onBranch.editor.setInstanceProperty("i", "label", "Branch again");
      onMain.editor.setInstanceProperty("i", "label", "Main's");
      main.settle();
      branch.settle();
      const again = branchChanges(base, branch.store, main.store);
      expect(again.some((c) => c.conflict && c.kind === "changed")).toBe(true);
      main.commit(mergeOpsOf(main, branch, again));
      main.settle();
      for (const row of rowsEverywhere(main, "i", "label"))
        expect(row).toMatchObject({ value: "Main's", changed: true });
    });

    it("takes a tab from before properties editing a driven layer by hand as that property's value", () => {
      const room = new Room(buttonKit(), form);
      const a = room.join("a");
      // Offline, it knows no properties: it edits the label text, a layer like any other.
      const old = room.joinOffline("old");
      const label = old.editor.doc
        .childIds("i")
        .find((id) => old.editor.doc.get(id)?.type === "text") as string;
      old.editor.commit([{ op: "set", id: label, prop: "characters", value: "Typed" }]);
      // Meanwhile a teammate sets Show.
      a.editor.setInstanceProperty("i", "show", false);
      room.settle();
      expectConverged(room);
      expect(room.rejected).toEqual([]);
      for (const row of rowsEverywhere(room, "i", "label"))
        expect(row).toMatchObject({ value: "Typed", changed: true });
      for (const row of rowsEverywhere(room, "i", "show"))
        expect(row).toMatchObject({ value: false, changed: true });
      // And a reset of the property puts it back, everywhere.
      (room.clients[0] as Client).editor.resetInstanceProperty("i", "label");
      room.settle();
      for (const row of rowsEverywhere(room, "i", "label"))
        expect(row).toMatchObject({ value: "Button", changed: false });
    });
  });

/** The merge operations a room makes, as stored. */
function mergeOpsOf(main: Room, branch: Room, changes: ReturnType<typeof branchChanges>): Op[] {
  const ops = mergeOps(main.store, branch.store, changes);
  // Checked as the room checks it: it applies whole.
  const probe = new MemoryStore(structuredClone([...main.store.nodes()]));
  applyTransaction(probe, ops);
  return ops;
}
