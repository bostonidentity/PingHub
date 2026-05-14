import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let configDir = "";

vi.mock("@/lib/fr-config", () => ({
  getConfigDir: () => configDir,
  getEnvFileContent: () => "TENANT_BASE_URL=https://tenant.example\nREALMS=[\"alpha\"]\n",
}));

vi.mock("@/lib/iga-api", () => ({
  getAccessToken: async () => "token",
}));

import {
  aggregateCertStatus,
  extractMetadataCerts,
  listLocalSamlProviders,
  getLocalSamlProvider,
} from "@/lib/federation/saml";

function metadata(certBody: string): string {
  return `<EntityDescriptor><KeyDescriptor><ds:X509Certificate>${certBody}</ds:X509Certificate></KeyDescriptor></EntityDescriptor>`;
}

describe("SAML federation helpers", () => {
  beforeEach(() => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), "saml-local-"));
  });

  afterEach(() => {
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  it("classifies aggregate certificate status by worst cert", () => {
    expect(aggregateCertStatus([{ status: "ok" } as never])).toBe("ok");
    expect(aggregateCertStatus([{ status: "ok" } as never, { status: "warning" } as never])).toBe("warning");
    expect(aggregateCertStatus([{ status: "warning" } as never, { status: "expired" } as never])).toBe("expired");
  });

  it("ignores malformed and missing metadata certs", () => {
    expect(extractMetadataCerts(null)).toEqual([]);
    expect(extractMetadataCerts(metadata("not-a-cert"))).toEqual([]);
    expect(aggregateCertStatus([])).toBe("unknown");
  });

  it("discovers local hosted and remote provider files", async () => {
    const hostedDir = path.join(configDir, "realms", "alpha", "realm-config", "saml", "hosted");
    const remoteDir = path.join(configDir, "realms", "alpha", "realm-config", "saml", "remote");
    fs.mkdirSync(hostedDir, { recursive: true });
    fs.mkdirSync(remoteDir, { recursive: true });
    fs.writeFileSync(path.join(hostedDir, "hosted.json"), JSON.stringify({
      config: { _id: "hosted-id", entityId: "hosted-entity" },
      metadata: metadata("not-a-cert"),
    }));
    fs.writeFileSync(path.join(remoteDir, "remote.json"), JSON.stringify({
      config: { _id: "remote-id", entityId: "remote-entity" },
      metadata: "",
    }));

    const all = await listLocalSamlProviders({ environment: "sandbox", realm: "alpha" });
    expect(all.map((p) => p.entityId).sort()).toEqual(["hosted-entity", "remote-entity"]);
    expect(all.find((p) => p.entityId === "hosted-entity")?.metadataCertStatus).toBe("unknown");

    const filtered = await listLocalSamlProviders({ environment: "sandbox", realm: "alpha", query: "remote" });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].location).toBe("remote");

    const detail = await getLocalSamlProvider({ environment: "sandbox", realm: "alpha", location: "hosted", id: "hosted-id" });
    expect(detail?.localPath).toBe("realms/alpha/realm-config/saml/hosted/hosted.json");
  });
});
