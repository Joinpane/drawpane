/**
 * The prototype stage: the device, the screen inside it and any overlays,
 * drawn with the same renderer as the canvas and animated with the Web
 * Animations API. It turns pointer and key input into player steps and plays
 * each step; the React page around it only draws chrome.
 *
 * Plain DOM rather than React because transitions need two live copies of a
 * screen at once, with exact control over when each appears and goes.
 */
import {
  type CanvasRenderer,
  chainAt,
  type Editor,
  easingCss,
  type Hit,
  hotspotRects,
  type OverlayLayer,
  type PlayerStep,
  type PrototypePlayer,
  reverseTransition,
  transitionFrames,
  transitionMs,
} from "@drawpane/editor";
import {
  DEVICES,
  type DeviceId,
  getProp,
  type OverlayPosition,
  SafeUrl,
  type Transition,
} from "@drawpane/model";

/** Tap slop: a pointer that moves further than this is a drag. */
const DRAG_PX = 8;
/** The most canvas pixels one screen may use (keeps very tall screens within memory). */
const MAX_PIXELS = 24_000_000;
/** Bezel and corner sizes by device kind, in device pixels. */
const CHROME = {
  none: { bezel: 0, radius: 0, inner: 0 },
  phone: { bezel: 12, radius: 56, inner: 44 },
  tablet: { bezel: 16, radius: 40, inner: 24 },
  desktop: { bezel: 0, radius: 10, inner: 10 },
} as const;

interface Layer {
  readonly root: string;
  /** Scrolls when the screen is taller than the viewport. */
  readonly el: HTMLDivElement;
  readonly canvas: HTMLCanvasElement;
  /** Device pixels per document unit, before the stage scale. */
  readonly contentScale: number;
}

interface OverlayView {
  readonly overlay: OverlayLayer;
  readonly layer: Layer;
  readonly dim: HTMLDivElement;
}

export interface StageCallbacks {
  /** Something worth a hint happened: hotspots flashed, a destination is gone. */
  onHint?: (hint: "hotspots" | "nothing") => void;
  /** The current screen or overlays changed (after a step starts). */
  onChange?: () => void;
}

export interface StageOptions extends StageCallbacks {
  readonly editor: Editor;
  readonly renderer: CanvasRenderer;
  readonly player: PrototypePlayer;
  readonly host: HTMLElement;
  readonly device: DeviceId;
}

const reducedMotion = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

export class PlayerStage {
  readonly #editor: Editor;
  readonly #renderer: CanvasRenderer;
  readonly #player: PrototypePlayer;
  readonly #host: HTMLElement;
  readonly #callbacks: StageCallbacks;
  #device: DeviceId;

  readonly #deviceEl: HTMLDivElement;
  readonly #viewport: HTMLDivElement;
  #screen: Layer | null = null;
  #overlays: OverlayView[] = [];
  /** Viewport size in device pixels, and the scale that fits it in the host. */
  #vw = 0;
  #vh = 0;
  #scale = 1;
  readonly #animations = new Set<Animation>();
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  #hover: { step: PlayerStep; rect: DOMRect } | null = null;
  #press: { x: number; y: number; dragged: boolean; root: string; chain: string[] } | null = null;
  #frame = 0;
  readonly #cleanup: (() => void)[] = [];

  constructor(options: StageOptions) {
    this.#editor = options.editor;
    this.#renderer = options.renderer;
    this.#player = options.player;
    this.#host = options.host;
    this.#device = options.device;
    this.#callbacks = options;

    this.#deviceEl = document.createElement("div");
    this.#deviceEl.className = "stage__device";
    this.#viewport = document.createElement("div");
    this.#viewport.className = "stage__viewport";
    this.#deviceEl.append(this.#viewport);
    this.#host.append(this.#deviceEl);

    const vp = this.#viewport;
    const on = <K extends keyof HTMLElementEventMap>(
      el: HTMLElement,
      type: K,
      fn: (e: HTMLElementEventMap[K]) => void,
    ) => {
      el.addEventListener(type, fn);
      this.#cleanup.push(() => el.removeEventListener(type, fn));
    };
    on(vp, "pointerdown", (e) => this.#down(e));
    on(vp, "pointermove", (e) => this.#move(e));
    on(vp, "pointerup", (e) => this.#up(e));
    on(vp, "pointercancel", () => {
      this.#press = null;
    });
    on(vp, "pointerleave", () => this.#leave());

    const resize = new ResizeObserver(() => this.layout());
    resize.observe(this.#host);
    this.#cleanup.push(() => resize.disconnect());
    this.#cleanup.push(this.#editor.doc.subscribe(() => this.invalidate()));
    this.#cleanup.push(this.#renderer.images.subscribe(() => this.invalidate()));
    const fonts = () => this.invalidate();
    document.fonts?.addEventListener?.("loadingdone", fonts);
    this.#cleanup.push(() => document.fonts?.removeEventListener?.("loadingdone", fonts));

    // Size the viewport first: a screen's scale depends on it.
    this.layout();
    this.#showScreen(this.#player.state.screen);
    this.#scheduleDelays();
  }

  destroy(): void {
    cancelAnimationFrame(this.#frame);
    for (const fn of this.#cleanup) fn();
    for (const t of this.#timers.values()) clearTimeout(t);
    for (const a of this.#animations) a.cancel();
    this.#deviceEl.remove();
  }

  setDevice(device: DeviceId): void {
    if (device === this.#device) return;
    this.#device = device;
    this.#rebuild();
  }

  /** Puts the player's current state on screen without animating (restart, flow change). */
  reset(): void {
    this.#hover = null;
    this.#rebuild();
    this.#scheduleDelays();
    this.#callbacks.onChange?.();
  }

  /** Repaints on the next frame (the document or an image changed). */
  invalidate(): void {
    cancelAnimationFrame(this.#frame);
    this.#frame = requestAnimationFrame(() => this.#paintAll());
  }

  // -------------------------------------------------------------------------
  // Layout and painting

  #frameSize(id: string): { width: number; height: number } {
    const props = this.#editor.doc.get(id)?.props ?? {};
    return {
      width: Math.max(1, getProp(props, "width")),
      height: Math.max(1, getProp(props, "height")),
    };
  }

  /** Recomputes the viewport for the device and the start screen, and the scale that fits the host. */
  layout(): void {
    const device = DEVICES[this.#device];
    const start = this.#frameSize(this.#player.start);
    this.#vw = device.kind === "none" ? start.width : device.width;
    this.#vh = device.kind === "none" ? start.height : device.height;
    const box = this.#host.getBoundingClientRect();
    // On a phone, the phone is the device: fill the screen, no bezel.
    if (box.width < 520 && box.width > 0) {
      this.#scale = box.width / this.#vw;
      this.#vh = box.height / this.#scale;
      this.#deviceEl.dataset.kind = "none";
      const d = this.#deviceEl.style;
      d.setProperty("--bezel", "0px");
      d.setProperty("--radius", "0px");
      d.setProperty("--inner", "0px");
      this.#viewport.style.width = `${box.width}px`;
      this.#viewport.style.height = `${box.height}px`;
      this.#paintAll();
      return;
    }
    const chrome = CHROME[device.kind];
    const margin = box.width < 600 ? 16 : 48;
    const availW = Math.max(100, box.width - margin * 2);
    const availH = Math.max(100, box.height - margin * 2);
    const outerW = this.#vw + chrome.bezel * 2;
    const outerH = this.#vh + chrome.bezel * 2;
    // Never enlarge a design past its real size; shrink to fit.
    let scale = Math.min(1, availW / outerW, availH / outerH);
    // Very long screens with no device: fit the width and let the page scroll.
    if (device.kind === "none" && this.#vh * scale > availH) {
      scale = Math.min(1, availW / outerW);
      this.#vh = Math.max(100, availH / scale);
    }
    this.#scale = scale;
    const d = this.#deviceEl.style;
    this.#deviceEl.dataset.kind = device.kind;
    d.setProperty("--bezel", `${chrome.bezel * scale}px`);
    d.setProperty("--radius", `${chrome.radius * scale}px`);
    d.setProperty("--inner", `${chrome.inner * scale}px`);
    this.#viewport.style.width = `${this.#vw * scale}px`;
    this.#viewport.style.height = `${this.#vh * scale}px`;
    this.#paintAll();
  }

  #contentScale(root: string, base?: Layer): number {
    if (base) return base.contentScale;
    if (DEVICES[this.#device].kind === "none") return 1;
    return this.#vw / this.#frameSize(root).width;
  }

  #makeLayer(root: string, kind: "screen" | "overlay", base?: Layer): Layer {
    const el = document.createElement("div");
    el.className = kind === "screen" ? "stage__screen" : "stage__overlay";
    const canvas = document.createElement("canvas");
    canvas.className = "stage__canvas";
    el.append(canvas);
    const layer = { root, el, canvas, contentScale: this.#contentScale(root, base) };
    this.#paint(layer);
    return layer;
  }

  #paint(layer: Layer): void {
    const bounds = this.#editor.scene.bounds(layer.root);
    const size = this.#frameSize(layer.root);
    const css = layer.contentScale * this.#scale;
    let dpr = window.devicePixelRatio || 1;
    const pixels = size.width * size.height * (css * dpr) ** 2;
    if (pixels > MAX_PIXELS) dpr *= Math.sqrt(MAX_PIXELS / pixels);
    const w = Math.max(1, Math.round(size.width * css * dpr));
    const h = Math.max(1, Math.round(size.height * css * dpr));
    const { canvas } = layer;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    canvas.style.width = `${size.width * css}px`;
    canvas.style.height = `${size.height * css}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx || !bounds) return;
    this.#renderer.renderNodes(
      ctx,
      [layer.root],
      { x: bounds.x, y: bounds.y, width: size.width, height: size.height },
      css * dpr,
    );
  }

  #paintAll(): void {
    if (this.#screen) {
      if (!this.#editor.doc.has(this.#screen.root)) return;
      this.#paint(this.#screen);
    }
    for (const view of this.#overlays) {
      this.#paint(view.layer);
      this.#placeOverlay(view);
    }
  }

  #rebuild(): void {
    this.#finishAnimations();
    this.#viewport.replaceChildren();
    this.#overlays = [];
    this.#screen = null;
    this.layout();
    this.#showScreen(this.#player.state.screen);
    for (const overlay of this.#player.state.overlays) this.#openOverlay(overlay, false);
  }

  #showScreen(root: string): Layer {
    const layer = this.#makeLayer(root, "screen");
    this.#viewport.prepend(layer.el);
    this.#screen = layer;
    return layer;
  }

  #overlayRect(view: { overlay: OverlayLayer; layer: Layer }): {
    left: number;
    top: number;
    width: number;
    height: number;
  } {
    const size = this.#frameSize(view.layer.root);
    const s = view.layer.contentScale * this.#scale;
    const width = size.width * s;
    const height = size.height * s;
    const vw = this.#vw * this.#scale;
    const vh = this.#vh * this.#scale;
    const [v, h] = positionParts(view.overlay.position);
    const left = h === "left" ? 0 : h === "right" ? vw - width : (vw - width) / 2;
    const top = v === "top" ? 0 : v === "bottom" ? vh - height : (vh - height) / 2;
    return { left, top, width, height };
  }

  #placeOverlay(view: OverlayView): void {
    const r = this.#overlayRect(view);
    view.layer.el.style.left = `${r.left}px`;
    view.layer.el.style.top = `${r.top}px`;
  }

  // -------------------------------------------------------------------------
  // Steps

  /** Plays a step the player produced. */
  play(step: PlayerStep | null): void {
    if (!step) return;
    this.#finishAnimations();
    switch (step.type) {
      case "navigate":
        this.#navigate(step);
        break;
      case "open-overlay":
        this.#openOverlay(step.overlay, true);
        break;
      case "close-overlay":
        this.#closeOverlay(step.overlay);
        break;
      case "swap-overlay":
        this.#swapOverlay(step);
        break;
      case "open-url":
        if (SafeUrl.safeParse(step.url).success)
          window.open(step.url, step.newTab ? "_blank" : "_top", "noopener,noreferrer");
        break;
    }
    this.#scheduleDelays();
    this.#callbacks.onChange?.();
  }

  #timing(transition: Transition): KeyframeAnimationOptions | null {
    if (transition.type === "instant") return null;
    if (reducedMotion()) return { duration: 120, easing: "linear", fill: "both" };
    return {
      duration: transitionMs(transition),
      easing: easingCss(transition.easing),
      fill: "both",
    };
  }

  /** Under reduced motion every transition becomes a short dissolve. */
  #effective(transition: Transition): Transition {
    return reducedMotion() && transition.type !== "instant"
      ? { ...transition, type: "dissolve" }
      : transition;
  }

  #animate(el: HTMLElement, frames: Keyframe[] | null, timing: KeyframeAnimationOptions | null) {
    if (!frames || !timing) return null;
    const animation = el.animate(frames, timing);
    this.#animations.add(animation);
    const done = () => this.#animations.delete(animation);
    animation.finished.then(done, done);
    return animation;
  }

  #finishAnimations(): void {
    for (const a of [...this.#animations]) a.finish();
  }

  #navigate(step: Extract<PlayerStep, { type: "navigate" }>): void {
    // Overlays close with the navigation, at once.
    for (const view of this.#overlays) {
      view.layer.el.remove();
      view.dim.remove();
    }
    this.#overlays = [];
    this.#hover = null;
    const old = this.#screen;
    const next = this.#showScreen(step.to);
    const transition = this.#effective(step.transition);
    const timing = this.#timing(transition);
    if (!old || !timing) {
      old?.el.remove();
      return;
    }
    const size = { width: this.#vw * this.#scale, height: this.#vh * this.#scale };
    const frames = transitionFrames(transition, size);
    // The one that moves over the other paints on top. Stacking rather than
    // reordering the DOM keeps the old screen's scroll position.
    old.el.style.zIndex = frames.top === "outgoing" ? "2" : "1";
    next.el.style.zIndex = frames.top === "outgoing" ? "1" : "2";
    old.el.style.pointerEvents = "none";
    const incoming = this.#animate(next.el, frames.incoming, timing);
    const outgoing = this.#animate(old.el, frames.outgoing, timing);
    const remove = () => {
      old.el.remove();
      next.el.style.zIndex = "";
    };
    const last = outgoing ?? incoming;
    if (last) last.finished.then(remove, remove);
    else remove();
  }

  #overlayFrames(view: { overlay: OverlayLayer; layer: Layer }, transition: Transition) {
    if (transition.type === "dissolve") return [{ opacity: 0 }, { opacity: 1 }];
    if (transition.type === "instant") return null;
    // Overlays slide in from the edge they face away from, all the way off screen.
    const r = this.#overlayRect(view);
    const vw = this.#vw * this.#scale;
    const vh = this.#vh * this.#scale;
    const d =
      transition.type === "move-out" || transition.type === "slide-out"
        ? reverseTransition(transition).direction
        : transition.direction;
    const offset = {
      left: `translate(${vw - r.left}px, 0px)`,
      right: `translate(${-(r.left + r.width)}px, 0px)`,
      up: `translate(0px, ${vh - r.top}px)`,
      down: `translate(0px, ${-(r.top + r.height)}px)`,
    }[d];
    return [{ transform: offset }, { transform: "translate(0px, 0px)" }];
  }

  #openOverlay(overlay: OverlayLayer, animate: boolean): void {
    const base = this.#screen ?? undefined;
    const layer = this.#makeLayer(overlay.screen, "overlay", base);
    const dim = document.createElement("div");
    dim.className = "stage__dim";
    dim.style.background = `rgba(0, 0, 0, ${overlay.dim})`;
    const view: OverlayView = { overlay, layer, dim };
    this.#viewport.append(dim, layer.el);
    this.#overlays.push(view);
    this.#placeOverlay(view);
    if (!animate) return;
    const transition = this.#effective(overlay.transition);
    const timing = this.#timing(transition);
    this.#animate(layer.el, this.#overlayFrames(view, transition), timing);
    this.#animate(dim, [{ opacity: 0 }, { opacity: 1 }], timing);
  }

  #closeOverlay(overlay: OverlayLayer): void {
    const index = this.#overlays.findIndex((v) => v.overlay.key === overlay.key);
    if (index === -1) return;
    const closing = this.#overlays.slice(index);
    this.#overlays = this.#overlays.slice(0, index);
    if (
      this.#hover &&
      this.#hover.step.type === "open-overlay" &&
      this.#hover.step.overlay.key === overlay.key
    )
      this.#hover = null;
    for (const view of closing) {
      const transition = this.#effective(view.overlay.transition);
      const timing = this.#timing(transition);
      const frames = this.#overlayFrames(view, transition);
      view.layer.el.style.pointerEvents = "none";
      const reversed = timing ? { ...timing, direction: "reverse" as const } : null;
      const a = this.#animate(view.layer.el, frames, reversed);
      this.#animate(view.dim, [{ opacity: 0 }, { opacity: 1 }], reversed);
      const remove = () => {
        view.layer.el.remove();
        view.dim.remove();
      };
      if (a) a.finished.then(remove, remove);
      else remove();
    }
  }

  #swapOverlay(step: Extract<PlayerStep, { type: "swap-overlay" }>): void {
    const index = this.#overlays.findIndex((v) => v.overlay.key === step.from.key);
    const old = this.#overlays[index];
    if (!old) return;
    const layer = this.#makeLayer(step.to.screen, "overlay", this.#screen ?? undefined);
    const view: OverlayView = { overlay: step.to, layer, dim: old.dim };
    old.layer.el.after(layer.el);
    this.#overlays[index] = view;
    this.#placeOverlay(view);
    const transition = this.#effective(step.transition);
    const timing = this.#timing(transition);
    old.layer.el.style.pointerEvents = "none";
    const a = this.#animate(
      layer.el,
      transition.type === "instant" ? null : [{ opacity: 0 }, { opacity: 1 }],
      timing,
    );
    const remove = () => old.layer.el.remove();
    if (a) a.finished.then(remove, remove);
    else remove();
  }

  // -------------------------------------------------------------------------
  // Delays

  /** Arms "after delay" reactions for what's showing; leaves running timers alone. */
  #scheduleDelays(): void {
    const { screen, overlays, history } = this.#player.state;
    const wanted = new Map<string, string>([[`s:${screen}:${history.length}`, screen]]);
    for (const o of overlays) wanted.set(`o:${o.key}`, o.screen);
    for (const [key, timer] of this.#timers) {
      if (!wanted.has(key)) {
        clearTimeout(timer);
        this.#timers.delete(key);
      }
    }
    for (const [key, root] of wanted) {
      if (this.#timers.has(key)) continue;
      const reaction = this.#player.delays(root)[0];
      if (reaction?.trigger.type !== "delay") continue;
      this.#timers.set(
        key,
        setTimeout(() => {
          this.play(this.#player.run({ source: root, reaction }));
        }, reaction.trigger.ms),
      );
    }
  }

  // -------------------------------------------------------------------------
  // Input

  /** The layer under a client point, topmost first, and the page point inside it. */
  #pick(
    clientX: number,
    clientY: number,
  ): { root: string; chain: string[]; outside: OverlayView | null } | null {
    const top = this.#overlays.at(-1);
    const layers = [...this.#overlays.map((v) => v.layer)].reverse();
    if (this.#screen) layers.push(this.#screen);
    for (const layer of layers) {
      const rect = layer.canvas.getBoundingClientRect();
      if (
        clientX < rect.left ||
        clientY < rect.top ||
        clientX > rect.right ||
        clientY > rect.bottom
      ) {
        // A click outside the top overlay never reaches what's under it.
        if (top && layer === top.layer) return { root: layer.root, chain: [], outside: top };
        continue;
      }
      const bounds = this.#editor.scene.bounds(layer.root);
      if (!bounds) return null;
      const s = layer.contentScale * this.#scale;
      const p = { x: bounds.x + (clientX - rect.left) / s, y: bounds.y + (clientY - rect.top) / s };
      return { root: layer.root, chain: chainAt(this.#editor.scene, layer.root, p), outside: null };
    }
    return null;
  }

  #down(e: PointerEvent): void {
    if (e.button !== 0) return;
    const pick = this.#pick(e.clientX, e.clientY);
    if (!pick) return;
    if (pick.outside) {
      if (pick.outside.overlay.closeOnOutside)
        this.play(this.#player.closeOverlay(pick.outside.overlay.key));
      return;
    }
    this.#press = {
      x: e.clientX,
      y: e.clientY,
      dragged: false,
      root: pick.root,
      chain: pick.chain,
    };
  }

  #move(e: PointerEvent): void {
    const press = this.#press;
    if (press && !press.dragged && Math.hypot(e.clientX - press.x, e.clientY - press.y) > DRAG_PX) {
      const hit = this.#player.find(press.chain, "drag");
      if (hit) {
        press.dragged = true;
        this.play(this.#player.run(hit));
        return;
      }
    }
    if (e.buttons === 0) this.#hoverAt(e.clientX, e.clientY);
  }

  #up(e: PointerEvent): void {
    const press = this.#press;
    this.#press = null;
    if (!press || press.dragged) return;
    if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > DRAG_PX) return;
    const hit = this.#player.find(press.chain, "tap");
    if (hit) this.#run(hit);
    else this.flashHotspots();
  }

  #run(hit: Hit): void {
    const step = this.#player.run(hit);
    if (!step) {
      this.#callbacks.onHint?.("nothing");
      return;
    }
    this.play(step);
  }

  #hoverAt(clientX: number, clientY: number): void {
    const current = this.#hover;
    if (current) {
      const r = current.rect;
      const inside =
        clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
      if (inside) return;
      this.#hover = null;
      this.play(this.#player.revert(current.step));
    }
    const pick = this.#pick(clientX, clientY);
    if (!pick || pick.outside) return;
    const hit = this.#player.find(pick.chain, "hover");
    if (!hit) return;
    const rect = this.#clientRect(hit.source, pick.root);
    const step = this.#player.run(hit);
    if (!step || !rect) return;
    this.#hover = { step, rect };
    this.play(step);
  }

  #leave(): void {
    this.#press = null;
    const current = this.#hover;
    if (!current) return;
    this.#hover = null;
    this.play(this.#player.revert(current.step));
  }

  /** A layer's box on screen, from the layer it's drawn in. */
  #clientRect(id: string, root: string): DOMRect | null {
    const layer = [this.#screen, ...this.#overlays.map((v) => v.layer)].find(
      (l) => l?.root === root,
    );
    const bounds = this.#editor.scene.bounds(id);
    const origin = this.#editor.scene.bounds(root);
    if (!layer || !bounds || !origin) return null;
    const rect = layer.canvas.getBoundingClientRect();
    const s = layer.contentScale * this.#scale;
    return new DOMRect(
      rect.left + (bounds.x - origin.x) * s,
      rect.top + (bounds.y - origin.y) * s,
      bounds.width * s,
      bounds.height * s,
    );
  }

  /** Runs a key reaction if one matches. Returns true when the key was used. */
  key(press: { key: string; shift: boolean; alt: boolean; mod: boolean }): boolean {
    const hit = this.#player.findKey(press);
    if (!hit) return false;
    this.#run(hit);
    return true;
  }

  /** Briefly highlights everything you can tap on what's showing. */
  flashHotspots(): void {
    const layer = this.#overlays.at(-1)?.layer ?? this.#screen;
    if (!layer) return;
    const rects = hotspotRects(this.#editor.scene, layer.root);
    this.#callbacks.onHint?.("hotspots");
    const s = layer.contentScale * this.#scale;
    for (const r of rects) {
      const el = document.createElement("div");
      el.className = "stage__hotspot";
      el.style.left = `${r.x * s}px`;
      el.style.top = `${r.y * s}px`;
      el.style.width = `${r.width * s}px`;
      el.style.height = `${r.height * s}px`;
      layer.el.append(el);
      const a = el.animate(
        [{ opacity: 0 }, { opacity: 1, offset: 0.2 }, { opacity: 1, offset: 0.7 }, { opacity: 0 }],
        {
          duration: reducedMotion() ? 900 : 1100,
          easing: "ease-out",
        },
      );
      const remove = () => el.remove();
      a.finished.then(remove, remove);
    }
  }
}

function positionParts(
  position: OverlayPosition,
): ["top" | "middle" | "bottom", "left" | "center" | "right"] {
  const v = position.startsWith("top")
    ? "top"
    : position.startsWith("bottom")
      ? "bottom"
      : "middle";
  const h = position.endsWith("left") ? "left" : position.endsWith("right") ? "right" : "center";
  return [v, h];
}
