import {
  cloneElement,
  type FocusEvent,
  type KeyboardEvent,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { cx } from "../lib/cx";
import { assignRef } from "../lib/refs";

/** Hover delay before a tooltip shows. Keyboard focus shows it at once. */
const SHOW_DELAY = 500;
/** After a tooltip closes, others open without delay for this long (moving along a toolbar). */
const SKIP_DELAY_WINDOW = 300;
const GAP = 6;
const VIEWPORT_MARGIN = 8;

let lastClosedAt = Number.NEGATIVE_INFINITY;

interface TriggerProps {
  ref?: Ref<HTMLElement>;
  onPointerEnter?: (event: PointerEvent<HTMLElement>) => void;
  onPointerLeave?: (event: PointerEvent<HTMLElement>) => void;
  onPointerDown?: (event: PointerEvent<HTMLElement>) => void;
  onFocus?: (event: FocusEvent<HTMLElement>) => void;
  onBlur?: (event: FocusEvent<HTMLElement>) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void;
  "aria-describedby"?: string | undefined;
}

export type TooltipPlacement = "top" | "bottom";

export interface TooltipProps {
  /** Names the thing, not the instruction: "Rectangle", not "Click to draw a rectangle". */
  label: ReactNode;
  /** Shown after the label in mono. */
  shortcut?: string | undefined;
  className?: string | undefined;
  /**
   * The trigger: one element that accepts ref, focus and pointer props. Without children, Tooltip
   * renders only the bubble, for a host that positions it.
   */
  children?: ReactElement<TriggerProps>;
  /** Preferred side; flips when there is no room. Default "bottom". */
  placement?: TooltipPlacement;
  /** Hover delay in ms. Default 500. */
  delay?: number;
  /**
   * Link the bubble to the trigger with aria-describedby (default). Pass false when the trigger
   * is already named by the same text, as IconButton is; the bubble is then visual only.
   */
  describe?: boolean;
  /** Never show, for example while dragging. */
  disabled?: boolean;
}

function TooltipBubble({
  label,
  shortcut,
  className,
  ...rest
}: Pick<TooltipProps, "label" | "shortcut" | "className"> & {
  id?: string;
  role?: "tooltip";
  ref?: Ref<HTMLSpanElement>;
  "aria-hidden"?: boolean;
}) {
  return (
    <span {...rest} className={cx("dp-tooltip", className)}>
      {label}
      {shortcut && <span className="dp-tooltip__key">{shortcut}</span>}
    </span>
  );
}

function isKeyboardFocus(element: Element): boolean {
  try {
    return element.matches(":focus-visible");
  } catch {
    return true;
  }
}

function position(trigger: HTMLElement, bubble: HTMLElement, placement: TooltipPlacement) {
  const anchor = trigger.getBoundingClientRect();
  const { width, height } = bubble.getBoundingClientRect();
  const below = anchor.bottom + GAP;
  const above = anchor.top - GAP - height;
  const fitsBelow = below + height <= window.innerHeight - VIEWPORT_MARGIN;
  const fitsAbove = above >= VIEWPORT_MARGIN;
  const top =
    placement === "bottom" ? (fitsBelow || !fitsAbove ? below : above) : fitsAbove ? above : below;
  const centered = anchor.left + anchor.width / 2 - width / 2;
  const maxLeft = window.innerWidth - width - VIEWPORT_MARGIN;
  const left = Math.max(VIEWPORT_MARGIN, Math.min(centered, maxLeft));
  bubble.style.top = `${Math.round(top)}px`;
  bubble.style.left = `${Math.round(left)}px`;
}

/**
 * The one inverted surface: a short label and optional shortcut. Wrap a trigger to show it after
 * a hover delay or at once on keyboard focus; Escape, pointer down, blur and scrolling hide it.
 */
export function Tooltip(props: TooltipProps) {
  if (!props.children) {
    return (
      <TooltipBubble
        label={props.label}
        shortcut={props.shortcut}
        className={props.className}
        role="tooltip"
      />
    );
  }
  return <TooltipTrigger {...props} trigger={props.children} />;
}

function TooltipTrigger({
  label,
  shortcut,
  className,
  trigger,
  placement = "bottom",
  delay = SHOW_DELAY,
  describe = true,
  disabled = false,
}: TooltipProps & { trigger: ReactElement<TriggerProps> }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [container, setContainer] = useState<Element | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const bubbleRef = useRef<HTMLSpanElement | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const childProps = trigger.props;
  const childRef = childProps.ref;

  const clearTimer = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
  }, []);

  const show = useCallback(
    (immediate: boolean) => {
      if (disabled) return;
      clearTimer();
      const reveal = () => {
        setContainer(triggerRef.current?.closest(".dp-root") ?? document.body);
        setOpen(true);
      };
      if (immediate || Date.now() - lastClosedAt < SKIP_DELAY_WINDOW) reveal();
      else timer.current = window.setTimeout(reveal, delay);
    },
    [clearTimer, delay, disabled],
  );

  const hide = useCallback(() => {
    clearTimer();
    setOpen((wasOpen) => {
      if (wasOpen) lastClosedAt = Date.now();
      return false;
    });
  }, [clearTimer]);

  useEffect(() => clearTimer, [clearTimer]);

  useEffect(() => {
    if (disabled) hide();
  }, [disabled, hide]);

  useLayoutEffect(() => {
    const anchor = triggerRef.current;
    const bubble = bubbleRef.current;
    if (open && anchor && bubble) position(anchor, bubble, placement);
  });

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") hide();
    };
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
    };
  }, [open, hide]);

  const setTriggerRef = useCallback(
    (node: HTMLElement | null) => {
      triggerRef.current = node;
      assignRef(childRef, node);
    },
    [childRef],
  );

  const describedBy =
    describe && open
      ? [childProps["aria-describedby"], id].filter(Boolean).join(" ")
      : childProps["aria-describedby"];

  const element = cloneElement(trigger, {
    ref: setTriggerRef,
    "aria-describedby": describedBy,
    onPointerEnter: (event: PointerEvent<HTMLElement>) => {
      childProps.onPointerEnter?.(event);
      if (event.pointerType !== "touch") show(false);
    },
    onPointerLeave: (event: PointerEvent<HTMLElement>) => {
      childProps.onPointerLeave?.(event);
      hide();
    },
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      childProps.onPointerDown?.(event);
      hide();
    },
    onFocus: (event: FocusEvent<HTMLElement>) => {
      childProps.onFocus?.(event);
      if (isKeyboardFocus(event.currentTarget)) show(true);
    },
    onBlur: (event: FocusEvent<HTMLElement>) => {
      childProps.onBlur?.(event);
      hide();
    },
  });

  return (
    <>
      {element}
      {open &&
        container &&
        createPortal(
          <TooltipBubble
            ref={bubbleRef}
            id={id}
            label={label}
            shortcut={shortcut}
            className={cx("dp-tooltip--floating", className)}
            {...(describe ? { role: "tooltip" as const } : { "aria-hidden": true })}
          />,
          container,
        )}
    </>
  );
}
