import { describe, it, expect } from "vitest";
import path from "path";
import fs from "fs";
import { loadCanonicalEnv } from "@/lib/semantic-compare/loader";
import { journeysEqual } from "@/lib/semantic-compare/journey-equal";

const IDE  = path.resolve(__dirname, "../../../environments/ide/config");
const IDE3 = path.resolve(__dirname, "../../../environments/ide3/config/ide3");

const describeIf = (cond: boolean) => cond ? describe : describe.skip;

describeIf(fs.existsSync(IDE) && fs.existsSync(IDE3))(
  "semantic-compare integration (ide vs ide3)",
  () => {
    it("loads journeys from both envs", () => {
      const a = loadCanonicalEnv(IDE);
      const b = loadCanonicalEnv(IDE3);
      expect(a.journeys.size).toBeGreaterThan(0);
      expect(b.journeys.size).toBeGreaterThan(0);
    });

    it("a journey compared to itself is equal", () => {
      const a = loadCanonicalEnv(IDE);
      const [firstName] = a.journeys.keys();
      const j = a.journeys.get(firstName)!;
      const r = journeysEqual(j, j, {
        scriptsA: a.scripts, scriptsB: a.scripts,
        journeysA: a.journeys, journeysB: a.journeys,
      });
      expect(r.equal).toBe(true);
    });

    it("cross-env compare of same-name journey produces reasons (not a crash)", () => {
      const a = loadCanonicalEnv(IDE);
      const b = loadCanonicalEnv(IDE3);
      const common = [...a.journeys.keys()].find((n) => b.journeys.has(n));
      if (!common) return;
      const r = journeysEqual(a.journeys.get(common)!, b.journeys.get(common)!, {
        scriptsA: a.scripts, scriptsB: b.scripts,
        journeysA: a.journeys, journeysB: b.journeys,
      });
      // We don't assert equal/not-equal — the point is the function returns a structured result.
      expect(r.reasons).toBeInstanceOf(Array);
    });

    it("unknown script UUIDs manifest as <missing:…> markers, not crashes", () => {
      const a = loadCanonicalEnv(IDE);
      for (const j of a.journeys.values()) {
        for (const n of j.nodes.values()) {
          const script = n.payload.script;
          if (typeof script === "string" && script.startsWith("<missing:")) {
            // At least one marker implies the canonicalizer handles missing refs gracefully.
            expect(script).toMatch(/^<missing:[0-9a-f-]+>$/);
            return;
          }
        }
      }
      // If no missing scripts in this fixture, that's fine too.
    });
  },
);
