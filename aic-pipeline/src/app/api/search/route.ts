import { NextRequest, NextResponse } from "next/server";
import path from "path";
import fs from "fs";
import { getConfigDir } from "@/lib/fr-config";
import { pathToScopeItem } from "@/lib/scope-paths";
import type { SearchResponse, SearchFileResult, SearchMatch } from "@/app/search/types";

export const dynamic = "force-dynamic";

const MAX_RESULTS = 500;            // hard cap on file results
const MAX_MATCHES_PER_FILE = 50;    // per-file hit cap
const MAX_FILE_BYTES = 2 * 1024 * 1024; // skip files larger than 2MB
const MAX_LINE_LENGTH = 500;        // truncate very long lines

const SKIP_DIR = new Set([".git", "node_modules", ".next", ".DS_Store"]);

const BINARY_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico",
  ".pdf", ".zip", ".gz", ".tar", ".tgz", ".7z", ".rar",
  ".mp3", ".mp4", ".mov", ".avi", ".wav",
  ".woff", ".woff2", ".ttf", ".eot", ".otf",
  ".class", ".jar",
]);

/** Convert a simple glob pattern to a RegExp. Supports **, *, ?, {a,b}. */
function globToRegExp(glob: string): RegExp {
  let i = 0;
  let out = "^";
  while (i < glob.length) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i += 2;
        if (glob[i] === "/") i++;
      } else {
        out += "[^/]*";
        i++;
      }
    } else if (c === "?") {
      out += "[^/]";
      i++;
    } else if (c === "{") {
      const end = glob.indexOf("}", i);
      if (end === -1) { out += "\\{"; i++; continue; }
      const alts = glob.slice(i + 1, end).split(",").map((a) => a.replace(/[.+^${}()|[\]\\]/g, "\\$&"));
      out += "(?:" + alts.join("|") + ")";
      i = end + 1;
    } else if (".+^${}()|[]\\".includes(c)) {
      out += "\\" + c;
      i++;
    } else {
      out += c;
      i++;
    }
  }
  out += "$";
  return new RegExp(out);
}

function isLikelyBinaryBuffer(buf: Buffer): boolean {
  const n = Math.min(buf.length, 512);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

function buildQueryRegExp(q: string, isRegex: boolean, isCase: boolean, isWord: boolean): RegExp {
  let pattern = isRegex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (isWord) pattern = `\\b(?:${pattern})\\b`;
  return new RegExp(pattern, isCase ? "g" : "gi");
}

function* walk(dir: string): Generator<string> {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return; }
  for (const entry of entries) {
    if (SKIP_DIR.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (BINARY_EXT.has(ext)) continue;
      yield full;
    }
  }
}

function findMatchesInLine(line: string, queryRe: RegExp): { start: number; end: number }[] {
  const subs: { start: number; end: number }[] = [];
  let cap = 0;
  for (const m of line.matchAll(queryRe)) {
    const idx = m.index ?? 0;
    const len = m[0].length;
    if (len === 0) break; // avoid infinite loop on zero-width patterns
    subs.push({ start: idx, end: idx + len });
    if (++cap >= 32) break;
  }
  return subs;
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const env = sp.get("env") ?? "";
  const q = sp.get("q") ?? "";
  const isRegex = sp.get("regex") === "1";
  const isCase = sp.get("case") === "1";
  const isWord = sp.get("word") === "1";
  const glob = sp.get("glob") ?? "";

  if (!env || !q) {
    return NextResponse.json({ error: "Missing env or q" }, { status: 400 });
  }

  const configDir = getConfigDir(env);
  if (!configDir || !fs.existsSync(configDir)) {
    return NextResponse.json({ error: "Environment config directory not found" }, { status: 404 });
  }

  let queryRe: RegExp;
  try {
    queryRe = buildQueryRegExp(q, isRegex, isCase, isWord);
  } catch (e) {
    return NextResponse.json({ error: `Invalid pattern: ${(e as Error).message}` }, { status: 400 });
  }

  const globRe = glob ? globToRegExp(glob) : null;

  const results: SearchFileResult[] = [];
  let totalMatches = 0;
  let truncated = false;

  for (const abs of walk(configDir)) {
    if (req.signal.aborted) { truncated = true; break; }
    const rel = path.relative(configDir, abs).split(path.sep).join("/");
    if (globRe && !globRe.test(rel)) continue;

    let stat: fs.Stats;
    try { stat = fs.statSync(abs); } catch { continue; }
    if (stat.size > MAX_FILE_BYTES) continue;

    let buf: Buffer;
    try { buf = fs.readFileSync(abs); } catch { continue; }
    if (isLikelyBinaryBuffer(buf)) continue;

    const text = buf.toString("utf8");
    const matches: SearchMatch[] = [];
    const lines = text.split("\n");
    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      if (matches.length >= MAX_MATCHES_PER_FILE) break;
      const line = lines[lineIdx];
      const display = line.length > MAX_LINE_LENGTH ? line.slice(0, MAX_LINE_LENGTH) : line;
      const submatches = findMatchesInLine(display, queryRe);
      if (submatches.length > 0) {
        matches.push({ line: lineIdx + 1, text: display, submatches });
      }
    }

    if (matches.length === 0) continue;
    if (results.length >= MAX_RESULTS) { truncated = true; break; }

    // Map the on-disk path back to a config scope (journeys, scripts,
    // managed-objects, …) so results group by scope rather than by the
    // top-level directory, which for realm-based paths is just the realm.
    const parsed = pathToScopeItem(rel);
    const scope = parsed?.scope ?? (rel.split("/")[0] ?? "");
    results.push({ path: rel, scope, matches });
    totalMatches += matches.length;
  }

  results.sort((a, b) => a.path.localeCompare(b.path));

  const out: SearchResponse = { results, totalFiles: results.length, totalMatches, truncated };
  return NextResponse.json(out);
}
