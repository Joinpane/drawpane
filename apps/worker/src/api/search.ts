/**
 * Searching a team's files by name. Every word typed has to appear, in any
 * order and case; the best matches come first: the whole name, then names
 * that start with the query, then a word that starts with it, then anywhere;
 * within each, the most recently edited first.
 */

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
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean).slice(0, MAX_TERMS);
  if (words.length === 0) return null;
  const whole = words.join(" ");
  const like = escapeLike(whole);
  return {
    where: words.map(() => "lower(name) LIKE ? ESCAPE '\\'").join(" AND "),
    order: `CASE
        WHEN lower(name) = ? THEN 0
        WHEN lower(name) LIKE ? ESCAPE '\\' THEN 1
        WHEN lower(name) LIKE ? ESCAPE '\\' THEN 2
        ELSE 3
      END, updated_at DESC`,
    binds: [...words.map((w) => `%${escapeLike(w)}%`), whole, `${like}%`, `% ${like}%`],
  };
}
