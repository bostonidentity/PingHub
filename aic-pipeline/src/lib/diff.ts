import fs from "fs";
import path from "path";
import type { DiffLine, FileDiff, CompareReport, CompareEndpoint, DiffOptions, JourneyTreeNode, JourneyScript, JourneyNodeInfo } from "./diff-types";
import { formatHtml, shouldFormatAsHtml } from "./format-html";
import { getRealmRoots } from "./realm-paths";
import { loadSemanticJourneys } from "./semantic-compare-adapter";

const MAX_LINES = 2000;
const MAX_CONTENT_BYTES = 200_000; // 200 KB per side

// ── Metadata fields to strip from JSON when not including metadata ───────────

const METADATA_KEYS = new Set([
  "createdBy", "creationDate", "lastModifiedBy", "lastModifiedDate",
  "lastChangeDate", "lastChangedBy",
]);

// ── Scope → directory mapping ────────────────────────────────────────────────

const SCOPE_DIR: Record<string, string> = {
  "access-config":         "access-config",
  "audit":                 "audit",
  "connector-definitions": "sync/connectors",
  "connector-mappings":    "sync/mappings",
  "cookie-domains":        "cookie-domains",
  "cors":                  "cors",
  "csp":                   "csp",
  "custom-nodes":          "custom-nodes",
  "email-provider":        "email-provider",
  "email-templates":       "email-templates",
  "endpoints":             "endpoints",
  "idm-authentication":    "idm-authentication-config",
  "iga-workflows":         "iga/workflows",
  "internal-roles":        "internal-roles",
  "kba":                   "kba",
  "locales":               "locales",
  "managed-objects":       "managed-objects",
  "org-privileges":        "org-privileges",
  "raw":                   "raw",
  "remote-servers":        "sync/rcs",
  "schedules":             "schedules",
  "secrets":               "esvs/secrets",
  "service-objects":       "service-objects",
  "telemetry":             "telemetry",
  "terms-and-conditions":  "terms-conditions",
  "ui-config":             "ui",
  "variables":             "esvs/variables",
};

const REALM_SCOPE_SUBDIR: Record<string, string> = {
  "authz-policies":  "authorization",
  "journeys":        "journeys",
  "oauth2-agents":   "realm-config/agents",
  "password-policy": "password-policy",
  "saml":            "realm-config/saml",
  "scripts":         "scripts",
  "secret-mappings": "secret-mappings",
  "services":        "services",
  "themes":          "themes",
};

/** Resolve scope names to actual filesystem directories within a config dir. */
function resolveScopeDirs(configDir: string, scopes: string[]): string[] {
  const dirs: string[] = [];
  for (const scope of scopes) {
    if (scope in REALM_SCOPE_SUBDIR) {
      const subdir = REALM_SCOPE_SUBDIR[scope];
      // Both upstream (configDir/realms/<r>/subdir) and vendored
      // (configDir/<r>/subdir) layouts are supported.
      for (const root of getRealmRoots(configDir, subdir)) {
        dirs.push(path.join(root, subdir));
      }
    } else {
      const dirName = SCOPE_DIR[scope] ?? scope;
      const scopePath = path.join(configDir, dirName);
      if (fs.existsSync(scopePath)) dirs.push(scopePath);
    }
  }
  return dirs;
}

function stripMetadata(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(stripMetadata);
  if (obj && typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (!METADATA_KEYS.has(k)) out[k] = stripMetadata(v);
    }
    return out;
  }
  return obj;
}

/**
 * Canonicalize JSON by alphabetically sorting object keys at every level so
 * diffs aren't sensitive to key insertion order — IDM reorders keys when it
 * round-trips managed-object configs, and fr-config-pull's script extraction
 * moves `file` around, which caused spurious "modified" results even when
 * the semantic content was identical.
 */
function sortJsonKeys(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(sortJsonKeys);
  if (obj && typeof obj === "object") {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(obj as Record<string, unknown>).sort()) {
      sorted[k] = sortJsonKeys((obj as Record<string, unknown>)[k]);
    }
    return sorted;
  }
  return obj;
}

/** Strip single-line (//) and multi-line (/* *​/) comments from JS/Groovy code. */
function stripComments(code: string): string {
  let result = "";
  let i = 0;
  while (i < code.length) {
    // Single-line comment
    if (code[i] === "/" && code[i + 1] === "/") {
      // Skip to end of line
      while (i < code.length && code[i] !== "\n") i++;
    }
    // Multi-line comment
    else if (code[i] === "/" && code[i + 1] === "*") {
      i += 2;
      while (i < code.length && !(code[i] === "*" && code[i + 1] === "/")) i++;
      i += 2; // skip */
    }
    // String literal (don't strip // or /* inside strings)
    else if (code[i] === '"' || code[i] === "'" || code[i] === "`") {
      const q = code[i];
      result += code[i++];
      while (i < code.length && code[i] !== q) {
        if (code[i] === "\\") { result += code[i++]; }
        if (i < code.length) { result += code[i++]; }
      }
      if (i < code.length) result += code[i++]; // closing quote
    }
    else {
      result += code[i++];
    }
  }
  return result;
}

function isScriptFile(filePath: string): boolean {
  return /\.(js|groovy)$/i.test(filePath);
}

function normalizeContent(content: string, filePath: string, opts: DiffOptions = {}): string {
  let result = content;

  // Normalize line endings
  result = result.replace(/\r\n?/g, "\n");

  if (filePath.endsWith(".json")) {
    try {
      let parsed = JSON.parse(result);
      if (!opts.includeMetadata) parsed = stripMetadata(parsed);
      parsed = sortJsonKeys(parsed);
      result = JSON.stringify(parsed, null, 2);
    } catch { /* fall through */ }
  }

  // Pretty-print HTML-bearing email-template files (.md/.html) so a single
  // upstream long line shows as structured indentation in both compare and
  // browse views — the diff is computed on the formatted text so changes
  // are line-precise.
  if (shouldFormatAsHtml(filePath)) {
    try { result = formatHtml(result); } catch { /* keep raw */ }
  }

  // Strip comments from script files
  if (isScriptFile(filePath) && !opts.includeMetadata) {
    result = stripComments(result);
  }

  // Ignore whitespace: trim each line, remove blank lines
  if (opts.ignoreWhitespace) {
    result = result
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .join("\n");
  }

  return result;
}

function computeLineDiff(aText: string, bText: string): DiffLine[] {
  const a = aText === "" ? [] : aText.split("\n");
  const b = bText === "" ? [] : bText.split("\n");

  if (a.length > MAX_LINES || b.length > MAX_LINES) {
    return [{ type: "context", content: `(file too large to diff — ${a.length} vs ${b.length} lines)` }];
  }

  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  const lines: DiffLine[] = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      lines.unshift({ type: "context", content: a[i - 1] });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      lines.unshift({ type: "added", content: b[j - 1] });
      j--;
    } else {
      lines.unshift({ type: "removed", content: a[i - 1] });
      i--;
    }
  }
  return lines;
}

function countChanges(lines: DiffLine[]): { linesAdded: number; linesRemoved: number } {
  let linesAdded = 0, linesRemoved = 0;
  for (const l of lines) {
    if (l.type === "added") linesAdded++;
    else if (l.type === "removed") linesRemoved++;
  }
  return { linesAdded, linesRemoved };
}

function walkDir(dir: string, base: string, out: Map<string, string>): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkDir(full, base, out);
    } else {
      // Normalize to POSIX separators so downstream consumers (regexes, UI
      // path splits, scope derivation) work identically on Windows and Unix.
      const rel = path.relative(base, full).split(path.sep).join("/");
      out.set(rel, fs.readFileSync(full, "utf-8"));
    }
  }
}

export function compareDirs(
  remoteDir: string,
  localDir: string,
  scopes?: string[],
  opts: DiffOptions = {},
): FileDiff[] {
  const remote = new Map<string, string>();
  const local = new Map<string, string>();

  if (scopes && scopes.length > 0) {
    for (const dir of resolveScopeDirs(remoteDir, scopes)) {
      walkDir(dir, remoteDir, remote);
    }
    for (const dir of resolveScopeDirs(localDir, scopes)) {
      walkDir(dir, localDir, local);
    }
  } else {
    walkDir(remoteDir, remoteDir, remote);
    walkDir(localDir, localDir, local);
  }

  const allPaths = new Set([...remote.keys(), ...local.keys()]);
  const diffs: FileDiff[] = [];

  // Metadata file patterns to skip when includeMetadata is false
  const METADATA_PATH_PATTERNS = [
    /scripts-config\//,         // Script registration/metadata files
  ];

  for (const rel of [...allPaths].sort()) {
    // Skip metadata files when not including metadata
    if (!opts.includeMetadata && METADATA_PATH_PATTERNS.some((p) => p.test(rel))) continue;
    const r = remote.get(rel);
    const l = local.get(rel);

    if (r !== undefined && l === undefined) {
      // Only in remote — added
      const rNorm = normalizeContent(r, rel, opts);
      const diffLines = rNorm.split("\n").slice(0, MAX_LINES).map((c) => ({ type: "added" as const, content: c }));
      diffs.push({
        relativePath: rel,
        status: "added",
        diffLines,
        remoteContent: Buffer.byteLength(rNorm) <= MAX_CONTENT_BYTES ? rNorm : undefined,
        linesAdded: diffLines.length,
        linesRemoved: 0,
      });
    } else if (r === undefined && l !== undefined) {
      // Only in local — removed
      const lNorm = normalizeContent(l, rel, opts);
      const diffLines = lNorm.split("\n").slice(0, MAX_LINES).map((c) => ({ type: "removed" as const, content: c }));
      diffs.push({
        relativePath: rel,
        status: "removed",
        diffLines,
        localContent: Buffer.byteLength(lNorm) <= MAX_CONTENT_BYTES ? lNorm : undefined,
        linesAdded: 0,
        linesRemoved: diffLines.length,
      });
    } else if (r !== undefined && l !== undefined) {
      // ESV definitions (variables/secrets) are environment-specific by
      // design — value drift is expected and uninteresting for promotions.
      // Only added/removed presence matters, so treat present-on-both as
      // unchanged regardless of content.
      if (/^esvs\/(variables|secrets)\//.test(rel)) {
        diffs.push({ relativePath: rel, status: "unchanged" });
        continue;
      }
      const rNorm = normalizeContent(r, rel, opts);
      const lNorm = normalizeContent(l, rel, opts);
      if (rNorm === lNorm) {
        diffs.push({ relativePath: rel, status: "unchanged" });
      } else {
        const diffLines = computeLineDiff(lNorm, rNorm);
        const { linesAdded, linesRemoved } = countChanges(diffLines);
        diffs.push({
          relativePath: rel,
          status: "modified",
          diffLines,
          localContent: Buffer.byteLength(lNorm) <= MAX_CONTENT_BYTES ? lNorm : undefined,
          remoteContent: Buffer.byteLength(rNorm) <= MAX_CONTENT_BYTES ? rNorm : undefined,
          linesAdded,
          linesRemoved,
        });
      }
    }
  }
  return diffs;
}

// ── Journey tree builder ─────────────────────────────────────────────────────

interface JourneyNodeMeta {
  uuid: string;
  name: string;
  displayName?: string;
  nodeType: string;
}

interface JourneyMeta {
  name: string;
  innerTreeOnly: boolean;
  subJourneys: string[];
  scriptUUIDs: string[];
  allNodes: JourneyNodeMeta[];
  /** nodeUUID → script UUID (for ScriptedDecisionNode and similar) */
  nodeScripts: Map<string, string>;
  /** nodeUUID → sub-journey name (for InnerTreeEvaluatorNode) */
  nodeSubJourneys: Map<string, string>;
  /** nodeUUID → raw node JSON body (from the per-node file). Used for canonical compare. */
  rawNodes: Map<string, Record<string, unknown>>;
}

function walkNodeFiles(dir: string, out: string[]): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkNodeFiles(full, out);
    } else if (entry.name.endsWith(".json")) {
      out.push(full);
    }
  }
}

function scanJourneys(configDir: string): Map<string, JourneyMeta> {
  const map = new Map<string, JourneyMeta>();

  for (const realmRoot of getRealmRoots(configDir, "journeys")) {
    const journeysDir = path.join(realmRoot, "journeys");
    for (const jDir of fs.readdirSync(journeysDir, { withFileTypes: true })) {
      if (!jDir.isDirectory()) continue;
      const mainFile = path.join(journeysDir, jDir.name, `${jDir.name}.json`);
      if (!fs.existsSync(mainFile)) continue;

      try {
        const data = JSON.parse(fs.readFileSync(mainFile, "utf-8"));
        const nodes = (data.nodes ?? {}) as Record<string, { nodeType?: string; displayName?: string }>;
        const innerTreeUUIDs = new Set<string>();
        const uuidToDisplayName = new Map<string, string>();
        for (const [uuid, node] of Object.entries(nodes)) {
          if (node.nodeType === "InnerTreeEvaluatorNode") innerTreeUUIDs.add(uuid);
          if (typeof node.displayName === "string" && node.displayName) {
            uuidToDisplayName.set(uuid, node.displayName);
          }
        }

        const subJourneys: string[] = [];
        const scriptUUIDs: string[] = [];
        const allNodes: JourneyNodeMeta[] = [];
        const nodeScripts = new Map<string, string>();
        const nodeSubJourneys = new Map<string, string>();
        const rawNodes = new Map<string, Record<string, unknown>>();
        const nodesDir = path.join(journeysDir, jDir.name, "nodes");
        if (fs.existsSync(nodesDir)) {
          const nodeFiles: string[] = [];
          walkNodeFiles(nodesDir, nodeFiles);
          for (const fp of nodeFiles) {
            const nf = path.basename(fp);
            try {
              const nd = JSON.parse(fs.readFileSync(fp, "utf-8")) as Record<string, unknown> & { tree?: string; script?: string; _type?: { _id?: string; name?: string }; _id?: string };
              // Accept both "NodeType - uuid.json" and "NodeType_-_uuid.json"
              // (vendored pull replaces spaces with underscores).
              const m = nf.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/i);
              const uuid = m?.[1] ?? nd._id ?? "";
              const nodeType = nd._type?._id ?? "unknown";
              const nodeName = nd._type?.name ?? nf.replace(/\s*-\s*[0-9a-f-]+\.json$/i, "");
              if (m && innerTreeUUIDs.has(m[1]) && nd.tree) {
                subJourneys.push(nd.tree);
                nodeSubJourneys.set(uuid, nd.tree);
              }
              if (nd.script) {
                scriptUUIDs.push(nd.script);
                nodeScripts.set(uuid, nd.script);
              }
              const displayName = uuidToDisplayName.get(uuid);
              allNodes.push({ uuid, name: nodeName, displayName, nodeType });
              if (uuid) rawNodes.set(uuid, nd);
            } catch { /* skip */ }
          }
        }

        map.set(jDir.name, {
          name: jDir.name,
          innerTreeOnly: data.innerTreeOnly ?? false,
          subJourneys,
          scriptUUIDs,
          allNodes,
          nodeScripts,
          nodeSubJourneys,
          rawNodes,
        });
      } catch { /* skip */ }
    }
  }
  return map;
}

/** Build UUID → script name mapping from scripts-config dir. */
function buildScriptNameMap(configDir: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const realmRoot of getRealmRoots(configDir, "scripts/scripts-config")) {
    const configPath = path.join(realmRoot, "scripts", "scripts-config");
    for (const f of fs.readdirSync(configPath)) {
      if (!f.endsWith(".json")) continue;
      try {
        const data = JSON.parse(fs.readFileSync(path.join(configPath, f), "utf-8"));
        if (data._id && data.name) map.set(data._id, data.name);
      } catch { /* skip */ }
    }
  }
  return map;
}

/** Build theme UUID → theme name mapping from realms/*\/themes/<name>/<name>.json. */
function buildThemeNameMap(configDir: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const realmRoot of getRealmRoots(configDir, "themes")) {
    const themesDir = path.join(realmRoot, "themes");
    for (const entry of fs.readdirSync(themesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const jsonPath = path.join(themesDir, entry.name, `${entry.name}.json`);
      if (!fs.existsSync(jsonPath)) continue;
      try {
        const data = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
        if (data._id && data.name) map.set(data._id, data.name);
      } catch { /* skip */ }
    }
  }
  return map;
}

// ── Canonical node form ──────────────────────────────────────────────────────
// Strip per-env noise (UUIDs, revisions, layout) and resolve reference UUIDs to
// stable names so two semantically-equal nodes produce byte-identical output
// across environments.

const CANON_NOISE_KEYS = new Set(["_rev", "x", "y", "version", "nodeVersion"]);

interface CanonCtx {
  scriptNames: Map<string, string>;
  themeNames: Map<string, string>;
  /** Sibling nodes in the same journey. Used to rewrite connection UUIDs. */
  siblings: Map<string, Record<string, unknown>>;
}

function stableStringify(v: unknown): string {
  if (v === null || v === undefined) return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(o[k])).join(",") + "}";
  }
  return JSON.stringify(v);
}

function siblingLabel(uuid: string, ctx: CanonCtx): string {
  const n = ctx.siblings.get(uuid);
  if (!n) return `:uuid:${uuid}`;
  const disp = typeof n.displayName === "string" ? n.displayName : "";
  const t = n._type as { _id?: string } | undefined;
  const type = t?._id ?? "";
  return `${type}::${disp}`;
}

/** Recursively strip noise from nested objects/arrays. */
function canonRecurse(v: unknown): unknown {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(canonRecurse);
  const o = v as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(o)) {
    if (CANON_NOISE_KEYS.has(k) || k === "_id") continue;
    out[k] = canonRecurse(val);
  }
  return out;
}

function canonicalizeNode(node: Record<string, unknown>, ctx: CanonCtx): string {
  // Build outcome-id → stable label map from the node's own _outcomes. Scripted
  // decisions assign random UUIDs to each outcome; the displayName is stable.
  const outcomeLabel = new Map<string, string>();
  const outcomes = (node._outcomes as Array<Record<string, unknown>> | undefined) ?? [];
  for (const o of outcomes) {
    const id = typeof o.id === "string" ? o.id : null;
    if (!id) continue;
    const disp = typeof o.displayName === "string" ? o.displayName : "";
    outcomeLabel.set(id, disp || id);
  }

  const out: Record<string, unknown> = {};

  for (const [k, v] of Object.entries(node)) {
    if (CANON_NOISE_KEYS.has(k) || k === "_id") continue;

    if (k === "_type" && v && typeof v === "object") {
      // Keep the node-type discriminator but drop per-instance fields.
      const t = v as Record<string, unknown>;
      out[k] = { _id: t._id, name: t.name };
      continue;
    }

    if (k === "script" && typeof v === "string") {
      out[k] = ctx.scriptNames.get(v) ?? `:unresolved-script:${v}`;
      continue;
    }

    if (k === "stage" && v && typeof v === "object") {
      const s = { ...(v as Record<string, unknown>) };
      if (typeof s.themeId === "string") {
        s.themeId = ctx.themeNames.get(s.themeId) ?? `:unresolved-theme:${s.themeId}`;
      }
      out[k] = canonRecurse(s);
      continue;
    }

    if (k === "connections" && v && typeof v === "object" && !Array.isArray(v)) {
      // Rewrite both the outcome-UUID keys and the target-UUID values to
      // stable labels, so source/target forms match when the graph topology
      // is the same modulo per-env UUIDs.
      const rewritten: Record<string, string> = {};
      for (const [outKey, tgt] of Object.entries(v as Record<string, unknown>)) {
        const label = outcomeLabel.get(outKey) ?? outKey;
        rewritten[label] = typeof tgt === "string" ? siblingLabel(tgt, ctx) : String(tgt);
      }
      out[k] = rewritten;
      continue;
    }

    if (k === "_outcomes" && Array.isArray(v)) {
      out[k] = v.map((o: unknown) => {
        if (!o || typeof o !== "object") return o;
        const rec = o as Record<string, unknown>;
        const id = typeof rec.id === "string" ? rec.id : "";
        const disp = typeof rec.displayName === "string" ? rec.displayName : "";
        return { id: outcomeLabel.get(id) ?? id, displayName: disp };
      });
      continue;
    }

    if (k === "nodes" && Array.isArray(v)) {
      // PageNode sub-node list: keep only the stable identity fields. The
      // sub-nodes' full bodies live in separate files and are canonicalized
      // independently.
      out[k] = v.map((sub: unknown) => {
        if (!sub || typeof sub !== "object") return sub;
        const r = sub as Record<string, unknown>;
        return { nodeType: r.nodeType, displayName: r.displayName };
      });
      continue;
    }

    out[k] = canonRecurse(v);
  }

  return stableStringify(out);
}

function buildJourneyTree(
  sourceDir: string,
  targetDir: string,
  changedJourneys: Map<string, FileDiff["status"]>,
  changedScripts: Map<string, FileDiff["status"]>,
  changedScriptNames: Map<string, FileDiff["status"]>,  // script name → status (UUID-independent)
  changedNodeFiles: Map<string, FileDiff["status"]>,  // "journeyName/nodeUUID" → status
  forceIncludeJourneys?: Set<string>,  // Always include these in the tree, even if unchanged
): JourneyTreeNode[] {
  const sourceJourneys = scanJourneys(sourceDir);
  const targetJourneys = scanJourneys(targetDir);

  // Per-env name maps for canonicalization (keep separate so UUIDs resolve
  // using the side they actually came from). A merged view is also used below
  // for display lookups where we don't care which env contributed the name.
  const srcScriptNames = buildScriptNameMap(sourceDir);
  const tgtScriptNames = buildScriptNameMap(targetDir);
  const srcThemeNames = buildThemeNameMap(sourceDir);
  const tgtThemeNames = buildThemeNameMap(targetDir);
  const scriptNames = new Map<string, string>();
  for (const [k, v] of srcScriptNames) scriptNames.set(k, v);
  for (const [k, v] of tgtScriptNames) scriptNames.set(k, v);

  // Per-node canonical status for journeys present on both sides. A node whose
  // canonical form matches across envs is "unchanged" even if its raw JSON
  // differs (e.g. different UUIDs, layout shifts, revision bumps). Nodes only
  // on one side become "added"/"removed".
  const canonicalNodeStatus = new Map<string, FileDiff["status"]>();
  for (const name of new Set([...sourceJourneys.keys(), ...targetJourneys.keys()])) {
    const sMeta = sourceJourneys.get(name);
    const tMeta = targetJourneys.get(name);
    if (!sMeta || !tMeta) continue;
    const sCtx: CanonCtx = { scriptNames: srcScriptNames, themeNames: srcThemeNames, siblings: sMeta.rawNodes };
    const tCtx: CanonCtx = { scriptNames: tgtScriptNames, themeNames: tgtThemeNames, siblings: tMeta.rawNodes };
    const uuids = new Set([...sMeta.rawNodes.keys(), ...tMeta.rawNodes.keys()]);
    for (const uuid of uuids) {
      const sNode = sMeta.rawNodes.get(uuid);
      const tNode = tMeta.rawNodes.get(uuid);
      let status: FileDiff["status"];
      if (sNode && tNode) {
        status = canonicalizeNode(sNode, sCtx) === canonicalizeNode(tNode, tCtx)
          ? "unchanged"
          : "modified";
      } else if (sNode) {
        status = "removed";
      } else {
        status = "added";
      }
      canonicalNodeStatus.set(`${name}/${uuid}`, status);
    }
  }

  const allNames = new Set([...sourceJourneys.keys(), ...targetJourneys.keys()]);
  const calledBy = new Map<string, string[]>();

  for (const name of allNames) {
    const meta = targetJourneys.get(name) ?? sourceJourneys.get(name)!;
    for (const sub of meta.subJourneys) {
      if (!calledBy.has(sub)) calledBy.set(sub, []);
      calledBy.get(sub)!.push(name);
    }
  }

  function hasChangedDescendant(name: string, visited: Set<string>): boolean {
    if (visited.has(name)) return false;
    visited.add(name);
    if (changedJourneys.has(name)) return true;
    const meta = targetJourneys.get(name) ?? sourceJourneys.get(name);
    if (!meta) return false;
    // Also consider changed scripts
    if (meta.scriptUUIDs.some((uuid) => changedScripts.has(uuid))) return true;
    return meta.subJourneys.some((s) => hasChangedDescendant(s, visited));
  }

  function buildNode(name: string, visited: Set<string>): JourneyTreeNode | null {
    if (visited.has(name)) return null;
    visited.add(name);

    const meta = targetJourneys.get(name) ?? sourceJourneys.get(name);
    const status = changedJourneys.get(name) ?? "unchanged";
    const isEntry = !meta?.innerTreeOnly && !(calledBy.get(name)?.length);

    // Resolve scripts for this journey. Name-based lookup so a script renamed
    // to a different UUID across envs still resolves correctly.
    const scripts: JourneyScript[] = [];
    const nodes: JourneyNodeInfo[] = [];
    if (meta) {
      for (const uuid of meta.scriptUUIDs) {
        const scriptName = scriptNames.get(uuid) ?? uuid;
        const scriptStatus = changedScriptNames.get(scriptName)
          ?? changedScripts.get(uuid)
          ?? "unchanged";
        scripts.push({ uuid, name: scriptName, status: scriptStatus });
      }
      scripts.sort((a, b) => a.name.localeCompare(b.name));

      // For each node: a node may reference an independent resource (a script
      // or sub-journey). When it does, the node's visible status should reflect
      // that resource's own compare state — not blindly inherit "added"/"removed"
      // from the parent journey, since the resource may exist in the other env.
      const mergeRefStatus = (
        nodeFile: FileDiff["status"],
        ref: FileDiff["status"],
      ): FileDiff["status"] => {
        // If the node file itself differs (config change on the node), that
        // wins — the referenced resource's status is only the fallback.
        if (nodeFile === "modified") return "modified";
        return ref;
      };

      for (const nm of meta.allNodes) {
        // Prefer canonical equality when available (it correctly classifies
        // nodes that differ only in noise like _id/_rev/x/y). Fall back to the
        // raw file-diff status when the journey exists on only one side.
        const nodeFileStatus = canonicalNodeStatus.get(`${name}/${nm.uuid}`)
          ?? changedNodeFiles.get(`${name}/${nm.uuid}`)
          ?? "unchanged";
        let nodeStatus: FileDiff["status"] = nodeFileStatus;
        let modifiedReason: "script" | "subjourney" | undefined;

        const scriptUuid = meta.nodeScripts.get(nm.uuid);
        const subJourneyName = meta.nodeSubJourneys.get(nm.uuid);

        if (scriptUuid) {
          const scriptName = scriptNames.get(scriptUuid);
          const refStatus: FileDiff["status"] = scriptName
            ? (changedScriptNames.get(scriptName) ?? changedScripts.get(scriptUuid) ?? "unchanged")
            : "unchanged";
          nodeStatus = mergeRefStatus(nodeFileStatus, refStatus);
          if (nodeStatus === "modified" && refStatus === "modified" && nodeFileStatus !== "modified") {
            modifiedReason = "script";
          }
        } else if (subJourneyName) {
          let refStatus: FileDiff["status"] = changedJourneys.get(subJourneyName) ?? "unchanged";
          // Sub-journey unchanged itself but has changed descendants: treat
          // as modified so the node signals that something deeper shifted.
          if (refStatus === "unchanged" && hasChangedDescendant(subJourneyName, new Set())) {
            refStatus = "modified";
          }
          nodeStatus = mergeRefStatus(nodeFileStatus, refStatus);
          if (nodeStatus === "modified" && refStatus === "modified" && nodeFileStatus !== "modified") {
            modifiedReason = "subjourney";
          }
        }

        nodes.push({ uuid: nm.uuid, name: nm.name, displayName: nm.displayName, nodeType: nm.nodeType, status: nodeStatus, modifiedReason });
      }
      nodes.sort((a, b) => a.name.localeCompare(b.name));
    }

    const childNodes: JourneyTreeNode[] = [];
    if (meta) {
      for (const sub of meta.subJourneys) {
        const child = buildNode(sub, new Set(visited));
        if (child) childNodes.push(child);
      }
    }

    return { name, status, isEntry, subJourneys: childNodes, scripts, nodes };
  }

  const roots: JourneyTreeNode[] = [];
  for (const name of allNames) {
    const meta = targetJourneys.get(name) ?? sourceJourneys.get(name)!;
    const parents = calledBy.get(name) ?? [];
    const isEntry = parents.length === 0 && !meta.innerTreeOnly;
    if (!isEntry) continue;
    // Always build the full tree (including unchanged journeys). Client-side
    // filtering controls visibility via the "Hide unchanged files" checkbox.
    const node = buildNode(name, new Set());
    if (node) roots.push(node);
  }
  // forceIncludeJourneys is kept for backward compat but no longer needed
  // since we always include all entry journeys.
  void forceIncludeJourneys;

  return roots.sort((a, b) => a.name.localeCompare(b.name));
}

export function buildReport(
  source: CompareEndpoint,
  sourceDir: string,
  target: CompareEndpoint,
  targetDir: string,
  scopes?: string[],
  opts: DiffOptions = {},
  forceIncludeJourneys?: Set<string>,
): CompareReport {
  // Default: ignore whitespace, exclude metadata
  const effectiveOpts: DiffOptions = {
    includeMetadata: opts.includeMetadata ?? false,
    ignoreWhitespace: opts.ignoreWhitespace ?? true,
  };
  const files = compareDirs(targetDir, sourceDir, scopes, effectiveOpts);
  const summary = { added: 0, removed: 0, modified: 0, unchanged: 0 };
  for (const f of files) summary[f.status]++;

  // Build journey tree from changed journey and script files
  const changedJourneys = new Map<string, FileDiff["status"]>();
  const changedScripts = new Map<string, FileDiff["status"]>(); // UUID → status
  for (const f of files) {
    if (f.status === "unchanged") continue;
    const jm = f.relativePath.match(/(?:^|\/)?journeys\/([^/]+)\//);
    if (jm) {
      const existing = changedJourneys.get(jm[1]);
      if (!existing || f.status === "modified") changedJourneys.set(jm[1], f.status);
    }
    // Track changed script content files by extracting script name
    const sm = f.relativePath.match(/scripts-content\/[^/]+\/(.+)\.\w+$/);
    if (sm) {
      // We need UUID for matching — look up from script config
      // For now, track by content file name; we'll resolve in the tree builder
    }
  }

  // Build script name → status map from changed script content files
  const changedScriptNames = new Map<string, FileDiff["status"]>();
  for (const f of files) {
    if (f.status === "unchanged") continue;
    const sm = f.relativePath.match(/scripts-content\/[^/]+\/(.+)\.\w+$/);
    if (sm) changedScriptNames.set(sm[1], f.status);
  }

  // Resolve script name → UUID using config files from both dirs
  const scriptNameToUUID = new Map<string, string>();
  for (const dir of [sourceDir, targetDir]) {
    for (const realmRoot of getRealmRoots(dir, "scripts/scripts-config")) {
      const cfgDir = path.join(realmRoot, "scripts", "scripts-config");
      for (const f of fs.readdirSync(cfgDir)) {
        if (!f.endsWith(".json")) continue;
        try {
          const d = JSON.parse(fs.readFileSync(path.join(cfgDir, f), "utf-8"));
          if (d._id && d.name) scriptNameToUUID.set(d.name, d._id);
        } catch { /* skip */ }
      }
    }
  }

  for (const [name, status] of changedScriptNames) {
    const uuid = scriptNameToUUID.get(name);
    if (uuid) changedScripts.set(uuid, status);
  }

  // Track changed node files: "journeyName/nodeUUID" → status
  const changedNodeFiles = new Map<string, FileDiff["status"]>();
  for (const f of files) {
    if (f.status === "unchanged") continue;
    const nm = f.relativePath.match(/journeys\/([^/]+)\/nodes\/.*?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/i);
    if (nm) changedNodeFiles.set(`${nm[1]}/${nm[2]}`, f.status);
  }

  // Run the whole-journey semantic comparator first so we can prune file-diff
  // noise from changedJourneys before building the tree. Without this, journey
  // files that differ only in tenant-side _rev, empty-but-differently-shaped
  // uiConfig, or node-entry key order get flagged "modified" and cascade up to
  // any InnerTreeEvaluatorNode that references them.
  const semanticJourneys = loadSemanticJourneys(sourceDir, targetDir, scopes ?? []);
  if (semanticJourneys) {
    for (const rep of semanticJourneys) {
      if (rep.status === "equal") changedJourneys.delete(rep.name);
    }
  }

  let journeyTree: JourneyTreeNode[] | undefined;
  try {
    journeyTree = buildJourneyTree(sourceDir, targetDir, changedJourneys, changedScripts, changedScriptNames, changedNodeFiles, forceIncludeJourneys);
  } catch { /* ignore */ }

  return {
    source,
    target,
    generatedAt: new Date().toISOString(),
    options: effectiveOpts,
    summary,
    files,
    journeyTree,
    ...(semanticJourneys ? { semanticJourneys } : {}),
  };
}
