import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { getConfigDir } from "@/lib/fr-config";
import {
  categorizeFilePath,
  findNearestJsonFieldName,
  type Category,
} from "@/lib/managed-object-usage";

const TYPE_RE = /^[A-Za-z0-9_-]+$/;
const MAX_FILES = 20_000;
const MAX_BYTES_PER_FILE = 5 * 1024 * 1024;
const MAX_HITS = 2_000;
const TIMEOUT_MS = 30_000;

type Hit = {
  category: Category;
  filePath: string;
  line: number;
  column: number;
  snippet: string;
  fieldName: string | null;
  realmRoot: string | null;
  isSelfReference: boolean;
};

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function* walkFiles(rootDir: string): Generator<string> {
  const stack: string[] = [rootDir];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      if (e.name === "node_modules") continue;
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(fp);
      } else if (e.isFile()) {
        if (e.name.endsWith(".json") || e.name.endsWith(".js")) {
          yield fp;
        }
      }
    }
  }
}

function relPathFromRoot(rootDir: string, abs: string): string {
  return path.relative(rootDir, abs).replace(/\\/g, "/");
}

function detectRealmRoot(rel: string): string | null {
  const m = rel.match(/^(?:realms\/)?([^/]+)\//);
  if (!m) return null;
  const NON_REALM = new Set([
    "endpoints", "iga", "sync", "schedules", "internal-roles",
    "access-config", "agents", "misc",
  ]);
  if (NON_REALM.has(m[1])) return null;
  return m[1];
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const env = searchParams.get("env");
  const type = searchParams.get("type");

  if (!env) return NextResponse.json({ error: "env required" }, { status: 400 });
  if (!type) return NextResponse.json({ error: "type required" }, { status: 400 });
  if (!TYPE_RE.test(type)) return NextResponse.json({ error: "invalid type" }, { status: 400 });

  const configDir = getConfigDir(env);
  if (!configDir || !fs.existsSync(configDir)) {
    return NextResponse.json({ error: "Config dir not found" }, { status: 404 });
  }

  const query = `managed/${type}`;
  const matchRe = new RegExp(`\\bmanaged/${escapeRegExp(type)}(?=[/"'\\s,)\\]}]|$)`, "g");
  const selfRefRe = new RegExp(`(?:^|/)managed-objects/${escapeRegExp(type)}/`);

  const t0 = Date.now();
  const hits: Hit[] = [];
  let files = 0;
  let bytes = 0;
  let skipped = 0;
  let errors = 0;
  let truncated = false;

  outer:
  for (const abs of walkFiles(configDir)) {
    if (files >= MAX_FILES || hits.length >= MAX_HITS) { truncated = true; break; }
    if (Date.now() - t0 > TIMEOUT_MS) { truncated = true; break; }

    files++;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch {
      errors++;
      continue;
    }
    if (stat.size > MAX_BYTES_PER_FILE) { skipped++; continue; }
    bytes += stat.size;

    let src: string;
    try {
      src = fs.readFileSync(abs, "utf-8");
    } catch {
      errors++;
      continue;
    }

    const rel = relPathFromRoot(configDir, abs);
    const isJson = abs.endsWith(".json");
    const category = categorizeFilePath(rel);
    const realmRoot = detectRealmRoot(rel);
    const isSelfReference = category === "managed-object-config" && selfRefRe.test(rel);

    for (const m of src.matchAll(matchRe)) {
      if (hits.length >= MAX_HITS) { truncated = true; break outer; }
      const idx = m.index ?? 0;
      const before = src.slice(0, idx);
      const line = (before.match(/\n/g)?.length ?? 0) + 1;
      const lastNl = before.lastIndexOf("\n");
      const column = idx - (lastNl + 1) + 1;
      const lineEnd = src.indexOf("\n", idx);
      const fullLine = src.slice(lastNl + 1, lineEnd === -1 ? src.length : lineEnd);
      const snippet = fullLine.length > 200 ? fullLine.slice(0, 200) + "…" : fullLine;
      const fieldName = isJson ? findNearestJsonFieldName(src, idx) : null;

      hits.push({
        category, filePath: rel, line, column, snippet,
        fieldName, realmRoot, isSelfReference,
      });
    }
  }

  const counts = hits.reduce<Record<Category, number>>((acc, h) => {
    acc[h.category] = (acc[h.category] ?? 0) + 1;
    return acc;
  }, {} as Record<Category, number>);

  console.log(`[managed-object-usage] env=${env} type=${type} files=${files} hits=${hits.length} ms=${Date.now() - t0} truncated=${truncated}`);

  return NextResponse.json({
    env,
    type,
    query,
    scanned: { files, bytes, ms: Date.now() - t0, skipped, errors },
    truncated,
    hits,
    counts: { byCategory: counts },
  });
}
