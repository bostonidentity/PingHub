"use client";

import { useMemo } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import type { Cluster, ClusterStatus } from "@/lib/rcs/types";
import { StatusDot } from "./StatusDot";

interface Props {
  open: boolean;
  onClose: () => void;
  env: string;
  cluster: Cluster | null;
  status: ClusterStatus | null;
  checkedAt: string | null;
  watched: string[] | null;
  onWatchlistChange: (clusterName: string, include: string[] | null) => void;
}

function targetLabel(kind: Cluster["kind"]): string {
  switch (kind) {
    case "clientGroup": return "RCS Cluster · client mode";
    case "serverGroup": return "RCS Cluster · server mode";
    case "client": return "RCS Instance · client mode";
    case "server": return "RCS Instance · server mode";
  }
}

function isCluster(kind: Cluster["kind"]): boolean {
  return kind === "clientGroup" || kind === "serverGroup";
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function formatAgo(iso?: string | null): string {
  if (!iso) return "never";
  const sec = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

export function RcsStatusDrawer({ open, onClose, env, cluster, status, checkedAt, watched, onWatchlistChange }: Props) {
  const hasWatchlist = watched !== null;
  const selected = useMemo<Set<string>>(
    () => new Set(watched ?? cluster?.connectors ?? []),
    [watched, cluster],
  );
  const allConnectors = cluster?.connectors ?? [];

  function toggle(name: string) {
    if (!cluster) return;
    const next = new Set(selected);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    const include = allConnectors.filter((c) => next.has(c));
    // "all selected" === no filter, drop the entry.
    onWatchlistChange(cluster.name, include.length === allConnectors.length ? null : include);
  }

  function selectAll() {
    if (!cluster) return;
    onWatchlistChange(cluster.name, null);
  }

  function clearAll() {
    if (!cluster) return;
    onWatchlistChange(cluster.name, []);
  }

  return (
    <Dialog.Root open={open} onOpenChange={(v) => !v && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-50" />
        <Dialog.Content className="fixed right-0 top-0 bottom-0 w-full max-w-xl bg-white z-50 shadow-2xl flex flex-col">
          <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
            <div>
              <Dialog.Title className="text-sm font-semibold text-slate-700 font-mono">
                {cluster?.name ?? ""}
              </Dialog.Title>
              <div className="text-xs text-slate-400 mt-0.5">
                {env}
                {cluster && ` · ${targetLabel(cluster.kind)}`}
                {cluster && isCluster(cluster.kind) && ` · ${cluster.members.length} member instance${cluster.members.length === 1 ? "" : "s"}`}
              </div>
            </div>
            <Dialog.Close asChild>
              <button
                type="button"
                className="text-slate-400 hover:text-slate-600 text-sm px-2 py-1 rounded"
              >
                Close
              </button>
            </Dialog.Close>
          </div>

          <div className="flex-1 overflow-auto px-5 py-4 space-y-5">
            {!status && (
              <div className="text-sm text-slate-500">
                Never checked. Click <span className="font-medium">Refresh</span> in the matrix to probe this environment.
              </div>
            )}

            {status && (
              <div className="flex items-center gap-2">
                <StatusDot overall={status.overall} />
                <div className="text-sm font-medium text-slate-700 capitalize">{status.overall}</div>
                <div className="text-sm text-slate-500">
                  {isCluster(cluster?.kind ?? "client")
                    ? `${status.okCount}/${status.totalCount} RCS instance${status.totalCount === 1 ? "" : "s"} up`
                    : status.okCount > 0
                    ? "RCS instance reachable"
                    : "RCS instance not reachable"}
                </div>
                <div className="text-xs text-slate-400 ml-auto">probed {formatAgo(checkedAt)}</div>
              </div>
            )}

            {cluster && isCluster(cluster.kind) && cluster.members.length > 0 && (
              <section>
                <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-2">
                  Member RCS instances
                </div>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
                      <th className="py-1.5 font-medium w-6"></th>
                      <th className="py-1.5 font-medium">Instance</th>
                      <th className="py-1.5 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cluster.members.map((memberName) => {
                      const m = status?.members.find((x) => x.name === memberName);
                      return (
                        <tr key={memberName} className="border-b border-slate-100 last:border-0">
                          <td className="py-2">
                            <StatusDot
                              overall={!m ? "empty" : m.orphan ? "empty" : m.ok ? "ok" : "down"}
                            />
                          </td>
                          <td className="py-2 font-mono text-[12px] text-slate-800">{memberName}</td>
                          <td className="py-2 text-xs">
                            {!m && <span className="text-slate-400">not probed</span>}
                            {m && m.orphan && (
                              <span className="text-amber-700">orphan — not in remoteConnectorClients</span>
                            )}
                            {m && !m.orphan && m.ok && <span className="text-emerald-600 font-medium">Connected</span>}
                            {m && !m.orphan && !m.ok && (
                              <span className="text-rose-600 font-medium" title={m.error}>
                                {m.error ? truncate(m.error, 80) : "Not connected"}
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </section>
            )}

            {cluster && !isCluster(cluster.kind) && status && status.members[0] && (
              <section>
                <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-2">
                  RCS instance status
                </div>
                <div className="text-sm">
                  {status.members[0].ok && <span className="text-emerald-600 font-medium">Connected</span>}
                  {!status.members[0].ok && (
                    <span className="text-rose-600 font-medium">
                      {status.members[0].error ?? "Not connected"}
                    </span>
                  )}
                </div>
              </section>
            )}

            <section>
              <div className="flex items-center justify-between mb-1">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  IDM Connector integration probes
                  {cluster && cluster.connectors.length > 0 && (
                    <span className="text-slate-400 normal-case font-normal ml-2">
                      {hasWatchlist
                        ? `watchlist: ${selected.size} / ${allConnectors.length}`
                        : `all ${allConnectors.length} probed`}
                    </span>
                  )}
                </div>
                {cluster && cluster.connectors.length > 0 && (
                  <div className="flex items-center gap-2 text-xs">
                    <button
                      type="button"
                      onClick={selectAll}
                      className="text-slate-500 hover:text-slate-800"
                    >
                      Select all
                    </button>
                    <span className="text-slate-300">·</span>
                    <button
                      type="button"
                      onClick={clearAll}
                      className="text-slate-500 hover:text-slate-800"
                    >
                      Clear
                    </button>
                  </div>
                )}
              </div>
              <div className="text-[11px] text-slate-400 mb-2">
                Secondary signal — tests whether each IDM Connector&apos;s config can reach its external system through the RCS. Cluster / instance status above comes from{" "}
                <code className="font-mono">testConnectorServers</code>.
              </div>
              {(!cluster || cluster.connectors.length === 0) && (
                <div className="text-sm text-slate-400">No IDM Connectors route through this target.</div>
              )}
              {cluster && cluster.connectors.length > 0 && (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
                      <th className="py-1.5 font-medium w-6"></th>
                      <th className="py-1.5 font-medium">IDM Connector</th>
                      <th className="py-1.5 font-medium">Status</th>
                      <th className="py-1.5 font-medium text-right">Latency</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cluster.connectors.map((name) => {
                      const r = status?.connectors.find((c) => c.name === name);
                      const isWatched = selected.has(name);
                      return (
                        <tr key={name} className={`border-b border-slate-100 last:border-0 ${isWatched ? "" : "text-slate-400"}`}>
                          <td className="py-2">
                            <input
                              type="checkbox"
                              checked={isWatched}
                              onChange={() => toggle(name)}
                              className="rounded"
                              aria-label={`Probe ${name}`}
                            />
                          </td>
                          <td className="py-2 font-mono text-[12px]">{name}</td>
                          <td className="py-2">
                            {!isWatched && <span className="text-slate-400 text-xs italic">skipped</span>}
                            {isWatched && !r && <span className="text-slate-400 text-xs">not probed</span>}
                            {isWatched && r && r.ok && <span className="text-emerald-600 text-xs font-medium">OK</span>}
                            {isWatched && r && !r.ok && (
                              <span className="text-rose-600 text-xs font-medium">
                                {r.error ?? `HTTP ${r.httpStatus ?? "?"}`}
                              </span>
                            )}
                          </td>
                          <td className="py-2 text-right text-xs">
                            {isWatched && r ? `${r.latencyMs}ms` : "—"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </section>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
