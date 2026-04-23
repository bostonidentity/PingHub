import { NextRequest, NextResponse } from "next/server";
import { parseEnvFile } from "@/lib/env-parser";
import { getConfigDir, getEnvFileContent } from "@/lib/fr-config";
import { getAccessToken } from "@/lib/iga-api";
import { aggregateFromMembers } from "@/lib/rcs/aggregate";
import { buildClusters, loadConnectors, loadProvider } from "@/lib/rcs/cluster-map";
import { writeStatus } from "@/lib/rcs/persistence";
import { probeAll, probeConnectorServers } from "@/lib/rcs/probe";
import { acquireRunLock } from "@/lib/rcs/run-lock";
import { filterConnectorsForProbe, readWatchlist } from "@/lib/rcs/watchlist";
import type { ClusterStatus, MemberStatus, ProbeResult, RcsStatusFile } from "@/lib/rcs/types";

const PROBE_TIMEOUT_MS = 5000;
const PROBE_CONCURRENCY = 6;
const PROVIDER_STALE_DAYS = 7;

export async function POST(req: NextRequest) {
  const { env } = (await req.json()) as { env?: string };
  if (!env) return NextResponse.json({ error: "env required" }, { status: 400 });

  const release = acquireRunLock(env);
  if (!release) return NextResponse.json({ error: "already-running" }, { status: 409 });

  const stream = runCheck(env, release);
  return new Response(stream as unknown as ReadableStream<Uint8Array>, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

function runCheck(env: string, release: () => void): ReadableStream<string> {
  return new ReadableStream<string>({
    async start(controller) {
      const emit = (type: string, data: string) =>
        controller.enqueue(JSON.stringify({ type, data, ts: Date.now() }) + "\n");
      const emitLine = (line: string) => emit("stdout", line);
      const emitError = (line: string) => emit("stderr", line);
      const done = (code: number) => {
        controller.enqueue(JSON.stringify({ type: "exit", code, ts: Date.now() }) + "\n");
        controller.close();
        release();
      };

      const start = Date.now();
      try {
        const configDir = getConfigDir(env);
        if (!configDir) {
          emitError(`No CONFIG_DIR configured for env '${env}'.\n`);
          writeStatus(env, fatal(start, "no-config-dir"));
          return done(1);
        }

        const loaded = loadProvider(configDir);
        if (!loaded) {
          emitError(`Provider file missing at ${configDir}/sync/rcs/. Run a pull first.\n`);
          writeStatus(env, fatal(start, "provider-missing"));
          return done(1);
        }

        const ageDays = (Date.now() - new Date(loaded.mtime).getTime()) / 86_400_000;
        if (ageDays > PROVIDER_STALE_DAYS) {
          emitLine(`⚠ Provider config is ${ageDays.toFixed(1)} days old — consider re-pulling.\n`);
        }

        const connectors = loadConnectors(configDir);
        if (connectors.length === 0) {
          emitLine(`No connectors on disk for env '${env}' — run pull first.\n`);
        }
        const clusters = buildClusters(loaded.provider, connectors);
        emit("stdout", `Found ${clusters.length} cluster(s), ${connectors.length} connector(s).\n`);

        const envContent = getEnvFileContent(env);
        const envVars = parseEnvFile(envContent);
        const tenantUrl = envVars.TENANT_BASE_URL;
        if (!tenantUrl) {
          emitError("TENANT_BASE_URL missing from .env\n");
          writeStatus(env, fatal(start, "tenant-url-missing"));
          return done(1);
        }

        emitLine("Acquiring access token...\n");
        let token: string;
        try {
          token = await getAccessToken(envVars);
        } catch (err) {
          emitError(`Token acquisition failed: ${err instanceof Error ? err.message : String(err)}\n`);
          writeStatus(env, fatal(start, "auth-failed"));
          return done(1);
        }

        // ── Primary signal: RCS instance health (one call for the whole env) ──
        emitLine("Probing RCS instances (testConnectorServers)…\n");
        let rcsStatus: Record<string, MemberStatus>;
        try {
          rcsStatus = await probeConnectorServers({ tenantUrl, token, timeoutMs: PROBE_TIMEOUT_MS });
        } catch (err) {
          emitError(`testConnectorServers failed: ${err instanceof Error ? err.message : String(err)}\n`);
          writeStatus(env, fatal(start, err instanceof Error ? err.message : String(err)));
          return done(1);
        }
        for (const [name, m] of Object.entries(rcsStatus)) {
          emitLine(`  ${m.ok ? "ok " : "err"}  ${name}${m.error ? `  ${m.error}` : ""}\n`);
        }

        // ── Secondary signal: per-IDM-connector _action=test (filtered by watchlist) ──
        const watchlist = readWatchlist(env);
        const perClusterFiltered = new Map<string, string[]>();
        for (const c of clusters) {
          perClusterFiltered.set(c.name, filterConnectorsForProbe(c.connectors, c.name, watchlist));
        }
        const allConnectorNames = Array.from(
          new Set(Array.from(perClusterFiltered.values()).flat()),
        );
        const totalPossible = clusters.reduce((n, c) => n + c.connectors.length, 0);
        const skipped = totalPossible - allConnectorNames.length;
        if (skipped > 0) {
          emitLine(`Watchlist active: probing ${allConnectorNames.length} of ${totalPossible} IDM connectors.\n`);
        }

        emitLine(`Probing ${allConnectorNames.length} IDM connector(s) with concurrency ${PROBE_CONCURRENCY}…\n`);
        const probeResults = await probeAll({
          tenantUrl,
          token,
          timeoutMs: PROBE_TIMEOUT_MS,
          concurrency: PROBE_CONCURRENCY,
          connectors: allConnectorNames,
          onResult: (r) => {
            const tag = r.ok ? "ok" : "err";
            const suffix = r.ok ? `${r.latencyMs}ms` : `${r.error ?? "?"} (${r.latencyMs}ms)`;
            emitLine(`  ${tag}  ${r.name}  ${suffix}\n`);
          },
        });

        const byName = new Map(probeResults.map((r) => [r.name, r]));

        // Resolve the member list for each matrix row and derive cluster overall from member OK.
        const clusterStatuses: ClusterStatus[] = clusters.map((c) => {
          const members = resolveMembers(c.name, c.members, rcsStatus);
          const agg = aggregateFromMembers(members);
          const filtered = perClusterFiltered.get(c.name) ?? c.connectors;
          const probes: ProbeResult[] = filtered
            .map((name) => byName.get(name))
            .filter((p): p is ProbeResult => Boolean(p));
          return {
            name: c.name,
            kind: c.kind,
            overall: agg.overall,
            okCount: agg.okCount,
            totalCount: agg.totalCount,
            members,
            connectors: probes,
          };
        });

        for (const cs of clusterStatuses) {
          emit("cluster-summary", `${cs.name}: ${cs.overall} (${cs.okCount}/${cs.totalCount})`);
        }

        const file: RcsStatusFile = {
          checkedAt: new Date().toISOString(),
          durationMs: Date.now() - start,
          provider: { path: loaded.path, mtime: loaded.mtime },
          clusters: clusterStatuses,
        };
        writeStatus(env, file);
        emitLine("Wrote rcs-status.json\n");
        return done(0);
      } catch (err) {
        emitError(`Unexpected error: ${err instanceof Error ? err.message : String(err)}\n`);
        writeStatus(env, fatal(start, err instanceof Error ? err.message : String(err)));
        return done(1);
      }
    },
  });
}

function fatal(start: number, msg: string): RcsStatusFile {
  return {
    checkedAt: new Date().toISOString(),
    durationMs: Date.now() - start,
    provider: null,
    fatalError: msg,
    clusters: [],
  };
}

/**
 * Build the member list for a matrix row.
 * - Cluster row: every name in the cluster's serversList, each with its
 *   testConnectorServers result (or orphan=true if the instance isn't in
 *   the provider JSON's remoteConnectorClients at all).
 * - Instance row: a single-member list containing the instance itself.
 */
function resolveMembers(
  rowName: string,
  memberNames: string[],
  rcsStatus: Record<string, MemberStatus>,
): MemberStatus[] {
  const names = memberNames.length > 0 ? memberNames : [rowName];
  return names.map((name) => {
    const live = rcsStatus[name];
    if (!live) {
      return { name, ok: false, latencyMs: 0, orphan: true, error: "not reported by testConnectorServers" };
    }
    return live;
  });
}
