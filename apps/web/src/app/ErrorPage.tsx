import { Button } from "@drawpane/ui";
import { type ErrorComponentProps, useRouter } from "@tanstack/react-router";

/** Shown when a page fails to load: what happened, and one way forward. */
export function ErrorPage({ error, reset }: ErrorComponentProps) {
  const router = useRouter();
  const message =
    error instanceof Error ? error.message : "Something went wrong loading this page.";
  return (
    <main className="app-empty-page">
      <h1 className="app-display">Couldn't load this.</h1>
      <p className="app-muted">{message}</p>
      <Button
        variant="primary"
        size="lg"
        onClick={() => {
          reset();
          void router.invalidate();
        }}
      >
        Try again
      </Button>
    </main>
  );
}
