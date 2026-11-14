/**
 * How you hear about your inbox by email: as it happens, a daily digest at
 * an hour you pick (your time zone, from this browser), or not at all.
 * Saved as you choose. When this instance doesn't send email, the choice is
 * kept for when it does.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { api } from "../api/client";

type Choice = "instant" | "daily" | "off";

interface Picked {
  readonly notifications: Choice;
  readonly digestHour: number;
}

interface EmailPrefs {
  readonly notifications: Choice;
  readonly digestHour: number;
  readonly timeZone: string | null;
  readonly available: boolean;
}

const CHOICES: ReadonlyArray<{ value: Choice; title: string; detail: string }> = [
  {
    value: "instant",
    title: "As they happen",
    detail:
      "Mentions, replies and resolved comments you haven't seen in Drawpane, a few minutes after.",
  },
  { value: "daily", title: "Once a day", detail: "One email with what you haven't seen." },
  { value: "off", title: "Never", detail: "Your inbox in Drawpane still has everything." },
];

/** "9:00" in the viewer's own clock style. */
const hourLabel = (hour: number) =>
  new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(
    new Date(2026, 0, 1, hour, 0),
  );

/** "Lisbon time", from an IANA zone. */
const zoneLabel = (zone: string) => `${zone.split("/").at(-1)?.replace(/_/g, " ") ?? zone} time`;

export function EmailPreferences() {
  const queryClient = useQueryClient();
  const prefs = useQuery({
    queryKey: ["account", "email"],
    queryFn: () => api.get<EmailPrefs>("/account/email"),
  });
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  // What was just picked, shown at once: the query's data changes only when
  // the save answers, and a controlled input would flick back until then.
  const [picked, setPicked] = useState<Picked | null>(null);
  const latest = useRef(0);
  const save = useMutation({
    // One at a time, in order: a slow early save can't land after a later one.
    scope: { id: "account-email" },
    mutationFn: (next: Picked) =>
      api.put<EmailPrefs>("/account/email", { ...next, timeZone: zone }),
    onSuccess: (data) => queryClient.setQueryData(["account", "email"], data),
  });
  const data = prefs.data;
  if (!data) return <div className="account__skeleton" />;
  const choose = (next: Picked) => {
    const id = ++latest.current;
    setPicked(next);
    save.mutate(next, {
      // Settled: the data says what was saved (or what's still true, on an error).
      onSettled: () => {
        if (id === latest.current) setPicked(null);
      },
    });
  };
  const current = picked?.notifications ?? data.notifications;
  const hour = picked?.digestHour ?? data.digestHour;
  return (
    <>
      {data.available ? null : (
        <p className="account__hint">
          This instance doesn't send email yet. Your choice is kept for when it does.
        </p>
      )}
      <div className="account__choices" role="radiogroup" aria-labelledby="email-title">
        {CHOICES.map((choice) => (
          <label key={choice.value} className="account__choice">
            <input
              type="radio"
              name="email-notifications"
              value={choice.value}
              checked={current === choice.value}
              onChange={() => choose({ notifications: choice.value, digestHour: hour })}
            />
            <span className="account__choice-text">
              <strong>{choice.title}</strong>
              <span>{choice.detail}</span>
            </span>
            {choice.value === "daily" && current === "daily" ? (
              <span className="account__choice-extra">
                <select
                  aria-label="Digest time"
                  value={hour}
                  onChange={(e) =>
                    choose({ notifications: "daily", digestHour: Number(e.target.value) })
                  }
                >
                  {Array.from({ length: 24 }, (_, h) => (
                    <option key={h} value={h}>
                      {hourLabel(h)}
                    </option>
                  ))}
                </select>
                {/* The zone it's sent in: the one saved (picking a time here saves this browser's). */}
                <span className="account__choice-zone">{zoneLabel(data.timeZone ?? zone)}</span>
              </span>
            ) : null}
          </label>
        ))}
      </div>
      <p className="account__save" role="status">
        {save.isError ? (
          <span className="account__save--error">{save.error.message}</span>
        ) : save.isSuccess ? (
          "Saved."
        ) : (
          ""
        )}
      </p>
    </>
  );
}
