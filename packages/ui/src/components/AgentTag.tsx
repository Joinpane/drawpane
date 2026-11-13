import type { ComponentPropsWithRef } from "react";
import { cx } from "../lib/cx";
import { Icon } from "./Icon";

export type AgentStatus = "working" | "waiting" | "idle" | "stopped";

const STATUS_LABELS: Record<AgentStatus, string> = {
  working: "Working",
  waiting: "Waiting for review",
  idle: "Idle",
  stopped: "Stopped",
};

export interface AgentTagProps extends Omit<ComponentPropsWithRef<"span">, "children"> {
  /** The agent or MCP client, such as "Claude". */
  name: string;
  status?: AgentStatus;
  /** The person who started the agent: "Claude, for Ana". */
  onBehalfOf?: string;
  hideStatus?: boolean;
}

/** Names an AI agent. The chip is always the agent color, so it is never mistaken for a person. */
export function AgentTag({
  name,
  status = "working",
  onBehalfOf,
  hideStatus = false,
  className,
  ...rest
}: AgentTagProps) {
  return (
    <span
      title={onBehalfOf ? `${name}, for ${onBehalfOf}` : name}
      {...rest}
      className={cx("dp-agenttag", `dp-agenttag--${status}`, className)}
    >
      <span className="dp-agenttag__chip">
        <Icon name="agent" size={12} />
        {name}
      </span>
      {!hideStatus && (
        <span className="dp-agenttag__status">
          <span className="dp-agenttag__dot" aria-hidden="true" />
          {STATUS_LABELS[status]}
        </span>
      )}
      {onBehalfOf && <span className="dp-agenttag__for">for {onBehalfOf}</span>}
    </span>
  );
}
