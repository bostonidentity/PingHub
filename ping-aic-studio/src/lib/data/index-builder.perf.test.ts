import { describe, it, expect } from "vitest";
import os from "os";
import path from "path";
import fs from "fs";
import { buildIndexFromNDJson } from "./index-builder";
import { openIndexDb } from "./index-db";
import { NDJSON_FILE } from "./ndjson-format";

const skip = process.env.RUN_PERF !== "1";

describe.skipIf(skip)("buildIndexFromNDJson — performance", () => {
  it("indexes 100k records in under 5 seconds", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "perf-"));
    const lines: string[] = [];
    for (let i = 0; i < 100_000; i++) {
      lines.push(JSON.stringify({ _id: `id-${i}`, userName: `user-${i}`, givenName: `given-${i}` }));
    }
    fs.writeFileSync(path.join(dir, NDJSON_FILE), lines.join("\n") + "\n");

    const t0 = Date.now();
    const n = await buildIndexFromNDJson(dir, (r) => {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(r)) {
        if (k.startsWith("_") && k !== "_id") continue;
        if (typeof v === "string") out[k] = v;
      }
      return out;
    });
    const elapsed = Date.now() - t0;

    expect(n).toBe(100_000);
    expect(elapsed).toBeLessThan(5000);

    const db = openIndexDb(dir);
    const c = (db.prepare("SELECT COUNT(*) AS c FROM records").get() as { c: number }).c;
    db.close();
    expect(c).toBe(100_000);
  });
});
