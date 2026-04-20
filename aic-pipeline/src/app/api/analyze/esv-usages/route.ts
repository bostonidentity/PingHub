import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { getConfigDir } from "@/lib/fr-config";
import { extractNamedRefs, stripJsComments } from "@/lib/analyze/esv-orphans";

export const dynamic = "force-dynamic";

const SKIP_DIR = new Set([".git", "node_modules", ".next", ".DS_Store"]);
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const BINARY_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".pdf",
  ".zip", ".gz", ".tar", ".tgz", ".7z", ".rar",
  ".mp3", ".mp4", ".mov", ".avi", ".wav",
  ".woff", ".woff2", ".ttf", ".eot", ".otf", ".class", ".jar",
]);

function* walk(dir: string, skipRoots: string[]): Generator<string> {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return; }
  for (const entry of entries) {
    if (SKIP_DIR.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (skipRoots.some((r) => full === r || full.startsWith(r + path.sep))) continue;
    if (entry.isDirectory()) yield* walk(full, skipRoots);
    else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (BINARY_EXT.has(ext)) continue;
      yield full;
    }
  }
}

function normalizeName(raw: string): string {
  let n = raw.trim().toLowerCase();
  if (n.startsWith("esv-")) n = n.slice(4);
  else if (n.startsWith("esv.")) n = n.slice(4);
  return n.replace(/\./g, "-");
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const env = sp.get("env") ?? "";
  const rawName = sp.get("name") ?? "";
  if (!env || !rawName) {
    return NextResponse.json({ error: "Missing env or name" }, { status: 400 });
  }
  const target = normalizeName(rawName);

  const configDir = getConfigDir(env);
  if (!configDir || !fs.existsSync(configDir)) {
    return NextResponse.json({ error: "Environment config directory not found" }, { status: 404 });
  }

  const skipRoots = [path.join(configDir, "esvs")];
  const references: { path: string; line: number; snippet: string; form: string }[] = [];
  let scannedFiles = 0;

  for (const abs of walk(configDir, skipRoots)) {
    if (req.signal.aborted) break;
    let stat: fs.Stats;
    try { stat = fs.statSync(abs); } catch { continue; }
    if (stat.size > MAX_FILE_BYTES) continue;
    let text: string;
    try { text = fs.readFileSync(abs, "utf8"); } catch { continue; }
    scannedFiles += 1;
    const rel = path.relative(configDir, abs).split(path.sep).join("/");
    const ext = path.extname(abs).toLowerCase();
    const scanText = ext === ".js" || ext === ".groovy" || ext === ".mjs" || ext === ".cjs"
      ? stripJsComments(text)
      : text;
    const refs = extractNamedRefs(scanText, rel, text);
    for (const r of refs) {
      if (r.name === target) {
        references.push({ path: r.path, line: r.line, snippet: r.snippet, form: r.form });
      }
    }
  }

  references.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);

  return NextResponse.json({
    env,
    name: target,
    references,
    scannedFiles,
  });
}
