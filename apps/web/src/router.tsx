import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { api } from "./api/client";
import { ErrorPage } from "./app/ErrorPage";
import { NotFound } from "./app/NotFound";
import { AccountPage } from "./auth/AccountPage";
import { InvitePage } from "./auth/InvitePage";
import { SetupPage } from "./auth/SetupPage";
import { SignInPage } from "./auth/SignInPage";
import { DashboardPage } from "./dashboard/DashboardPage";
import type { PresentSearch } from "./prototype/PresentPage";
import type { SharedSearch } from "./prototype/SharedPrototypePage";

// The editor is the heaviest screen; load it only when a file opens.
const EditorPage = lazy(() =>
  import("./editor/EditorPage").then((m) => ({ default: m.EditorPage })),
);
const PresentPage = lazy(() =>
  import("./prototype/PresentPage").then((m) => ({ default: m.PresentPage })),
);
const SharedPrototypePage = lazy(() =>
  import("./prototype/SharedPrototypePage").then((m) => ({ default: m.SharedPrototypePage })),
);

interface RouterContext {
  queryClient: QueryClient;
}

const sessionQuery = { queryKey: ["session"], queryFn: api.session };

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: () => <Outlet />,
  notFoundComponent: NotFound,
});

/** Sends signed-out visitors to sign-in (or setup on a fresh install). */
async function requireUser({
  context,
  location,
}: {
  context: RouterContext;
  location: { href: string };
}) {
  const session = await context.queryClient.ensureQueryData(sessionQuery);
  if (!session.user) {
    throw redirect({
      to: session.needsSetup ? "/setup" : "/signin",
      search: { next: location.href },
    });
  }
  return session.user;
}

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: async ({ context, location }) => {
    await requireUser({ context, location });
    const { teams } = await context.queryClient.ensureQueryData({
      queryKey: ["teams"],
      queryFn: api.teams,
    });
    const first = teams[0];
    if (first) throw redirect({ to: "/t/$teamId", params: { teamId: first.id } });
  },
  component: NotFound,
});

const signInRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/signin",
  validateSearch: (search: Record<string, unknown>): ProviderSearch & { next?: string } => ({
    ...(typeof search.next === "string" &&
    search.next.startsWith("/") &&
    !search.next.startsWith("//")
      ? { next: search.next }
      : {}),
    ...providerSearch(search),
  }),
  component: SignInPage,
});

const setupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/setup",
  component: SetupPage,
});

const inviteRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/invite/$token",
  validateSearch: providerSearch,
  component: InvitePage,
});

/** A provider sign-in that came back with an error (see auth/providers.tsx). */
interface ProviderSearch {
  error?: string;
  provider?: string;
}
function providerSearch(search: Record<string, unknown>): ProviderSearch {
  return {
    ...(typeof search.error === "string" ? { error: search.error.slice(0, 32) } : {}),
    ...(typeof search.provider === "string" ? { provider: search.provider.slice(0, 32) } : {}),
  };
}

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  beforeLoad: requireUser,
  validateSearch: providerSearch,
  component: AccountPage,
});

const teamRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/t/$teamId",
  beforeLoad: requireUser,
  validateSearch: (
    search: Record<string, unknown>,
  ): { project?: string; view?: "trash" | "fonts" } => ({
    ...(typeof search.project === "string" ? { project: search.project } : {}),
    ...(search.view === "trash" || search.view === "fonts" ? { view: search.view } : {}),
  }),
  component: DashboardPage,
});

const fileRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/f/$fileId",
  beforeLoad: requireUser,
  component: () => (
    <Suspense fallback={<div className="app-loading" aria-busy="true" />}>
      <EditorPage />
    </Suspense>
  ),
});

const presentRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/f/$fileId/present",
  beforeLoad: requireUser,
  validateSearch: (search: Record<string, unknown>): PresentSearch => {
    const id = (v: unknown) =>
      typeof v === "string" && /^[0-9A-Za-z_-]{1,64}$/.test(v) ? v : undefined;
    const page = id(search.page);
    const flow = id(search.flow);
    const screen = id(search.screen);
    return {
      ...(page ? { page } : {}),
      ...(flow ? { flow } : {}),
      ...(screen ? { screen } : {}),
    };
  },
  component: () => (
    <Suspense fallback={<div className="app-loading" aria-busy="true" />}>
      <PresentPage />
    </Suspense>
  ),
});

/** A shared prototype: public, no sign-in. */
const sharedRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/p/$token",
  validateSearch: (search: Record<string, unknown>): SharedSearch => {
    const id = (v: unknown) =>
      typeof v === "string" && /^[0-9A-Za-z_-]{1,64}$/.test(v) ? v : undefined;
    const page = id(search.page);
    const flow = id(search.flow);
    return { ...(page ? { page } : {}), ...(flow ? { flow } : {}) };
  },
  component: () => (
    <Suspense fallback={<div className="app-loading" aria-busy="true" />}>
      <SharedPrototypePage />
    </Suspense>
  ),
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  signInRoute,
  setupRoute,
  inviteRoute,
  settingsRoute,
  teamRoute,
  fileRoute,
  presentRoute,
  sharedRoute,
]);

export const router = createRouter({
  routeTree,
  context: { queryClient: undefined as unknown as QueryClient },
  defaultPreload: "intent",
  defaultErrorComponent: ErrorPage,
  scrollRestoration: true,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

export { sessionQuery };
