import { describe, it, expect } from "vitest";
import { buildClusters, parseProvider } from "@/lib/rcs/cluster-map";
import type { Provider, ConnectorRef } from "@/lib/rcs/types";

const emptyProvider = (): Provider => ({
  remoteConnectorClients: [],
  remoteConnectorClientsGroups: [],
  remoteConnectorServers: [],
  remoteConnectorServersGroups: [],
});

describe("buildClusters", () => {
  it("returns [] when provider is empty and there are no connectors", () => {
    expect(buildClusters(emptyProvider(), [])).toEqual([]);
  });

  it("surfaces a clientGroup from the provider and attaches connectors that route to it", () => {
    const provider = emptyProvider();
    provider.remoteConnectorClients = [
      { name: "rcs-ext-1" },
      { name: "rcs-ext-2" },
    ];
    provider.remoteConnectorClientsGroups = [
      {
        name: "rcs-cluster-external",
        algorithm: "failover",
        serversList: [{ name: "rcs-ext-1" }, { name: "rcs-ext-2" }],
      },
    ];
    const connectors: ConnectorRef[] = [
      { name: "ad-hr", connectorHostRef: "rcs-cluster-external" },
      { name: "oracle-hr", connectorHostRef: "rcs-cluster-external" },
    ];
    const clusters = buildClusters(provider, connectors);
    expect(clusters).toEqual([
      {
        name: "rcs-cluster-external",
        kind: "clientGroup",
        members: ["rcs-ext-1", "rcs-ext-2"],
        connectors: ["ad-hr", "oracle-hr"],
      },
    ]);
  });

  it("supports a connector that references a direct client instance (not a group)", () => {
    const provider = emptyProvider();
    provider.remoteConnectorClients = [{ name: "rcs-ext-1" }];
    const connectors: ConnectorRef[] = [{ name: "ldap-partner", connectorHostRef: "rcs-ext-1" }];
    expect(buildClusters(provider, connectors)).toEqual([
      {
        name: "rcs-ext-1",
        kind: "client",
        members: ["rcs-ext-1"],
        connectors: ["ldap-partner"],
      },
    ]);
  });

  it("skips connectors with no connectorHostRef", () => {
    const provider = emptyProvider();
    provider.remoteConnectorClientsGroups = [{ name: "rcs-cluster-external", serversList: [] }];
    const connectors: ConnectorRef[] = [
      { name: "local-only" },
      { name: "ad-hr", connectorHostRef: "rcs-cluster-external" },
    ];
    const result = buildClusters(provider, connectors);
    expect(result).toHaveLength(1);
    expect(result[0].connectors).toEqual(["ad-hr"]);
  });

  it("tags a direct-instance ref as kind=client when the name is a known provider client, even if it's also a group member", () => {
    const provider = emptyProvider();
    provider.remoteConnectorClients = [{ name: "rcs-int-1" }, { name: "rcs-int-2" }];
    provider.remoteConnectorClientsGroups = [
      {
        name: "rcs-cluster-internal",
        serversList: [{ name: "rcs-int-1" }, { name: "rcs-int-2" }],
      },
    ];
    const connectors: ConnectorRef[] = [
      { name: "via-group", connectorHostRef: "rcs-cluster-internal" },
      { name: "direct-pin", connectorHostRef: "rcs-int-1" },
    ];
    const result = buildClusters(provider, connectors);
    const direct = result.find((c) => c.name === "rcs-int-1");
    expect(direct?.kind).toBe("client");
    expect(direct?.connectors).toEqual(["direct-pin"]);
  });

  it("surfaces clusters referenced by connectors even when not in the provider config", () => {
    const provider = emptyProvider();
    const connectors: ConnectorRef[] = [
      { name: "orphan", connectorHostRef: "rcs-cluster-doesnotexist" },
    ];
    expect(buildClusters(provider, connectors)).toEqual([
      {
        name: "rcs-cluster-doesnotexist",
        kind: "clientGroup",
        members: [],
        connectors: ["orphan"],
      },
    ]);
  });

  it("handles reverse-mode remoteConnectorServers (absorbs group members)", () => {
    const provider = emptyProvider();
    provider.remoteConnectorServers = [{ name: "server-1" }, { name: "server-standalone" }];
    provider.remoteConnectorServersGroups = [
      { name: "server-group-1", serversList: [{ name: "server-1" }] },
    ];
    expect(buildClusters(provider, [])).toEqual([
      {
        name: "server-standalone",
        kind: "server",
        members: ["server-standalone"],
        connectors: [],
      },
      { name: "server-group-1", kind: "serverGroup", members: ["server-1"], connectors: [] },
    ]);
  });
});

describe("parseProvider", () => {
  it("normalizes a minimal provider JSON so all four arrays exist", () => {
    const parsed = parseProvider({ _id: "x" });
    expect(parsed).toEqual(emptyProvider());
  });
});
