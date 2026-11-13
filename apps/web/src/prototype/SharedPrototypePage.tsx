import { CanvasTextMeasurer, Editor, ImageCache } from "@drawpane/editor";
import { Logo } from "@drawpane/ui";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import { connectFile } from "../editor/connection";
import { Player, resolveTarget, useDoc } from "./Player";
import { useLoaded } from "./PresentPage";

export interface SharedSearch {
  flow?: string;
  page?: string;
}

/** A prototype opened from its share link: no account, read-only, live. */
export function SharedPrototypePage() {
  const { token } = useParams({ from: "/p/$token" });
  return <Shared key={token} token={token} />;
}

function Shared({ token }: { token: string }) {
  const search = useSearch({ from: "/p/$token" });
  const navigate = useNavigate({ from: "/p/$token" });
  const shared = useQuery({
    queryKey: ["share-token", token],
    queryFn: () => api.resolveShare(token),
    retry: false,
  });
  const fileId = shared.data?.file.id ?? null;
  const [editor] = useState(() => new Editor({ measurer: new CanvasTextMeasurer() }));
  const images = useMemo(
    () =>
      new ImageCache({
        url: (sha) => `/api/share/${encodeURIComponent(token)}/media/${sha}`,
      }),
    [token],
  );
  const [fatal, setFatal] = useState<string | null>(null);
  useEffect(() => {
    if (!fileId) return;
    return connectFile(
      editor,
      fileId,
      setFatal,
      undefined,
      `/ws/share/${encodeURIComponent(token)}`,
    );
  }, [editor, fileId, token]);
  const loaded = useLoaded(editor);
  useDoc(editor);

  const name = shared.data?.file.name ?? "";
  useEffect(() => {
    document.title = name ? `${name} – Drawpane prototype` : "Drawpane prototype";
    return () => {
      document.title = "Drawpane";
    };
  }, [name]);

  if (shared.isError || fatal) {
    return (
      <main className="app-empty-page">
        <Logo size={28} label="Drawpane" />
        <h1 className="app-display">This prototype isn't available.</h1>
        <p className="app-muted">
          {fatal ?? "The link was turned off or reset. Ask whoever sent it for a new one."}
        </p>
      </main>
    );
  }
  if (!loaded) return <div className="app-loading" aria-busy="true" />;
  const target = resolveTarget(editor, search);
  if (!target) {
    return (
      <main className="app-empty-page">
        <Logo size={28} label="Drawpane" />
        <h1 className="app-display">Nothing to play yet.</h1>
        <p className="app-muted">This file doesn't have any screens yet. Check back soon.</p>
      </main>
    );
  }
  return (
    <Player
      key={`${target.pageId}:${target.flow?.id ?? ""}`}
      editor={editor}
      images={images}
      target={target}
      initialScreen={null}
      onFlow={(page, flow) => navigate({ search: { page, flow }, replace: true })}
      leading={
        <span className="present__brand">
          <Logo size={20} label="" />
          <span className="present__file" title={name}>
            {name}
          </span>
          <span className="present__divider" aria-hidden="true" />
        </span>
      }
    />
  );
}
