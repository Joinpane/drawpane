import "@drawpane/ui/styles.css";
import "./app/app.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ApiError } from "./api/client";
import { UpdateBanner } from "./app/UpdateBanner";
import {
  DEFAULT_RENDERER_POLICY,
  parseRendererPolicy,
  setRendererPolicy,
} from "./editor/renderer-switch";
import { router } from "./router";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: (count, error) =>
        !(error instanceof ApiError && error.status >= 400 && error.status < 500) && count < 2,
      refetchOnWindowFocus: true,
    },
  },
});

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

async function loadRendererPolicy() {
  try {
    // The Worker includes the policy in standalone diagnostics HTML so it can run without API requests.
    const embedded = document.querySelector<HTMLMetaElement>(
      'meta[name="drawpane-renderer-policy"]',
    );
    if (embedded) return parseRendererPolicy(JSON.parse(embedded.content));
    if (window.location.pathname.replace(/\/$/, "") === "/diagnostics/renderer")
      return DEFAULT_RENDERER_POLICY;
    const response = await fetch("/api/renderer-policy", {
      cache: "no-store",
      credentials: "omit",
      signal: AbortSignal.timeout(5_000),
    });
    return response.ok ? parseRendererPolicy(await response.json()) : null;
  } catch {
    return null;
  }
}

void loadRendererPolicy().then((policy) => {
  setRendererPolicy(policy);
  createRoot(root).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} context={{ queryClient }} />
        <UpdateBanner />
      </QueryClientProvider>
    </StrictMode>,
  );
});
