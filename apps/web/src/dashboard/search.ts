/** Dashboard search helpers: waiting for typing to settle, and showing what matched. */
import { useEffect, useState } from "react";

/** `value` once it has stopped changing for `ms`. */
export function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}

/** The words a query searches for, as the server reads them. */
export const searchWords = (query: string) =>
  query.trim().toLowerCase().split(/\s+/).filter(Boolean);

/** Whether a name has every word of the query, as the server matches. */
export const matchesAll = (name: string, query: string) => {
  const lower = name.toLowerCase();
  return searchWords(query).every((w) => lower.includes(w));
};

/**
 * A name split into runs, with the parts that match a query's words marked:
 * "Onboarding flow" for "flow on" → Onboarding (marked "On"), flow (marked).
 * Overlapping matches merge into one run.
 */
export function highlightParts(text: string, query: string): { text: string; match: boolean }[] {
  const words = searchWords(query);
  if (words.length === 0) return [{ text, match: false }];
  const lower = text.toLowerCase();
  const marked = new Array<boolean>(text.length).fill(false);
  for (const word of words) {
    for (let at = lower.indexOf(word); at !== -1; at = lower.indexOf(word, at + 1))
      marked.fill(true, at, at + word.length);
  }
  const parts: { text: string; match: boolean }[] = [];
  for (let i = 0; i < text.length; i++) {
    const last = parts.at(-1);
    if (last && last.match === marked[i]) last.text += text[i];
    else parts.push({ text: text[i] as string, match: marked[i] as boolean });
  }
  return parts;
}
