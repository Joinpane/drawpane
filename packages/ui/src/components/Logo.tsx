import type { ComponentPropsWithRef, CSSProperties } from "react";
import { cx } from "../lib/cx";
import { colors } from "../tokens";

export type LogoVariant = "mark" | "mono" | "app-icon";

export interface LogoProps extends Omit<ComponentPropsWithRef<"span">, "children"> {
  /**
   * `mark` (default) draws in the theme's ink and signal, so it is right on Paper and Graphite.
   * `mono` uses currentColor. `app-icon` is the fixed tile for the PWA and favicon.
   */
  variant?: LogoVariant;
  /** Height of the mark in px. Minimum 16. Default 24. */
  size?: number;
  /** Sets "Drawpane" beside the mark. */
  wordmark?: boolean;
  /** Accessible name when there is no wordmark. Default "Drawpane". */
  label?: string;
}

type LogoStyle = CSSProperties & Record<"--dp-logo-size", string>;

function Mark({ variant }: { variant: "mark" | "mono" }) {
  const ink = variant === "mark" ? "var(--ink)" : "currentColor";
  const front = variant === "mark" ? "var(--signal)" : "currentColor";
  return (
    <>
      <rect
        x="3.25"
        y="3.25"
        width="18.5"
        height="18.5"
        rx="4"
        fill="none"
        strokeWidth="2.5"
        style={{ stroke: ink }}
      />
      <rect x="10" y="10" width="19" height="19" rx="4" style={{ fill: front }} />
    </>
  );
}

/** The two-pane mark (an outlined pane behind a solid signal pane), optionally with the wordmark. */
export function Logo({
  variant = "mark",
  size = 24,
  wordmark = false,
  label = "Drawpane",
  className,
  style,
  ...rest
}: LogoProps) {
  const logoStyle: LogoStyle = { ...style, "--dp-logo-size": `${Math.max(16, size)}px` };
  const name = wordmark ? undefined : label;
  return (
    <span {...rest} className={cx("dp-logo", className)} style={logoStyle}>
      {variant === "app-icon" ? (
        <svg
          className="dp-logo__mark"
          viewBox="0 0 64 64"
          role="img"
          aria-label={name}
          aria-hidden={wordmark || undefined}
        >
          <rect width="64" height="64" rx="14" fill={colors.ink.light} />
          <rect
            x="14"
            y="14"
            width="25"
            height="25"
            rx="5.5"
            fill="none"
            stroke={colors.ink.dark}
            strokeWidth="3.5"
          />
          <rect x="24" y="24" width="26" height="26" rx="5.5" fill={colors.signal.dark} />
        </svg>
      ) : (
        <svg
          className="dp-logo__mark"
          viewBox="0 0 32 32"
          role="img"
          aria-label={name}
          aria-hidden={wordmark || undefined}
        >
          <Mark variant={variant} />
        </svg>
      )}
      {wordmark && <span className="dp-logo__wordmark">Drawpane</span>}
    </span>
  );
}
