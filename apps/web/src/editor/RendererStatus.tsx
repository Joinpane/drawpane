/**
 * Shows the active renderer and offers a browser preference during rollout.
 */
import { Button, cx, Icon, Popover, Tooltip } from "@drawpane/ui";
import { useEffect, useRef, useState } from "react";
import { PASS_GESTURES } from "./canvas-gestures";
import { useEditor } from "./hooks";
import {
  formatRendererReason,
  rendererChipLabel,
  showCanvasRendererChip,
  useRendererStatus,
} from "./renderer-status";
import { rendererPolicy, rendererSelection, switchBrowserRenderer } from "./renderer-switch";

export function RendererStatus() {
  const editor = useEditor();
  const status = useRendererStatus(editor);
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const selection = rendererSelection();
  const policy = rendererPolicy();
  const visible = status.switchOn || showCanvasRendererChip(selection, policy);

  useEffect(() => {
    if (!visible && open) setOpen(false);
  }, [visible, open]);

  if (!visible) return null;

  const label = rendererChipLabel(status);
  const reason = status.switchOn
    ? formatRendererReason(status)
    : policy === null
      ? "Renderer settings couldn’t be loaded. Reload to try again."
      : policy.forceCanvas
        ? "Your Drawpane administrator has turned on Canvas for everyone."
        : "Drawing with Canvas.";
  const isEngine = status.switchOn && status.active === "engine";
  const isStarting =
    status.switchOn &&
    status.active === "canvas" &&
    (status.reason.kind === "starting" || status.reason.kind === "recovering");
  const ariaLabel =
    !isEngine && (status.switchOn || !policy || policy.forceCanvas)
      ? `Renderer: ${label}, ${reason}`
      : `Renderer: ${label}`;
  const icon = isEngine ? "bolt" : status.switchOn ? "warning" : "layers";
  const meta = isEngine
    ? [status.compatibility ? "Compatibility mode" : null, status.software ? "Software GPU" : null]
        .filter(Boolean)
        .join(" · ")
    : "";
  const next = selection.choice === "canvas" ? "engine" : "canvas";
  const switchAction = (
    <div className="renderer-popover__switch">
      <Button size="sm" onClick={() => switchBrowserRenderer(next)}>
        {next === "canvas" ? "Use Canvas in this browser" : "Use the render engine in this browser"}
      </Button>
      <p className="renderer-popover__meta">Reloads this page.</p>
    </div>
  );

  return (
    <>
      <Tooltip label={reason} placement="top" disabled={open} describe={false}>
        <button
          ref={buttonRef}
          type="button"
          className={cx(
            "renderer-chip pane",
            isEngine
              ? "renderer-chip--engine"
              : isStarting
                ? "renderer-chip--starting"
                : "renderer-chip--canvas",
          )}
          aria-label={ariaLabel}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          {...PASS_GESTURES}
        >
          <Icon name={icon} size={12} />
          <span>{label}</span>
        </button>
      </Tooltip>
      {open && buttonRef.current ? (
        <Popover
          anchor={buttonRef.current}
          label="Renderer status"
          side="top"
          className="renderer-popover"
          onClose={() => setOpen(false)}
        >
          <div className="renderer-popover__head">
            <Icon
              name={icon}
              size={16}
              className={
                isEngine ? "renderer-popover__icon--engine" : "renderer-popover__icon--canvas"
              }
            />
            <span className="renderer-popover__title">{label}</span>
          </div>
          <p className="renderer-popover__reason">{reason}</p>
          {meta ? <p className="renderer-popover__meta">{meta}</p> : null}
          {policy && !policy.forceCanvas ? (
            policy.defaultRenderer === "canvas" && next === "engine" ? (
              <details className="renderer-popover__switch">
                <summary>Switch renderer</summary>
                {switchAction}
              </details>
            ) : (
              switchAction
            )
          ) : null}
        </Popover>
      ) : null}
    </>
  );
}
