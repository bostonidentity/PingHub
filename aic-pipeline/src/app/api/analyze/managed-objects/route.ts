import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { getConfigDir } from "@/lib/fr-config";

export const dynamic = "force-dynamic";

/**
 * A single relationship emitted by a managed object schema:
 *   typeA ── field ──▶ typeB
 * The array flag distinguishes one-to-many from one-to-one, and the
 * reverse flag tracks properties declared `reverseRelationship: true`
 * (back-references pointed at by the "forward" side).
 */
export interface ManagedObjectRelationship {
  /** Source managed object (e.g. "alpha_group"). */
  source: string;
  /** Field name on the source that holds the relationship (e.g. "members"). */
  field: string;
  /** Target managed object (e.g. "alpha_user"). */
  target: string;
  /** True when the property is an array of relationships. */
  isArray: boolean;
  /** True when this is the reverse side of another relationship. */
  isReverse: boolean;
}

export interface ManagedObjectType {
  /** Directory + schema name (e.g. "alpha_user"). */
  name: string;
  /** Count of fields pointing outward. Used for node sizing. */
  outgoingCount: number;
  /** Count of fields pointing in (computed by the caller across all types). */
  incomingCount: number;
}

export interface ManagedObjectsReport {
  types: ManagedObjectType[];
  relationships: ManagedObjectRelationship[];
}

/** Walk a property definition and yield any resourceCollection targets it references. */
function extractTargets(prop: unknown): { targets: string[]; isArray: boolean } | null {
  if (!prop || typeof prop !== "object") return null;
  const p = prop as Record<string, unknown>;

  // Direct single relationship:  { type: "relationship", resourceCollection: [...] }
  if (Array.isArray(p.resourceCollection)) {
    const targets = collectTargets(p.resourceCollection);
    if (targets.length > 0) return { targets, isArray: false };
  }

  // Array of relationships:      { type: "array", items: { type: "relationship", resourceCollection: [...] } }
  if (p.type === "array" && p.items && typeof p.items === "object") {
    const items = p.items as Record<string, unknown>;
    if (Array.isArray(items.resourceCollection)) {
      const targets = collectTargets(items.resourceCollection);
      if (targets.length > 0) return { targets, isArray: true };
    }
  }

  return null;
}

function collectTargets(rcList: unknown[]): string[] {
  const out: string[] = [];
  for (const rc of rcList) {
    if (!rc || typeof rc !== "object") continue;
    const pathStr = (rc as Record<string, unknown>).path;
    if (typeof pathStr !== "string") continue;
    // "managed/alpha_user" → "alpha_user"
    const m = pathStr.match(/^managed\/(.+)$/);
    if (m) out.push(m[1]);
  }
  return out;
}

function readManagedObject(filePath: string): { name: string; relationships: ManagedObjectRelationship[] } | null {
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }

  const name = typeof json.name === "string" ? json.name : path.basename(filePath, ".json");
  const schema = (json.schema ?? {}) as Record<string, unknown>;
  const properties = (schema.properties ?? {}) as Record<string, unknown>;

  const relationships: ManagedObjectRelationship[] = [];
  for (const [field, prop] of Object.entries(properties)) {
    const ext = extractTargets(prop);
    if (!ext) continue;
    const isReverse = !!(prop && typeof prop === "object" && (prop as Record<string, unknown>).reverseRelationship);
    for (const target of ext.targets) {
      relationships.push({ source: name, field, target, isArray: ext.isArray, isReverse });
    }
  }

  return { name, relationships };
}

export async function POST(req: NextRequest) {
  const { env } = await req.json();
  if (!env) return NextResponse.json({ error: "env is required" }, { status: 400 });

  const configDir = getConfigDir(env);
  if (!configDir) return NextResponse.json({ error: "Config dir not found" }, { status: 404 });

  const managedDir = path.join(configDir, "managed-objects");
  if (!fs.existsSync(managedDir)) {
    return NextResponse.json({ types: [], relationships: [] } satisfies ManagedObjectsReport);
  }

  const typesByName = new Map<string, { outgoing: number; incoming: number }>();
  const relationships: ManagedObjectRelationship[] = [];

  for (const entry of fs.readdirSync(managedDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const jsonFile = path.join(managedDir, entry.name, `${entry.name}.json`);
    if (!fs.existsSync(jsonFile)) continue;
    const mo = readManagedObject(jsonFile);
    if (!mo) continue;
    typesByName.set(mo.name, typesByName.get(mo.name) ?? { outgoing: 0, incoming: 0 });
    for (const rel of mo.relationships) {
      relationships.push(rel);
    }
  }

  // Tally outgoing/incoming. Register the target as a type even if the
  // target's own schema file is missing — a referenced type is still
  // worth showing in the graph (it's just an externally-managed one).
  for (const rel of relationships) {
    const src = typesByName.get(rel.source) ?? { outgoing: 0, incoming: 0 };
    src.outgoing += 1;
    typesByName.set(rel.source, src);
    const tgt = typesByName.get(rel.target) ?? { outgoing: 0, incoming: 0 };
    tgt.incoming += 1;
    typesByName.set(rel.target, tgt);
  }

  const types: ManagedObjectType[] = [...typesByName.entries()]
    .map(([name, v]) => ({ name, outgoingCount: v.outgoing, incomingCount: v.incoming }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return NextResponse.json({ types, relationships } satisfies ManagedObjectsReport);
}
