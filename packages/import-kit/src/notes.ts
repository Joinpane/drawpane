/**
 * What an import couldn't carry over exactly, counted by kind, so the person
 * importing gets a short, honest summary ("3 boolean groups became paths")
 * instead of silent differences. Each importer names its own kinds.
 */
export type NoteTexts = Readonly<Record<string, readonly [one: string, many: string]>>;

export class NoteBook<K extends string> {
  readonly #texts: Readonly<Record<K, readonly [string, string]>>;
  readonly #counts = new Map<K, number>();

  constructor(texts: Readonly<Record<K, readonly [string, string]>>) {
    this.#texts = texts;
  }

  add(kind: K, count = 1): void {
    this.#counts.set(kind, (this.#counts.get(kind) ?? 0) + count);
  }

  merge(other: NoteBook<K>): void {
    for (const [kind, count] of other.entries()) this.add(kind, count);
  }

  entries(): Array<[K, number]> {
    return [...this.#counts.entries()];
  }

  /** "2 boolean groups became paths", one line per kind. */
  lines(): string[] {
    return this.entries().map(([kind, count]) => {
      const [one, many] = this.#texts[kind];
      return count === 1 ? `1 ${one}` : `${count} ${many}`;
    });
  }
}
