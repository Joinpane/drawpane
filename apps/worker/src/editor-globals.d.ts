// The editor package (bundled for the agent engine, decision 0021) is typed
// against the browser. The Worker never calls its drawing code, only its
// document, layout and text logic, so the browser types it names are opaque
// here rather than pulling the DOM library into the Worker's own types.
// biome-ignore-all lint/suspicious/noExplicitAny: opaque stand-ins for browser types the Worker never touches.
type Path2D = any;
declare const Path2D: any;
interface CanvasTextMeasure {
  readonly width: number;
  readonly [metric: string]: any;
}
interface CanvasRenderingContext2D {
  measureText(text: string): CanvasTextMeasure;
  textRendering: any;
  [member: string]: any;
}
type OffscreenCanvasRenderingContext2D = CanvasRenderingContext2D;
type OffscreenCanvas = any;
declare const OffscreenCanvas: any;
type HTMLCanvasElement = any;
type ImageBitmap = any;
type ImageData = any;
declare const ImageData: any;
type DOMMatrix = any;
declare const DOMMatrix: any;
type CanvasPattern = any;
type CanvasGradient = any;
type CanvasFillRule = any;
type GlobalCompositeOperation = any;
type Keyframe = any;
type WebGL2RenderingContext = any;
declare const WebGL2RenderingContext: any;
type WebGLTexture = any;
type WebGLProgram = any;
type WebGLShader = any;
type WebGLFramebuffer = any;
type WebGLUniformLocation = any;
declare const document: any;
declare function requestAnimationFrame(callback: (now: number) => void): number;
declare function cancelAnimationFrame(handle: number): void;
declare function matchMedia(query: string): { matches: boolean };
declare function createImageBitmap(...args: any[]): Promise<any>;
// The image loader asks for same-origin cookies, as browsers take them.
interface RequestInit {
  credentials?: string;
}
