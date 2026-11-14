import type { CommentPerson } from "@drawpane/model";
import { Button } from "@drawpane/ui";
import {
  type KeyboardEvent,
  type RefObject,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { mentionsIn } from "./people";

/** People shown in the @ list at once. */
const MAX_SUGGESTIONS = 6;

interface MentionQuery {
  /** Index of the `@` in the text. */
  readonly start: number;
  readonly query: string;
}

/** The `@word` being typed right before the caret, if any. */
function mentionAt(text: string, caret: number): MentionQuery | null {
  const before = text.slice(0, caret);
  const match = /(?:^|\s)@([\p{L}\p{N}._'-]*)$/u.exec(before);
  if (!match) return null;
  const query = match[1] ?? "";
  return { start: caret - query.length - 1, query };
}

function suggestionsFor(people: readonly CommentPerson[], query: string): CommentPerson[] {
  const q = query.toLowerCase();
  const starts = (name: string) =>
    name.toLowerCase().startsWith(q) ||
    name
      .toLowerCase()
      .split(/\s+/)
      .some((w) => w.startsWith(q));
  return people.filter((p) => starts(p.name)).slice(0, MAX_SUGGESTIONS);
}

export interface ComposerProps {
  readonly people: readonly CommentPerson[];
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** Called with the trimmed body and the ids of everyone it mentions. */
  readonly onSubmit: (body: string, mentions: string[]) => void;
  readonly submitLabel: string;
  readonly placeholder: string;
  /** Accessible name of the text field. */
  readonly label: string;
  readonly onCancel?: () => void;
  /** The "Mention someone with @" hint; off where it's already known (editing). Default true. */
  readonly hint?: boolean;
  readonly busy?: boolean;
  readonly autoFocus?: boolean;
  readonly textareaRef?: RefObject<HTMLTextAreaElement | null>;
}

/**
 * A comment field: grows with its text, posts with Enter (Shift+Enter for a
 * new line; ⌘↵ and Ctrl+Enter post too), and
 * suggests teammates after `@`. The field keeps focus while the list is open
 * (a combobox): arrows move, Enter or Tab picks, Escape closes the list.
 */
export function Composer({
  people,
  value,
  onChange,
  onSubmit,
  submitLabel,
  placeholder,
  label,
  onCancel,
  hint = true,
  busy = false,
  autoFocus = false,
  textareaRef,
}: ComposerProps) {
  const id = useId();
  const ownRef = useRef<HTMLTextAreaElement>(null);
  const field = textareaRef ?? ownRef;
  const [mention, setMention] = useState<MentionQuery | null>(null);
  const [active, setActive] = useState(0);
  const suggestions = mention ? suggestionsFor(people, mention.query) : [];
  const listOpen = suggestions.length > 0;
  const empty = value.trim() === "";

  // Grow with the text, up to the CSS max-height.
  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value, field]);

  useEffect(() => {
    if (!autoFocus) return;
    const el = field.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    el.setSelectionRange(el.value.length, el.value.length);
  }, [autoFocus, field]);

  const track = (el: HTMLTextAreaElement) => {
    const next =
      el.selectionStart === el.selectionEnd ? mentionAt(el.value, el.selectionStart) : null;
    if (next?.start === mention?.start && next?.query === mention?.query) return;
    setMention(next);
    setActive(0);
  };

  const pick = (person: CommentPerson) => {
    const el = field.current;
    if (!el || !mention) return;
    const end = mention.start + 1 + mention.query.length;
    const insert = `@${person.name} `;
    const next = value.slice(0, mention.start) + insert + value.slice(end);
    onChange(next);
    setMention(null);
    const caret = mention.start + insert.length;
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(caret, caret);
    });
  };

  const submit = () => {
    if (busy || empty) return;
    onSubmit(value.trim(), mentionsIn(value, people));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (listOpen) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const delta = e.key === "ArrowDown" ? 1 : -1;
        setActive((i) => (i + delta + suggestions.length) % suggestions.length);
        return;
      }
      if ((e.key === "Enter" && !e.metaKey && !e.ctrlKey) || e.key === "Tab") {
        const person = suggestions[active] ?? suggestions[0];
        if (person) {
          e.preventDefault();
          pick(person);
          return;
        }
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setMention(null);
        return;
      }
    }
    // Enter posts, as in chat; Shift+Enter breaks the line. Not mid-composition (an IME's Enter confirms).
    if (e.key === "Enter" && !e.shiftKey && !e.altKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
      return;
    }
    if (e.key === "Escape" && onCancel) {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    }
  };

  const listId = `${id}-people`;
  const optionId = (i: number) => `${id}-person-${String(i)}`;

  return (
    <div className="comment-composer" data-busy={busy || undefined}>
      <textarea
        ref={field}
        className="comment-composer__field"
        rows={1}
        value={value}
        placeholder={placeholder}
        aria-label={label}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={listOpen}
        aria-controls={listOpen ? listId : undefined}
        aria-activedescendant={listOpen ? optionId(active) : undefined}
        onChange={(e) => {
          onChange(e.currentTarget.value);
          track(e.currentTarget);
        }}
        onSelect={(e) => track(e.currentTarget)}
        onKeyDown={onKeyDown}
        onBlur={() => setMention(null)}
      />
      {listOpen ? (
        <div
          className="comment-composer__people dp-menu"
          id={listId}
          role="listbox"
          aria-label="People"
        >
          <div className="dp-menu__heading" aria-hidden="true">
            People on this team
          </div>
          {suggestions.map((person, i) => (
            <div
              key={person.id}
              id={optionId(i)}
              role="option"
              tabIndex={-1}
              aria-selected={i === active}
              className={i === active ? "dp-menu__item is-active" : "dp-menu__item"}
              // Keep focus in the field: pick on mousedown, before blur.
              onMouseDown={(e) => {
                e.preventDefault();
                pick(person);
              }}
              onPointerMove={() => setActive(i)}
            >
              <span className="dp-menu__label">{person.name}</span>
            </div>
          ))}
        </div>
      ) : null}
      <div className="comment-composer__foot">
        {hint ? (
          <span className="comment-composer__hint">
            Mention someone with <b>@</b>
          </span>
        ) : null}
        <span className="comment-composer__actions">
          {onCancel ? (
            <Button size="sm" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="primary"
            disabled={empty || busy}
            shortcut="↵"
            onClick={submit}
          >
            {submitLabel}
          </Button>
        </span>
      </div>
    </div>
  );
}
