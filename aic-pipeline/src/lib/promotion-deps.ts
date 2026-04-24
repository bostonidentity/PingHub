import type { ScopeSelection } from "@/lib/fr-config-types";
import type { JourneyDeps } from "@/lib/resolve-journey-deps";

export interface AddedScriptDep {
  uuid: string;
  configFile: string;
  name: string;
}

export interface JourneyDepsSelectionUpdate {
  addedSubJourneys: string[];
  addedScripts: AddedScriptDep[];
}

export function getSelectedJourneyNames(scopeSelections: ScopeSelection[]): string[] {
  return scopeSelections
    .filter((s) => s.scope === "journeys" && s.items?.length)
    .flatMap((s) => s.items ?? []);
}

export function addJourneyDepsToSelections(
  scopeSelections: ScopeSelection[],
  deps: JourneyDeps,
): JourneyDepsSelectionUpdate {
  const update: JourneyDepsSelectionUpdate = {
    addedSubJourneys: [],
    addedScripts: [],
  };

  if (deps.subJourneys.length > 0) {
    const journeySel = scopeSelections.find((s) => s.scope === "journeys");
    if (journeySel?.items) {
      for (const sub of deps.subJourneys) {
        if (!journeySel.items.includes(sub)) {
          journeySel.items.push(sub);
          update.addedSubJourneys.push(sub);
        }
      }
    }
  }

  if (deps.scriptUuids.length > 0) {
    let scriptSel = scopeSelections.find((s) => s.scope === "scripts");
    if (!scriptSel) {
      scriptSel = { scope: "scripts" as ScopeSelection["scope"], items: [] };
      scopeSelections.push(scriptSel);
    }
    if (!scriptSel.items) scriptSel.items = [];

    for (const uuid of deps.scriptUuids) {
      const configFile = `${uuid}.json`;
      if (!scriptSel.items.includes(configFile)) {
        const name = deps.scriptNames.get(uuid) ?? uuid;
        scriptSel.items.push(configFile);
        update.addedScripts.push({ uuid, configFile, name });
      }
    }
  }

  return update;
}
