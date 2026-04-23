"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Cluster, ClusterStatus, Overall, RcsStatusFile } from "@/lib/rcs/types";
import { buildMatrixRows, type MatrixRow } from "@/lib/rcs/grouping";
import { StatusDot } from "./StatusDot";
import { RcsStatusDrawer } from "./RcsStatusDrawer";

interface EnvStatus {
  env: string;
  label: string;
  color: string;
  clusters: Cluster[];
  status: RcsStatusFile | null;
  providerMissing: boolean;
  watchlist: Record<string, string[]>;
}

interface ApiResponse {
  envs: EnvStatus[];
}

interface DrawerState {
  env: string;
  clusterName: string;
}

function prettyKind(kind: Cluster["kind"]): string {
  switch (kind) {
    case "clientGroup": return "cluster · client mode";
    case "serverGroup": return "cluster · server mode";
    case "client": return "instance · client mode";
    case "server": return "instance · server mode";
  }
}

function formatAgo(iso?: string): string {
  if (!iso) return "";
  const sec = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

export function RcsStatusMatrix() {
  const [data, setData] = useState<EnvStatus[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState<Set<string>>(new Set());
  const [log, setLog] = useState<string>("");
  const [drawer, setDrawer] = useState<DrawerState | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/rcs-status", { cache: "no-store" });
      if (!res.ok) throw new Error(`GET /api/rcs-status HTTP ${res.status}`);
      const json = (await res.json()) as ApiResponse;
      setData(json.envs);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  const runCheck = useCallback(
    async (env: string | null) => {
      const url = env ? "/api/rcs-status/check" : "/api/rcs-status/check-all";
      const body = env ? JSON.stringify({ env }) : undefined;
      const startingEnvs = env ? [env] : (data?.map((e) => e.env) ?? []);
      setRunning((prev) => {
        const next = new Set(prev);
        for (const e of startingEnvs) next.add(e);
        return next;
      });
      setLog((prev) => prev + `\n--- ${new Date().toLocaleTimeString()} ${env ? `check ${env}` : "check-all"} ---\n`);
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        });
        if (res.status === 409) {
          setLog((prev) => prev + `409: already-running\n`);
          return;
        }
        if (!res.ok || !res.body) {
          setLog((prev) => prev + `HTTP ${res.status}\n`);
          return;
        }
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buf = "";
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += value;
          let idx: number;
          while ((idx = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, idx);
            buf = buf.slice(idx + 1);
            if (!line) continue;
            try {
              const evt = JSON.parse(line) as { type: string; data?: string; env?: string };
              if (evt.type === "heartbeat") continue;
              const prefix = evt.env ? `[${evt.env}] ` : "";
              if (typeof evt.data === "string") {
                setLog((prev) => prev + prefix + evt.data);
              } else if (evt.type === "exit") {
                setLog((prev) => prev + `${prefix}exit\n`);
              }
            } catch {
              // ignore
            }
          }
        }
      } finally {
        setRunning((prev) => {
          const next = new Set(prev);
          for (const e of startingEnvs) next.delete(e);
          return next;
        });
        await refresh();
      }
    },
    [data, refresh],
  );

  const [groupByType, setGroupByType] = useState(true);
  const [hideUnused, setHideUnused] = useState(true);

  const rows = useMemo<MatrixRow[]>(() => {
    if (!data) return [];
    return buildMatrixRows(
      data.map((e) => ({ env: e.env, clusters: e.clusters })),
      { groupByType, hideUnused },
    );
  }, [data, groupByType, hideUnused]);

  const cellStatus = useCallback(
    (env: EnvStatus, clusterName: string): ClusterStatus | null => {
      return env.status?.clusters.find((c) => c.name === clusterName) ?? null;
    },
    [],
  );

  const selected = useMemo(() => {
    if (!drawer || !data) return null;
    const env = data.find((e) => e.env === drawer.env);
    const cluster = env?.clusters.find((c) => c.name === drawer.clusterName) ?? null;
    const status = env?.status?.clusters.find((c) => c.name === drawer.clusterName) ?? null;
    const checkedAt = env?.status?.checkedAt ?? null;
    const watched = env && drawer.clusterName in env.watchlist ? env.watchlist[drawer.clusterName] : null;
    return { cluster, status, checkedAt, watched };
  }, [drawer, data]);

  const saveWatchlist = useCallback(
    async (envName: string, clusterName: string, include: string[] | null) => {
      setData((prev) => {
        if (!prev) return prev;
        return prev.map((e) => {
          if (e.env !== envName) return e;
          const nextWl = { ...e.watchlist };
          if (include === null) delete nextWl[clusterName];
          else nextWl[clusterName] = include;
          return { ...e, watchlist: nextWl };
        });
      });
      try {
        await fetch("/api/rcs-status/watchlist", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ env: envName, cluster: clusterName, include }),
        });
      } catch {
        await refresh();
      }
    },
    [refresh],
  );

  if (error) {
    return <div className="text-rose-600 text-sm">Error: {error}</div>;
  }

  if (!data) {
    return <div className="text-slate-500 text-sm">Loading…</div>;
  }

  const allRunning = running.size > 0 && data.some((e) => running.has(e.env));

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4 flex-wrap">
        <button
          type="button"
          onClick={() => runCheck(null)}
          disabled={allRunning}
          className="text-sm px-3 py-1.5 rounded-md bg-indigo-600 text-white hover:bg-indigo-700 disabled:bg-slate-300"
        >
          {allRunning ? "Checking…" : "Check all"}
        </button>
        <label className="flex items-center gap-1.5 text-xs text-slate-600 select-none">
          <input
            type="checkbox"
            checked={groupByType}
            onChange={(e) => setGroupByType(e.target.checked)}
            className="rounded"
          />
          Group by type
        </label>
        <label className="flex items-center gap-1.5 text-xs text-slate-600 select-none">
          <input
            type="checkbox"
            checked={hideUnused}
            onChange={(e) => setHideUnused(e.target.checked)}
            className="rounded"
          />
          Hide unused
        </label>
        <div className="flex-1" />
        <Legend />
      </div>

      <div className="overflow-x-auto border border-slate-200 rounded-lg bg-white">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50/60">
              <th className="text-left px-3 py-2 font-medium text-slate-600 sticky left-0 bg-slate-50/60">
                RCS Target
              </th>
              <th className="text-left px-3 py-2 font-medium text-slate-600 whitespace-nowrap">
                Type
              </th>
              {data.map((env) => (
                <th key={env.env} className="px-3 py-2 font-medium text-slate-600 text-left min-w-[180px]">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <div className="text-slate-900">{env.label}</div>
                      <div className="text-xs text-slate-400">{env.env}</div>
                    </div>
                    <button
                      type="button"
                      onClick={() => runCheck(env.env)}
                      disabled={running.has(env.env)}
                      className="text-xs px-2 py-1 rounded border border-slate-300 text-slate-600 hover:bg-slate-100 disabled:opacity-50"
                    >
                      {running.has(env.env) ? "…" : "Refresh"}
                    </button>
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={data.length + 2} className="px-3 py-6 text-slate-500 text-center">
                  No RCS clusters found. Run a pull on an environment first.
                </td>
              </tr>
            )}
            {rows.map((row, i) => {
              if (row.kind === "header") {
                return (
                  <tr key={`header-${i}-${row.label}`} className="bg-slate-100/70">
                    <td
                      colSpan={data.length + 2}
                      className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500 sticky left-0 bg-slate-100/70"
                    >
                      {row.label}
                    </td>
                  </tr>
                );
              }
              return (
              <tr key={row.name} className="border-b border-slate-100 last:border-0">
                <td className="px-3 py-2 sticky left-0 bg-white">
                  <div className="font-mono text-slate-800">{row.name}</div>
                  <div className="text-xs text-slate-400">{prettyKind(row.rowKind)}</div>
                </td>
                <td className="px-3 py-2 text-xs text-slate-500 whitespace-nowrap">{row.type}</td>
                {data.map((env) => {
                  const cluster = env.clusters.find((c) => c.name === row.name);
                  const status = cellStatus(env, row.name);
                  if (!cluster) {
                    return (
                      <td key={env.env} className="px-3 py-2 text-slate-300">
                        —
                      </td>
                    );
                  }
                  const watched = env.watchlist[row.name];
                  const hasWatchlist = watched !== undefined;
                  return (
                    <td key={env.env} className="px-3 py-2">
                      <button
                        type="button"
                        onClick={() => setDrawer({ env: env.env, clusterName: row.name })}
                        className="flex items-center gap-2 text-left hover:bg-slate-50 rounded px-2 py-1 -mx-2 -my-1 w-full"
                      >
                        <StatusDot overall={(status?.overall ?? "empty") as Overall} />
                        <div className="min-w-0">
                          <div className="text-slate-800 text-xs">
                            {status ? `${status.okCount}/${status.totalCount} ok` : "Never checked"}
                          </div>
                          <div className="text-[11px] text-slate-400 flex items-center gap-1.5">
                            <span>
                              {status ? formatAgo(env.status?.checkedAt) : cluster.connectors.length === 0 ? "no connectors" : ""}
                            </span>
                            {hasWatchlist && (
                              <span className="inline-block px-1.5 py-0.5 text-[10px] rounded bg-indigo-50 text-indigo-700 border border-indigo-200">
                                {watched.length}/{cluster.connectors.length} watched
                              </span>
                            )}
                          </div>
                        </div>
                      </button>
                    </td>
                  );
                })}
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="text-xs text-slate-600">
        <div className="flex items-center justify-between mb-1">
          <span className="font-medium">Activity</span>
          {log && (
            <button type="button" onClick={() => setLog("")} className="text-slate-400 hover:text-slate-600">
              clear
            </button>
          )}
        </div>
        <div
          ref={logRef}
          className="font-mono text-[11px] bg-slate-900 text-slate-100 rounded-md p-3 h-40 overflow-auto whitespace-pre-wrap"
        >
          {log || <span className="text-slate-500">idle</span>}
        </div>
      </div>

      <RcsStatusDrawer
        open={drawer !== null}
        onClose={() => setDrawer(null)}
        env={drawer?.env ?? ""}
        cluster={selected?.cluster ?? null}
        status={selected?.status ?? null}
        checkedAt={selected?.checkedAt ?? null}
        watched={selected?.watched ?? null}
        onWatchlistChange={(clusterName, include) => {
          if (drawer) saveWatchlist(drawer.env, clusterName, include);
        }}
      />
    </div>
  );
}

function Legend() {
  const items: { overall: Overall; label: string }[] = [
    { overall: "ok", label: "up" },
    { overall: "degraded", label: "degraded" },
    { overall: "down", label: "down" },
    { overall: "empty", label: "n/a" },
  ];
  return (
    <div className="flex items-center gap-3 text-xs text-slate-500">
      {items.map((i) => (
        <span key={i.overall} className="flex items-center gap-1.5">
          <StatusDot overall={i.overall} />
          {i.label}
        </span>
      ))}
    </div>
  );
}
