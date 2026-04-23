import fs from "node:fs";
import path from "node:path";
import type { Cluster, ConnectorRef, Provider } from "./types";

const PROVIDER_REL = "sync/rcs/provisioner.openicf.connectorinfoprovider.json";
const CONNECTORS_REL = "sync/connectors";

export interface LoadedProvider {
  provider: Provider;
  path: string;
  mtime: string;
}

export function loadProvider(configDir: string): LoadedProvider | null {
  const file = path.join(configDir, PROVIDER_REL);
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, "utf8");
  const parsed = JSON.parse(text);
  const stat = fs.statSync(file);
  return { provider: parseProvider(parsed), path: file, mtime: stat.mtime.toISOString() };
}

export function loadConnectors(configDir: string): ConnectorRef[] {
  const dir = path.join(configDir, CONNECTORS_REL);
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  return files.map((file) => {
    const obj = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
    const id = typeof obj._id === "string" ? obj._id : "";
    const derivedFromId = id.startsWith("provisioner.openicf/") ? id.slice("provisioner.openicf/".length) : "";
    const name = derivedFromId || path.basename(file, ".json");
    const connectorHostRef = obj?.connectorRef?.connectorHostRef;
    return { name, connectorHostRef };
  });
}

export function parseProvider(obj: unknown): Provider {
  const src = (obj ?? {}) as Record<string, unknown>;
  const arr = (k: string) => (Array.isArray(src[k]) ? (src[k] as unknown[]) : []);
  return {
    remoteConnectorClients: arr("remoteConnectorClients") as Provider["remoteConnectorClients"],
    remoteConnectorClientsGroups: arr("remoteConnectorClientsGroups") as Provider["remoteConnectorClientsGroups"],
    remoteConnectorServers: arr("remoteConnectorServers") as Provider["remoteConnectorServers"],
    remoteConnectorServersGroups: arr("remoteConnectorServersGroups") as Provider["remoteConnectorServersGroups"],
  };
}

interface ClusterDraft {
  name: string;
  kind: Cluster["kind"];
  members: string[];
  connectors: string[];
}

export function buildClusters(provider: Provider, connectors: ConnectorRef[]): Cluster[] {
  const order: string[] = [];
  const byName = new Map<string, ClusterDraft>();

  const upsert = (name: string, kind: Cluster["kind"], members: string[]): ClusterDraft => {
    const existing = byName.get(name);
    if (existing) {
      if (members.length > 0 && existing.members.length === 0) existing.members = members;
      return existing;
    }
    const draft: ClusterDraft = { name, kind, members, connectors: [] };
    byName.set(name, draft);
    order.push(name);
    return draft;
  };

  const clientMembers = new Set(
    provider.remoteConnectorClientsGroups.flatMap((g) => (g.serversList ?? []).map((s) => s.name)),
  );
  const serverMembers = new Set(
    provider.remoteConnectorServersGroups.flatMap((g) => (g.serversList ?? []).map((s) => s.name)),
  );

  for (const c of provider.remoteConnectorClients) {
    if (!clientMembers.has(c.name)) upsert(c.name, "client", [c.name]);
  }
  for (const g of provider.remoteConnectorClientsGroups) {
    upsert(g.name, "clientGroup", (g.serversList ?? []).map((s) => s.name));
  }
  for (const s of provider.remoteConnectorServers) {
    if (!serverMembers.has(s.name)) upsert(s.name, "server", [s.name]);
  }
  for (const g of provider.remoteConnectorServersGroups) {
    upsert(g.name, "serverGroup", (g.serversList ?? []).map((x) => x.name));
  }

  const clientNames = new Set(provider.remoteConnectorClients.map((c) => c.name));
  const serverNames = new Set(provider.remoteConnectorServers.map((s) => s.name));

  for (const conn of connectors) {
    const ref = conn.connectorHostRef;
    if (!ref) continue;
    let draft = byName.get(ref);
    if (!draft) {
      let kind: Cluster["kind"] = "clientGroup";
      let members: string[] = [];
      if (clientNames.has(ref)) {
        kind = "client";
        members = [ref];
      } else if (serverNames.has(ref)) {
        kind = "server";
        members = [ref];
      }
      draft = upsert(ref, kind, members);
    }
    draft.connectors.push(conn.name);
  }

  return order.map((name) => byName.get(name)!);
}
