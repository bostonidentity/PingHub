"use client";

import { useMemo, useState } from "react";
import type { Environment } from "@/lib/fr-config-types";
import type { HistoryRecord } from "@/lib/op-history";
import { ActivityRow } from "@/components/ActivityRow";

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatDuration(ms: number): string {
  if (!ms) return "—";
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** Group records into day buckets based on completedAt. */
function groupByDay(records: HistoryRecord[]): { label: string; records: HistoryRecord[] }[] {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  const buckets = new Map<string, HistoryRecord[]>();
  for (const r of records) {
    const d = new Date(r.completedAt);
    d.setHours(0, 0, 0, 0);
    let label: string;
    if (d.getTime() === today.getTime()) {
      label = "Today";
    } else if (d.getTime() === yesterday.getTime()) {
      label = "Yesterday";
    } else {
      label = new Date(r.completedAt).toLocaleDateString(undefined, {
        month: "long",
        day: "numeric",
        year: d.getFullYear() !== today.getFullYear() ? "numeric" : undefined,
      });
    }
    if (!buckets.has(label)) buckets.set(label, []);
    buckets.get(label)!.push(r);
  }
  return Array.from(buckets.entries()).map(([label, recs]) => ({ label, records: recs }));
}

// ── Types ────────────────────────────────────────────────────────────────────

type TypeFilter = "all" | "pull" | "push" | "compare" | "dry-run" | "promote" | "log-search" | "analyze";
type StatusFilter = "all" | "success" | "failed";

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100];

// ── Drawer ───────────────────────────────────────────────────────────────────

function RecordDrawer({
  record,
  onClose,
}: {
  record: HistoryRecord;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed left-0 right-0 bottom-0 top-14 z-40 bg-slate-900/40"
      onClick={onClose}
    >
      <aside
        className="fixed right-0 top-14 bottom-0 w-[min(560px,100vw)] bg-white shadow-2xl overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between p-6 border-b border-slate-200">
          <div>
            <div className="label-xs mb-1">RECORD DETAIL</div>
            <h2 className="text-lg font-semibold text-slate-900 capitalize">
              {record.type} · {record.environment || "—"}
            </h2>
            <p className="text-sm text-slate-500 mt-0.5">{record.summary}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="ml-4 p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Metadata */}
        <div className="p-6 space-y-4">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-slate-400 text-xs pt-0.5">Kind</dt>
            <dd className="font-mono text-xs text-slate-700">{record.kind === "commit" ? "git commit" : "op log"}</dd>

            <dt className="text-slate-400 text-xs pt-0.5">Status</dt>
            <dd>
              <span
                className={
                  record.status === "success"
                    ? "inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-100 text-emerald-700"
                    : "inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-rose-100 text-rose-700"
                }
              >
                {record.status}
              </span>
            </dd>

            <dt className="text-slate-400 text-xs pt-0.5">Started</dt>
            <dd className="font-mono text-xs text-slate-700">{formatTimestamp(record.startedAt)}</dd>

            {record.completedAt && record.completedAt !== record.startedAt && (
              <>
                <dt className="text-slate-400 text-xs pt-0.5">Completed</dt>
                <dd className="font-mono text-xs text-slate-700">{formatTimestamp(record.completedAt)}</dd>
              </>
            )}

            <dt className="text-slate-400 text-xs pt-0.5">Duration</dt>
            <dd className="font-mono text-xs text-slate-700">{formatDuration(record.duration)}</dd>

            {record.scopes.length > 0 && (
              <>
                <dt className="text-slate-400 text-xs pt-0.5">Scopes</dt>
                <dd className="text-xs text-slate-700">{record.scopes.join(", ")}</dd>
              </>
            )}

            {record.author && (
              <>
                <dt className="text-slate-400 text-xs pt-0.5">Author</dt>
                <dd className="font-mono text-xs text-slate-700">{record.author}</dd>
              </>
            )}

            {record.commitHash && (
              <>
                <dt className="text-slate-400 text-xs pt-0.5">Commit</dt>
                <dd className="font-mono text-xs text-slate-700">{record.commitHash}</dd>
              </>
            )}

            {record.source && (
              <>
                <dt className="text-slate-400 text-xs pt-0.5">Source</dt>
                <dd className="font-mono text-xs text-slate-700">
                  {typeof record.source === "string"
                    ? record.source
                    : `${record.source.environment} (${record.source.mode})`}
                </dd>
              </>
            )}

            {record.target && (
              <>
                <dt className="text-slate-400 text-xs pt-0.5">Target</dt>
                <dd className="font-mono text-xs text-slate-700">
                  {typeof record.target === "string"
                    ? record.target
                    : `${record.target.environment} (${record.target.mode})`}
                </dd>
              </>
            )}

            {record.taskName && (
              <>
                <dt className="text-slate-400 text-xs pt-0.5">Task</dt>
                <dd className="text-xs text-slate-700">{record.taskName}</dd>
              </>
            )}

            {record.logSource && (
              <>
                <dt className="text-slate-400 text-xs pt-0.5">Log Source</dt>
                <dd className="font-mono text-xs text-slate-700">{record.logSource}</dd>
              </>
            )}

            {record.logEntryCount != null && (
              <>
                <dt className="text-slate-400 text-xs pt-0.5">Log Entries</dt>
                <dd className="font-mono text-xs text-slate-700">{record.logEntryCount.toLocaleString()}</dd>
              </>
            )}
          </dl>

          {record.phaseOutcomes && Object.keys(record.phaseOutcomes).length > 0 && (
            <div>
              <div className="label-xs mb-2">PHASE OUTCOMES</div>
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(record.phaseOutcomes).map(([phase, outcome]) => (
                  <span
                    key={phase}
                    className="px-2 py-0.5 rounded border border-slate-200 bg-white text-[11px] font-medium text-slate-700"
                  >
                    {phase}: {outcome}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* If there are logs (future field) show a dark code block */}
          {"logs" in record && record.logs ? (
            <div>
              <div className="label-xs mb-2">LOGS</div>
              <pre className="text-[11px] bg-slate-900 text-slate-100 p-4 rounded-lg overflow-x-auto whitespace-pre-wrap break-all">
                {String((record as { logs: unknown }).logs)}
              </pre>
            </div>
          ) : (
            <div>
              <div className="label-xs mb-2">LOGS</div>
              <p className="text-xs text-slate-400 italic">No logs stored for this record.</p>
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}

// ── Main component ───────────────────────────────────────────────────────────

export function HistoryView({
  environments,
  history,
}: {
  environments: Environment[];
  history: HistoryRecord[];
}) {
  const [envFilter, setEnvFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(25);
  const [openRecord, setOpenRecord] = useState<HistoryRecord | null>(null);

  const filtered = useMemo(() => {
    return history.filter((r) => {
      if (envFilter) {
        const match =
          r.environment === envFilter ||
          (typeof r.source !== "string" && r.source?.environment === envFilter) ||
          (typeof r.target !== "string" && r.target?.environment === envFilter);
        if (!match) return false;
      }
      if (typeFilter !== "all" && r.type !== typeFilter) return false;
      if (statusFilter !== "all" && r.status !== statusFilter) return false;
      if (search) {
        const q = search.toLowerCase();
        const searchable = [
          r.summary,
          r.environment,
          r.type,
          r.author,
          r.commitHash,
          r.taskName,
          ...r.scopes,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!searchable.includes(q)) return false;
      }
      return true;
    });
  }, [history, envFilter, typeFilter, statusFilter, search]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, totalPages - 1);
  const pageStart = safePage * pageSize;
  const pageRows = filtered.slice(pageStart, pageStart + pageSize);
  const groups = groupByDay(pageRows);

  return (
    <div className="space-y-6">
      {/* Filter bar */}
      <div className="card-padded">
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={typeFilter}
            onChange={(e) => {
              setTypeFilter(e.target.value as TypeFilter);
              setPage(0);
            }}
            className="px-3 py-2 rounded-lg border border-slate-200 text-[13px] bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
          >
            <option value="all">All types</option>
            <option value="pull">Pull</option>
            <option value="push">Push</option>
            <option value="compare">Compare</option>
            <option value="dry-run">Dry Run</option>
            <option value="promote">Promote</option>
            <option value="log-search">Log Search</option>
            <option value="analyze">Analyze</option>
          </select>

          <select
            value={envFilter}
            onChange={(e) => {
              setEnvFilter(e.target.value);
              setPage(0);
            }}
            className="px-3 py-2 rounded-lg border border-slate-200 text-[13px] bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
          >
            <option value="">All environments</option>
            {environments.map((env) => (
              <option key={env.name} value={env.name}>
                {env.label}
              </option>
            ))}
          </select>

          <select
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value as StatusFilter);
              setPage(0);
            }}
            className="px-3 py-2 rounded-lg border border-slate-200 text-[13px] bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
          >
            <option value="all">All statuses</option>
            <option value="success">Success</option>
            <option value="failed">Failed</option>
          </select>

          <input
            type="search"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(0);
            }}
            placeholder="Search summary, env, author…"
            className="flex-1 min-w-[200px] px-3 py-2 rounded-lg border border-slate-200 text-[13px] bg-white placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />

          {(envFilter || typeFilter !== "all" || statusFilter !== "all" || search) && (
            <button
              type="button"
              onClick={() => {
                setEnvFilter("");
                setTypeFilter("all");
                setStatusFilter("all");
                setSearch("");
                setPage(0);
              }}
              className="px-3 py-2 rounded-lg border border-slate-200 text-[13px] text-slate-500 hover:bg-slate-50 transition-colors"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {/* Grouped list */}
      {filtered.length === 0 ? (
        <div className="card-padded text-center text-sm text-slate-400 py-10">
          No history entries match the current filters.
        </div>
      ) : (
        <div className="space-y-4">
          {groups.map((group) => (
            <section key={group.label}>
              <h2 className="label-xs mb-2 px-1">{group.label}</h2>
              <div className="card divide-y divide-slate-100">
                {group.records.map((r) => (
                  <ActivityRow
                    key={r.id}
                    record={r}
                    onClick={() => setOpenRecord(r)}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {/* Pagination */}
      {filtered.length > 0 && (
        <div className="flex items-center justify-between px-4 py-2.5 card text-xs text-slate-500 flex-wrap gap-2">
          <span>
            {`${pageStart + 1}–${Math.min(pageStart + pageSize, filtered.length)} of ${filtered.length}`}
          </span>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1.5">
              Rows per page
              <select
                value={pageSize}
                onChange={(e) => {
                  setPageSize(Number(e.target.value));
                  setPage(0);
                }}
                className="rounded border border-slate-300 px-1.5 py-0.5 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500"
              >
                {PAGE_SIZE_OPTIONS.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </label>

            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setPage(0)}
                disabled={safePage === 0}
                className="p-1 rounded hover:bg-slate-200 disabled:opacity-30 transition-colors"
                title="First page"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M11 19l-7-7 7-7M18 19l-7-7 7-7" />
                </svg>
              </button>
              <button
                type="button"
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={safePage === 0}
                className="p-1 rounded hover:bg-slate-200 disabled:opacity-30 transition-colors"
                title="Previous page"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                </svg>
              </button>
              <span className="px-2 tabular-nums">
                {safePage + 1} / {totalPages}
              </span>
              <button
                type="button"
                onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                disabled={safePage >= totalPages - 1}
                className="p-1 rounded hover:bg-slate-200 disabled:opacity-30 transition-colors"
                title="Next page"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                </svg>
              </button>
              <button
                type="button"
                onClick={() => setPage(totalPages - 1)}
                disabled={safePage >= totalPages - 1}
                className="p-1 rounded hover:bg-slate-200 disabled:opacity-30 transition-colors"
                title="Last page"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13 5l7 7-7 7M6 5l7 7-7 7" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Right-side drawer */}
      {openRecord && (
        <RecordDrawer record={openRecord} onClose={() => setOpenRecord(null)} />
      )}
    </div>
  );
}
