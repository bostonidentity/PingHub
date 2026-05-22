// src/lib/data/flatten-fields.ts
//
// Deep-flatten a managed-object record into a map of dotted-path → string value
// for indexing. Used by both the pull-runner (initial index build) and
// snapshot-fs (lazy rebuild after schema upgrade).
//
// Why dotted paths?
//   The browse panel's per-attribute search needs to match values nested in
//   arrays, sub-objects, and `_ref` relationship pointers. A flat scalar
//   projection (the v1 indexer) can't express those, so values like
//   `profile.givenName`, `mail.0`, and `manager._ref` were invisible to the
//   attribute filter — even though global search (which streams the raw NDJSON)
//   found them. v2 indexes flattened paths so the two search paths agree.
//
// Conventions:
//   - Arrays: each element gets `.{index}` (e.g. `mail.0`, `mail.1`). Callers
//     that want "match any element of `mail`" should treat the bare path as a
//     prefix — `attr-match.ts` handles this.
//   - Underscore keys (`_id`, `_ref`, `_refProperties`, …) are kept at every
//     depth because relationships are encoded as `_ref` and IDs as `_id`. The
//     top-level `_*` skip rule from the v1 indexer made these unsearchable.
//   - Length cap is applied per-leaf, not per-record. Strings beyond
//     `INDEX_FIELD_MAX_LEN` are skipped (the global-search path still streams
//     the full record for users who really need the long value). The cap is
//     deliberately generous (10 KB) so realistic content like descriptions,
//     instructions, and translated copy stays searchable; pathological blobs
//     (base64 images, full scripts) drop out so the index stays bounded.
//   - null / undefined leaves are skipped.

export const INDEX_FIELD_MAX_LEN = 10_000;

export function flattenForIndex(record: Record<string, unknown>): Record<string, string> {
    const out: Record<string, string> = {};
    walk(record, "", out);
    return out;
}

function walk(value: unknown, prefix: string, out: Record<string, string>): void {
    if (value === null || value === undefined) return;

    if (typeof value === "string") {
        if (value.length <= INDEX_FIELD_MAX_LEN) out[prefix] = value;
        return;
    }
    if (typeof value === "number" || typeof value === "boolean") {
        out[prefix] = String(value);
        return;
    }

    if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
            const child = `${prefix}.${i}`;
            walk(value[i], child, out);
        }
        return;
    }

    if (typeof value === "object") {
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            const child = prefix ? `${prefix}.${k}` : k;
            walk(v, child, out);
        }
        return;
    }

    // functions, symbols, bigints — ignore
}

/**
 * Decide whether a flattened path matches a user-supplied attribute selector.
 *
 * Match rules (case-insensitive throughout). Each rule is applied to BOTH the
 * raw path and its array-index-collapsed form, so a user-picked attr from the
 * dropdown (which shows collapsed paths like `addresses.city`) still matches
 * the stored path (`addresses.0.city`).
 *   1. Exact: `attr === path`.
 *      e.g. attr="profile.givenName" matches "profile.givenName".
 *      e.g. attr="addresses.city" matches "addresses.0.city" (via collapse).
 *   2. Prefix: path starts with `attr + "."`.
 *      e.g. attr="mail" matches "mail.0", "mail.1".
 *      e.g. attr="profile" matches "profile.givenName", "profile.surname".
 *      e.g. attr="addresses" matches "addresses.0.city" (via collapse).
 *   3. Last segment: the path's final segment equals `attr`.
 *      e.g. attr="givenName" matches "profile.givenName".
 *      e.g. attr="_ref" matches "manager._ref".
 *
 * Rule 3 is the "any depth, leaf name" shortcut — users can type a bare
 * attribute and get every occurrence regardless of where it sits in the tree.
 */
export function attrMatchesPath(attr: string, path: string): boolean {
    const a = attr.toLowerCase();
    const p = path.toLowerCase();
    if (matchAgainst(a, p)) return true;
    const collapsed = collapseArrayIndices(p);
    if (collapsed !== p && matchAgainst(a, collapsed)) return true;
    return false;
}

function matchAgainst(a: string, p: string): boolean {
    if (a === p) return true;
    if (p.startsWith(a + ".")) return true;
    const lastDot = p.lastIndexOf(".");
    const leaf = lastDot >= 0 ? p.slice(lastDot + 1) : p;
    return leaf === a;
}

/**
 * Collapse array-index path segments for the attribute dropdown.
 *
 * `mail.0`, `mail.1`, `mail.2`  →  `mail`
 * `addresses.0.city`, `addresses.1.city`  →  `addresses.city`
 *
 * Keeps non-numeric segments verbatim. Used so the UI doesn't show
 * `mail.0 … mail.99` as 100 separate options when the user just wants `mail`.
 */
export function collapseArrayIndices(path: string): string {
    return path
        .split(".")
        .filter((seg) => !/^\d+$/.test(seg))
        .join(".");
}
