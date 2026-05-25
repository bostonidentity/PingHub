import fs from "node:fs";
import path from "node:path";
import { ENVIRONMENTS_DIR } from "../paths";
import type { HealthCacheEntry } from "./types";

const FILE = "health.json";

function filePath(envName: string): string {
    return path.join(ENVIRONMENTS_DIR, envName, FILE);
}

export function readHealthInfo(envName: string): HealthCacheEntry | null {
    const fp = filePath(envName);
    if (!fs.existsSync(fp)) return null;
    try {
        return JSON.parse(fs.readFileSync(fp, "utf8")) as HealthCacheEntry;
    } catch {
        return null;
    }
}

export function writeHealthInfo(envName: string, entry: HealthCacheEntry): void {
    const fp = filePath(envName);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, JSON.stringify(entry, null, 2) + "\n");
}
