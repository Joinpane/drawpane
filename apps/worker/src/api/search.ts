/**
 * Searching a team's files by name. Every word typed has to appear, in any
 * order, case or accent ("ecole" finds "École"); the best matches come
 * first: the whole name, then names that start with the query, then a word
 * that starts with it, then anywhere; within each, the most recently edited
 * first. Names are compared folded (`search_name`, see searchFold).
 */
import { searchFold } from "@drawpane/model";

/** Words searched for, at most this many. */
const MAX_TERMS = 6;
/** Results returned. */
export const SEARCH_LIMIT = 50;

/** A LIKE pattern's literal text: `%`, `_` and `\` match themselves (with `ESCAPE '\'`). */
export const escapeLike = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`);

export interface FileSearch {
  /** SQL to AND into the WHERE clause, with `?` placeholders. */
  readonly where: string;
  /** SQL for ORDER BY. */
  readonly order: string;
  /** Values for the placeholders, in order: the WHERE clause's, then ORDER BY's. */
  readonly binds: readonly string[];
}

/** The search for `query`, or null when it has no words. */
export function fileSearch(query: string): FileSearch | null {
  const words = searchFold(query).trim().split(/\s+/).filter(Boolean).slice(0, MAX_TERMS);
  if (words.length === 0) return null;
  const whole = words.join(" ");
  const like = escapeLike(whole);
  return {
    where: words.map(() => "search_name LIKE ? ESCAPE '\\'").join(" AND "),
    order: `CASE
        WHEN search_name = ? THEN 0
        WHEN search_name LIKE ? ESCAPE '\\' THEN 1
        WHEN search_name LIKE ? ESCAPE '\\' THEN 2
        ELSE 3
      END, updated_at DESC`,
    binds: [...words.map((w) => `%${escapeLike(w)}%`), whole, `${like}%`, `% ${like}%`],
  };
}

/** How many names from before search_name existed one search fills in at most. */
const BACKFILL = 500;

/**
 * Fills in folded names the team's files don't have yet (they predate the
 * column): done in JS, since D1 can't fold Unicode. A team's first search
 * pays for it, a few hundred files at a time.
 */
export async function backfillSearchNames(db: D1Database, teamId: string): Promise<void> {
  const { results } = await db
    .prepare(
      `SELECT id, name FROM files WHERE team_id = ? AND search_name IS NULL LIMIT ${BACKFILL}`,
    )
    .bind(teamId)
    .all<{ id: string; name: string }>();
  if (results.length === 0) return;
  await db.batch(
    results.map((f) =>
      db.prepare("UPDATE files SET search_name = ? WHERE id = ?").bind(searchFold(f.name), f.id),
    ),
  );
}
