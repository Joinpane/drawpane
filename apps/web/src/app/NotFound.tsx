import { Button } from "@drawpane/ui";
import { useNavigate } from "@tanstack/react-router";

export function NotFound() {
  const navigate = useNavigate();
  return (
    <main className="app-empty-page">
      <h1 className="app-display">Nothing here.</h1>
      <p className="app-muted">This page doesn't exist, or you don't have access to it.</p>
      <Button variant="primary" size="lg" onClick={() => navigate({ to: "/" })}>
        Go to your files
      </Button>
    </main>
  );
}
