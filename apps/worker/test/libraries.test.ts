/**
 * Team libraries (decision 0010): publishing a file as a library, listing a
 * file's publishes, and the libraries other files on the team can use.
 */
import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import type { LibraryAsset, LibraryPublish, NodeRecord, Op, VersionInfo } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { snapshotKey } from "../src/rooms/snapshots";
import { type Browser, openSocket, signedInUser } from "./helpers";

const asset = (id: string, name: string, hash = "0123456789abcdef"): LibraryAsset => ({
  id,
  name,
  description: "",
  set: false,
  hash,
});

async function newFile(browser: Browser, projectId: string, name: string) {
  const { file } = await browser.json<{ file: { id: string } }>(
    `/api/projects/${projectId}/files`,
    { method: "POST", json: { name } },
  );
  await open(browser, file.id);
  return file.id;
}

/** Opens a file in the editor (as publishing does from there): its room knows it, and edits go in. */
async function open(browser: Browser, fileId: string) {
  const socket = await openSocket(browser, fileId);
  socket.send({ t: "hello", protocol: 1, clientId: `client-${fileId}`, revn: null });
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

function publish(browser: Browser, fileId: string, body: unknown) {
  return browser.fetch(`/api/files/${fileId}/library/publish`, { method: "POST", json: body });
}

describe("team libraries", () => {
  it("publishes a file as a named version, with what it offers", async () => {
    const ana = await signedInUser("Ana");
    const kit = await newFile(ana.browser, ana.projectId, "Brand kit");
    const res = await publish(ana.browser, kit, {
      description: "  Buttons and cards\nWith a new radius ",
      assets: [asset("btn", "Button"), asset("card", "Card")],
    });
    expect(res.status).toBe(201);
    const { publish: published } = (await res.json()) as { publish: LibraryPublish };
    expect(published).toMatchObject({
      fileId: kit,
      fileName: "Brand kit",
      description: "Buttons and cards\nWith a new radius",
      publishedBy: { id: ana.userId, name: "Ana" },
    });
    expect(published.assets.map((a) => a.name)).toEqual(["Button", "Card"]);
    // Its version is a named one in the file's history, so it never expires.
    const { versions } = await ana.browser.json<{ versions: VersionInfo[] }>(
      `/api/files/${kit}/versions`,
    );
    expect(versions.find((v) => v.id === published.versionId)?.name).toBe(
      "Published: Buttons and cards",
    );
    const { publishes } = await ana.browser.json<{ publishes: LibraryPublish[] }>(
      `/api/files/${kit}/library`,
    );
    expect(publishes.map((p) => p.id)).toEqual([published.id]);
  });

  it("refuses an empty publish, bad assets, and people who can only view", async () => {
    const ana = await signedInUser("Ana");
    const kit = await newFile(ana.browser, ana.projectId, "Kit");
    expect((await publish(ana.browser, kit, { assets: [] })).status).toBe(400);
    expect((await publish(ana.browser, kit, { assets: [{ id: "x" }] })).status).toBe(400);
    const viewer = await signedInUser("Vic", "viewer", ana.teamId);
    expect((await publish(viewer.browser, kit, { assets: [asset("b", "B")] })).status).toBe(403);
    const stranger = await signedInUser("Sam");
    expect((await publish(stranger.browser, kit, { assets: [asset("b", "B")] })).status).toBe(404);
  });

  it("offers a team's other libraries to a file, latest publish each, and their snapshots", async () => {
    const ana = await signedInUser("Ana");
    const kit = await newFile(ana.browser, ana.projectId, "Kit");
    const icons = await newFile(ana.browser, ana.projectId, "Icons");
    const product = await newFile(ana.browser, ana.projectId, "Product");
    await publish(ana.browser, kit, { assets: [asset("btn", "Button")] });
    const second = (await (
      await publish(ana.browser, kit, {
        description: "Rounder",
        assets: [asset("btn", "Button", "fedcba9876543210")],
      })
    ).json()) as { publish: LibraryPublish };
    await publish(ana.browser, icons, { assets: [asset("star", "Star")] });

    // A teammate who can only view still uses the team's libraries.
    const vic = await signedInUser("Vic", "viewer", ana.teamId);
    const { libraries } = await vic.browser.json<{ libraries: LibraryPublish[] }>(
      `/api/files/${product}/libraries`,
    );
    expect(libraries.map((l) => [l.fileName, l.description])).toEqual([
      ["Icons", null],
      ["Kit", "Rounder"],
    ]);
    // A library doesn't offer itself to itself.
    const own = await ana.browser.json<{ libraries: LibraryPublish[] }>(
      `/api/files/${kit}/libraries`,
    );
    expect(own.libraries.map((l) => l.fileName)).toEqual(["Icons"]);
    // The publish's snapshot is there to copy from.
    const snapshot = await vic.browser.fetch(
      `/api/files/${kit}/versions/${second.publish.versionId}/snapshot`,
    );
    expect(snapshot.status).toBe(200);
    // Another team sees none of them.
    const sam = await signedInUser("Sam");
    expect((await sam.browser.fetch(`/api/files/${product}/libraries`)).status).toBe(404);
  });

  it("keeps the version a publish points at when the sweep runs, even un-named", async () => {
    const ana = await signedInUser("Ana");
    const kit = await newFile(ana.browser, ana.projectId, "Kit");
    const { page, edit } = await open(ana.browser, kit);
    await edit([
      {
        op: "create",
        id: "card",
        type: "rect",
        parent: page.id,
        key: "a0",
        props: { x: 0, y: 0, width: 10, height: 10 },
      },
    ]);
    const { publish: published } = (await (
      await publish(ana.browser, kit, { assets: [asset("btn", "Button")] })
    ).json()) as { publish: LibraryPublish };
    await ana.browser.fetch(`/api/files/${kit}/versions/${published.versionId}`, {
      method: "PATCH",
      json: { name: null },
    });
    // Later edits and an autosave, then everything ages past retention.
    await edit([{ op: "set", id: "card", prop: "x", value: 5 }]);
    const stub = env.FILE_ROOM.get(env.FILE_ROOM.idFromName(kit));
    await runInDurableObject(stub, (_room, state) => {
      state.storage.sql.exec("UPDATE log SET at = at - 11 * 60000");
    });
    await runDurableObjectAlarm(stub);
    await env.DB.prepare(
      "UPDATE versions SET created_at = created_at - 31 * 86400000 WHERE file_id = ?",
    )
      .bind(kit)
      .run();
    // Another edit, so the room's alarm runs again, and sweeps.
    await edit([{ op: "set", id: "card", prop: "x", value: 9 }]);
    await runInDurableObject(stub, (_room, state) => {
      state.storage.sql.exec("UPDATE log SET at = at - 11 * 60000");
      state.storage.sql.exec("DELETE FROM meta WHERE k = 'swept_at'");
    });
    await runDurableObjectAlarm(stub);
    const { versions } = await ana.browser.json<{ versions: VersionInfo[] }>(
      `/api/files/${kit}/versions`,
    );
    expect(versions.map((v) => v.id)).toContain(published.versionId);
    expect(await env.FILES.head(snapshotKey(kit, published.revn))).not.toBeNull();
  });
});
