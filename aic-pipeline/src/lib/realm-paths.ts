/**
 * Realm directory resolution helpers.
 *
 * Two on-disk layouts exist depending on how the env was pulled:
 *   1. configDir/realms/<realm>/<subdir>   (upstream-style)
 *   2. configDir/<realm>/<subdir>           (vendored pull output)
 *
 * These helpers probe both so analyze/audit/item routes work either way.
 */

import fs from "fs";
import path from "path";

/**
 * Return absolute paths to realm roots across both layouts.
 * A "realm root" is a directory that contains realm-scoped subdirs
 * like `journeys/`, `scripts/`, `services/` etc.
 *
 * When `requiredSubdir` is set, only roots containing that subdir are
 * returned — this is the fast path when the caller already knows
 * which scope it's looking for (avoids returning unrelated top-level
 * directories that happen to share the configDir).
 */
export function getRealmRoots(configDir: string, requiredSubdir?: string): string[] {
  if (!fs.existsSync(configDir)) return [];
  const roots: string[] = [];
  const seen = new Set<string>();
  const push = (root: string) => {
    if (seen.has(root)) return;
    if (requiredSubdir && !fs.existsSync(path.join(root, requiredSubdir))) return;
    seen.add(root);
    roots.push(root);
  };

  const realmsRoot = path.join(configDir, "realms");
  if (fs.existsSync(realmsRoot)) {
    for (const e of fs.readdirSync(realmsRoot, { withFileTypes: true })) {
      if (e.isDirectory()) push(path.join(realmsRoot, e.name));
    }
  }
  for (const e of fs.readdirSync(configDir, { withFileTypes: true })) {
    if (e.isDirectory() && e.name !== "realms") push(path.join(configDir, e.name));
  }
  return roots;
}

/**
 * Return the first realm root whose <subpath> exists, or null.
 * Use when you need to locate a specific item (e.g. a journey by id).
 */
export function findRealmContaining(configDir: string, subpath: string): string | null {
  for (const root of getRealmRoots(configDir)) {
    if (fs.existsSync(path.join(root, subpath))) return root;
  }
  return null;
}
