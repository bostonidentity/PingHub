import fs from "fs";
import path from "path";
import { getConfigDir } from "@/lib/fr-config";

const SKIP_DIR = new Set([".git", "node_modules", ".next", ".DS_Store"]);
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const BINARY_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico",
  ".pdf", ".zip", ".gz", ".tar", ".tgz", ".7z", ".rar",
  ".mp3", ".mp4", ".mov", ".avi", ".wav",
  ".woff", ".woff2", ".ttf", ".eot", ".otf",
  ".class", ".jar",
]);

export interface EsvReference {
  path: string;       // relative to configDir
  line: number;       // 1-indexed
  snippet: string;    // matched line, trimmed and truncated
  form: "placeholder" | "realmPlaceholder" | "systemEnv";
}

export interface EsvOrphan {
  name: string;       // normalized ESV name (no esv- prefix)
  references: EsvReference[];
}

export interface EsvUnused {
  name: string;
  file: string;       // relative path to the definition file
  kind: "variable" | "secret";
}

export interface EsvOrphanReport {
  env: string;
  totalReferences: number;
  totalReferencedNames: number;
  totalDefinedNames: number;
  orphans: EsvOrphan[];
  unused: EsvUnused[];
  scannedFiles: number;
  generatedAt: string;
}

function* walk(dir: string, skipRoots: string[] = []): Generator<string> {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return; }
  for (const entry of entries) {
    if (SKIP_DIR.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (skipRoots.some((r) => full === r || full.startsWith(r + path.sep))) continue;
    if (entry.isDirectory()) {
      yield* walk(full, skipRoots);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (BINARY_EXT.has(ext)) continue;
      yield full;
    }
  }
}

/**
 * Normalize any ESV name to a canonical key.
 *
 * AIC treats `.` and `-` interchangeably in ESV names: a variable stored as
 * `esv-ad-external-basedn` is referenced as `&{esv.ad.external.basedn}` in
 * config. We canonicalize by stripping the `esv-` / `esv.` prefix, replacing
 * every `.` with `-`, and lowercasing, so references and definitions match
 * regardless of which separator style the source file uses.
 */
function normalizeEsvName(raw: string): string {
  let n = raw.trim().toLowerCase();
  if (n.startsWith("esv-")) n = n.slice(4);
  else if (n.startsWith("esv.")) n = n.slice(4);
  return n.replace(/\./g, "-");
}

/**
 * Pull defined ESV names from esvs/variables/*.json and esvs/secrets/*.json.
 * The filename (minus .json and the esv- prefix) is authoritative.
 */
export function collectDefinedEsvs(configDir: string): {
  defined: Map<string, { file: string; kind: "variable" | "secret" }>;
} {
  const defined = new Map<string, { file: string; kind: "variable" | "secret" }>();
  const scan = (sub: string, kind: "variable" | "secret") => {
    const dir = path.join(configDir, sub);
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".json")) continue;
      // Some tooling emits `esv-foo.variable.json` / `esv-foo.secret.json`
      // while other exports use bare `esv-foo.json`. Strip any of these.
      const base = entry.name
        .replace(/\.variable\.json$/i, "")
        .replace(/\.secret\.json$/i, "")
        .replace(/\.json$/i, "");
      const name = normalizeEsvName(base);
      if (!name) continue;
      const rel = path.relative(configDir, path.join(dir, entry.name)).split(path.sep).join("/");
      defined.set(name, { file: rel, kind });
    }
  };
  scan("esvs/variables", "variable");
  scan("esvs/secrets", "secret");
  return { defined };
}

/**
 * Blank out `//` and `/* *\/` comments in JS/Groovy source, preserving
 * character positions and newlines so line numbers remain accurate.
 * String literals are honored so that `//` inside e.g. "https://..." is
 * not mistaken for a comment.
 */
export function stripJsComments(src: string): string {
  const out = src.split("");
  const n = src.length;
  let i = 0;
  let str: '"' | "'" | "`" | null = null;
  while (i < n) {
    const c = src[i];
    if (str) {
      if (c === "\\" && i + 1 < n) { i += 2; continue; }
      if (c === str) str = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { str = c as '"' | "'" | "`"; i++; continue; }
    if (c === "/" && src[i + 1] === "/") {
      // Line comment until newline
      while (i < n && src[i] !== "\n") { out[i] = " "; i++; }
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      // Block comment until */
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      while (i < stop) {
        out[i] = src[i] === "\n" ? "\n" : " ";
        i++;
      }
      continue;
    }
    i++;
  }
  return out.join("");
}

const REF_RE_PLACEHOLDER      = /&\{esv\.([A-Za-z0-9._-]+)\}/g;
const REF_RE_REALM            = /fr\.realm\.esv\.([A-Za-z0-9._-]+)/g;
// Order matters: the specific getProperty(...) / [...] forms must be tried
// before the bare `.name` form, otherwise the alternation engine will capture
// `getProperty` (from `systemEnv.getProperty("foo")`) as the ESV name. The
// negative lookahead on the bare `.name` form also guards against defensive
// code like `if (systemEnv.getProperty)` where the method is referenced
// without an immediate parenthesized call.
const REF_RE_SYSTEMENV_PROP   = /systemEnv(?:\.getProperty\(\s*['"]([^'"]+)['"]|\[\s*['"]([^'"]+)['"]\s*\]|\.(?!getProperty\b|getSecret\b|getConfig\b)([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*))/g;

function collectRefsFromContent(content: string, relPath: string): EsvReference[] {
  const refs: EsvReference[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const truncated = line.length > 300 ? line.slice(0, 300) + "…" : line;
    for (const m of line.matchAll(REF_RE_PLACEHOLDER)) {
      refs.push({ path: relPath, line: i + 1, snippet: truncated.trim(), form: "placeholder" });
      // Keep the matched name on the ref via a side map is unnecessary; caller maps by regex too.
      void m;
    }
    for (const m of line.matchAll(REF_RE_REALM)) {
      refs.push({ path: relPath, line: i + 1, snippet: truncated.trim(), form: "realmPlaceholder" });
      void m;
    }
    for (const m of line.matchAll(REF_RE_SYSTEMENV_PROP)) {
      refs.push({ path: relPath, line: i + 1, snippet: truncated.trim(), form: "systemEnv" });
      void m;
    }
  }
  return refs;
}

/**
 * Return every ESV name referenced on this line, with line metadata — we
 * redo the matching here (instead of threading captures through the helper
 * above) so the grouping stage gets one ref per matched name, not per match.
 */
export interface NamedRef extends EsvReference { name: string }
export function extractNamedRefs(scanText: string, relPath: string, displayText?: string): NamedRef[] {
  const refs: NamedRef[] = [];
  const scanLines = scanText.split("\n");
  const displayLines = (displayText ?? scanText).split("\n");
  for (let i = 0; i < scanLines.length; i++) {
    const scanLine = scanLines[i];
    const displayLine = displayLines[i] ?? scanLine;
    const trimmed = displayLine.trim();
    const snippet = trimmed.length > 300 ? trimmed.slice(0, 300) + "…" : trimmed;
    const pushAll = (re: RegExp, form: NamedRef["form"]) => {
      for (const m of scanLine.matchAll(re)) {
        const raw = m[1] ?? m[2] ?? m[3];
        if (!raw) continue;
        refs.push({ name: normalizeEsvName(raw), line: i + 1, path: relPath, snippet, form });
      }
    };
    pushAll(REF_RE_PLACEHOLDER, "placeholder");
    pushAll(REF_RE_REALM, "realmPlaceholder");
    pushAll(REF_RE_SYSTEMENV_PROP, "systemEnv");
  }
  return refs;
}

export async function runEsvOrphans(env: string, signal?: AbortSignal): Promise<EsvOrphanReport> {
  const configDir = getConfigDir(env);
  if (!configDir || !fs.existsSync(configDir)) {
    throw new Error(`Environment '${env}' has no configDir on disk`);
  }

  const { defined } = collectDefinedEsvs(configDir);
  const definedNames = new Set(defined.keys());

  // Skip the esvs/ tree itself — a reference inside a secret/variable file is
  // not a usage; it's the definition.
  const skipRoots = [path.join(configDir, "esvs")];

  const byName = new Map<string, EsvReference[]>();
  let scannedFiles = 0;
  let totalRefs = 0;

  for (const abs of walk(configDir, skipRoots)) {
    if (signal?.aborted) break;
    let stat: fs.Stats;
    try { stat = fs.statSync(abs); } catch { continue; }
    if (stat.size > MAX_FILE_BYTES) continue;
    let text: string;
    try { text = fs.readFileSync(abs, "utf8"); } catch { continue; }
    scannedFiles += 1;
    const rel = path.relative(configDir, abs).split(path.sep).join("/");
    // For script files, blank out // and /* */ comments so commented-out
    // references aren't reported. Line numbers are preserved.
    const ext = path.extname(abs).toLowerCase();
    const scanText = ext === ".js" || ext === ".groovy" || ext === ".mjs" || ext === ".cjs"
      ? stripJsComments(text)
      : text;
    const refs = extractNamedRefs(scanText, rel, text);
    if (refs.length === 0) continue;
    for (const r of refs) {
      totalRefs += 1;
      const list = byName.get(r.name) ?? [];
      list.push({ path: r.path, line: r.line, snippet: r.snippet, form: r.form });
      byName.set(r.name, list);
    }
  }

  // Orphans: referenced names not in defined set
  const orphans: EsvOrphan[] = [];
  for (const [name, references] of byName) {
    if (!definedNames.has(name)) {
      orphans.push({ name, references });
    }
  }
  orphans.sort((a, b) => a.name.localeCompare(b.name));

  // Unused: defined names never referenced
  const unused: EsvUnused[] = [];
  for (const [name, info] of defined) {
    if (!byName.has(name)) unused.push({ name, file: info.file, kind: info.kind });
  }
  unused.sort((a, b) => a.name.localeCompare(b.name));

  return {
    env,
    totalReferences: totalRefs,
    totalReferencedNames: byName.size,
    totalDefinedNames: defined.size,
    orphans,
    unused,
    scannedFiles,
    generatedAt: new Date().toISOString(),
  };
}

// Keep the helper export so tests / other callers can reach it later.
export { collectRefsFromContent };
