import type { CanonicalScript, EqualityReason, EqualityResult } from "./types";

export function scriptsEqual(a: CanonicalScript, b: CanonicalScript): EqualityResult {
  if (a.identity !== b.identity) {
    throw new Error(`scriptsEqual called with different identities: ${a.identity} vs ${b.identity}`);
  }
  const reasons: EqualityReason[] = [];

  const metaFields: string[] = [];
  if (a.language !== b.language) metaFields.push("language");
  if (a.evaluatorVersion !== b.evaluatorVersion) metaFields.push("evaluatorVersion");
  if (a.defaultFlag !== b.defaultFlag) metaFields.push("defaultFlag");
  if (metaFields.length > 0) {
    reasons.push({ kind: "script-meta", identity: a.identity, fields: metaFields });
  }

  if (a.body !== b.body) {
    reasons.push({ kind: "script-body", identity: a.identity });
  }

  return { equal: reasons.length === 0, reasons };
}
