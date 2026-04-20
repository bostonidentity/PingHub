import { loadCanonicalEnv } from "./semantic-compare/loader";
import { journeysEqual } from "./semantic-compare/journey-equal";
import type { SemanticJourneyReport } from "./diff-types";

/**
 * Build the SemanticJourneyReport array that decorates a compare response.
 * Returns undefined when the "journeys" scope isn't part of the compare —
 * avoids paying the canonicalization cost when it wouldn't be surfaced.
 */
export function loadSemanticJourneys(
  sourceDir: string,
  targetDir: string,
  scopes: string[],
): SemanticJourneyReport[] | undefined {
  if (!scopes.includes("journeys")) return undefined;
  const src = loadCanonicalEnv(sourceDir);
  const tgt = loadCanonicalEnv(targetDir);
  const allNames = new Set([...src.journeys.keys(), ...tgt.journeys.keys()]);
  const reports: SemanticJourneyReport[] = [];
  for (const name of [...allNames].sort()) {
    const a = src.journeys.get(name);
    const b = tgt.journeys.get(name);
    if (a && !b)      reports.push({ name, status: "removed" });
    else if (!a && b) reports.push({ name, status: "added" });
    else if (a && b) {
      const r = journeysEqual(a, b, {
        scriptsA: src.scripts, scriptsB: tgt.scripts,
        journeysA: src.journeys, journeysB: tgt.journeys,
      });
      reports.push({ name, status: r.equal ? "equal" : "modified", reasons: r.reasons });
    }
  }
  return reports;
}
