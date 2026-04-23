export type ClusterKind = "client" | "clientGroup" | "server" | "serverGroup";

export type Overall = "ok" | "degraded" | "down" | "empty";

export interface ProviderClient {
  name: string;
  enabled?: boolean;
  useSSL?: boolean;
  clientId?: string;
}

export interface ProviderGroup {
  name: string;
  algorithm?: string;
  serversList?: Array<{ name: string }>;
}

export interface Provider {
  remoteConnectorClients: ProviderClient[];
  remoteConnectorClientsGroups: ProviderGroup[];
  remoteConnectorServers: ProviderClient[];
  remoteConnectorServersGroups: ProviderGroup[];
}

export interface ConnectorRef {
  name: string;
  connectorHostRef?: string;
}

export interface Cluster {
  name: string;
  kind: ClusterKind;
  members: string[];
  connectors: string[];
}

export interface ProbeResult {
  name: string;
  ok: boolean;
  latencyMs: number;
  httpStatus?: number;
  error?: string;
}

export interface ClusterStatus {
  name: string;
  kind: ClusterKind;
  overall: Overall;
  okCount: number;
  totalCount: number;
  connectors: ProbeResult[];
}

export interface RcsStatusFile {
  checkedAt: string;
  durationMs: number;
  provider: { path: string; mtime: string } | null;
  fatalError?: string;
  clusters: ClusterStatus[];
}
