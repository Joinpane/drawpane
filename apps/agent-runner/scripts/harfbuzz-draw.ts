/** The WebAssembly signatures used by harfbuzzjs's DrawFuncs setters. */
const signatures = ["viiii", "viiiffi", "viiiffffi", "viiiffffffi"];

const string = (value: string) => [value.length, ...new TextEncoder().encode(value)];
const section = (id: number, bytes: number[]) => {
  if (bytes.length >= 128) throw new Error("HarfBuzz draw bridge section exceeds one-byte LEB128");
  return [id, bytes.length, ...bytes];
};

/**
 * A tiny module with one forwarding function per draw signature. Each export is a typed Wasm
 * function, so HarfBuzz can put it in its indirect function table. Workerd compiles this module
 * when it loads the Worker. Emscripten's usual JS-to-Wasm wrappers compile on first use.
 */
export function harfBuzzDrawWasm(): Uint8Array<ArrayBuffer> {
  const params = signatures.map((signature) => [...signature.slice(1)]);
  return Uint8Array.from([
    0,
    97,
    115,
    109,
    1,
    0,
    0,
    0,
    ...section(1, [
      params.length,
      ...params.flatMap((p) => [0x60, p.length, ...p.map((t) => (t === "i" ? 0x7f : 0x7d)), 0]),
    ]),
    ...section(2, [
      signatures.length,
      ...signatures.flatMap((name, i) => [...string("draw"), ...string(name), 0, i]),
    ]),
    ...section(3, [signatures.length, ...signatures.map((_, i) => i)]),
    ...section(7, [
      signatures.length,
      ...signatures.flatMap((name, i) => [...string(name), 0, signatures.length + i]),
    ]),
    ...section(10, [
      params.length,
      ...params.flatMap((p, i) => {
        const body = [0, ...p.flatMap((_, arg) => [0x20, arg]), 0x10, i, 0x0b];
        return [body.length, ...body];
      }),
    ]),
  ]);
}
