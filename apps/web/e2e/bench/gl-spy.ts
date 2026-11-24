/**
 * Counts WebGL2 calls page-wide, the way the Figma research spy did (its `gpu_spy.js`), so a
 * per-tile count here compares with its numbers: `binds` are `bindFramebuffer` calls to
 * FRAMEBUFFER or DRAW_FRAMEBUFFER with a framebuffer (render targets other than the canvas).
 * Run it before any page script (`page.addInitScript(installGlSpy)`); the totals live on
 * `window.__glSpy`, and the frame bench reads them with its GPU counters. Wrapping every call
 * costs time, so time nothing on a run that counts.
 */
export function installGlSpy(): void {
  const scope = window as unknown as { __glSpy?: Record<string, number> };
  if (typeof WebGL2RenderingContext === "undefined" || scope.__glSpy) return;
  const totals = {
    binds: 0,
    canvasBinds: 0,
    framebufferTexture2D: 0,
    draws: 0,
    clears: 0,
    uploads: 0,
    copies: 0,
    reads: 0,
  };
  scope.__glSpy = totals;
  const proto = WebGL2RenderingContext.prototype as unknown as Record<
    string,
    (...args: unknown[]) => unknown
  >;
  const wrap = (name: string, count: (gl: WebGL2RenderingContext, args: unknown[]) => void) => {
    const original = proto[name];
    if (typeof original !== "function") return;
    proto[name] = function (this: WebGL2RenderingContext, ...args: unknown[]) {
      count(this, args);
      return original.apply(this, args);
    };
  };
  wrap("bindFramebuffer", (gl, [target, framebuffer]) => {
    if (target !== gl.FRAMEBUFFER && target !== gl.DRAW_FRAMEBUFFER) return;
    if (framebuffer) totals.binds++;
    else totals.canvasBinds++;
  });
  wrap("framebufferTexture2D", () => totals.framebufferTexture2D++);
  for (const name of [
    "drawArrays",
    "drawElements",
    "drawArraysInstanced",
    "drawElementsInstanced",
    "drawRangeElements",
  ])
    wrap(name, () => totals.draws++);
  for (const name of ["clear", "clearBufferfv", "clearBufferiv", "clearBufferuiv", "clearBufferfi"])
    wrap(name, () => totals.clears++);
  for (const name of ["texImage2D", "texSubImage2D", "texImage3D", "texSubImage3D"])
    wrap(name, () => totals.uploads++);
  for (const name of [
    "blitFramebuffer",
    "copyTexSubImage2D",
    "copyTexSubImage3D",
    "copyBufferSubData",
  ])
    wrap(name, () => totals.copies++);
  wrap("readPixels", () => totals.reads++);
}
