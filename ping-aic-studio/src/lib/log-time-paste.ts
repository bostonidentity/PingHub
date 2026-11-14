// Parse a timestamp pasted into the Logs custom time range, e.g. a log entry's
// `2026-10-13T02:08:30.383Z`, keeping its milliseconds.

/**
 * Returns the exact instant `text` names, milliseconds included.
 *
 * Accepts ISO 8601 with a zone (`Z` / `±hh:mm`), epoch seconds or
 * milliseconds, and a zoneless `YYYY-MM-DD[T ]HH:MM[:SS[.fff]]`, which is read
 * in the display zone (`utc` for UTC/epoch display, otherwise local).
 * Returns null for anything else so the browser's own paste applies.
 */
export function parsePastedTimestamp(text: string, zone: "local" | "utc"): Date | null {
    const t = text.trim().replace(/^["']|["']$/g, "");
    let ms: number;
    if (/^\d{13}$/.test(t)) ms = Number(t);
    else if (/^\d{10}$/.test(t)) ms = Number(t) * 1000;
    else {
        const m = t.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(Z|[+-]\d{2}:?\d{2})?$/i);
        if (!m) return null;
        const iso = `${m[1]}T${m[2]}`;
        ms = Date.parse(m[3] ? iso + m[3] : zone === "utc" ? iso + "Z" : iso);
    }
    if (!Number.isFinite(ms)) return null;
    return new Date(ms);
}
