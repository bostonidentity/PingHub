import fs from "fs";
import path from "path";
import { getConfigDir } from "@/lib/fr-config";
import { getScopePruneTargets } from "@/lib/git";
import type { ScopeSelection } from "@/lib/fr-config-types";
import { collectDefinedEsvs, extractNamedRefs, stripJsComments } from "./esv-orphans";

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
const BINARY_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".pdf",
  ".zip", ".gz", ".tar", ".tgz", ".7z", ".rar",
  ".mp3", ".mp4", ".mov", ".avi", ".wav",
  ".woff", ".woff2", ".ttf", ".eot", ".otf", ".class", ".jar",
]);
const SKIP_DIR = new Set([".git", "node_modules", ".next", ".DS_Store"]);

function* walkDir(dir: string): Generator<string> {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return; }
  for (const entry of entries) {
    if (SKIP_DIR.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walkDir(full);
    else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (BINARY_EXT.has(ext)) continue;
      yield full;
    }
  }
}

/**
 * Given a scope directory and an optional list of item identifiers,
 * yield the absolute file paths that belong to those items. When no
 * items are specified (items === undefined or empty), every file in
 * the scope directory is yielded — i.e. "promote all items".
 *
 * The matcher is intentionally loose: a file belongs to an item if
 * any item id appears anywhere in its basename or directory path.
 * That covers the common layouts:
 *   scripts          — scripts-content/<TYPE>/<name>-<uuid>.js
 *   endpoints        — endpoints/<name>.{js,json}
 *   journeys         — journeys/<name>/...
 *   iga-workflows    — iga/workflows/<name>/...
 *   email-templates  — email-templates/<name>/...
 *   custom-nodes     — custom-nodes/<id>/...
 *   managed-objects  — managed-objects/<id>/...
 */
function* filterFilesForItems(scopeDir: string, items: string[] | undefined): Generator<string> {
  if (!fs.existsSync(scopeDir)) return;
  const hasItems = items && items.length > 0;
  const needles = hasItems ? items!.map((i) => i.toLowerCase()) : null;
  for (const abs of walkDir(scopeDir)) {
    if (!needles) { yield abs; continue; }
    const rel = path.relative(scopeDir, abs).toLowerCase();
    const basename = path.basename(abs).toLowerCase();
    if (needles.some((n) => rel.includes(n) || basename.includes(n))) {
      yield abs;
    }
  }
}

export async function runPromotePrecheck(
  sourceEnv: string,
  targetEnv: string,
  scopeSelections: ScopeSelection[],
  signal?: AbortSignal,
): Promise<PromotePrecheckResult> {
  const sourceDir = getConfigDir(sourceEnv);
  const targetDir = getConfigDir(targetEnv);
  if (!sourceDir || !fs.existsSync(sourceDir)) {
    throw new Error(`Source environment '${sourceEnv}' has no config on disk`);
  }
  if (!targetDir || !fs.existsSync(targetDir)) {
    throw new Error(`Target environment '${targetEnv}' has no config on disk`);
  }

  const { defined: targetDefined } = collectDefinedEsvs(targetDir);
  const targetNames = new Set(targetDefined.keys());

  const seen = new Set<string>();
  const byName = new Map<string, PrecheckReference[]>();
  let scannedFiles = 0;

  for (const selection of scopeSelections) {
    if (signal?.aborted) break;
    // Skip ESV scopes themselves — the point is to check whether refs
    // elsewhere resolve against the target, not to diff ESV definitions.
    if (selection.scope === "variables" || selection.scope === "secrets") continue;
    const scopeDirs = getScopePruneTargets(sourceDir, selection.scope);
    for (const scopeDir of scopeDirs) {
      for (const abs of filterFilesForItems(scopeDir, selection.items)) {
        if (seen.has(abs)) continue;
        seen.add(abs);
        let stat: fs.Stats;
        try { stat = fs.statSync(abs); } catch { continue; }
        if (stat.size > MAX_FILE_BYTES) continue;
        let text: string;
        try { text = fs.readFileSync(abs, "utf8"); } catch { continue; }
        scannedFiles += 1;
        const rel = path.relative(sourceDir, abs).split(path.sep).join("/");
        const ext = path.extname(abs).toLowerCase();
        const scanText = ext === ".js" || ext === ".groovy" || ext === ".mjs" || ext === ".cjs"
          ? stripJsComments(text)
          : text;
        const refs = extractNamedRefs(scanText, rel, text);
        for (const r of refs) {
          const list = byName.get(r.name) ?? [];
          list.push({ path: r.path, line: r.line, snippet: r.snippet, form: r.form });
          byName.set(r.name, list);
        }
      }
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
    sourceEnv,
    targetEnv,
    missing,
    scannedFiles,
    totalReferences: totalRefs,
    totalReferencedNames: byName.size,
  };
}
