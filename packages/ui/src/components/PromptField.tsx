import {
  type ChangeEvent,
  type ComponentPropsWithRef,
  type KeyboardEvent,
  type Ref,
  useId,
} from "react";
import type { IconName } from "../icons";
import { cx } from "../lib/cx";
import { useControllableState } from "../lib/use-controllable-state";
import { Icon } from "./Icon";
import { IconButton } from "./IconButton";
import { Tooltip } from "./Tooltip";

export interface PromptChip {
  label: string;
  /** Default "layers". */
  icon?: IconName;
}

export type PromptTrigger = "/" | "@";

export interface PromptFieldProps
  extends Omit<
    ComponentPropsWithRef<"div">,
    "onSubmit" | "onChange" | "defaultValue" | "children"
  > {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  placeholder?: string;
  /** What the agent can see: the selection, a library, an attached file. */
  context?: readonly (PromptChip | string)[];
  /** Which model runs and who pays: "Claude Opus 5.5 · your key". */
  model?: string;
  /** Swaps Send for Stop. */
  running?: boolean;
  rows?: number;
  /** Accessible name of the text area. Default "Message the agent". */
  label?: string;
  /** Enter (without Shift) or the Send button, with the trimmed text. */
  onSubmit?: (value: string) => void;
  onStop?: () => void;
  onAttach?: () => void;
  onSkills?: () => void;
  /** "/" (skills) or "@" (context) typed at the start of a word. */
  onTrigger?: (trigger: PromptTrigger) => void;
  textareaRef?: Ref<HTMLTextAreaElement>;
}

function typedTrigger(
  event: ChangeEvent<HTMLTextAreaElement>,
  previous: string,
): PromptTrigger | null {
  const { value, selectionStart } = event.target;
  if (value.length !== previous.length + 1) return null;
  const char = value[selectionStart - 1];
  const before = value[selectionStart - 2];
  if ((char === "/" || char === "@") && (before === undefined || /\s/.test(before))) return char;
  return null;
}

/** Where people talk to an agent. Enter sends, Shift+Enter adds a line. */
export function PromptField({
  value: valueProp,
  defaultValue = "",
  onValueChange,
  placeholder = "Ask the agent, or type / for a skill",
  context = [],
  model = "Your model",
  running = false,
  rows = 2,
  label = "Message the agent",
  onSubmit,
  onStop,
  onAttach,
  onSkills,
  onTrigger,
  textareaRef,
  className,
  ...rest
}: PromptFieldProps) {
  const modelId = useId();
  const [value, setValue] = useControllableState(valueProp, defaultValue, onValueChange);
  const canSend = !running && value.trim() !== "";

  const submit = () => {
    if (!canSend) return;
    onSubmit?.(value.trim());
    if (valueProp === undefined) setValue("");
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <div {...rest} className={cx("dp-prompt", className)}>
      {context.length > 0 && (
        <ul className="dp-prompt__chips" aria-label="Context">
          {context.map((chip, i) => {
            const { label: text, icon = "layers" } =
              typeof chip === "string" ? { label: chip } : chip;
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: chips can repeat and keep their order
              <li key={`${text}-${i}`} className="dp-prompt__chip">
                <Icon name={icon} size={12} />
                {text}
              </li>
            );
          })}
        </ul>
      )}
      <textarea
        ref={textareaRef}
        className="dp-prompt__input"
        rows={rows}
        placeholder={placeholder}
        aria-label={label}
        aria-describedby={modelId}
        value={value}
        onChange={(event) => {
          const trigger = typedTrigger(event, value);
          setValue(event.target.value);
          if (trigger) onTrigger?.(trigger);
        }}
        onKeyDown={onKeyDown}
      />
      <div className="dp-prompt__foot">
        <IconButton icon="plus" label="Attach a file or link" onClick={onAttach} />
        <IconButton icon="book" label="Use a skill" shortcut="/" onClick={onSkills} />
        <span id={modelId} className="dp-prompt__model">
          {model}
        </span>
        {running ? (
          <Tooltip label="Stop the agent" describe={false}>
            <button
              type="button"
              className="dp-prompt__send dp-prompt__send--stop"
              aria-label="Stop the agent"
              onClick={onStop}
            >
              <Icon name="stop" />
            </button>
          </Tooltip>
        ) : (
          <Tooltip label="Send" shortcut="↵" describe={false}>
            <button
              type="button"
              className="dp-prompt__send"
              aria-label="Send"
              disabled={!canSend}
              onClick={submit}
            >
              <Icon name="send" />
            </button>
          </Tooltip>
        )}
      </div>
    </div>
  );
}
