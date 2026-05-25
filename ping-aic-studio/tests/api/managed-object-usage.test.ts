import { describe, it, expect, vi, beforeEach } from "vitest";
import path from "path";
import fs from "fs";
import os from "os";
import { GET } from "@/app/api/analyze/managed-object-usage/route";

const FIXTURE_ROOT = path.resolve(__dirname, "../fixtures/managed-object-usage/env-root");

// configDirOverride lets individual tests redirect the mock to a tmp directory
// without needing vi.resetModules() / dynamic imports.
let configDirOverride: string | null = null;

vi.mock("@/lib/fr-config", () => ({
  getConfigDir: (env: string) => {
    if (env === "trunc-env" && configDirOverride !== null) return configDirOverride;
    return env === "test-env" ? FIXTURE_ROOT : null;
  },
}));

function makeReq(params: Record<string, string>): Request {
  const url = new URL("http://localhost/api/analyze/managed-object-usage");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new Request(url);
}

describe("GET /api/analyze/managed-object-usage", () => {
  beforeEach(() => vi.clearAllMocks());

  it("400 when env is missing", async () => {
    const res = await GET(makeReq({ type: "alpha_user" }));
    expect(res.status).toBe(400);
  });

  it("400 when type is missing", async () => {
    const res = await GET(makeReq({ env: "test-env" }));
    expect(res.status).toBe(400);
  });

  it("400 when type fails the validation regex", async () => {
    const res = await GET(makeReq({ env: "test-env", type: "bad type!" }));
    expect(res.status).toBe(400);
  });

  it("404 when env config dir is missing", async () => {
    const res = await GET(makeReq({ env: "no-such-env", type: "alpha_user" }));
    expect(res.status).toBe(404);
  });

  it("returns hits across all expected categories", async () => {
    const res = await GET(makeReq({ env: "test-env", type: "alpha_user" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.type).toBe("alpha_user");
    expect(body.query).toBe("managed/alpha_user");
    expect(body.truncated).toBe(false);
    const cats = body.counts.byCategory;
    expect(cats.journey).toBe(1);
    expect(cats["script-library"]).toBe(1);
    expect(cats["script-library-config"]).toBe(1);
    expect(cats["custom-endpoint"]).toBe(2);
    expect(cats.workflow).toBe(1);
    expect(cats["iga-assignment"]).toBe(1);
    expect(cats["iga-form"]).toBe(1);
    expect(cats["managed-object-config"]).toBe(2);
    expect(cats["sync-mapping"]).toBe(1);
    expect(cats.scheduler).toBe(1);
    expect(cats["internal-role"]).toBe(1);
    expect(cats["access-config"]).toBe(1);
    expect(cats["connector-agent"]).toBe(1);
    expect(cats.other).toBe(1);
  });

  it("does NOT match alpha_user_extra (word-boundary lookahead)", async () => {
    const res = await GET(makeReq({ env: "test-env", type: "alpha_user" }));
    const body = await res.json();
    const decoy = body.hits.find((h: any) =>
      h.filePath.includes("managed-objects/alpha_other/alpha_other.json")
    );
    expect(decoy).toBeUndefined();
  });

  it("captures fieldName for JSON hits", async () => {
    const res = await GET(makeReq({ env: "test-env", type: "alpha_user" }));
    const body = await res.json();
    const journeyHit = body.hits.find((h: any) => h.category === "journey");
    expect(journeyHit.fieldName).toBe("identityResource");
    const mappingHit = body.hits.find((h: any) => h.category === "sync-mapping");
    expect(mappingHit.fieldName).toBe("target");
  });

  it("leaves fieldName null for .js hits", async () => {
    const res = await GET(makeReq({ env: "test-env", type: "alpha_user" }));
    const body = await res.json();
    const jsHit = body.hits.find(
      (h: any) => h.category === "script-library" && h.filePath.endsWith(".js")
    );
    expect(jsHit.fieldName).toBeNull();
  });

  it("marks self-references when file lives under managed-objects/<type>/", async () => {
    const res = await GET(makeReq({ env: "test-env", type: "alpha_user" }));
    const body = await res.json();
    const selfHits = body.hits.filter((h: any) => h.isSelfReference);
    expect(selfHits.length).toBe(2);
    for (const h of selfHits) {
      expect(h.filePath.includes("managed-objects/alpha_user/")).toBe(true);
    }
  });
});

describe("truncation", () => {
  it("sets truncated=true and caps at MAX_HITS", async () => {
    // Build a tmp tree with a single .js file containing 2500 matches.
    // The route's MAX_HITS = 2000, so scanning this file must trigger the
    // inner-loop guard and set truncated = true.
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mou-trunc-"));
    try {
      // Place file under alpha/scripts/scripts-content/AUTH so it is
      // categorised as a known category and scanned normally.
      const dir = path.join(tmpRoot, "alpha/scripts/scripts-content/AUTH");
      fs.mkdirSync(dir, { recursive: true });

      const lines: string[] = [];
      for (let i = 0; i < 2500; i++) {
        lines.push(`openidm.read("managed/alpha_user/${i}");`);
      }
      fs.writeFileSync(path.join(dir, "many.js"), lines.join("\n"));

      // Point the mock at the tmp tree for "trunc-env".
      configDirOverride = tmpRoot;

      const res = await GET(makeReq({ env: "trunc-env", type: "alpha_user" }));
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.truncated).toBe(true);
      expect(body.hits.length).toBeLessThanOrEqual(2000);
    } finally {
      configDirOverride = null;
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
