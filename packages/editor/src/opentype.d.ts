/** The font-only parser API. The public DefinitelyTyped declarations also load DOM globals. */
declare module "opentype.js" {
  type Command =
    | { readonly type: "M" | "L"; readonly x: number; readonly y: number }
    | {
        readonly type: "Q";
        readonly x1: number;
        readonly y1: number;
        readonly x: number;
        readonly y: number;
      }
    | {
        readonly type: "C";
        readonly x1: number;
        readonly y1: number;
        readonly x2: number;
        readonly y2: number;
        readonly x: number;
        readonly y: number;
      }
    | { readonly type: "Z" };
  export function parse(
    bytes: ArrayBuffer,
    options: { readonly lowMemory: boolean },
  ): {
    readonly glyphs: {
      get(id: number): { readonly path: { readonly commands: readonly Command[] } };
    };
  };
}
