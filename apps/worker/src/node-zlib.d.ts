// The two node:zlib functions the Worker uses (nodejs_compat provides them),
// declared here rather than pulling in all of @types/node.
declare module "node:zlib" {
  export function inflateSync(data: Uint8Array): Uint8Array;
  export function brotliDecompressSync(data: Uint8Array): Uint8Array;
}
