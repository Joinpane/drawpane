import type { ComponentPropsWithRef } from "react";
import type { IconName } from "../icons";
import { cx } from "../lib/cx";
import { Icon } from "./Icon";

export type AgentStepStatus = "done" | "running" | "queued" | "failed" | "review";

const STATUS: Record<AgentStepStatus, { word: string; icon?: IconName }> = {
  done: { word: "Done", icon: "check" },
  running: { word: "Running" },
  queued: { word: "Queued" },
  failed: { word: "Failed", icon: "warning" },
  review: { word: "Waiting for review", icon: "branch" },
};

export interface AgentStepProps extends Omit<ComponentPropsWithRef<"li">, "children"> {
  /** What the agent is doing, present tense: "Adding empty state to Upcoming". */
  label: string;
  /** done, running (one at a time), queued, failed, or review (waiting for a person). */
  status?: AgentStepStatus;
  detail?: string;
  /** The typed operations this step applied, in command syntax. */
  ops?: string;
  /** Time or cost, such as "2 s". */
  meta?: string;
}

/** One step in an agent's plan, as a list item: render steps inside an AgentPlan. */
export function AgentStep({
  label,
  status = "queued",
  detail,
  ops,
  meta,
  className,
  ...rest
}: AgentStepProps) {
  const { word, icon } = STATUS[status];
  return (
    <li
      {...rest}
      aria-current={status === "running" ? "step" : undefined}
      className={cx("dp-step", `dp-step--${status}`, className)}
    >
      <span className="dp-step__mark" aria-hidden="true">
        {icon && <Icon name={icon} size={12} />}
      </span>
      <span className="dp-step__body">
        <span className="dp-step__label">
          <span className="dp-visually-hidden">{word}: </span>
          {label}
        </span>
        {detail && <span className="dp-step__detail">{detail}</span>}
        {ops && <code className="dp-step__ops">{ops}</code>}
      </span>
      {meta && <span className="dp-step__meta">{meta}</span>}
    </li>
  );
}

export type AgentPlanProps = ComponentPropsWithRef<"ol">;

/** The ordered list of an agent's steps. */
export function AgentPlan({ className, ...rest }: AgentPlanProps) {
  return <ol {...rest} className={cx("dp-plan", className)} />;
}
