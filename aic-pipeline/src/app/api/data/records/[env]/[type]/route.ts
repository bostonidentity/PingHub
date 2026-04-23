import { NextRequest, NextResponse } from "next/server";
import path from "path";
import fs from "fs";
import { cwd } from "process";
import { getConfigDir } from "@/lib/fr-config";
import { listRecords } from "@/lib/data/snapshot-fs";
import { deriveDisplayFields, fallbackDisplayFields } from "@/lib/data/display-fields";

export const dynamic = "force-dynamic";

function loadSchema(env: string, type: string): Record<string, unknown> | null {
  const configDir = getConfigDir(env);
  if (!configDir) return null;
  const p = path.join(configDir, "managed-objects", type, `${type}.json`);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return null; }
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ env: string; type: string }> },
) {
  const { env, type } = await params;
  const url = new URL(req.url);
  const q = url.searchParams.get("q") ?? "";
  const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1", 10));
  const limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get("limit") ?? "50", 10)));
  const titleField = url.searchParams.get("titleField")?.trim() || undefined;

  const schema = loadSchema(env, type);
  const envsRoot = path.join(cwd(), "environments");
  let display;
  if (schema) {
    display = deriveDisplayFields(schema);
  } else {
    display = fallbackDisplayFields({});
  }

  const result = await listRecords(envsRoot, env, type, { q, page, limit, display, titleField });
  return NextResponse.json(result);
}
