/**
 * Who's in the file, in the top bar: faces to click to follow, and a list
 * (after the design sheet) with where each person is, Follow buttons, and
 * "Spotlight me" to ask everyone to follow you.
 */
import type { Peer } from "@drawpane/model";
import {
  Icon,
  initialsOf,
  Popover,
  type PresenceSlot,
  PresenceStack,
  presenceColor,
} from "@drawpane/ui";
import { useRef, useState } from "react";
import { useEditor, useEditorState } from "../hooks";

/** A peer's presence slot (1–8), as their cursor and avatar ring use. */
export function slotOf(peer: Peer): PresenceSlot {
  return (((((peer.color - 1) % 8) + 8) % 8) + 1) as PresenceSlot;
}

/** "Home · editing" style: the page they're on, and what they're doing. */
function whereOf(
  peer: Peer,
  pageName: (id: string) => string | null,
  peers: ReadonlyMap<string, Peer>,
): string {
  const p = peer.presence;
  const page = p?.pageId ? pageName(p.pageId) : null;
  const doing = p?.spotlight
    ? "spotlighting"
    : p?.following
      ? `following ${peers.get(p.following)?.name.split(" ")[0] ?? "someone"}`
      : peer.kind === "agent"
        ? "agent"
        : null;
  return [page, doing].filter(Boolean).join(" · ") || "Just joined";
}

export function People() {
  const editor = useEditor();
  const peers = useEditorState((s) => s.peers);
  const following = useEditorState((s) => s.following);
  const spotlight = useEditorState((s) => s.spotlight);
  const button = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const list = [...peers.values()];
  if (list.length === 0) return null;
  const pageName = (id: string) => (editor.doc.get(id)?.props.name as string | undefined) ?? null;
  const toggle = (sessionId: string) =>
    following === sessionId ? editor.stopFollowing() : editor.follow(sessionId);

  return (
    <>
      <PresenceStack
        people={list.map((p) => ({
          id: p.sessionId,
          name: p.name,
          color: slotOf(p),
          where: whereOf(p, pageName, peers),
        }))}
        max={4}
        {...(following ? { following } : {})}
        onFollow={(person) => person.id && toggle(person.id)}
      />
      <button
        ref={button}
        type="button"
        className="people__more"
        aria-label="People in this file"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="chevron-down" size={12} />
      </button>
      {open && button.current ? (
        <Popover
          anchor={button.current}
          side="bottom"
          label="People in this file"
          className="people dp-root"
          onClose={() => setOpen(false)}
        >
          <div className="people__head">
            <span className="people__title">In this file · {list.length + 1}</span>
            <button
              type="button"
              className="people__spotlight"
              aria-pressed={spotlight}
              onClick={() => {
                editor.setSpotlight(!spotlight);
                setOpen(false);
              }}
            >
              {spotlight ? "Stop spotlight" : "Spotlight me"}
            </button>
          </div>
          <ul className="people__list">
            {list.map((peer) => {
              const isFollowing = following === peer.sessionId;
              return (
                <li key={peer.sessionId} className="people__row">
                  <span
                    className="people__avatar"
                    style={{ background: presenceColor(slotOf(peer)) }}
                    aria-hidden="true"
                  >
                    {initialsOf(peer.name)}
                  </span>
                  <span className="people__who">
                    <span className="people__name">{peer.name}</span>
                    <span className="people__where">{whereOf(peer, pageName, peers)}</span>
                  </span>
                  <button
                    type="button"
                    className="people__follow"
                    aria-pressed={isFollowing}
                    aria-label={isFollowing ? `Stop following ${peer.name}` : `Follow ${peer.name}`}
                    onClick={() => {
                      toggle(peer.sessionId);
                      setOpen(false);
                    }}
                  >
                    {isFollowing ? "Following" : "Follow"}
                  </button>
                </li>
              );
            })}
          </ul>
          <p className="people__note">
            Click a face to follow. You stop when you move the canvas or edit.
          </p>
        </Popover>
      ) : null}
    </>
  );
}
