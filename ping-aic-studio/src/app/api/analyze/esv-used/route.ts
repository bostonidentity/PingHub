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

export async function GET(req: NextRequest) {
  const env = req.nextUrl.searchParams.get("env") ?? "";
  if (!env) return NextResponse.json({ error: "Missing env" }, { status: 400 });

  const configDir = getConfigDir(env);
  if (!configDir || !fs.existsSync(configDir)) {
    return NextResponse.json({ error: "Environment config directory not found" }, { status: 404 });
  }

  const skipRoots = [path.join(configDir, "esvs")];
  const names = new Set<string>();
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
    for (const r of extractNamedRefs(scanText, rel, text)) names.add(r.name);
  }

  return NextResponse.json({ env, names: Array.from(names).sort(), scannedFiles });
}
