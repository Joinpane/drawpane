/**
 * Focused, dismissible bottom sheet for the phone workspace (Pages, Inspect,
 * Comments, Thread and Draft composer). Tracks `visualViewport` via CSS custom
 * properties (`--vv-*`) and safe areas so content and submit actions stay
 * reachable when the on-screen keyboard opens, and restores focus to its
 * trigger when dismissed.
 */
import { IconButton } from "@drawpane/ui";
import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
} from "react";
import { PASS_GESTURES } from "./canvas-gestures";

export interface MobileSheetProps {
  readonly id?: string | undefined;
  readonly title: string;
  readonly ariaLabel?: string | undefined;
  readonly onClose: () => void;
  /** Optional Back button before the title (for example Thread back to Comments list). */
  readonly onBack?: (() => void) | undefined;
  readonly backLabel?: string | undefined;
  /** Extra controls placed in the sheet header before the Close button. */
  readonly headerActions?: ReactNode;
  /** Trigger element to restore focus to on dismiss. */
  readonly returnFocusTo?: (() => HTMLElement | null) | RefObject<HTMLElement | null> | undefined;
  /** True when a child handles its own initial autofocus (such as a comment composer). */
  readonly focusInside?: boolean | undefined;
  /** Keep the top area lighter when the canvas pin above the sheet matters (threads, inspect). */
  readonly variant?: "default" | "thread" | "inspect" | undefined;
  readonly children: ReactNode;
}

function resolveTrigger(
  target: MobileSheetProps["returnFocusTo"],
  fallback: HTMLElement | null,
): HTMLElement | null {
  const explicit = typeof target === "function" ? target() : target ? target.current : null;
  if (explicit?.isConnected) return explicit;
  return fallback?.isConnected ? fallback : null;
}

export function MobileSheet({
  id,
  title,
  ariaLabel,
  onClose,
  onBack,
  backLabel = "Back",
  headerActions,
  returnFocusTo,
  focusInside = false,
  variant = "default",
  children,
}: MobileSheetProps) {
  const titleId = useId();
  const sheetRef = useRef<HTMLElement>(null);
  const returnFocusRef = useRef(returnFocusTo);
  returnFocusRef.current = returnFocusTo;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Remember whatever had focus before the sheet opened, and return it on unmount.
  const fallbackTrigger = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const active = document.activeElement;
    fallbackTrigger.current = active instanceof HTMLElement ? active : null;
  }, []);

  useEffect(() => {
    const sheet = sheetRef.current;
    if (sheet && !focusInside) {
      const target =
        sheet.querySelector<HTMLElement>('[aria-current="page"], [aria-current="true"]') ?? sheet;
      target.focus({ preventScroll: true });
    }
    return () => {
      // Restore focus to the trigger when the sheet leaves the screen, unless focus
      // already moved explicitly to another interactive control (for example another sheet).
      const active = document.activeElement;
      const lostToBody = !active || active === document.body || !active.isConnected;
      const stillInside = sheet !== null && active instanceof Node && sheet.contains(active);
      if (lostToBody || stillInside) {
        const trigger = resolveTrigger(returnFocusRef.current, fallbackTrigger.current);
        trigger?.focus({ preventScroll: true });
      }
    };
  }, [focusInside]);

  // Escape dismisses the sheet before global editor shortcuts see it.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Let a nested native dialog or open mention listbox handle Escape first.
      if (document.querySelector("dialog[open]:modal")) return;
      if (e.defaultPrevented) return;
      e.preventDefault();
      e.stopPropagation();
      onCloseRef.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const handleKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };

  return (
    <div className="mobile-sheet-host" data-variant={variant} {...PASS_GESTURES}>
      <button
        type="button"
        className="mobile-sheet-scrim"
        aria-label={`Close ${title}`}
        tabIndex={-1}
        onClick={onClose}
      />
      <section
        ref={sheetRef}
        id={id}
        className="mobile-sheet"
        data-variant={variant}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        aria-labelledby={ariaLabel ? undefined : titleId}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <header className="mobile-sheet__head">
          {onBack ? (
            <IconButton
              icon="arrow-left"
              label={backLabel}
              size="md"
              className="mobile-sheet__btn"
              onClick={onBack}
            />
          ) : null}
          <h2 id={titleId} className="mobile-sheet__title">
            {title}
          </h2>
          {headerActions ? <div className="mobile-sheet__actions">{headerActions}</div> : null}
          <IconButton
            icon="close"
            label={`Close ${title}`}
            size="md"
            className="mobile-sheet__btn"
            onClick={onClose}
          />
        </header>
        <div className="mobile-sheet__body">{children}</div>
      </section>
    </div>
  );
}
