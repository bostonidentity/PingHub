import fs from "node:fs";
import path from "node:path";

import { ENVIRONMENTS_DIR } from "../paths";
import type { MonitorsFile } from "./types";

const FILENAME = "monitors.json";

function monitorsPath(): string {
    return path.join(ENVIRONMENTS_DIR, FILENAME);
}

const EMPTY: MonitorsFile = { groups: [], monitors: [] };

export function readMonitors(): MonitorsFile {
    const file = monitorsPath();
    if (!fs.existsSync(file)) return structuredClone(EMPTY);
    try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<MonitorsFile>;
        return {
            groups: Array.isArray(parsed.groups) ? parsed.groups : [],
            monitors: Array.isArray(parsed.monitors) ? parsed.monitors : [],
        };
    } catch {
        return structuredClone(EMPTY);
    }
}

export function writeMonitors(data: MonitorsFile): void {
    const file = monitorsPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

export function monitorsFilePath(): string {
    return monitorsPath();
}
