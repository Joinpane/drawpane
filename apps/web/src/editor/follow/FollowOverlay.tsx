/**
 * What following and spotlighting look like: a frame in the leader's color
 * around the canvas with "Following Lena Park · Esc to stop", your own
 * spotlight banner with how many follow you, and the prompt when someone
 * else asks everyone to follow them.
 */
import type { Peer } from "@drawpane/model";
import { Button, initialsOf, presenceColor } from "@drawpane/ui";
import { type CSSProperties, useState } from "react";
import { useEditor, useEditorState } from "../hooks";
import { slotOf } from "./People";

export function FollowOverlay() {
  const editor = useEditor();
  const peers = useEditorState((s) => s.peers);
  const following = useEditorState((s) => s.following);
  const spotlight = useEditorState((s) => s.spotlight);
  const insets = useEditorState((s) => s.insets);
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  const leader = following ? peers.get(following) : undefined;
  const me = editor.sync.sessionId;
  const followers = [...peers.values()].filter((p) => me && p.presence?.following === me);
  // Someone else spotlighting whom you neither follow nor turned down.
  const asking = [...peers.values()].find(
    (p) => p.presence?.spotlight && p.sessionId !== following && !dismissed.has(p.sessionId),
  );
  // Forget a "Not now" once they stop, so their next spotlight asks again.
  const spotlighting = new Set(
    [...peers.values()].filter((p) => p.presence?.spotlight).map((p) => p.sessionId),
  );
  if ([...dismissed].some((id) => !spotlighting.has(id)))
    setDismissed(new Set([...dismissed].filter((id) => spotlighting.has(id))));

  // The canvas area between the panes, where the frame goes.
  const area: CSSProperties = {
    left: insets.left > 0 ? insets.left : 12,
    right: insets.right > 0 ? insets.right : 12,
  };
  return (
    <>
      {leader ? (
        <div
          className="follow-frame"
          style={{ ...area, ["--follow-color" as string]: presenceColor(slotOf(leader)) }}
        >
          <button
            type="button"
            className="follow-frame__banner"
            onClick={() => editor.stopFollowing()}
            title="Stop following"
          >
            <span className="follow-frame__avatar" aria-hidden="true">
              {initialsOf(leader.name)}
            </span>
            <span>Following {leader.name}</span>
            <span className="follow-frame__key">Esc to stop</span>
          </button>
        </div>
      ) : null}
      {spotlight ? (
        <div className="follow-frame follow-frame--mine" style={area}>
          <div className="follow-frame__banner" role="status">
            <span>
              You're spotlighting ·{" "}
              {followers.length === 1 ? "1 person follows" : `${followers.length} people follow`}
            </span>
            <button
              type="button"
              className="follow-frame__key"
              onClick={() => editor.setSpotlight(false)}
            >
              Stop
            </button>
          </div>
        </div>
      ) : null}
      {asking && !spotlight ? (
        <SpotlightPrompt
          peer={asking}
          onDismiss={() => setDismissed(new Set([...dismissed, asking.sessionId]))}
        />
      ) : null}
    </>
  );
}

function SpotlightPrompt({ peer, onDismiss }: { peer: Peer; onDismiss: () => void }) {
  const editor = useEditor();
  const first = peer.name.split(" ")[0] ?? peer.name;
  return (
    <section className="spotlight-prompt pane" aria-label={`${peer.name} wants to spotlight`}>
      <div className="spotlight-prompt__head">
        <span
          className="spotlight-prompt__avatar"
          style={{ background: presenceColor(slotOf(peer)) }}
          aria-hidden="true"
        >
          {initialsOf(peer.name)}
        </span>
        <div>
          <p className="spotlight-prompt__title">{first} wants to spotlight</p>
          <p className="spotlight-prompt__text">Your view will follow {first}.</p>
        </div>
      </div>
      <div className="spotlight-prompt__actions">
        <Button variant="secondary" size="sm" onClick={onDismiss}>
          Not now
        </Button>
        <Button variant="primary" size="sm" onClick={() => editor.follow(peer.sessionId)}>
          Follow {first}
        </Button>
      </div>
    </section>
  );
}
