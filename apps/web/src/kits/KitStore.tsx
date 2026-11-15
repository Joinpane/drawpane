/**
 * The kit store: a team page (`/t/$teamId?view=kits`) listing UI kits,
 * libraries and templates from the instance's registry, with a cover, name,
 * author and kind on each card, a search and a filter by kind. A card opens
 * the kit's details (KitDialog), where "Add to team" makes it a file. Kits
 * the team has added say so.
 */
import { Badge, Button, Icon } from "@drawpane/ui";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { api } from "../api/client";
import { modKey } from "../app/format";
import { KitCover } from "./KitCover";
import { KitDialog } from "./KitDialog";
import {
  KIND_LABEL,
  KIND_SINGULAR,
  KIT_KINDS,
  type Kit,
  type KitIndex,
  type KitKind,
  parseIndex,
  searchKits,
} from "./registry";
import "./kits.css";

type Store = { enabled: false } | { enabled: true; index: KitIndex };

export interface AddedKit {
  readonly kitId: string;
  readonly fileId: string;
  readonly addedAt: number;
}

export const kitStoreQuery = {
  queryKey: ["kits"],
  queryFn: async (): Promise<Store> => {
    const body = await api.get<{ enabled: boolean; registry?: string; index?: unknown }>("/kits");
    return body.enabled
      ? { enabled: true, index: parseIndex(body.index, body.registry) }
      : { enabled: false };
  },
  // The registry refreshes daily; within a session, the list read once is fine.
  staleTime: 10 * 60 * 1000,
};

export const teamKitsQuery = (teamId: string) => ({
  queryKey: ["team-kits", teamId],
  queryFn: () => api.get<{ added: AddedKit[] }>(`/teams/${teamId}/kits`),
});

type Filter = "all" | KitKind;

export function KitStoreView({ teamId, canEdit }: { teamId: string; canEdit: boolean }) {
  const store = useQuery(kitStoreQuery);
  const added = useQuery(teamKitsQuery(teamId));
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [open, setOpen] = useState<Kit | null>(null);
  const search = useRef<HTMLInputElement>(null);

  const kits = store.data?.enabled ? store.data.index.kits : [];
  const addedIds = useMemo(
    () => new Set((added.data?.added ?? []).map((a) => a.kitId)),
    [added.data],
  );
  const counts = useMemo(() => {
    const c = new Map<Filter, number>([["all", kits.length]]);
    for (const k of kits) c.set(k.kind, (c.get(k.kind) ?? 0) + 1);
    return c;
  }, [kits]);
  const shown = useMemo(
    () => searchKits(filter === "all" ? kits : kits.filter((k) => k.kind === filter), query),
    [kits, filter, query],
  );
  const filters: Filter[] = ["all", ...KIT_KINDS.filter((k) => (counts.get(k) ?? 0) > 0)];

  return (
    <div className="kits">
      <header className="dash__header">
        <h1 className="dash__title">Kit store</h1>
        <label className="dash__search">
          <Icon name="search" />
          <input
            ref={search}
            type="search"
            placeholder="Search kits"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search kits"
          />
          <kbd>{modKey("K")}</kbd>
        </label>
      </header>
      <p className="kits__lede">
        UI kits, libraries and templates from Penpot's community hub and Drawpane. Add one and it
        becomes a file your whole team can open, copy from and publish as a library.
      </p>

      {store.isPending ? (
        <ul className="kits__grid" aria-busy="true" aria-label="Loading kits">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <li key={i} className="kits__card kits__card--skeleton" />
          ))}
        </ul>
      ) : store.isError ? (
        <div className="dash__empty" role="alert">
          <p className="app-display-md">Couldn't load the kits.</p>
          <p className="app-muted">{store.error.message}</p>
          <Button onClick={() => void store.refetch()}>Try again</Button>
        </div>
      ) : !store.data.enabled ? (
        <div className="dash__empty">
          <p className="app-display-md">The kit store is off.</p>
          <p className="app-muted">
            Whoever runs this Drawpane turned it off. Import a kit from Figma or Penpot from the
            Import button on your files instead.
          </p>
        </div>
      ) : (
        <>
          <fieldset className="kits__filters">
            <legend className="dp-visually-hidden">Show</legend>
            {filters.map((f) => (
              <button
                key={f}
                type="button"
                className="kits__filter"
                aria-pressed={filter === f}
                onClick={() => setFilter(f)}
              >
                {f === "all" ? "All" : KIND_LABEL[f]}
                <span className="kits__filter-count">{counts.get(f) ?? 0}</span>
              </button>
            ))}
          </fieldset>
          {shown.length === 0 ? (
            <div className="dash__empty">
              <p className="app-display-md">No kits match.</p>
              <p className="app-muted">Try fewer words, or another kind.</p>
            </div>
          ) : (
            <ul className="kits__grid" aria-label="Kits">
              {shown.map((kit) => (
                <KitCard
                  key={kit.id}
                  kit={kit}
                  added={addedIds.has(kit.id)}
                  onOpen={() => setOpen(kit)}
                />
              ))}
            </ul>
          )}
        </>
      )}

      <KitDialog
        kit={open}
        teamId={teamId}
        canEdit={canEdit}
        added={(added.data?.added ?? []).filter((a) => a.kitId === open?.id)}
        onClose={() => setOpen(null)}
      />
    </div>
  );
}

function KitCard({ kit, added, onOpen }: { kit: Kit; added: boolean; onOpen: () => void }) {
  return (
    <li className="kits__card">
      <button
        type="button"
        className="kits__cover-button"
        onClick={onOpen}
        aria-label={`${kit.name}${kit.author ? ` by ${kit.author.name}` : ""}${added ? ", added" : ""}`}
      >
        <KitCover kit={kit} />
      </button>
      <div className="kits__card-meta">
        <span className="kits__card-name">{kit.name}</span>
        {added ? (
          <Badge tone="success" icon="check" className="kits__added">
            Added
          </Badge>
        ) : kit.file && !kit.file.importable ? (
          <span className="kits__only" title="Drawpane can't import this file's format yet">
            Penpot only
          </span>
        ) : null}
      </div>
      <span className="kits__card-sub">
        {KIND_SINGULAR[kit.kind]}
        {kit.author ? ` · ${kit.author.name}` : ""}
      </span>
    </li>
  );
}
