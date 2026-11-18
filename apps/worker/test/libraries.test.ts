/**
 * Team libraries (decision 0010): publishing a file as a library, listing a
 * file's publishes, and the libraries other files on the team can use.
 */
import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import {
  type LibraryPublish,
  libraryAssets,
  type NodeRecord,
  nodeReader,
  type Op,
  type VersionInfo,
} from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { TableReader, toRecord } from "../src/rooms/node-tables";
import { snapshotKey } from "../src/rooms/snapshots";
import { type Browser, openSocket, signedInUser } from "./helpers";

/** A component on the page: a frame marked as a main component. */
const component = (id: string, name: string, parent: string, key: string, extra = {}): Op => ({
  op: "create",
  id,
  type: "frame",
  parent,
  key,
  props: { name, x: 0, y: 0, width: 120, height: 40, isComponent: true, ...extra },
});

/** A new file, open in the editor, with `components` (names) on its page. */
async function newFile(
  browser: Browser,
  projectId: string,
  name: string,
  components: string[] = [],
) {
  const { file } = await browser.json<{ file: { id: string } }>(
    `/api/projects/${projectId}/files`,
    { method: "POST", json: { name } },
  );
  const opened = await open(browser, file.id);
  if (components.length > 0)
    await opened.edit(
      components.map((c, i) => component(c.toLowerCase(), c, opened.page.id, `a${i}`)),
    );
  return { id: file.id, ...opened };
}

/** Opens a file in the editor (as publishing does from there): its room knows it, and edits go in. */
async function open(browser: Browser, fileId: string) {
  const socket = await openSocket(browser, fileId);
  socket.send({
    t: "hello",
    protocol: 3,
    clientId: `client-${fileId}`,
    revn: null,
    copies: ["materialized", "compact"],
  });
  await socket.next("welcome");
  const nodes: NodeRecord[] = [];
  for (;;) {
    const chunk = await socket.next<{ nodes: NodeRecord[]; done: boolean }>("snapshot");
    nodes.push(...chunk.nodes);
    if (chunk.done) break;
  }
  const page = nodes.find((n) => n.type === "page") as NodeRecord;
  let seq = 0;
  const edit = async (ops: Op[]) => {
    socket.send({ t: "txn", seq: ++seq, ops });
    await socket.next("ack");
  };
  return { page, edit };
}

async function publish(browser: Browser, fileId: string, body: unknown = {}) {
  return browser.fetch(`/api/files/${fileId}/library/publish`, { method: "POST", json: body });
}

async function published(browser: Browser, fileId: string, body: unknown = {}) {
  const res = await publish(browser, fileId, body);
  expect(res.status).toBe(201);
  return ((await res.json()) as { publish: LibraryPublish }).publish;
}

const roomOf = (fileId: string) => env.FILE_ROOM.get(env.FILE_ROOM.idFromName(fileId));

describe("team libraries", () => {
  it("publishes a file as a named version, with what that version offers", async () => {
    const ana = await signedInUser("Ana");
    const kit = await newFile(ana.browser, ana.projectId, "Brand kit", ["Button", "Card"]);
    const pub = await published(ana.browser, kit.id, {
      description: "  Buttons and cards\nWith a new radius ",
      // What a client says it offers doesn't count: the version's snapshot does.
      assets: [{ id: "x", name: "Made up", description: "", set: false, hash: "0".repeat(16) }],
    });
    expect(pub).toMatchObject({
      fileId: kit.id,
      fileName: "Brand kit",
      description: "Buttons and cards\nWith a new radius",
      publishedBy: { id: ana.userId, name: "Ana" },
    });
    expect(pub.assets.map((a) => [a.id, a.name])).toEqual([
      ["button", "Button"],
      ["card", "Card"],
    ]);
    expect(pub.assets[0]?.hash).toMatch(/^[0-9a-f]{16}$/);
    // Its version is a named one in the file's history, so it never expires.
    const { versions } = await ana.browser.json<{ versions: VersionInfo[] }>(
      `/api/files/${kit.id}/versions`,
    );
    expect(versions.find((v) => v.id === pub.versionId)?.name).toBe("Published: Buttons and cards");
    const { publishes } = await ana.browser.json<{ publishes: LibraryPublish[] }>(
      `/api/files/${kit.id}/library`,
    );
    expect(publishes.map((p) => p.id)).toEqual([pub.id]);
  });

  it("publishes a component however deep it sits, as the in-memory reader finds it", async () => {
    const ana = await signedInUser("Ana");
    const kit = await newFile(ana.browser, ana.projectId, "Deep kit", ["Button"]);
    // Under 132 nested groups (the component at level 134): deeper than an edit may make now,
    // as a file could hold from before moves checked the layers they carry down.
    await runInDurableObject(roomOf(kit.id), (_room, state) => {
      for (let i = 0; i < 132; i++)
        state.storage.sql.exec(
          "INSERT INTO nodes (id, parent, key, type, props) VALUES (?, ?, 'a5', 'group', '{}')",
          `D${i}`,
          i === 0 ? kit.page.id : `D${i - 1}`,
        );
      state.storage.sql.exec(
        "INSERT INTO nodes (id, parent, key, type, props) VALUES ('deep', 'D131', 'a0', 'frame', ?)",
        JSON.stringify({ name: "Deep", isComponent: true }),
      );
    });
    const pub = await published(ana.browser, kit.id);
    expect(pub.assets.map((a) => [a.id, a.name])).toEqual([
      ["button", "Button"],
      ["deep", "Deep"],
    ]);
    // The room's reader over SQLite gives the manifest the in-memory reader does.
    await runInDurableObject(roomOf(kit.id), (_room, state) => {
      const nodes = state.storage.sql
        .exec<{ id: string; parent: string; key: string; type: string; props: string }>(
          "SELECT id, parent, key, type, props FROM nodes",
        )
        .toArray()
        .map(toRecord);
      const inMemory = libraryAssets(nodeReader(nodes));
      expect(libraryAssets(new TableReader(state.storage.sql, "nodes"))).toEqual(inMemory);
      expect(pub.assets).toEqual(inMemory);
    });
  });

  it("refuses an empty publish (leaving no version), and people who can only view", async () => {
    const ana = await signedInUser("Ana");
    const empty = await newFile(ana.browser, ana.projectId, "Empty");
    expect((await publish(ana.browser, empty.id)).status).toBe(400);
    const { versions } = await ana.browser.json<{ versions: VersionInfo[] }>(
      `/api/files/${empty.id}/versions`,
    );
    expect(versions).toEqual([]);
    const kit = await newFile(ana.browser, ana.projectId, "Kit", ["Button"]);
    const viewer = await signedInUser("Vic", "viewer", ana.teamId);
    expect((await publish(viewer.browser, kit.id)).status).toBe(403);
    const stranger = await signedInUser("Sam");
    expect((await publish(stranger.browser, kit.id)).status).toBe(404);
  });

  it("offers a team's other libraries to a file, latest publish each, and every publish's snapshot", async () => {
    const ana = await signedInUser("Ana");
    const kit = await newFile(ana.browser, ana.projectId, "Kit", ["Button"]);
    const icons = await newFile(ana.browser, ana.projectId, "Icons", ["Star"]);
    const product = await newFile(ana.browser, ana.projectId, "Product");
    const first = await published(ana.browser, kit.id);
    await kit.edit([{ op: "set", id: "button", prop: "cornerRadius", value: 12 }]);
    const second = await published(ana.browser, kit.id, { description: "Rounder" });
    expect(second.assets[0]?.hash).not.toBe(first.assets[0]?.hash);
    await published(ana.browser, icons.id);

    // A teammate who can only view still uses the team's libraries.
    const vic = await signedInUser("Vic", "viewer", ana.teamId);
    const { libraries } = await vic.browser.json<{ libraries: LibraryPublish[] }>(
      `/api/files/${product.id}/libraries`,
    );
    expect(libraries.map((l) => [l.fileName, l.description])).toEqual([
      ["Icons", null],
      ["Kit", "Rounder"],
    ]);
    // A library doesn't offer itself to itself.
    const own = await ana.browser.json<{ libraries: LibraryPublish[] }>(
      `/api/files/${kit.id}/libraries`,
    );
    expect(own.libraries.map((l) => l.fileName)).toEqual(["Icons"]);
    // Any publish, however old, and its snapshot, are there to copy from.
    const old = await vic.browser.json<{ publish: LibraryPublish }>(
      `/api/files/${kit.id}/library/publishes/${first.id}`,
    );
    expect(old.publish.id).toBe(first.id);
    expect(
      (await vic.browser.fetch(`/api/files/${kit.id}/versions/${first.versionId}/snapshot`)).status,
    ).toBe(200);
    expect((await vic.browser.fetch(`/api/files/${kit.id}/library/publishes/nope`)).status).toBe(
      404,
    );
    // Another team sees none of them.
    const sam = await signedInUser("Sam");
    expect((await sam.browser.fetch(`/api/files/${product.id}/libraries`)).status).toBe(404);
  });

  it("keeps the version a publish points at when the sweep runs, even un-named", async () => {
    const ana = await signedInUser("Ana");
    const kit = await newFile(ana.browser, ana.projectId, "Kit", ["Button"]);
    const pub = await published(ana.browser, kit.id);
    await ana.browser.fetch(`/api/files/${kit.id}/versions/${pub.versionId}`, {
      method: "PATCH",
      json: { name: null },
    });
    // Later edits and an autosave, then everything ages past retention.
    await kit.edit([{ op: "set", id: "button", prop: "x", value: 5 }]);
    const stub = env.FILE_ROOM.get(env.FILE_ROOM.idFromName(kit.id));
    await runInDurableObject(stub, (_room, state) => {
      state.storage.sql.exec("UPDATE log SET at = at - 11 * 60000");
    });
    await runDurableObjectAlarm(stub);
    await env.DB.prepare(
      "UPDATE versions SET created_at = created_at - 31 * 86400000 WHERE file_id = ?",
    )
      .bind(kit.id)
      .run();
    // Another edit, so the room's alarm runs again, and sweeps.
    await kit.edit([{ op: "set", id: "button", prop: "x", value: 9 }]);
    await runInDurableObject(stub, (_room, state) => {
      state.storage.sql.exec("UPDATE log SET at = at - 11 * 60000");
      state.storage.sql.exec("DELETE FROM meta WHERE k = 'swept_at'");
    });
    await runDurableObjectAlarm(stub);
    const { versions } = await ana.browser.json<{ versions: VersionInfo[] }>(
      `/api/files/${kit.id}/versions`,
    );
    expect(versions.map((v) => v.id)).toContain(pub.versionId);
    expect(await env.FILES.head(snapshotKey(kit.id, pub.revn))).not.toBeNull();
  });
});
