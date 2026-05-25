import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { getConfigDir } from "@/lib/fr-config";
import { findRealmContaining } from "@/lib/realm-paths";
import { pathToScopeItem } from "@/lib/scope-paths";

/**
 * Given a config-relative file path, return the scope + audit-item id that
 * owns it. Needed because pathToScopeItem alone can't resolve script content
 * files to their UUID — that mapping requires reading scripts-config JSON
 * to match by name + context.
 *
 * Response:
 *   { scope: string; itemId: string; fileName: string }
 * or
 *   { error: string }
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ env: string }> },
) {
  const { env } = await params;
  const relPath = req.nextUrl.searchParams.get("path");
  if (!relPath) return NextResponse.json({ error: "path required" }, { status: 400 });

  const configDir = getConfigDir(env);
  if (!configDir) return NextResponse.json({ error: "env not found" }, { status: 404 });

  const norm = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const fileName = norm.split("/").pop() ?? norm;

  const parsed = pathToScopeItem(norm);
  if (!parsed) return NextResponse.json({ error: "unable to resolve scope" }, { status: 404 });

  // For script content files (scripts-content/<context>/<name>.{js,groovy})
  // the path-derived "item" is the content filename, but the Browse audit
  // uses the scripts-config UUID as the id. Look up the UUID by walking
  // scripts-config until we find a JSON whose name+context match.
  if (parsed.scope === "scripts") {
    const isContent = norm.includes("/scripts/scripts-content/");
    if (isContent) {
      // Derive script name + context from the path
      const afterContent = norm.split("/scripts/scripts-content/")[1] ?? "";
      const parts = afterContent.split("/");
      const context = parts[0] ?? "";
      const contentFile = parts[parts.length - 1] ?? "";
      const scriptName = contentFile.replace(/\.(js|groovy)$/i, "");

      const realmRoot = findRealmContaining(configDir, "scripts/scripts-config");
      if (realmRoot) {
        const configPath = path.join(realmRoot, "scripts", "scripts-config");
        for (const file of fs.readdirSync(configPath)) {
          try {
            const json = JSON.parse(fs.readFileSync(path.join(configPath, file), "utf-8"));
            if (json.name === scriptName && (!context || json.context === context)) {
              return NextResponse.json({ scope: "scripts", itemId: file, fileName });
            }
          } catch { /* skip */ }
        }
      }
      // Fall through: return the content filename as a best-effort
    }
  }

  // journeys, managed-objects, endpoints, etc: parsed.item is the
  // audit-item id already. For scripts-config files the item is the UUID
  // filename (parsed.item from pathToScopeItem already handles this).
  return NextResponse.json({ scope: parsed.scope, itemId: parsed.item, fileName });
}
