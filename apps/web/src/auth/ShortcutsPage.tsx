/**
 * Keyboard shortcuts: every command can have one, and changes follow the
 * account to every browser. Pick a command's shortcut, press the new keys;
 * one taken by another command asks before moving it, and one the browser
 * keeps is refused with the reason. See designs/Preferences.dc.html.
 */
import { Button, Icon, IconButton, Kbd, Logo } from "@drawpane/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type KeyboardEvent, useMemo, useState } from "react";
import { api } from "../api/client";
import { fetchShortcuts, SHORTCUTS_QUERY } from "../app/ShortcutsSync";
import {
  ACTIONS,
  type Action,
  formatShortcut,
  type Shortcut,
  shortcutCaps,
  shortcutOf,
} from "../editor/actions";
import { actionUsing, assign, reservedReason, shortcutFromEvent } from "../editor/keymap";
import { type ShortcutOverrides, useOverridesVersion } from "../editor/shortcuts-store";
import { SettingsNav } from "./SettingsNav";
import "./account.css";

const GROUPS: readonly Action["group"][] = [
  "Tools",
  "Edit",
  "Layer",
  "Arrange",
  "View",
  "File",
  "Help",
];

/** A recording waiting on an answer: a shortcut another command has, or one the browser keeps. */
type Pending =
  | { readonly kind: "taken"; readonly shortcut: Shortcut; readonly by: Action }
  | { readonly kind: "reserved"; readonly shortcut: Shortcut; readonly reason: string };

export function ShortcutsPage() {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: SHORTCUTS_QUERY, queryFn: fetchShortcuts });
  useOverridesVersion();
  const overrides: ShortcutOverrides = query.data?.shortcuts ?? {};
  const [search, setSearch] = useState("");
  const [recording, setRecording] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (shortcuts: ShortcutOverrides) =>
      api.put<{ shortcuts: ShortcutOverrides }>("/account/shortcuts", { shortcuts }),
    onMutate: async (shortcuts) => {
      setError(null);
      await queryClient.cancelQueries({ queryKey: SHORTCUTS_QUERY });
      const before = queryClient.getQueryData(SHORTCUTS_QUERY);
      queryClient.setQueryData(SHORTCUTS_QUERY, { shortcuts });
      return { before };
    },
    onError: (e, _shortcuts, context) => {
      queryClient.setQueryData(SHORTCUTS_QUERY, context?.before);
      setError(e instanceof Error ? e.message : "That change wasn't saved. Try again.");
    },
  });

  const change = (action: Action, shortcut: Shortcut | null) => {
    save.mutate(assign(overrides, action, shortcut));
    setRecording(null);
    setPending(null);
  };

  const groups = useMemo(() => {
    const q = search.trim().toLowerCase();
    return GROUPS.map((group) => ({
      group,
      actions: ACTIONS.filter(
        (a) =>
          a.group === group &&
          (!q || `${a.label} ${a.keywords ?? ""} ${a.group}`.toLowerCase().includes(q)),
      ),
    })).filter((g) => g.actions.length > 0);
  }, [search]);

  const changed = Object.keys(overrides).length;

  return (
    <div className="account">
      <header className="account__bar">
        <Link to="/" className="account__back">
          <Icon name="arrow-left" size={16} />
          Files
        </Link>
        <Logo size={20} />
      </header>
      <main className="account__main">
        <SettingsNav />
        <div>
          <h1 className="account__title">Keyboard shortcuts</h1>
          <p className="keyprefs__lede">
            Every command can have a shortcut. Changes follow your account to every browser.
          </p>
        </div>
        {error ? (
          <p className="account__notice account__notice--error" role="alert">
            <Icon name="warning" size={16} />
            <span>{error}</span>
            <IconButton icon="close" label="Dismiss" onClick={() => setError(null)} />
          </p>
        ) : null}
        <div className="keyprefs__tools">
          <label className="keyprefs__search">
            <Icon name="search" size={16} />
            <input
              type="search"
              placeholder={`Search ${ACTIONS.length} commands`}
              aria-label="Search commands"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          <Button
            variant="ghost"
            disabled={changed === 0 || save.isPending}
            onClick={() => save.mutate({})}
          >
            Reset all
          </Button>
        </div>
        {query.isPending ? <div className="account__skeleton" style={{ height: 240 }} /> : null}
        {query.isSuccess
          ? groups.map(({ group, actions }) => (
              <section key={group} className="keyprefs__group" aria-labelledby={`group-${group}`}>
                <h2 id={`group-${group}`} className="keyprefs__group-title">
                  {group}
                </h2>
                <ul className="keyprefs__list">
                  {actions.map((action) => (
                    <Row
                      key={action.id}
                      action={action}
                      customized={Object.hasOwn(overrides, action.id)}
                      recording={recording === action.id}
                      pending={recording === action.id ? pending : null}
                      onRecord={() => {
                        setRecording(action.id);
                        setPending(null);
                      }}
                      onCancel={() => {
                        setRecording(null);
                        setPending(null);
                      }}
                      onPress={(shortcut) => {
                        const reason = reservedReason(shortcut);
                        if (reason) return setPending({ kind: "reserved", shortcut, reason });
                        const by = actionUsing(shortcut, action.id);
                        if (by) return setPending({ kind: "taken", shortcut, by });
                        change(action, shortcut);
                      }}
                      onRemove={() => change(action, null)}
                      onReplace={(shortcut) => change(action, shortcut)}
                      onReset={() => change(action, action.defaultShortcut ?? null)}
                    />
                  ))}
                </ul>
              </section>
            ))
          : null}
        {query.isSuccess && groups.length === 0 ? (
          <p className="keyprefs__empty">No commands match “{search.trim()}”.</p>
        ) : null}
      </main>
    </div>
  );
}

function Row({
  action,
  customized,
  recording,
  pending,
  onRecord,
  onCancel,
  onPress,
  onRemove,
  onReplace,
  onReset,
}: {
  action: Action;
  customized: boolean;
  recording: boolean;
  pending: Pending | null;
  onRecord: () => void;
  onCancel: () => void;
  onPress: (shortcut: Shortcut) => void;
  onRemove: () => void;
  onReplace: (shortcut: Shortcut) => void;
  onReset: () => void;
}) {
  const current = shortcutOf(action);
  const spoken = current ? formatShortcut(current) : "none";

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (!recording) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") return onCancel();
    const plain = !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
    if (plain && (e.key === "Backspace" || e.key === "Delete")) return onRemove();
    const shortcut = shortcutFromEvent(e.nativeEvent);
    if (shortcut) onPress(shortcut);
  };

  return (
    <li className="keyprefs__item" data-recording={recording || undefined}>
      <div className="keyprefs__row">
        <span className="keyprefs__label">{action.label}</span>
        {customized && !recording ? (
          <Button size="sm" variant="ghost" onClick={onReset}>
            Reset
          </Button>
        ) : null}
        <button
          type="button"
          className="keyprefs__keys"
          aria-label={
            recording
              ? `Press the new shortcut for ${action.label}. Escape cancels; Delete removes it.`
              : `Change the shortcut for ${action.label}, now ${spoken}`
          }
          onClick={recording ? undefined : onRecord}
          onKeyDown={onKeyDown}
          onBlur={() => {
            if (recording && !pending) onCancel();
          }}
          // biome-ignore lint/a11y/noAutofocus: recording starts on the field the person just pressed.
          autoFocus={recording}
        >
          {recording ? (
            <span className="keyprefs__press">
              Press keys…
              {pending ? <Kbd keys={shortcutCaps(pending.shortcut)} /> : null}
            </span>
          ) : current ? (
            <Kbd keys={shortcutCaps(current)} />
          ) : (
            <span className="keyprefs__none">None</span>
          )}
        </button>
      </div>
      {pending ? (
        <div className="keyprefs__question" role="alert">
          <Icon name="warning" size={12} />
          {pending.kind === "taken" ? (
            <>
              <span>
                {formatShortcut(pending.shortcut)} is used by “{pending.by.label}”. Replace it?
              </span>
              <Button size="sm" variant="ghost" onClick={onCancel}>
                Cancel
              </Button>
              <Button size="sm" onClick={() => onReplace(pending.shortcut)}>
                Replace
              </Button>
            </>
          ) : (
            <>
              <span>
                {formatShortcut(pending.shortcut)} can't be a shortcut: {pending.reason}. Press
                another.
              </span>
              <Button size="sm" variant="ghost" onClick={onCancel}>
                Cancel
              </Button>
            </>
          )}
        </div>
      ) : null}
    </li>
  );
}
