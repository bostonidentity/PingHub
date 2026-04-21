import type { DisplayFields } from "./types";

type Schema = {
  schema?: {
    properties?: Record<string, { type?: string; searchable?: boolean }>;
  };
};

function findNameKey(keys: string[]): string | undefined {
  return keys.find((k) => k.toLowerCase() === "name");
}

// Rule: if a "name" attribute exists (case-insensitive), use it; else "_id".
// searchFields is retained on the type for backward compatibility but list
// search is now full-JSON (see snapshot-fs.listRecords), so it is no longer
// consulted by the browse search path. It still seeds export's search-field
// derivation as a fallback when no sample is available.
export function deriveDisplayFields(schema: Schema): DisplayFields {
  const props = schema.schema?.properties ?? {};
  const keys = Object.keys(props);
  const title = findNameKey(keys) ?? "_id";
  return { title, searchFields: [title] };
}

export function fallbackDisplayFields(record: Record<string, unknown>): DisplayFields {
  const nameKey = findNameKey(Object.keys(record));
  const title = nameKey ?? "_id";
  return { title, searchFields: [title] };
}
