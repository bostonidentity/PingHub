import fs from "fs";
import path from "path";
import { getAccessToken } from "@/lib/iga-api";
import type { CompareEndpoint, CompareReport } from "@/lib/diff-types";
import { collectDefinedEsvs, extractNamedRefs, normalizeEsvName, stripJsComments } from "./esv-orphans";

export interface PrecheckReference {
  path: string;
  line: number;
  snippet: string;
  form: "placeholder" | "realmPlaceholder" | "systemEnv";
}

export interface MissingEsv {
  name: string;
  references: PrecheckReference[];
}

export interface PromotePrecheckResult {
  sourceEnv: string;
  targetEnv: string;
  missing: MissingEsv[];
  scannedFiles: number;
  totalReferences: number;
  totalReferencedNames: number;
}

const MAX_FILE_BYTES = 2 * 1024 * 1024;

/**
 * Collect the set of ESV names currently defined on the target.
 *
 *   Local mode  — scan `<targetConfigDir>/esvs/{variables,secrets}/`.
 *   Remote mode — GET `/environment/variables` and `/environment/secrets`
 *                 on the tenant. This reflects the tenant's live state,
 *                 which is what actually matters for a promote; the on-
 *                 disk snapshot may be stale or missing if the user hasn't
 *                 pulled those scopes recently.
 */
async function collectTargetEsvNames(
  target: CompareEndpoint,
  targetConfigDir: string,
  targetEnvVars: Record<string, string> | undefined,
): Promise<Set<string>> {
  if (target.mode === "local") {
    const { defined } = collectDefinedEsvs(targetConfigDir);
    return new Set(defined.keys());
  }

  if (!targetEnvVars) throw new Error("Remote target precheck requires env vars");
  const tenantUrl = targetEnvVars.TENANT_BASE_URL ?? "";
  if (!tenantUrl) throw new Error("TENANT_BASE_URL missing for remote target");

  const token = await getAccessToken(targetEnvVars);
  const names = new Set<string>();

  const fetchList = async (resource: "variables" | "secrets") => {
    const url = `${tenantUrl}/environment/${resource}?_queryFilter=true&_fields=_id`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`GET /environment/${resource} returned ${res.status}`);
    const body = (await res.json()) as { result?: { _id?: string }[] };
    for (const entry of body.result ?? []) {
      if (typeof entry._id === "string") names.add(normalizeEsvName(entry._id));
    }
  };
  await fetchList("variables");
  await fetchList("secrets");
  return names;
}

/**
 * Run the ESV precheck against a completed dry-run report.
 *
 * Algorithm (per product spec):
 *   1. Dependencies are already resolved — the caller (compare route)
 *      runs `addDepsToSelections` before building the report, so the
 *      diff already covers every file that will be promoted.
 *   2. Walk `report.files`, keeping only those with status "added" or
 *      "modified" (post-dry-run flip semantics: the file will be
 *      created on or pushed to the target). Unchanged files are skipped
 *      — their refs already resolve on target by definition. Removed
 *      files are skipped — they'll be gone from target after promote.
 *   3. Read each candidate file from the source config dir and extract
 *      ESV references.
 *   4. For each referenced name, check it against the target-defined
 *      set — live REST lookup for remote targets, on-disk scan for
 *      local. Anything unresolved is reported as missing.
 */
export async function runEsvPrecheckOnReport(input: {
  report: CompareReport;
  sourceEnv: string;
  targetEnv: string;
  sourceConfigDir: string;
  target: CompareEndpoint;
  targetConfigDir: string;
  targetEnvVars?: Record<string, string>;
  signal?: AbortSignal;
}): Promise<PromotePrecheckResult> {
  const {
    report, sourceEnv, targetEnv,
    sourceConfigDir, target, targetConfigDir, targetEnvVars, signal,
  } = input;

  const targetNames = await collectTargetEsvNames(target, targetConfigDir, targetEnvVars);

  const byName = new Map<string, PrecheckReference[]>();
  let scannedFiles = 0;

  for (const file of report.files) {
    if (signal?.aborted) break;
    // "added" and "modified" are the files that will land on target
    // — the ones whose refs need to resolve against target's ESVs.
    if (file.status !== "added" && file.status !== "modified") continue;

    const abs = path.join(sourceConfigDir, file.relativePath);
    let stat: fs.Stats;
    try { stat = fs.statSync(abs); } catch { continue; }
    if (stat.size > MAX_FILE_BYTES) continue;
    let text: string;
    try { text = fs.readFileSync(abs, "utf8"); } catch { continue; }
    scannedFiles += 1;

    const ext = path.extname(abs).toLowerCase();
    const scanText = ext === ".js" || ext === ".groovy" || ext === ".mjs" || ext === ".cjs"
      ? stripJsComments(text)
      : text;
    const refs = extractNamedRefs(scanText, file.relativePath, text);
    for (const r of refs) {
      const list = byName.get(r.name) ?? [];
      list.push({ path: r.path, line: r.line, snippet: r.snippet, form: r.form });
      byName.set(r.name, list);
    }
  }

  const missing: MissingEsv[] = [];
  let totalRefs = 0;
  for (const [name, references] of byName) {
    totalRefs += references.length;
    if (!targetNames.has(name)) missing.push({ name, references });
  }
  missing.sort((a, b) => a.name.localeCompare(b.name));

  return {
    sourceEnv, targetEnv,
    missing,
    scannedFiles,
    totalReferences: totalRefs,
    totalReferencedNames: byName.size,
  };
}
