// Writes runner/grow.wasm: a hand-assembled module with its own memory (1 page, no maximum,
// like resvg) and one export, grow(pages) -> previous size in pages or -1, i.e. memory.grow.
// Workers can't compile WebAssembly at run time, so the module is uploaded with the script.
import { writeFileSync } from "node:fs";

const bytes = Uint8Array.from([
  // magic, version 1
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  // type section: one type, (i32) -> i32
  0x01, 0x06, 0x01, 0x60, 0x01, 0x7f, 0x01, 0x7f,
  // function section: one function of type 0
  0x03, 0x02, 0x01, 0x00,
  // memory section: one memory, flag 0 (no maximum), minimum 1 page
  0x05, 0x03, 0x01, 0x00, 0x01,
  // export section: "memory" (memory 0), "grow" (function 0)
  0x07, 0x11, 0x02, 0x06, 0x6d, 0x65, 0x6d, 0x6f, 0x72, 0x79, 0x02, 0x00, 0x04, 0x67, 0x72, 0x6f,
  0x77, 0x00, 0x00,
  // code section: local.get 0, memory.grow 0, end
  0x0a, 0x08, 0x01, 0x06, 0x00, 0x20, 0x00, 0x40, 0x00, 0x0b,
]);

if (!WebAssembly.validate(bytes)) throw new Error("grow.wasm doesn't validate");
const { exports } = new WebAssembly.Instance(new WebAssembly.Module(bytes), {});
if (exports.grow(1) !== 1 || exports.memory.buffer.byteLength !== 2 * 65536) {
  throw new Error("grow.wasm doesn't grow");
}
writeFileSync(new URL("./runner/grow.wasm", import.meta.url), bytes);
console.log(`wrote runner/grow.wasm, ${bytes.length} bytes`);
