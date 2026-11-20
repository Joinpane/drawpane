/**
 * Small status chip shown in the editor's bottom bar when the render engine switch is on.
 * Reports whether the engine is drawing ("Engine · WebGPU") or the canvas renderer took over
 * ("Canvas renderer"), with the reason on hover and in a popover on click.
 */
import { cx, Icon, Popover, Tooltip } from "@drawpane/ui";
import { useEffect, useRef, useState } from "react";
import { PASS_GESTURES } from "./canvas-gestures";
import { useEditor } from "./hooks";
import { formatRendererReason, rendererChipLabel, useRendererStatus } from "./renderer-status";

export function RendererStatus() {
  const editor = useEditor();
  const status = useRendererStatus(editor);
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!status.switchOn && open) setOpen(false);
  }, [status.switchOn, open]);

  if (!status.switchOn) return null;

  const label = rendererChipLabel(status);
  const reason = formatRendererReason(status);
  const isEngine = status.active === "engine";
  const isStarting = status.active === "canvas" && status.reason.kind === "starting";
  const ariaLabel = isEngine ? `Renderer: ${label}` : `Renderer: ${label}, ${reason}`;
  const meta = isEngine
    ? [status.compatibility ? "Compatibility mode" : null, status.software ? "Software GPU" : null]
        .filter(Boolean)
        .join(" · ")
    : "";

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
          <Icon name={isEngine ? "bolt" : "warning"} size={12} />
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
              name={isEngine ? "bolt" : "warning"}
              size={16}
              className={
                isEngine ? "renderer-popover__icon--engine" : "renderer-popover__icon--canvas"
              }
            />
            <span className="renderer-popover__title">{label}</span>
          </div>
          <p className="renderer-popover__reason">{reason}</p>
          {meta ? <p className="renderer-popover__meta">{meta}</p> : null}
        </Popover>
      ) : null}
    </>
  );
}
