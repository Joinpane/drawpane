/** A tiny immutable state container that React can read with `useSyncExternalStore`. */
export class Store<S extends object> {
  #state: S;
  readonly #listeners = new Set<() => void>();

  constructor(initial: S) {
    this.#state = initial;
  }

  get = (): S => this.#state;

  set(patch: Partial<S> | ((state: S) => Partial<S>)): void {
    const next = typeof patch === "function" ? patch(this.#state) : patch;
    let changed = false;
    for (const key of Object.keys(next) as Array<keyof S>) {
      if (!Object.is(next[key], this.#state[key])) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    this.#state = { ...this.#state, ...next };
    for (const listener of this.#listeners) listener();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
}
