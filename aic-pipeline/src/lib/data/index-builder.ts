import fs from "fs";
import path from "path";
import readline from "readline";
import { openIndexDb } from "./index-db";
import { NDJSON_FILE } from "./ndjson-format";

export type PickIndexFields = (record: Record<string, unknown>) => Record<string, string>;

interface Row {
  id: string;
  ord: number;
  offset: number;
  length: number;
  fields_json: string;
  searchable: string;
}

/**
 * Build (or rebuild) `index.sqlite` in `typeDir` from `data.ndjson`.
 *
 * Streams the NDJSON line-by-line; each line is one record. Inserts are
 * wrapped in a single transaction for throughput (~50× faster than autocommit
 * on better-sqlite3). Returns the number of rows inserted.
 *
 * Idempotent: existing rows are deleted before insertion. Safe to call to
 * recover from a partial pull.
 */
export async function buildIndexFromNDJson(
  typeDir: string,
  pickIndexFields: PickIndexFields,
): Promise<number> {
  const ndjsonPath = path.join(typeDir, NDJSON_FILE);
  if (!fs.existsSync(ndjsonPath)) return 0;

  // Stream NDJSON to collect rows. The whole row set fits in memory because
  // each row is just id + offset + length + scalar-fields JSON — small even
  // for millions of records (< 1 GB at 5M rows).
  const rows: Row[] = [];
  const stream = fs.createReadStream(ndjsonPath);
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let offset = 0;
  let ord = 0;
  for await (const line of rl) {
    if (!line) {
      offset += 1; // empty line is just the newline
      continue;
    }
    const length = Buffer.byteLength(line, "utf-8");
    try {
      const r = JSON.parse(line) as Record<string, unknown>;
      const id = typeof r._id === "string" ? r._id : "";
      if (id) {
        const fields = pickIndexFields(r);
        rows.push({
          id,
          ord,
          offset,
          length,
          fields_json: JSON.stringify(fields),
          searchable: Object.values(fields).join(" ").toLowerCase(),
        });
        ord++;
      }
    } catch { /* skip malformed line */ }
    offset += length + 1; // +1 for the newline separator
  }
  rl.close();
  stream.destroy();

  const db = openIndexDb(typeDir);
  try {
    db.prepare("DELETE FROM records").run();
    const insert = db.prepare(
      "INSERT INTO records(id, ord, offset, length, fields_json, searchable) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const insertAll = db.transaction((batch: Row[]) => {
      for (const r of batch) {
        insert.run(r.id, r.ord, r.offset, r.length, r.fields_json, r.searchable);
      }
    });
    insertAll(rows);
    return rows.length;
  } finally {
    db.close();
  }
}
