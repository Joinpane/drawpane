import { useEffect, useState } from "react";
import { somethingUnsaved, useUpdateAvailable, watchForUpdates } from "./updates";

/**
 * Offers a reload once a newer Drawpane is deployed. Reloading waits until an
 * open file's edits are saved, so nothing is lost to it.
 */
export function UpdateBanner() {
  const available = useUpdateAvailable();
  const [waiting, setWaiting] = useState(false);
  useEffect(() => watchForUpdates(), []);
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => {
      if (!somethingUnsaved()) location.reload();
    }, 200);
    return () => clearInterval(timer);
  }, [waiting]);
  if (!available) return null;
  return (
    <div className="update-banner" role="status">
      <span>
        {waiting ? "Saving your edits, then reloading…" : "Drawpane was updated. Reload to use it."}
      </span>
      {waiting ? null : (
        <button
          type="button"
          className="update-banner__action"
          onClick={() => {
            if (!somethingUnsaved()) location.reload();
            else setWaiting(true);
          }}
        >
          Reload
        </button>
      )}
    </div>
  );
}
