/**
 * When who's signed in changes (sign in, setup, an invite, sign out), nothing
 * cached for the previous person may show. `resetQueries` empties every query
 * in place and refetches what's on screen. Not `clear()`: that throws the
 * query objects away under the components watching them, so anything mounted
 * across the change (the shortcuts sync at the app's root) would never hear
 * about new data again.
 */
import type { QueryClient } from "@tanstack/react-query";

export function forgetCachedData(queryClient: QueryClient): void {
  void queryClient.resetQueries();
}
