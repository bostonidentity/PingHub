import { NextResponse } from "next/server";
import { getConfigDir, getEnvironments } from "@/lib/fr-config";
import { buildClusters, loadConnectors, loadProvider } from "@/lib/rcs/cluster-map";
import { readStatus } from "@/lib/rcs/persistence";
import { readWatchlist, type Watchlist } from "@/lib/rcs/watchlist";
import type { Cluster, RcsStatusFile } from "@/lib/rcs/types";

interface EnvStatus {
  env: string;
  label: string;
  color: string;
  clusters: Cluster[];
  status: RcsStatusFile | null;
  providerMissing: boolean;
  watchlist: Watchlist;
}

export async function GET() {
  const envs = getEnvironments();
  const payload: EnvStatus[] = envs.map((e) => {
    const configDir = getConfigDir(e.name);
    let providerMissing = true;
    let clusters: Cluster[] = [];
    if (configDir) {
      try {
        const loaded = loadProvider(configDir);
        const connectors = loadConnectors(configDir);
        providerMissing = !loaded;
        clusters = buildClusters(loaded?.provider ?? {
          remoteConnectorClients: [],
          remoteConnectorClientsGroups: [],
          remoteConnectorServers: [],
          remoteConnectorServersGroups: [],
        }, connectors);
      } catch {
        providerMissing = true;
      }
    }
    return {
      env: e.name,
      label: e.label,
      color: e.color,
      clusters,
      status: readStatus(e.name),
      providerMissing,
      watchlist: readWatchlist(e.name),
    };
  });
  return NextResponse.json({ envs: payload });
}
