import { type ReactNode, useEffect, useRef } from "react";

/**
 * A modal dialog on the native <dialog> element: focus trap, Escape and the
 * top layer come from the browser.
 */
export function Dialog({
  open,
  title,
  onClose,
  children,
  footer,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="app-dialog"
      aria-label={title}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      {open ? (
        <div className="app-dialog__body">
          <h2 className="app-dialog__title">{title}</h2>
          {children}
          {footer ? <div className="app-dialog__footer">{footer}</div> : null}
        </div>
      ) : null}
    </dialog>
  );
}
