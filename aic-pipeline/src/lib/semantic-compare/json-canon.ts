export function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortKeys((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

export function stripFields(value: unknown, fields: string[]): unknown {
  const drop = new Set(fields);
  if (Array.isArray(value)) return value.map((v) => stripFields(v, fields));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (drop.has(k)) continue;
      out[k] = stripFields(v, fields);
    }
    return out;
  }
  return value;
}

/** Collapse \${foo} (escape artifact from vendored pull) to ${foo} for comparison. */
export function normalizeEsvEscapes(s: string): string {
  return s.replace(/\\\$\{/g, "${");
}

/**
 * True when a parsed JSON value carries no meaningful content — null, an empty
 * array, an empty object, an empty string, or a container whose every leaf is
 * itself empty by this definition. Used to treat cosmetic fields like
 * `uiConfig.categories: "[]"` and `uiConfig.annotations: "{…empty…}"` as
 * equivalent to the field being absent.
 */
export function isEmptyJsonValue(v: unknown): boolean {
  if (v == null) return true;
  if (typeof v === "string") return v.trim() === "";
  if (Array.isArray(v)) return v.length === 0 || v.every(isEmptyJsonValue);
  if (typeof v === "object") {
    const vals = Object.values(v as Record<string, unknown>);
    return vals.length === 0 || vals.every(isEmptyJsonValue);
  }
  return false;
}

/**
 * Recursively apply `normalizeEsvEscapes` to every string leaf in a JSON value.
 * Used inside the canonicalization pipeline so vendored-pull escape artifacts
 * (`\${foo}`) and upstream literals (`${foo}`) compare equal in node payloads
 * and journey headers.
 */
export function normalizeJsonEsvEscapes(value: unknown): unknown {
  if (typeof value === "string") return normalizeEsvEscapes(value);
  if (Array.isArray(value)) return value.map(normalizeJsonEsvEscapes);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = normalizeJsonEsvEscapes(v);
    }
    return out;
  }
  return value;
}
