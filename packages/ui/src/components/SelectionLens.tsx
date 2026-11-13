import type { ComponentPropsWithRef } from "react";
import type { IconName } from "../icons";
import { cx } from "../lib/cx";
import { Icon } from "./Icon";
import { IconButton } from "./IconButton";

export interface SelectionLensProps extends ComponentPropsWithRef<"div"> {
  /** Layer type and mode, such as "Frame · Auto layout". Default "Board". */
  kind?: string;
  kindIcon?: IconName;
  /** Opens the full Inspector. */
  onOpenInspector?: () => void;
  /** Shortcut shown in the Inspector button's tooltip. Default "⌘ .". */
  inspectorShortcut?: string;
}

/**
 * A compact toolbar anchored under the selection, holding its 4–6 most used controls (compact
 * NumberFields, TokenChips, SegmentedControls). Positioning is the host's job.
 */
export function SelectionLens({
  kind = "Board",
  kindIcon = "board",
  onOpenInspector,
  inspectorShortcut = "⌘ .",
  className,
  children,
  ...rest
}: SelectionLensProps) {
  return (
    <div {...rest} role="toolbar" aria-label="Selection Lens" className={cx("dp-lens", className)}>
      <span className="dp-lens__kind">
        <Icon name={kindIcon} size={12} />
        {kind}
      </span>
      <span className="dp-lens__sep" aria-hidden="true" />
      {children}
      <span className="dp-lens__sep" aria-hidden="true" />
      <IconButton
        icon="inspector"
        label="Open Inspector"
        shortcut={inspectorShortcut}
        onClick={onOpenInspector}
      />
    </div>
  );
}
