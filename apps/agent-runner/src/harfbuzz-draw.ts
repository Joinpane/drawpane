type Callback = (...args: number[]) => void;

export interface HarfBuzzWasmOptions {
  instantiateWasm(
    imports: WebAssembly.Imports,
    done: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void,
  ): Record<string, never>;
  drawpaneWrapDrawFunction(callback: Callback, signature: string): WebAssembly.ExportValue;
}

/** Provides HarfBuzz and its typed draw callbacks from modules compiled by the host. */
export function harfBuzzWasmOptions(
  wasm: WebAssembly.Module,
  draw: WebAssembly.Module,
  onMemory?: (memory: WebAssembly.Memory) => void,
): HarfBuzzWasmOptions {
  const names = WebAssembly.Module.imports(draw).map(({ name }) => name);
  return {
    instantiateWasm(imports, done) {
      const instance = new WebAssembly.Instance(wasm, imports);
      onMemory?.(instance.exports.memory as WebAssembly.Memory);
      done(instance, wasm);
      return {};
    },
    drawpaneWrapDrawFunction(callback, signature) {
      const callbacks = Object.fromEntries(
        names.map((name) => [name, name === signature ? callback : () => {}]),
      );
      const wrapped = new WebAssembly.Instance(draw, { draw: callbacks }).exports[signature];
      if (!wrapped) throw new Error(`No HarfBuzz draw bridge for ${signature}`);
      return wrapped;
    },
  };
}
