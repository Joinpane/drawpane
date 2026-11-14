/**
 * The installer's conversation with the person, behind an interface: the real
 * one is @clack/prompts, tests script the answers.
 */
import * as clack from "@clack/prompts";

export interface Choice<T> {
  readonly value: T;
  readonly label: string;
  readonly hint?: string;
}

export interface Ui {
  /** Whether questions can be asked (a terminal, not CI). */
  readonly interactive: boolean;
  intro(title: string): void;
  outro(message: string): void;
  text(question: {
    message: string;
    initial?: string;
    placeholder?: string;
    validate?: (value: string) => string | null;
  }): Promise<string>;
  select<T>(question: { message: string; options: readonly Choice<T>[] }): Promise<T>;
  confirm(question: { message: string; initial?: boolean }): Promise<boolean>;
  /** Runs one step with a spinner; `done` describes it once it has finished. */
  step<T>(label: string, work: () => Promise<T>, done?: (result: T) => string): Promise<T>;
  info(message: string): void;
  warn(message: string): void;
  note(body: string, title: string): void;
}

/** The person stopped the installer (Ctrl+C or Escape at a question). */
export class Cancelled extends Error {
  constructor() {
    super("Cancelled.");
  }
}

function answer<T>(value: T): Exclude<T, symbol> {
  if (clack.isCancel(value)) throw new Cancelled();
  return value as Exclude<T, symbol>;
}

export function terminalUi(): Ui {
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY) && !clack.isCI();
  return {
    interactive,
    intro: (title) => clack.intro(title),
    outro: (message) => clack.outro(message),
    async text({ message, initial, placeholder, validate }) {
      const value = answer(
        await clack.text({
          message,
          ...(initial !== undefined ? { initialValue: initial } : {}),
          ...(placeholder !== undefined ? { placeholder } : {}),
          ...(validate ? { validate: (v) => validate((v ?? "").trim()) ?? undefined } : {}),
        }),
      );
      return (value ?? "").trim();
    },
    async select({ message, options }) {
      return answer(
        await clack.select({
          message,
          // biome-ignore lint/suspicious/noExplicitAny: clack's option type is a conditional over T.
          options: options.map((o) => ({ ...o })) as any,
        }),
      );
    },
    async confirm({ message, initial = true }) {
      return answer(await clack.confirm({ message, initialValue: initial }));
    },
    async step(label, work, done) {
      if (!interactive) {
        // A log (CI, a pipe): one line per step, not a spinner's every frame.
        try {
          const result = await work();
          clack.log.step(done ? done(result) : label);
          return result;
        } catch (error) {
          clack.log.error(label);
          throw error;
        }
      }
      const spin = clack.spinner();
      spin.start(label);
      try {
        const result = await work();
        spin.stop(done ? done(result) : label);
        return result;
      } catch (error) {
        spin.error(label);
        throw error;
      }
    },
    info: (message) => clack.log.info(message),
    warn: (message) => clack.log.warn(message),
    note: (body, title) => clack.note(body, title),
  };
}
