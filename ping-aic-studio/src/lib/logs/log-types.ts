/** A raw log entry as returned by AIC /monitoring/logs (one element of `result`). */
export interface RawLogEntry {
    timestamp: string;
    source?: string;
    type?: string;
    payload: Record<string, unknown>;
}

/** Half-open-ish ISO time range [from, to]. */
export interface TimeRange {
    from: string;
    to: string;
}

export interface SourceManifest {
    /** Merged, non-overlapping ranges actually pulled, sorted by `from`. */
    coveredRanges: TimeRange[];
    /** High-water mark for "catch up to now". */
    lastPulledTo?: string;
    /** Total deduped entries stored for this source. */
    entryCount?: number;
}

export interface LogArchiveManifest {
    sources: Record<string, SourceManifest>;
}

/** A row as stored in the per-day SQLite index. */
export interface LogIndexRow {
    id: string;
    timestamp: string;
    transactionId: string;
    eventName: string;
    level: string;
    realm: string;
    userId: string;
    /** Byte offset of the entry's line in the day NDJSON. */
    offset: number;
    /** Byte length of the line, excluding the trailing newline. */
    length: number;
    /** The full raw entry, JSON-stringified (what gets written to NDJSON). */
    payloadJson: string;
    /** Lowercased concatenation of key fields for LIKE search. */
    searchable: string;
}
