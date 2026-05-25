import fs from "node:fs";
import path from "node:path";

import { ENVIRONMENTS_DIR } from "../paths";
import type { TlsMonitorsFile } from "./tls-types";

const FILENAME = "tls-monitors.json";

function filePath(): string {
    return path.join(ENVIRONMENTS_DIR, FILENAME);
}

const EMPTY: TlsMonitorsFile = { groups: [], targets: [] };

export function readTlsMonitors(): TlsMonitorsFile {
    const file = filePath();
    if (!fs.existsSync(file)) return structuredClone(EMPTY);
    try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<TlsMonitorsFile>;
        return {
            groups: Array.isArray(parsed.groups) ? parsed.groups : [],
            targets: Array.isArray(parsed.targets) ? parsed.targets : [],
        };
    } catch {
        return structuredClone(EMPTY);
    }
}

export function writeTlsMonitors(data: TlsMonitorsFile): void {
    const file = filePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

export function tlsMonitorsFilePath(): string {
    return filePath();
}
