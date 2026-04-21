// src/app/api/data/search/[env]/route.ts
import { NextRequest, NextResponse } from "next/server";
import path from "path";
import fs from "fs";
import { cwd } from "process";

export const dynamic = "force-dynamic";

export interface GlobalSearchHit {
  type: string;
  id: string;
  /** First matching key or value (truncated), to give the user context. */
  preview: string;
}

export interface GlobalSearchResponse {
  /** Hits across all types, capped at `limit`. Empty for empty query. */
  hits: GlobalSearchHit[];
  /** True when the cap was hit and more results exist. */
  truncated: boolean;
  /** Error message when the regex pattern failed to compile. */
  error?: string;
}

const DEFAULT_LIMIT = 200;
const HARD_LIMIT = 1000;
const PREVIEW_LEN = 140;

function previewFrom(raw: string, index: number): string {
  const start = Math.max(0, index - 20);
  const slice = raw.slice(start, start + PREVIEW_LEN);
  return (start > 0 ? "…" : "") + slice + (start + PREVIEW_LEN < raw.length ? "…" : "");
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ env: string }> },
) {
  const { env } = await params;
  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  const isRegex = url.searchParams.get("regex") === "true";
  const caseSensitive = url.searchParams.get("caseSensitive") === "true";
  const limit = Math.min(HARD_LIMIT, Math.max(1, parseInt(url.searchParams.get("limit") ?? String(DEFAULT_LIMIT), 10)));

  if (!q) {
    return NextResponse.json({ hits: [], truncated: false } satisfies GlobalSearchResponse);
  }

  const envsRoot = path.join(cwd(), "environments");
  const managedDir = path.join(envsRoot, env, "managed-data");
  if (!fs.existsSync(managedDir)) {
    return NextResponse.json({ hits: [], truncated: false } satisfies GlobalSearchResponse);
  }

  let findIndex: (raw: string) => number;
  if (isRegex) {
    try {
      const re = new RegExp(q, caseSensitive ? "" : "i");
      findIndex = (raw: string) => raw.search(re);
    } catch (e) {
      return NextResponse.json(
        { hits: [], truncated: false, error: `Invalid regex: ${(e as Error).message}` } satisfies GlobalSearchResponse,
      );
    }
  } else {
    const needle = caseSensitive ? q : q.toLowerCase();
    findIndex = (raw: string) => (caseSensitive ? raw : raw.toLowerCase()).indexOf(needle);
  }

  const hits: GlobalSearchHit[] = [];
  let truncated = false;

  outer:
  for (const typeEntry of fs.readdirSync(managedDir, { withFileTypes: true })) {
    if (!typeEntry.isDirectory() || typeEntry.name.startsWith(".")) continue;
    const typeDir = path.join(managedDir, typeEntry.name);
    const manifestPath = path.join(typeDir, "_manifest.json");
    if (!fs.existsSync(manifestPath)) continue; // unpulled / partial

    for (const f of fs.readdirSync(typeDir)) {
      if (!f.endsWith(".json") || f === "_manifest.json") continue;
      try {
        const raw = fs.readFileSync(path.join(typeDir, f), "utf-8");
        const idx = findIndex(raw);
        if (idx < 0) continue;
        hits.push({
          type: typeEntry.name,
          id: f.replace(/\.json$/, ""),
          preview: previewFrom(raw, idx),
        });
        if (hits.length >= limit) { truncated = true; break outer; }
      } catch { /* skip unreadable */ }
    }
  }

  return NextResponse.json({ hits, truncated } satisfies GlobalSearchResponse);
}
