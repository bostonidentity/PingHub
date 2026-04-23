import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConnectors, loadProvider } from "@/lib/rcs/cluster-map";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rcs-test-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("loadProvider", () => {
  it("returns null when the provider file does not exist", () => {
    expect(loadProvider(tmp)).toBeNull();
  });

  it("reads and parses the provider JSON, and reports mtime", () => {
    const rcsDir = path.join(tmp, "sync/rcs");
    fs.mkdirSync(rcsDir, { recursive: true });
    const file = path.join(rcsDir, "provisioner.openicf.connectorinfoprovider.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        remoteConnectorClients: [{ name: "a" }],
        remoteConnectorClientsGroups: [{ name: "g", serversList: [{ name: "a" }] }],
      }),
    );
    const result = loadProvider(tmp);
    expect(result).not.toBeNull();
    expect(result!.provider.remoteConnectorClients).toEqual([{ name: "a" }]);
    expect(result!.provider.remoteConnectorClientsGroups[0].name).toBe("g");
    expect(result!.path).toBe(file);
    expect(result!.mtime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("throws when the provider file is malformed JSON", () => {
    const rcsDir = path.join(tmp, "sync/rcs");
    fs.mkdirSync(rcsDir, { recursive: true });
    fs.writeFileSync(path.join(rcsDir, "provisioner.openicf.connectorinfoprovider.json"), "{not json");
    expect(() => loadProvider(tmp)).toThrow(/JSON|parse/i);
  });
});

describe("loadConnectors", () => {
  it("returns [] when the connectors dir does not exist", () => {
    expect(loadConnectors(tmp)).toEqual([]);
  });

  it("reads each *.json file, deriving name from _id", () => {
    const dir = path.join(tmp, "sync/connectors");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "ad-hr.json"),
      JSON.stringify({
        _id: "provisioner.openicf/ad-hr",
        connectorRef: { connectorHostRef: "rcs-cluster-external" },
      }),
    );
    fs.writeFileSync(
      path.join(dir, "no-host.json"),
      JSON.stringify({ _id: "provisioner.openicf/no-host", connectorRef: {} }),
    );
    fs.writeFileSync(path.join(dir, "ignore-me.txt"), "not json");
    const list = loadConnectors(tmp);
    expect(list).toEqual([
      { name: "ad-hr", connectorHostRef: "rcs-cluster-external" },
      { name: "no-host", connectorHostRef: undefined },
    ]);
  });

  it("falls back to filename when _id is missing", () => {
    const dir = path.join(tmp, "sync/connectors");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "weird.json"), JSON.stringify({ connectorRef: { connectorHostRef: "x" } }));
    expect(loadConnectors(tmp)).toEqual([{ name: "weird", connectorHostRef: "x" }]);
  });

  it("reads connectorHostRef from connectorRef (the real AIC shape)", () => {
    const dir = path.join(tmp, "sync/connectors");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "ceddskygov.json"),
      JSON.stringify({
        _id: "provisioner.openicf/ceddskygov",
        connectorRef: {
          bundleName: "org.forgerock.openicf.connectors.ldap-connector",
          connectorHostRef: "rcs-cluster-internal",
          connectorName: "org.identityconnectors.ldap.LdapConnector",
        },
      }),
    );
    expect(loadConnectors(tmp)).toEqual([
      { name: "ceddskygov", connectorHostRef: "rcs-cluster-internal" },
    ]);
  });
});
