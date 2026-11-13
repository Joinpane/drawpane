import type * as React from 'react';

/** One of the 43 names in Drawpane.icons, e.g. 'board', 'component', 'branch'. */
export type IconName = string;
/** Collaborator color slot, maps to the presence-1 … presence-8 tokens. */
export type PresenceSlot = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export interface IconProps { name: IconName; size?: 12 | 16; label?: string; className?: string }
export declare function Icon(props: IconProps): React.ReactElement;

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** primary = signal fill, at most one per view. Default secondary. */
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  /** sm 24px (panes), md 28px (default), lg 36px (dashboard, dialogs). */
  size?: 'sm' | 'md' | 'lg';
  icon?: IconName;
  /** Shortcut shown after the label in mono, e.g. '⌘ ↵'. */
  shortcut?: string;
}
export declare function Button(props: ButtonProps): React.ReactElement;

export interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  icon: IconName;
  /** Required accessible name; also the tooltip text. */
  label: string;
  shortcut?: string;
  /** Toggle state; renders aria-pressed. Omit for one-shot actions. */
  pressed?: boolean;
  size?: 'sm' | 'md';
}
export declare function IconButton(props: IconButtonProps): React.ReactElement;

export interface KbdProps { keys?: string[]; children?: string; label?: string; className?: string }
export declare function Kbd(props: KbdProps): React.ReactElement;

export interface TooltipProps { label: React.ReactNode; shortcut?: string; className?: string }
export declare function Tooltip(props: TooltipProps): React.ReactElement;

export interface BadgeProps {
  tone?: 'neutral' | 'signal' | 'component' | 'success' | 'warning' | 'danger' | 'info';
  icon?: IconName;
  children?: React.ReactNode;
  className?: string;
}
export declare function Badge(props: BadgeProps): React.ReactElement;

export interface TextFieldProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  hint?: string;
  /** Error message; replaces the hint and turns the border danger. */
  error?: string;
}
export declare function TextField(props: TextFieldProps): React.ReactElement;

export interface NumberFieldProps extends React.InputHTMLAttributes<HTMLInputElement> {
  /** One to three characters (W, H, X, ↔). Dragging the label scrubs the value. */
  label?: string;
  icon?: IconName;
  unit?: string;
  /** When bound to a token, the chip replaces the input. */
  token?: string;
  /** CSS color for a bound color token. */
  swatch?: string;
  ariaLabel?: string;
}
export declare function NumberField(props: NumberFieldProps): React.ReactElement;

export interface TokenChipProps {
  /** Token path as authored, e.g. 'space/300' or 'brand/500'. */
  name: string;
  /** CSS color for color tokens; omit for number tokens. */
  swatch?: string;
  /** The layer overrides the token's value. */
  detached?: boolean;
  className?: string;
}
export declare function TokenChip(props: TokenChipProps): React.ReactElement;

export interface SegmentedOption { value: string; label?: string; icon?: IconName; title?: string }
export interface SegmentedControlProps { options: SegmentedOption[]; value: string; onChange?: (value: string) => void; label?: string; className?: string }
export declare function SegmentedControl(props: SegmentedControlProps): React.ReactElement;

export interface SwitchProps { checked?: boolean; onChange?: (checked: boolean) => void; label?: string; disabled?: boolean; className?: string }
export declare function Switch(props: SwitchProps): React.ReactElement;

export interface PropertySectionProps { title: string; actions?: React.ReactNode; children?: React.ReactNode; className?: string }
export declare function PropertySection(props: PropertySectionProps): React.ReactElement;

export interface LayerRowProps {
  name: string;
  kind?: 'frame' | 'board' | 'group' | 'rect' | 'ellipse' | 'text' | 'path' | 'image' | 'component' | 'instance';
  depth?: number;
  selected?: boolean;
  hidden?: boolean;
  locked?: boolean;
  hasChildren?: boolean;
  expanded?: boolean;
  /** A collaborator has this layer selected. */
  presence?: PresenceSlot;
  className?: string;
}
export declare function LayerRow(props: LayerRowProps): React.ReactElement;

export interface MenuItem {
  label?: string; icon?: IconName; shortcut?: string; checked?: boolean; danger?: boolean; disabled?: boolean;
  active?: boolean; submenu?: boolean; separator?: boolean; heading?: string;
}
export interface MenuProps { items: MenuItem[]; label?: string; className?: string }
export declare function Menu(props: MenuProps): React.ReactElement;

export interface CommandItem {
  label: string; icon?: IconName; hint?: string; shortcut?: string; active?: boolean; kind?: 'component';
  /** For property commands: the current and the new value, shown as a diff. */
  from?: string; to?: string;
}
export interface CommandBarProps { query?: string; placeholder?: string; groups: { title: string; items: CommandItem[] }[]; scope?: string; readOnly?: boolean; className?: string }
export declare function CommandBar(props: CommandBarProps): React.ReactElement;

export interface SelectionLensProps { kind?: string; kindIcon?: IconName; children?: React.ReactNode; className?: string }
export declare function SelectionLens(props: SelectionLensProps): React.ReactElement;

export interface Person { name: string; initials?: string; color?: PresenceSlot; where?: string }
export interface PresenceStackProps { people: Person[]; max?: number; className?: string }
export declare function PresenceStack(props: PresenceStackProps): React.ReactElement;

export interface AgentTagProps { name: string; status?: 'working' | 'waiting' | 'idle' | 'stopped'; onBehalfOf?: string; hideStatus?: boolean; className?: string }
export declare function AgentTag(props: AgentTagProps): React.ReactElement;

export interface AgentStepProps {
  label: string;
  /** done, running (one at a time), queued, failed, or review (waiting for a person). */
  status?: 'done' | 'running' | 'queued' | 'failed' | 'review';
  detail?: string;
  /** The typed operations this step applied, in command syntax. */
  ops?: string;
  meta?: string;
  className?: string;
}
export declare function AgentStep(props: AgentStepProps): React.ReactElement;

export interface PromptChip { label: string; icon?: IconName }
export interface PromptFieldProps { value?: string; placeholder?: string; context?: (PromptChip | string)[]; model?: string; running?: boolean; rows?: number; label?: string; className?: string }
export declare function PromptField(props: PromptFieldProps): React.ReactElement;

declare global {
  interface Window {
    Drawpane: {
      Icon: typeof Icon; Button: typeof Button; IconButton: typeof IconButton; Kbd: typeof Kbd; Tooltip: typeof Tooltip;
      Badge: typeof Badge; TextField: typeof TextField; NumberField: typeof NumberField; TokenChip: typeof TokenChip;
      SegmentedControl: typeof SegmentedControl; Switch: typeof Switch; PropertySection: typeof PropertySection;
      LayerRow: typeof LayerRow; Menu: typeof Menu; CommandBar: typeof CommandBar; SelectionLens: typeof SelectionLens;
      PresenceStack: typeof PresenceStack; AgentTag: typeof AgentTag; AgentStep: typeof AgentStep; PromptField: typeof PromptField; icons: string[];
    };
  }
}
