import { describe, it, expect } from "vitest";
import * as semantic from "@/lib/semantic-compare";

describe("semantic-compare index", () => {
  it("re-exports public API", () => {
    expect(typeof semantic.canonicalizeScript).toBe("function");
    expect(typeof semantic.canonicalizeJourney).toBe("function");
    expect(typeof semantic.canonicalizeNode).toBe("function");
    expect(typeof semantic.buildScriptMap).toBe("function");
    expect(typeof semantic.buildNodeKeyMap).toBe("function");
    expect(typeof semantic.scriptsEqual).toBe("function");
    expect(typeof semantic.journeysEqual).toBe("function");
    expect(typeof semantic.normalizeScriptBody).toBe("function");
  });
});
