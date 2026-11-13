import { CanvasTextMeasurer, Editor } from "@drawpane/editor";
import { Button, Icon } from "@drawpane/ui";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { api } from "../api/client";
import { connectFile } from "../editor/connection";
import { useEditorStateOutside } from "../editor/hooks";
import { imagesFor } from "../editor/media";
import { Player, resolveTarget, useDoc } from "./Player";
import { ShareDialog } from "./ShareDialog";

export interface PresentSearch {
  page?: string;
  flow?: string;
  screen?: string;
}

/** Present mode: the file's prototype, played inside the app by people on the team. */
export function PresentPage() {
  const { fileId } = useParams({ from: "/f/$fileId/present" });
  return <Present key={fileId} fileId={fileId} />;
}

function Present({ fileId }: { fileId: string }) {
  const search = useSearch({ from: "/f/$fileId/present" });
  const navigate = useNavigate({ from: "/f/$fileId/present" });
  const meta = useQuery({
    queryKey: ["file", fileId],
    queryFn: () => api.file(fileId),
    retry: false,
  });
  const [editor] = useState(() => new Editor({ measurer: new CanvasTextMeasurer() }));
  const [fatal, setFatal] = useState<string | null>(null);
  useEffect(() => connectFile(editor, fileId, setFatal), [editor, fileId]);
  const loaded = useLoaded(editor);
  const [sharing, setSharing] = useState(false);
  useDoc(editor);

  useEffect(() => {
    if (meta.data) document.title = `${meta.data.file.name} · Prototype – Drawpane`;
    return () => {
      document.title = "Drawpane";
    };
  }, [meta.data]);

  if (fatal || meta.isError) {
    return (
      <main className="app-empty-page">
        <h1 className="app-display">Can't play this prototype.</h1>
        <p className="app-muted">{fatal ?? meta.error?.message}</p>
        <Button variant="primary" size="lg" onClick={() => navigate({ to: "/" })}>
          Go to your files
        </Button>
      </main>
    );
  }
  if (!loaded) return <div className="app-loading" aria-busy="true" />;

  const target = resolveTarget(editor, search);
  if (!target) {
    return (
      <main className="app-empty-page">
        <h1 className="app-display">Nothing to play yet.</h1>
        <p className="app-muted">Add a frame to a page, then press play again.</p>
        <Link to="/f/$fileId" params={{ fileId }} className="present__back-link">
          Back to editor
        </Link>
      </main>
    );
  }
  const fileName = meta.data?.file.name ?? "";
  return (
    <>
      <Player
        key={`${target.pageId}:${target.flow?.id ?? ""}`}
        editor={editor}
        images={imagesFor(editor)}
        target={target}
        initialScreen={search.screen ?? null}
        onFlow={(page, flow) => navigate({ search: { page, flow }, replace: true })}
        leading={
          <>
            <Link to="/f/$fileId" params={{ fileId }} className="present__back">
              <Icon name="arrow-left" size={12} />
              Back to editor
            </Link>
            <span className="present__divider" aria-hidden="true" />
          </>
        }
        actions={
          <Button variant="primary" size="md" onClick={() => setSharing(true)}>
            Share prototype
          </Button>
        }
      />
      <ShareDialog
        fileId={fileId}
        fileName={fileName}
        canEdit={meta.data ? meta.data.role !== "viewer" : false}
        flowId={target.flow?.id ?? null}
        open={sharing}
        onClose={() => setSharing(false)}
      />
    </>
  );
}

/** True once the document has arrived the first time (and stays true through reconnects). */
export function useLoaded(editor: Editor): boolean {
  const status = useEditorStateOutside(editor, (s) => s.status);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (status === "live") setLoaded(true);
  }, [status]);
  return loaded;
}
