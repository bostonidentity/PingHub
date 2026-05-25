export interface LogMatchEntry {
  timestamp?: string;
  type?: string;
  source?: string;
  payload?: unknown;
}

export interface LogMatchRow {
  key: string;
  index: number;
}

export function logEntryMatchKey(entry: LogMatchEntry, fallbackIndex: number): string {
  const payload =
    typeof entry.payload === "string"
      ? entry.payload
      : entry.payload == null
        ? ""
        : JSON.stringify(entry.payload);
  return [
    entry.timestamp ?? "",
    entry.source ?? "",
    entry.type ?? "",
    payload,
    fallbackIndex,
  ].join("\u001f");
}

export function buildKeywordTestRegex(
  keywords: string[],
  options: { matchCase: boolean; wholeWord: boolean },
): RegExp | null {
  const terms = keywords.map((k) => k.trim()).filter(Boolean);
  if (terms.length === 0) return null;
  const escaped = terms.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const wrapped = options.wholeWord ? escaped.map((k) => `\\b${k}\\b`) : escaped;
  return new RegExp(wrapped.join("|"), options.matchCase ? "" : "i");
}

export function findKeywordMatchRows(
  rows: Array<{ key: string; line: string }>,
  keywords: string[],
  options: { matchCase: boolean; wholeWord: boolean },
): LogMatchRow[] {
  const re = buildKeywordTestRegex(keywords, options);
  if (!re) return [];
  const matches: LogMatchRow[] = [];
  for (let i = 0; i < rows.length; i++) {
    if (re.test(rows[i].line)) matches.push({ key: rows[i].key, index: i });
  }
  return matches;
}
