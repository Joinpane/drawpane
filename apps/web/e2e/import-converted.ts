/**
 * A converted .fig (the folder `tools/kit-parity` convert step makes:
 * `meta.json`, `nodes.ndjson` and `images/`) imported into a new file of a
 * signed-in instance, the way the dashboard saves an import: images
 * uploaded, nodes sent in parts, then committed. Used by the kit parity
 * spec and the file benchmark.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { IMPORT_PART_BYTES } from "@drawpane/model";
import type { Page } from "@playwright/test";

const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, "utf8")) as T;

/** Fills a new file with the converted nodes, as the dashboard's import saves them. */
export async function importConverted(
  page: Page,
  cache: string,
  name = "Kit parity",
): Promise<string> {
  const meta = readJson<{ key: string; images: { sha: string; mime: string }[]; fig: string }>(
    join(cache, "meta.json"),
  );
  const fileId = await newFile(page, name);
  for (const image of meta.images) {
    const response = await page.request.post(`/api/files/${fileId}/media`, {
      data: readFileSync(join(cache, "images", image.sha)),
      headers: { "content-type": image.mime },
    });
    const body = await response.json();
    if (body.sha !== image.sha) throw new Error(`Image ${image.sha} stored as ${body.sha}`);
  }
  const lines = readFileSync(join(cache, "nodes.ndjson"), "utf8").split("\n").filter(Boolean);
  await sendNodes(page, fileId, lines);
  console.log(`Imported ${lines.length} nodes and ${meta.images.length} images.`);
  return fileId;
}

/** Nodes (made by a generator) imported into a new file, as the dashboard saves an import. */
export async function importNodes(
  page: Page,
  nodes: readonly object[],
  name = "Generated",
): Promise<string> {
  const fileId = await newFile(page, name);
  await sendNodes(
    page,
    fileId,
    nodes.map((n) => JSON.stringify(n)),
  );
  return fileId;
}

async function newFile(page: Page, name: string): Promise<string> {
  const teams = await (await page.request.get("/api/teams")).json();
  const projects = await (
    await page.request.get(`/api/teams/${teams.teams[0].id}/projects`)
  ).json();
  const created = await (
    await page.request.post(`/api/projects/${projects.projects[0].id}/files`, {
      data: { name },
    })
  ).json();
  return created.file.id as string;
}

/** Sends nodes (one JSON object a line) in parts and commits them. */
async function sendNodes(page: Page, fileId: string, lines: readonly string[]): Promise<void> {
  const begun = await (
    await page.request.post(`/api/files/${fileId}/imports`, { data: {} })
  ).json();
  const imports = `/api/files/${fileId}/imports/${begun.importId}`;
  let part: string[] = [];
  let bytes = 0;
  const send = async () => {
    const response = await page.request.post(`${imports}/parts`, {
      data: `{"nodes":[${part.join(",")}]}`,
      headers: { "content-type": "application/json" },
    });
    if (!response.ok()) throw new Error(`A part was refused: ${await response.text()}`);
    part = [];
    bytes = 0;
  };
  for (const line of lines) {
    const size = Buffer.byteLength(line);
    if (part.length > 0 && bytes + size > IMPORT_PART_BYTES) await send();
    part.push(line);
    bytes += size;
  }
  if (part.length > 0) await send();
  const committed = await page.request.post(`${imports}/commit`, { data: {} });
  if (!committed.ok()) throw new Error(`The import wasn't committed: ${await committed.text()}`);
}
