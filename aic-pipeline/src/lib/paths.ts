import path from "node:path";
import { resolveTargetDir } from "./git-settings";

/**
 * Root directory for environment data (configs, managed-data, etc.).
 *
 * Resolution order:
 *  1. `PINGHUB_DATA_DIR` env var (highest priority, for CI / custom layouts)
 *  2. `targetDir` from git-settings.json (user-configurable via Settings UI)
 *  3. `../environments` relative to the Next.js project root (default)
 */
export const ENVIRONMENTS_DIR: string =
    process.env.PINGHUB_DATA_DIR
        ? path.resolve(process.env.PINGHUB_DATA_DIR)
        : resolveTargetDir();
