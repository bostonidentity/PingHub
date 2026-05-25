import { existsSync } from "fs";
import path from "path";

export const NDJSON_FILE = "data.ndjson";
export const OFFSETS_FILE = "_offsets.json";

/** True when the type directory was pulled with the NDJSON storage format. */
export function isNDJsonFormat(typeDir: string): boolean {
  return existsSync(path.join(typeDir, NDJSON_FILE));
}

/** Map of record id → byte offset in data.ndjson where the record's line begins. */
export type Offsets = Record<string, number>;
