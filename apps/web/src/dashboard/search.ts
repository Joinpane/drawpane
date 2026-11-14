/**
 * Dashboard search helpers: waiting for typing to settle, and showing what
 * matched. Text is compared folded (searchFold), as the server compares it.
 */
import { searchFold } from "@drawpane/model";
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
export const searchWords = (query: string) => searchFold(query).trim().split(/\s+/).filter(Boolean);

/** Whether a name has every word of the query, as the server matches. */
export const matchesAll = (name: string, query: string) => {
  const folded = searchFold(name);
  return searchWords(query).every((w) => folded.includes(w));
};

/**
 * A name split into runs, with the parts that match a query's words marked:
 * "Onboarding flow" for "flow on" → Onboarding (marked "On"), flow (marked).
 * Overlapping matches merge into one run.
 */
export function highlightParts(text: string, query: string): { text: string; match: boolean }[] {
  const words = searchWords(query);
  if (words.length === 0) return [{ text, match: false }];
  // Fold each character, remembering which character every folded one came from:
  // "École" folds to "ecole", and a match on "eco" marks "Éco".
  let folded = "";
  const from: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const f = searchFold(text[i] as string);
    folded += f;
    for (let k = 0; k < f.length; k++) from.push(i);
  }
  const marked = new Array<boolean>(text.length).fill(false);
  for (const word of words) {
    for (let at = folded.indexOf(word); at !== -1; at = folded.indexOf(word, at + 1))
      for (let k = at; k < at + word.length; k++) marked[from[k] as number] = true;
  }
  const parts: { text: string; match: boolean }[] = [];
  for (let i = 0; i < text.length; i++) {
    const last = parts.at(-1);
    if (last && last.match === marked[i]) last.text += text[i];
    else parts.push({ text: text[i] as string, match: marked[i] as boolean });
  }
  return parts;
}
