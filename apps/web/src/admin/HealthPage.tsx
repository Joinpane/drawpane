/**
 * Health and cost: how the instance is doing, for whoever runs it. Who's
 * editing, how fast edits are confirmed, what's stored, what it costs (an
 * estimate, said plainly), whether each service answers, and when the last
 * backup was taken. See docs/decisions/0003-instance-health.md.
 */
import { Button, ButtonLink, Icon, Logo, SegmentedControl } from "@drawpane/ui";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { api } from "../api/client";
import { CopyField } from "../app/CopyField";
import "./admin.css";

type Period = "7" | "30" | "90";

interface Health {
  readonly days: number;
  readonly activeEditors: number;
  readonly edits: number;
  readonly latencyP95Ms: number | null;
  readonly storage: { readonly r2Bytes: number; readonly roomBytes: number };
  readonly cost: {
    readonly estimateUsd: number;
    readonly items: readonly { readonly name: string; readonly usd: number }[];
  };
  readonly files: { readonly total: number; readonly busy: number };
  readonly services: readonly {
    readonly name: string;
    readonly status: "healthy" | "slow" | "down";
    readonly metric: string;
  }[];
  readonly lastBackupAt: number | null;
  readonly retentionDays: number;
  /** The release running; null when it wasn't installed with `npm create drawpane`. */
  readonly version: string | null;
  readonly update: { readonly version: string; readonly notesUrl: string } | null;
}

const UPGRADE = "npm create drawpane@latest upgrade";

const NUMBER = new Intl.NumberFormat();
const USD = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" });
const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

function bytes(n: number): string {
  if (n < 1024 ** 2) return `${Math.max(0, Math.round(n / 1024))} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

/** "14 minutes ago", "3 days ago". */
function ago(at: number, now = Date.now()): string {
  const minutes = Math.round((at - now) / 60_000);
  if (Math.abs(minutes) < 60) return RELATIVE.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 48) return RELATIVE.format(hours, "hour");
  return RELATIVE.format(Math.round(hours / 24), "day");
}

/** "1 file", "3 files". */
function count(n: number, noun: string): string {
  return `${NUMBER.format(n)} ${noun}${n === 1 ? "" : "s"}`;
}

const STATUS_LABEL = { healthy: "Healthy", slow: "Slow", down: "Down" } as const;

export function HealthPage() {
  const [period, setPeriod] = useState<Period>("30");
  const health = useQuery({
    queryKey: ["admin", "health", period],
    queryFn: () => api.get<Health>(`/admin/health?days=${period}`),
    // A health page should look current; it's cheap to ask.
    refetchInterval: 60_000,
  });
  const data = health.data;

  return (
    <div className="admin">
      <header className="admin__bar">
        <Link to="/" className="admin__back">
          <Icon name="arrow-left" size={16} />
          Files
        </Link>
        <Logo size={20} />
      </header>
      <main className="admin__main">
        <div className="admin__head">
          <div>
            <h1 className="admin__title">Health and cost</h1>
            <p className="admin__lede">
              {data?.version ? `Drawpane ${data.version} · ` : ""}How this instance is doing, for
              whoever runs it.
            </p>
          </div>
          <SegmentedControl<Period>
            label="Period"
            value={period}
            onChange={setPeriod}
            options={[
              { value: "7", label: "7 days" },
              { value: "30", label: "30 days" },
              { value: "90", label: "90 days" },
            ]}
          />
        </div>

        {data?.update ? <UpdateNotice running={data.version} update={data.update} /> : null}

        {health.error ? (
          <p className="admin__notice" role="alert">
            <Icon name="warning" size={16} />
            {health.error instanceof Error
              ? health.error.message
              : "The instance's health couldn't be read."}
          </p>
        ) : null}

        <section className="admin__kpis" aria-label="At a glance" aria-busy={!data}>
          <Kpi
            label="Cost this month"
            value={data ? USD.format(data.cost.estimateUsd) : null}
            note="Estimate, base plan included"
          />
          <Kpi
            label="Active editors"
            value={data ? NUMBER.format(data.activeEditors) : null}
            note={data ? `${NUMBER.format(data.edits)} edits in ${data.days} days` : ""}
          />
          <Kpi
            label="Edit confirmed, p95"
            value={data ? (data.latencyP95Ms === null ? "—" : `≤ ${data.latencyP95Ms} ms`) : null}
            note={
              data?.latencyP95Ms === null
                ? "Not enough edits measured yet"
                : "Send to the room's confirmation"
            }
          />
          <Kpi
            label="Storage"
            value={data ? bytes(data.storage.r2Bytes + data.storage.roomBytes) : null}
            note={
              data
                ? `R2 ${bytes(data.storage.r2Bytes)} · rooms ${bytes(data.storage.roomBytes)}`
                : ""
            }
          />
        </section>

        <div className="admin__panels">
          <section className="admin__panel" aria-labelledby="cost-title">
            <div className="admin__panel-head">
              <h2 id="cost-title" className="admin__heading">
                Where this month's {data ? USD.format(data.cost.estimateUsd) : "…"} goes
              </h2>
              <span className="admin__muted">Estimate</span>
            </div>
            {data ? (
              <CostBars items={data.cost.items} />
            ) : (
              <div className="admin__skeleton" style={{ height: 96 }} />
            )}
            <p className="admin__foot">
              The base plan, and storage beyond what it includes. Requests and compute aren't
              counted here: your Cloudflare dashboard has the bill. Idle files sleep and cost
              nothing but storage
              {data
                ? `: ${count(data.files.total, "file")}, ${NUMBER.format(data.files.busy)} being edited now.`
                : "."}
            </p>
          </section>

          <section className="admin__panel" aria-labelledby="services-title">
            <h2 id="services-title" className="admin__heading admin__heading--spaced">
              Services
            </h2>
            <ul className="admin__services">
              {(data?.services ?? []).map((s) => (
                <li key={s.name} className="admin__service">
                  <span className="admin__service-name">{s.name}</span>
                  <span className="admin__service-metric">{s.metric}</span>
                  <span className="admin__status" data-status={s.status}>
                    <span className="admin__dot" aria-hidden="true" />
                    {STATUS_LABEL[s.status]}
                  </span>
                </li>
              ))}
              {data ? null : <li className="admin__skeleton" style={{ height: 96 }} />}
            </ul>
            <p className="admin__backup">
              <Icon name="history" size={16} />
              <span>
                {data?.lastBackupAt
                  ? `Last snapshot to R2: ${ago(data.lastBackupAt)} · ${data.retentionDays}-day restore`
                  : data
                    ? "No snapshots yet: one is saved once editing pauses for 10 minutes, and hourly during long sessions."
                    : "…"}
              </span>
            </p>
          </section>
        </div>
      </main>
    </div>
  );
}

/**
 * A newer release is out. Upgrading runs where the instance was installed
 * (its folder holds drawpane.json), so "Upgrade" shows the command to run there.
 */
function UpdateNotice({
  running,
  update,
}: {
  running: string | null;
  update: NonNullable<Health["update"]>;
}) {
  const [how, setHow] = useState(false);
  return (
    <div className="admin__update" role="status">
      <div className="admin__update-row">
        <span className="admin__update-icon" aria-hidden="true">
          <Icon name="arrow-up" size={16} />
        </span>
        <span className="admin__update-text">
          <b>Drawpane {update.version} is available.</b>
          {running ? ` This instance runs ${running}.` : ""}
        </span>
        <ButtonLink href={update.notesUrl} variant="ghost" size="sm">
          Release notes
        </ButtonLink>
        <Button size="sm" variant="primary" aria-expanded={how} onClick={() => setHow((v) => !v)}>
          Upgrade
        </Button>
      </div>
      {how ? (
        <div className="admin__update-how">
          <p>
            In the instance's folder (the one with <code>drawpane.json</code>), run this. It applies
            new database migrations, then deploys; files, people and settings stay as they are.
          </p>
          <CopyField value={UPGRADE} />
        </div>
      ) : null}
    </div>
  );
}

function Kpi({ label, value, note }: { label: string; value: string | null; note: string }) {
  return (
    <div className="admin__kpi">
      <div className="admin__muted">{label}</div>
      {value === null ? (
        <div className="admin__skeleton admin__kpi-skeleton" />
      ) : (
        <div className="admin__kpi-value">{value}</div>
      )}
      <div className="admin__muted">{note}</div>
    </div>
  );
}

function CostBars({ items }: { items: Health["cost"]["items"] }) {
  const most = Math.max(...items.map((i) => i.usd), 0.01);
  return (
    <ul className="admin__costs">
      {items.map((item, i) => (
        <li key={item.name} className="admin__cost">
          <span>{item.name}</span>
          <span className="admin__bar-track" aria-hidden="true">
            <span
              className="admin__bar-fill"
              data-base={i === 0 || undefined}
              style={{ width: `${Math.max(item.usd > 0 ? 2 : 0, (item.usd / most) * 100)}%` }}
            />
          </span>
          <span className="admin__cost-value">{USD.format(item.usd)}</span>
        </li>
      ))}
    </ul>
  );
}
