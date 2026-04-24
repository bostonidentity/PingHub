import { describe, expect, it } from "vitest";
import type { ScopeSelection } from "@/lib/fr-config-types";
import type { JourneyDeps } from "@/lib/resolve-journey-deps";
import { addJourneyDepsToSelections, getSelectedJourneyNames } from "./promotion-deps";

function deps(overrides: Partial<JourneyDeps> = {}): JourneyDeps {
  return {
    subJourneys: [],
    scriptUuids: [],
    scriptNames: new Map(),
    ...overrides,
  };
}

describe("promotion-deps helpers", () => {
  it("extracts selected journey names from item-scoped selections", () => {
    const selections: ScopeSelection[] = [
      { scope: "journeys", items: ["Login"] },
      { scope: "scripts", items: ["script-id.json"] },
      { scope: "journeys", items: ["Registration"] },
    ];

    expect(getSelectedJourneyNames(selections)).toEqual(["Login", "Registration"]);
  });

  it("adds journey and script dependencies without duplicating existing selections", () => {
    const selections: ScopeSelection[] = [
      { scope: "journeys", items: ["Login", "ExistingChild"] },
      { scope: "scripts", items: ["existing-script.json"] },
    ];

    const update = addJourneyDepsToSelections(selections, deps({
      subJourneys: ["ExistingChild", "NewChild"],
      scriptUuids: ["existing-script", "new-script"],
      scriptNames: new Map([
        ["existing-script", "Existing Script"],
        ["new-script", "New Script"],
      ]),
    }));

    expect(selections).toEqual([
      { scope: "journeys", items: ["Login", "ExistingChild", "NewChild"] },
      { scope: "scripts", items: ["existing-script.json", "new-script.json"] },
    ]);
    expect(update).toEqual({
      addedSubJourneys: ["NewChild"],
      addedScripts: [{ uuid: "new-script", configFile: "new-script.json", name: "New Script" }],
    });
  });

  it("creates a scripts selection when journey dependencies introduce scripts", () => {
    const selections: ScopeSelection[] = [
      { scope: "journeys", items: ["Login"] },
    ];

    addJourneyDepsToSelections(selections, deps({
      scriptUuids: ["script-id"],
      scriptNames: new Map([["script-id", "Decision"]]),
    }));

    expect(selections).toEqual([
      { scope: "journeys", items: ["Login"] },
      { scope: "scripts", items: ["script-id.json"] },
    ]);
  });
});
