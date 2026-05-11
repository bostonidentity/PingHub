"use client";

import { useState, useEffect, useRef, Fragment, startTransition, useDeferredValue, useCallback, useMemo, memo, createContext, useContext } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Environment } from "@/lib/fr-config-types";
import { EnvironmentBadge } from "@/components/EnvironmentBadge";
import { useDialog } from "@/components/ConfirmDialog";
import { cn } from "@/lib/utils";
import { logEntryMatchKey } from "@/lib/log-match-navigation";
import { parseQuery } from "@/lib/log-query";

// ── Timezone ──────────────────────────────────────────────────────────────────

type TzMode = "local" | "utc" | "epoch";

const TZ_OPTIONS: { value: TzMode; label: string }[] = [
  { value: "local", label: "Local" },
  { value: "utc", label: "UTC / Zulu" },
  { value: "epoch", label: "Epoch (ms)" },
];

const TzContext = createContext<TzMode>("local");

// ── Tail buffer size ─────────────────────────────────────────────────────────

const TAIL_BUFFER_DEFAULT = 300_000;

const TAIL_BUFFER_OPTIONS: { value: number; label: string }[] = [
  { value: 50_000, label: "50K" },
  { value: 100_000, label: "100K" },
  { value: 300_000, label: "300K" },
  { value: 500_000, label: "500K" },
  { value: 1_000_000, label: "1M" },
];

const TailBufferContext = createContext<number>(TAIL_BUFFER_DEFAULT);

// ── Types ─────────────────────────────────────────────────────────────────────

interface EnvWithLogApi extends Environment {
  hasLogApi: boolean;
}

/**
 * Pre-process the Search keywords box before passing to parseQuery.
 *
 * The boolean parser treats whitespace between barewords as implicit AND,
 * which is the right default for the Filter and Highlight boxes. For the
 * Search keywords box, however, users typically paste a phrase (e.g. an
 * error message or audit description) and expect it to match as-is. To make
 * that work without forcing them to add quotes, when the input contains no
 * boolean operators (`&&`, `||`, `,`), parens, or quotes, we wrap it as a
 * single quoted phrase so the parser sees one literal TERM.
 */
function normalizeSearchKeywords(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;
  const hasOperator =
    trimmed.includes("&&") ||
    trimmed.includes("||") ||
    /[,()"]/.test(trimmed);
  if (hasOperator) return trimmed;
  // Bareword phrase: escape backslashes (no quotes possible because of the
  // regex above) and wrap in double quotes.
  return `"${trimmed.replace(/\\/g, "\\\\")}"`;
}

interface LogEntry {
  timestamp: string;
  type: string;
  source?: string;
  payload: Record<string, unknown> | string;
}

/** Safely access payload as an object. Returns empty object for text/plain entries. */
function payloadObj(entry: LogEntry): Record<string, unknown> {
  return typeof entry.payload === "object" && entry.payload !== null ? entry.payload : {};
}

/** Check if entry is plain text (idm-core, am-core text logs). */
function isTextEntry(entry: LogEntry): boolean {
  return entry.type === "text/plain" || typeof entry.payload === "string";
}

/** Get the display text for a plain-text entry. */
function getTextPayload(entry: LogEntry): string {
  return typeof entry.payload === "string" ? entry.payload : "";
}

type TailSecs = 2 | 3 | 5 | 10 | 30 | 60;

const TAIL_SECS_OPTIONS: { value: TailSecs; label: string }[] = [
  { value: 2, label: "2s" },
  { value: 3, label: "3s" },
  { value: 5, label: "5s" },
  { value: 10, label: "10s" },
  { value: 30, label: "30s" },
  { value: 60, label: "60s" },
];

// Client-side level filter
const LEVEL_ORDER = ["FATAL", "SEVERE", "ERROR", "WARN", "WARNING", "INFO", "INFORMATION", "CONFIG", "DEBUG", "FINE", "FINER", "TRACE", "FINEST"];

const LEVEL_FILTERS = [
  { value: "ERROR", label: "ERROR+" },
  { value: "WARN", label: "WARN+" },
  { value: "INFO", label: "INFO+" },
  { value: "DEBUG", label: "DEBUG+" },
  { value: "ALL", label: "ALL" },
];

function levelPassesFilter(level: string, minLevel: string): boolean {
  if (minLevel === "ALL") return true;
  const idx = LEVEL_ORDER.indexOf(level.toUpperCase());
  const minIdx = LEVEL_ORDER.indexOf(minLevel.toUpperCase());
  if (idx === -1) return true;
  if (minIdx === -1) return true;
  return idx <= minIdx;
}

/**
 * Resolve a UI level selection to the set of effective payload-level strings
 * that AIC should return server-side. Mirrors frodo's `numLogLevelMap`.
 *
 * Returning `undefined` means "no server-side level filter" (used for ALL).
 * The client-side `levelPassesFilter` still runs as a safety net for entries
 * whose level we can't parse.
 */
const LEVEL_RESOLUTION: Record<string, string[]> = {
  ERROR: ["SEVERE", "ERROR", "FATAL"],
  WARN: ["SEVERE", "ERROR", "FATAL", "WARNING", "WARN", "CONFIG"],
  INFO: ["SEVERE", "ERROR", "FATAL", "WARNING", "WARN", "CONFIG", "INFO", "INFORMATION"],
  DEBUG: ["SEVERE", "ERROR", "FATAL", "WARNING", "WARN", "CONFIG", "INFO", "INFORMATION", "DEBUG", "FINE", "FINER", "FINEST"],
};

function resolveLevels(minLevel: string): string[] | undefined {
  if (!minLevel || minLevel === "ALL") return undefined;
  return LEVEL_RESOLUTION[minLevel];
}

// Sources queried for transaction drill-down
const TRANSACTION_SOURCES = [
  "am-access", "am-authentication", "am-core",
  "idm-access", "idm-activity", "idm-authentication",
];

// ── Tab config (shared between parent controls and tab content) ──────────────

type LogMode = "tail" | "search";
type Preset = "15m" | "1h" | "6h" | "24h" | "3d" | "5d" | "7d" | "30d" | "custom";

const PRESETS: { label: string; value: Preset; ms: number }[] = [
  { label: "15 min", value: "15m", ms: 15 * 60 * 1000 },
  { label: "1 hour", value: "1h", ms: 60 * 60 * 1000 },
  { label: "6 hours", value: "6h", ms: 6 * 60 * 60 * 1000 },
  { label: "24 hours", value: "24h", ms: 24 * 60 * 60 * 1000 },
  { label: "3 days", value: "3d", ms: 3 * 24 * 60 * 60 * 1000 },
  { label: "5 days", value: "5d", ms: 5 * 24 * 60 * 60 * 1000 },
  { label: "7 days", value: "7d", ms: 7 * 24 * 60 * 60 * 1000 },
  { label: "1 month", value: "30d", ms: 30 * 24 * 60 * 60 * 1000 },
  { label: "Custom", value: "custom", ms: 0 },
];

const LOG_SOURCES = ["am-everything", "idm-everything"] as const;

const TERMINAL_ROW_H = 20;     // px — fixed height per row (nowrap lines)
const TERMINAL_OVERSCAN = 15;    // extra rows rendered above/below viewport



function toDatetimeLocal(iso: string, tz: TzMode = "local"): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  if (tz === "epoch") {
    // datetime-local input can't show epoch; fall back to UTC representation
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  }
  if (tz === "utc") {
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  }
  // local
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function fromDatetimeLocal(val: string, tz: TzMode = "local"): string {
  if (!val) return "";
  if (tz === "utc" || tz === "epoch") {
    // The input value is in UTC; append Z so Date parses it as UTC
    return new Date(val + "Z").toISOString();
  }
  // local — browser interprets the value as local time
  return new Date(val).toISOString();
}

export interface TabConfig {
  env: string;
  selectedSources: string[];
  sourcesError: string;
  levelFilter: string;
  mode: LogMode;
  tailSecs: TailSecs;
  tailing: boolean;
  loading: boolean;
  // Search mode
  preset: Preset;
  customBegin: string;
  customEnd: string;
  /** Incremented to trigger a search fetch */
  searchSeq: number;
  /** True while search is auto-paginating through server pages */
  searching: boolean;
  // View prefs (persisted per tab)
  viewMode?: "terminal" | "table" | "json";
  /** @deprecated — use viewMode. Retained so old persisted tabs still open on the right view. */
  terminalView?: boolean;
  wrapLines?: boolean;
  dedupe?: boolean;
  autoScroll?: boolean;

}

// ── Field extraction ────────────────────────────────────────────────────────

/** Parse level from plain-text log line (e.g. "FINE:", "WARNING:", "SEVERE:") */
function parseTextLevel(text: string): string {
  const match = text.match(/^(FINEST|FINER|FINE|CONFIG|INFO|INFORMATION|WARNING|SEVERE|FATAL):/);
  if (match) return match[1].toUpperCase();
  return "INFO";
}

/** Parse class name from plain-text log line (e.g. "[147] Apr 05 ... org.foo.Bar method") */
function parseTextComponent(text: string): string {
  // Pattern: [threadId] date time AM/PM org.package.Class methodName
  const match = text.match(/\d{4}\s+(?:AM|PM)\s+([\w.]+)\s+\w+$/);
  if (match) {
    const parts = match[1].split(".");
    return parts[parts.length - 1];
  }
  return "";
}

function getLevel(entry: LogEntry): string {
  if (isTextEntry(entry)) {
    const text = getTextPayload(entry);
    return parseTextLevel(text);
  }
  const p = payloadObj(entry);
  if (typeof p.level === "string") return p.level.toUpperCase();
  if (typeof p.severity === "string") return p.severity.toUpperCase();
  if (p.result === "FAILED" || p.result === "false") return "WARN";
  const resp = p.response as Record<string, unknown> | undefined;
  if (resp?.status === "FAILED") return "WARN";
  return "INFO";
}

function getMessage(entry: LogEntry): string {
  if (isTextEntry(entry)) return getTextPayload(entry);
  const p = payloadObj(entry);
  if (typeof p.message === "string" && p.message) return p.message;
  const eventName = p.eventName as string | undefined;
  if (eventName === "AM-NODE-LOGIN-COMPLETED") {
    const entries = p.entries as Array<{ info?: Record<string, string> }> | undefined;
    const info = entries?.[0]?.info;
    if (info?.displayName) return `${info.displayName} → ${info.nodeOutcome ?? ""}`;
  }
  if (eventName) {
    const parts: string[] = [eventName];
    if (typeof p.result === "string") parts.push(`→ ${p.result}`);
    const userId = p.userId;
    if (typeof userId === "string" && userId) parts.push(`[${userId}]`);
    return parts.join(" ");
  }
  // IDM access: show operation + task/path
  const req = p.request as Record<string, unknown> | undefined;
  if (req) {
    const op = typeof req.operation === "string" ? req.operation : "";
    const detail = req.detail as Record<string, unknown> | undefined;
    const taskName = typeof detail?.taskName === "string" ? detail.taskName : "";
    const path = typeof req.path === "string" ? req.path : "";
    if (op && taskName) return `${op}: ${taskName}`;
    if (op && path) return `${op} ${path}`;
    if (path) return `${p.http_method ?? ""} ${path}`.trim();
  }
  return "(no message)";
}

function getComponent(entry: LogEntry, source: string): string {
  if (isTextEntry(entry)) return parseTextComponent(getTextPayload(entry)) || source;
  const p = payloadObj(entry);
  if (typeof p.component === "string" && p.component) return p.component;
  if (typeof p.logger === "string" && p.logger) {
    const match = p.logger.match(/\(([^)]+)\)$/);
    if (match) return match[1];
    const parts = p.logger.split(".");
    return parts[parts.length - 1];
  }
  // IDM access: show protocol
  const req = p.request as Record<string, unknown> | undefined;
  if (typeof req?.protocol === "string") return req.protocol;
  return source;
}

function getTransactionId(entry: LogEntry): string {
  const p = payloadObj(entry);
  if (typeof p.transactionId === "string") return p.transactionId;
  // Check mdc.transactionId (am-core pattern)
  const mdc = p.mdc as Record<string, unknown> | undefined;
  if (typeof mdc?.transactionId === "string") return mdc.transactionId;
  return "";
}

function getUserId(entry: LogEntry): string {
  const p = payloadObj(entry);
  if (typeof p.userId === "string" && p.userId) return p.userId;
  if (Array.isArray(p.principal) && p.principal.length > 0) return String(p.principal[0]);
  return "";
}

function getStatus(entry: LogEntry): string {
  const p = payloadObj(entry);
  const resp = p.response as Record<string, unknown> | undefined;
  if (typeof resp?.status === "string") return resp.status;
  if (typeof p.result === "string") return p.result;
  return "";
}

// ── Badges ────────────────────────────────────────────────────────────────────

const LEVEL_STYLES: Record<string, string> = {
  ERROR: "bg-red-100 text-red-700 border border-red-200",
  FATAL: "bg-red-100 text-red-700 border border-red-200",
  SEVERE: "bg-red-100 text-red-700 border border-red-200",
  WARN: "bg-yellow-100 text-yellow-700 border border-yellow-200",
  WARNING: "bg-yellow-100 text-yellow-700 border border-yellow-200",
  INFO: "bg-sky-50 text-sky-700 border border-sky-200",
  INFORMATION: "bg-sky-50 text-sky-700 border border-sky-200",
  CONFIG: "bg-sky-50 text-sky-700 border border-sky-200",
  DEBUG: "bg-slate-100 text-slate-600 border border-slate-200",
  FINE: "bg-slate-100 text-slate-600 border border-slate-200",
  FINER: "bg-slate-100 text-slate-500 border border-slate-200",
  TRACE: "bg-slate-100 text-slate-500 border border-slate-200",
  FINEST: "bg-slate-100 text-slate-500 border border-slate-200",
};

function LevelBadge({ level }: { level: string }) {
  const style = LEVEL_STYLES[level] ?? "bg-slate-100 text-slate-600 border border-slate-200";
  return (
    <span className={cn("inline-block px-1.5 py-0.5 rounded text-[10px] font-mono font-semibold leading-none", style)}>
      {level}
    </span>
  );
}

function SourceBadge({ source }: { source: string }) {
  const isAm = source.startsWith("am-");
  return (
    <span className={cn(
      "inline-block px-1.5 py-0.5 rounded text-[10px] font-mono leading-none whitespace-nowrap",
      isAm ? "bg-purple-100 text-purple-700" : "bg-teal-50 text-teal-700"
    )}>
      {source}
    </span>
  );
}

// ── Timestamp formatting ────────────────────────────────────────────────────

function formatTs(ts: string, tz: TzMode = "local"): { date: string; time: string } {
  try {
    const d = new Date(ts);
    if (tz === "epoch") {
      return { date: "", time: String(d.getTime()) };
    }
    const tzOpt: Intl.DateTimeFormatOptions["timeZone"] = tz === "utc" ? "UTC" : undefined;
    const date = d.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: tzOpt });
    const time = d.toLocaleTimeString(undefined, { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: tzOpt })
      + "." + String(d.getMilliseconds()).padStart(3, "0")
      + (tz === "utc" ? "Z" : "");
    return { date, time };
  } catch {
    return { date: "", time: ts };
  }
}

// ── Resizable table header ───────────────────────────────────────────────────

const DEFAULT_COL_WIDTHS: Record<string, number> = {
  timestamp: 160,
  source: 120,
  level: 70,
  transaction: 160,
  message: 0, // flex
};

function ResizableHeader({
  label,
  colKey,
  widths,
  onResize,
  className,
}: {
  label: string;
  colKey: string;
  widths: Record<string, number>;
  onResize: (key: string, width: number) => void;
  className?: string;
}) {
  const w = widths[colKey];
  const isFlex = !w;

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = w || 200;
    const onMove = (ev: MouseEvent) => {
      const delta = ev.clientX - startX;
      onResize(colKey, Math.max(40, startW + delta));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <th
      className={cn("px-2 py-2 font-semibold text-slate-500 whitespace-nowrap relative select-none", className)}
      style={isFlex ? undefined : { width: w, minWidth: w }}
    >
      {label}
      <div
        onMouseDown={handleMouseDown}
        className="absolute top-0 right-0 w-1.5 h-full cursor-col-resize hover:bg-sky-400/40 transition-colors"
      />
    </th>
  );
}

// ── JSON view ─────────────────────────────────────────────────────────────────
// Pretty-printed JSON over all filtered entries, rendered with variable-height
// virtualisation so only entries in (and just outside) the viewport pay the
// `deepUnescapeJson` + `JSON.stringify` cost. Per-entry text is memoised by
// entry reference so scrolling back doesn't re-stringify.
const JSON_VIEW_OVERSCAN = 8;
const JSON_VIEW_ROW_ESTIMATE = 240; // px; refined per-row by measureElement
const JSON_COPY_CHUNK = 500;        // entries per yield when building Copy text
/** Recursively unescape JSON-encoded string values within an object.
 *  Handles pure JSON strings and strings with a text prefix followed by
 *  embedded JSON (e.g. "SEVERE: [uuid] Content: {\"key\":\"val\"}").
 *  Embedded JSON is split into { _prefix, _json } so it renders cleanly. */
function deepUnescapeJson(val: unknown): unknown {
  if (typeof val === "string") {
    const trimmed = val.trim();
    // Pure JSON string
    if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
      try { return deepUnescapeJson(JSON.parse(trimmed)); } catch { /* not valid JSON — keep as string */ }
    }
    // Text prefix with embedded JSON: find the first { or [ and try to parse from there
    const jsonStart = findJsonStart(trimmed);
    if (jsonStart > 0) {
      const candidate = trimmed.slice(jsonStart);
      try {
        const parsed = deepUnescapeJson(JSON.parse(candidate));
        return { _prefix: trimmed.slice(0, jsonStart).trimEnd(), _json: parsed };
      } catch { /* not valid JSON after prefix */ }
    }
    return val;
  }
  if (Array.isArray(val)) return val.map(deepUnescapeJson);
  if (val !== null && typeof val === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      out[k] = deepUnescapeJson(v);
    }
    return out;
  }
  return val;
}

/** Find the index of the first opening delimiter that matches the string's
 *  closing delimiter. If the string ends with }, look for the first {.
 *  If it ends with ], look for the first [. This avoids false positives
 *  like "[uuid]" appearing before the actual JSON object. */
function findJsonStart(s: string): number {
  const t = s.trimEnd();
  if (t.endsWith("}")) { const i = s.indexOf("{"); return i > 0 ? i : -1; }
  if (t.endsWith("]")) { const i = s.indexOf("["); return i > 0 ? i : -1; }
  return -1;
}

function JsonLogView({
  entries,
  wrapLines = false,
  keywords = [],
  searchTerm = "",
  activeEntryIdx = -1,
  matchIndices = [],
  matchCase = false,
  wholeWord = false,
  onEntryDoubleClick,
  contextAnchorIdx = -1,
}: {
  entries: LogEntry[];
  wrapLines?: boolean;
  keywords?: string[];
  searchTerm?: string;
  activeEntryIdx?: number;
  matchIndices?: number[];
  matchCase?: boolean;
  wholeWord?: boolean;
  onEntryDoubleClick?: (idx: number) => void;
  contextAnchorIdx?: number;
}) {
  // Per-entry pretty-printed JSON, cached by entry reference so we never
  // re-stringify the same entry twice (scrolling, re-renders, tail appends).
  // WeakMap lets us forget entries that fall out of scope without bookkeeping.
  const textCacheRef = useRef<WeakMap<object, string>>(new WeakMap());
  const getEntryText = useCallback((entry: LogEntry): string => {
    const cache = textCacheRef.current;
    let t = cache.get(entry as unknown as object);
    if (t === undefined) {
      t = JSON.stringify(deepUnescapeJson(entry), null, 2);
      cache.set(entry as unknown as object, t);
    }
    return t;
  }, []);

  // Copy is built incrementally on click so a 50k-entry buffer doesn't freeze
  // the main thread for several seconds. Yields between chunks let the UI
  // stay responsive and update the progress label.
  const [copyState, setCopyState] = useState<{ phase: "idle" | "building" | "done"; pct: number }>({ phase: "idle", pct: 0 });
  const copyAbortRef = useRef(false);
  useEffect(() => () => { copyAbortRef.current = true; }, []);
  const onCopy = useCallback(async () => {
    if (copyState.phase === "building") return;
    copyAbortRef.current = false;
    const total = entries.length;
    if (total === 0) {
      try { await navigator.clipboard.writeText("[]"); } catch { /* ignore */ }
      setCopyState({ phase: "done", pct: 100 });
      setTimeout(() => setCopyState({ phase: "idle", pct: 0 }), 1500);
      return;
    }
    setCopyState({ phase: "building", pct: 0 });
    const parts: string[] = ["[\n"];
    for (let i = 0; i < total; i += JSON_COPY_CHUNK) {
      if (copyAbortRef.current) { setCopyState({ phase: "idle", pct: 0 }); return; }
      const end = Math.min(i + JSON_COPY_CHUNK, total);
      for (let j = i; j < end; j++) {
        parts.push(getEntryText(entries[j]));
        if (j < total - 1) parts.push(",\n"); else parts.push("\n");
      }
      setCopyState({ phase: "building", pct: Math.round((end / total) * 100) });
      // Yield to the browser so the progress label updates and input stays live.
      await new Promise((r) => setTimeout(r, 0));
    }
    parts.push("]");
    try {
      await navigator.clipboard.writeText(parts.join(""));
      setCopyState({ phase: "done", pct: 100 });
      setTimeout(() => setCopyState({ phase: "idle", pct: 0 }), 1500);
    } catch {
      setCopyState({ phase: "idle", pct: 0 });
    }
  }, [entries, getEntryText, copyState.phase]);

  // Build highlight regex once
  const allTerms = [searchTerm, ...keywords].filter(Boolean);
  const [hlRegex, hlTestRe] = useMemo(() => {
    if (allTerms.length === 0) return [null, null] as const;
    const escaped = allTerms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const wrapped = wholeWord ? escaped.map((k) => `\\b${k}\\b`) : escaped;
    const flags = matchCase ? "g" : "gi";
    return [
      new RegExp(`(${wrapped.join("|")})`, flags),
      new RegExp(`^(?:${wrapped.join("|")})$`, matchCase ? "" : "i"),
    ] as const;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchTerm, keywords, matchCase, wholeWord]);

  const matchSet = useMemo(() => new Set(matchIndices), [matchIndices]);

  function highlightText(str: string, isActiveEntry: boolean) {
    if (!hlRegex || !hlTestRe) return <>{str}</>;
    hlRegex.lastIndex = 0;
    const parts = str.split(hlRegex);
    if (parts.length === 1) return <>{str}</>;
    return (
      <>
        {parts.map((part, i) =>
          hlTestRe.test(part)
            ? <mark key={i} className={isActiveEntry ? "bg-amber-400 text-black rounded-sm" : "bg-yellow-200 text-inherit rounded-sm"}>{part}</mark>
            : part
        )}
      </>
    );
  }

  // Variable-height virtualizer over the full entry list. Only rows in the
  // viewport (+ overscan) are mounted, so cost is O(visible) regardless of
  // total entry count.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => JSON_VIEW_ROW_ESTIMATE,
    measureElement: (el) => el.getBoundingClientRect().height,
    overscan: JSON_VIEW_OVERSCAN,
  });

  // Reset measured sizes when wrap mode changes (heights will differ).
  useEffect(() => { virtualizer.measure(); }, [wrapLines, virtualizer]);

  // Scroll to the active match when it changes.
  useEffect(() => {
    if (activeEntryIdx >= 0 && activeEntryIdx < entries.length) {
      virtualizer.scrollToIndex(activeEntryIdx, { align: "center" });
    }
  }, [activeEntryIdx, entries.length, virtualizer]);

  const items = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();
  const copyLabel =
    copyState.phase === "building" ? `Copying… ${copyState.pct}%` :
      copyState.phase === "done" ? "Copied" : "Copy JSON";

  return (
    <div className="relative h-full flex flex-col">
      <button
        type="button"
        onClick={onCopy}
        disabled={copyState.phase === "building"}
        className="absolute top-2 right-3 px-2 py-1 text-[11px] font-medium rounded border border-slate-300 bg-white/90 backdrop-blur text-slate-600 hover:bg-slate-50 disabled:opacity-60 disabled:cursor-progress z-10 shadow-sm"
        title="Copy full JSON to clipboard"
      >
        {copyLabel}
      </button>
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto overflow-x-auto"
      >
        <div
          className={cn(
            "p-4 pt-2 font-mono text-[12px] leading-5 text-slate-700 relative",
            wrapLines ? "whitespace-pre-wrap break-all" : "whitespace-pre",
          )}
          style={{ height: totalSize, width: "100%" }}
        >
          {items.map((vi) => {
            const i = vi.index;
            const entry = entries[i];
            if (!entry) return null;
            const etxt = getEntryText(entry);
            const isMatch = matchSet.has(i);
            const isActive = i === activeEntryIdx;
            const isCtxAnchor = i === contextAnchorIdx;
            const isLast = i === entries.length - 1;
            return (
              <div
                key={vi.key}
                ref={virtualizer.measureElement}
                data-index={i}
                data-entry-idx={i}
                onDoubleClick={() => onEntryDoubleClick?.(i)}
                className={cn(
                  "absolute left-0 right-0 px-4",
                  isActive && "bg-amber-50 ring-1 ring-inset ring-amber-300 rounded",
                  isMatch && !isActive && "bg-yellow-50/60",
                  isCtxAnchor && !isActive && "bg-violet-50 ring-1 ring-inset ring-violet-300 rounded",
                )}
                style={{ transform: `translateY(${vi.start}px)` }}
              >
                {i === 0 ? "[\n" : null}
                {isMatch ? highlightText(etxt, isActive) : etxt}
                {isLast ? "\n]" : ","}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── Tail terminal ────────────────────────────────────────────────────────────

function formatTerminalLine(entry: LogEntry, defaultSource: string): string {
  const src = (entry.source ?? defaultSource).padEnd(15);
  const lvl = getLevel(entry).padEnd(5);
  const msg = getMessage(entry);
  try {
    const d = new Date(entry.timestamp);
    const pad = (n: number) => String(n).padStart(2, "0");
    const ts = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, "0")}`;
    return `${ts}  ${src}  ${lvl}  ${msg}`;
  } catch {
    return `${entry.timestamp}  ${src}  ${lvl}  ${msg}`;
  }
}

function terminalLevelClass(level: string): string {
  switch (level.toUpperCase()) {
    case "ERROR": case "SEVERE": return "text-red-600 font-semibold";
    case "WARN": case "WARNING": return "text-amber-600 font-medium";
    case "INFO": case "INFORMATION": return "text-emerald-600";
    case "DEBUG": case "FINE": case "FINER": case "FINEST": case "TRACE": return "text-slate-400";
    default: return "text-slate-500";
  }
}

function terminalMsgClass(level: string): string {
  switch (level.toUpperCase()) {
    case "ERROR": case "SEVERE": return "text-slate-800 font-medium";
    case "WARN": case "WARNING": return "text-slate-700";
    default: return "text-slate-600";
  }
}

const TailTerminal = memo(function TailTerminal({
  entries, defaultSource, searchTerm, keywords, wrapLines = false,
  scrollRequest = null, activeMatchIndex = null, matchCase = false, wholeWord = false,
  dupeCounts, autoScroll = true, onEntryDoubleClick, contextAnchorIdx = null,
  expandCommand = null, matchIndices = null, filterActive = false,
}: {
  entries: LogEntry[];
  defaultSource: string;
  searchTerm: string;
  keywords: string[];
  dupeCounts?: Map<number, number>;
  wrapLines?: boolean;
  scrollRequest?: { index: number; nonce: number } | null;
  activeMatchIndex?: number | null;
  matchCase?: boolean;
  wholeWord?: boolean;
  autoScroll?: boolean;
  onEntryDoubleClick?: (idx: number) => void;
  contextAnchorIdx?: number | null;
  /** Bulk expand/collapse signal from parent. Bumped via nonce to retrigger. */
  expandCommand?: { kind: "all" | "none"; nonce: number } | null;
  /** Highlight match indices into `entries`; when set, all match rows auto-expand. */
  matchIndices?: number[] | null;
  /** Whether the parent Filter is active. When true, every visible row matches → expand all. */
  filterActive?: boolean;
}) {
  const outerRef = useRef<HTMLDivElement>(null);
  const [viewH, setViewH] = useState(400);
  const atBottomRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  // Nowrap virtual list: track only the computed startIdx to avoid re-renders
  // on every scroll pixel.  Raw scrollTop is kept in a ref.
  const scrollTopRef = useRef(0);
  const [startIdx, setStartIdx] = useState(0);
  // Timestamp of the most recent programmatic scroll (auto-tail, match-nav).
  // handleScroll skips its at-bottom flip for ~400ms after that so the
  // programmatic scroll's cascade of scroll events doesn't flip auto-tail
  // back on and yank the user off a match they're inspecting.
  const lastProgrammaticScrollRef = useRef(0);

  // Wrap mode: track which rows are manually expanded (click-to-expand)
  const [expandedRows, setExpandedRows] = useState<Set<number>>(new Set());
  const toggleRow = useCallback((idx: number) => {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx); else next.add(idx);
      return next;
    });
  }, []);

  // Auto-expand matching rows (wrap mode):
  // - Filter active → every visible row matches, expand all.
  // - Highlight active → expand each matching row.
  // - Active match → also expanded (subset of the above when highlight is on,
  //   handles the case where the user navigates with no highlight query).
  const matchKey = matchIndices ? matchIndices.join(",") : "";
  useEffect(() => {
    if (filterActive) {
      const all = new Set<number>();
      for (let i = 0; i < entries.length; i++) all.add(i);
      setExpandedRows(all);
    } else if (matchIndices && matchIndices.length > 0) {
      setExpandedRows(new Set(matchIndices));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterActive, matchKey, entries.length]);

  // Ensure the active match (when navigating between matches with no highlight
  // query) is always expanded.
  useEffect(() => {
    if (activeMatchIndex != null && activeMatchIndex >= 0) {
      setExpandedRows((prev) => {
        if (prev.has(activeMatchIndex)) return prev;
        const next = new Set(prev);
        next.add(activeMatchIndex);
        return next;
      });
    }
  }, [activeMatchIndex]);

  // Bulk expand/collapse from parent toolbar buttons
  const lastExpandNonceRef = useRef<number | null>(null);
  useEffect(() => {
    if (!expandCommand) return;
    if (lastExpandNonceRef.current === expandCommand.nonce) return;
    lastExpandNonceRef.current = expandCommand.nonce;
    if (expandCommand.kind === "all") {
      const next = new Set<number>();
      for (let i = 0; i < entries.length; i++) next.add(i);
      setExpandedRows(next);
    } else {
      setExpandedRows(new Set());
    }
  }, [expandCommand, entries.length]);

  // Track container height for virtual list calculations
  useEffect(() => {
    const el = outerRef.current;
    if (!el) return;
    setViewH(el.clientHeight);
    const ro = new ResizeObserver(() => setViewH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Variable-height virtualizer for wrap mode
  const wrapVirtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => outerRef.current,
    estimateSize: () => 32, // rough estimate; actual heights measured by measureElement
    measureElement: (el) => el.getBoundingClientRect().height,
    overscan: TERMINAL_OVERSCAN,
    enabled: wrapLines,
  });

  // Auto-scroll to bottom when new entries arrive
  useEffect(() => {
    if (!autoScroll || !atBottomRef.current) return;
    lastProgrammaticScrollRef.current = Date.now();
    if (wrapLines) {
      if (entries.length > 0) wrapVirtualizer.scrollToIndex(entries.length - 1, { align: "end" });
    } else if (outerRef.current) {
      outerRef.current.scrollTop = outerRef.current.scrollHeight;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries.length, wrapLines, autoScroll]);

  // Scroll to match index
  const scrollRequestIndex = scrollRequest?.index;
  const scrollRequestNonce = scrollRequest?.nonce;
  useEffect(() => {
    if (scrollRequestIndex == null || scrollRequestIndex < 0) return;
    lastProgrammaticScrollRef.current = Date.now();
    if (wrapLines) {
      wrapVirtualizer.scrollToIndex(scrollRequestIndex, { align: "center" });
    } else if (outerRef.current) {
      outerRef.current.scrollTop = scrollRequestIndex * TERMINAL_ROW_H - outerRef.current.clientHeight / 2 + TERMINAL_ROW_H / 2;
    }
    atBottomRef.current = false;
    setAtBottom(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollRequestNonce, wrapLines]);

  function handleScroll(e: React.UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    scrollTopRef.current = el.scrollTop;
    // Only re-render when the visible row window actually shifts
    if (!wrapLines) {
      const newStart = Math.max(0, Math.floor(el.scrollTop / TERMINAL_ROW_H) - TERMINAL_OVERSCAN);
      setStartIdx((prev) => (prev === newStart ? prev : newStart));
    }
    // Within ~400ms of a programmatic scroll, skip the at-bottom flip so
    // the cascade of scroll events from that programmatic scroll can't
    // re-enable auto-tail and drag the user off a match they're inspecting.
    if (Date.now() - lastProgrammaticScrollRef.current < 400) return;
    const atBot = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    if (atBot !== atBottomRef.current) {
      atBottomRef.current = atBot;
      setAtBottom(atBot);
    }
  }

  // Virtual list window — startIdx is now state-driven (only updates when visible range shifts)
  const totalH = entries.length * TERMINAL_ROW_H;
  const endIdx = Math.min(entries.length - 1, startIdx + Math.ceil(viewH / TERMINAL_ROW_H) + TERMINAL_OVERSCAN * 2);

  // Flash key: increments each time we navigate to a match, re-triggers the CSS animation
  const [flashKey, setFlashKey] = useState(0);
  useEffect(() => {
    if (scrollRequestIndex != null && scrollRequestIndex >= 0) setFlashKey((k) => k + 1);
  }, [scrollRequestNonce, scrollRequestIndex]);

  // Highlight search / keyword terms — compile regexes once, not per row
  const allTerms = [searchTerm, ...keywords].filter(Boolean);
  const [hlRegex, hlTestRe] = useMemo(() => {
    if (allTerms.length === 0) return [null, null];
    const escaped = allTerms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const wrapped = wholeWord ? escaped.map((k) => `\\b${k}\\b`) : escaped;
    const flags = matchCase ? "g" : "gi";
    return [
      new RegExp(`(${wrapped.join("|")})`, flags),
      new RegExp(`^(?:${wrapped.join("|")})$`, matchCase ? "" : "i"),
    ];
    // allTerms is derived from props — use the props directly as deps
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchTerm, keywords, wholeWord, matchCase]);

  // A: active row marks use amber; other matched rows use sky-blue
  function highlightLine(text: string, isActive = false) {
    if (!hlRegex || !hlTestRe) return <>{text}</>;
    hlRegex.lastIndex = 0;
    const parts = text.split(hlRegex);
    if (parts.length === 1) return <>{text}</>;
    return (
      <>
        {parts.map((part, i) =>
          hlTestRe.test(part)
            ? <mark key={i} className={isActive
              ? "bg-amber-400 text-black rounded-sm"
              : "bg-yellow-200 text-inherit rounded-sm"
            }>{part}</mark>
            : part
        )}
      </>
    );
  }

  function renderStructuredLine(entry: LogEntry, isActive: boolean) {
    const src = entry.source ?? defaultSource;
    const lvl = getLevel(entry);
    const msg = getMessage(entry);
    let ts: string;
    try {
      const d = new Date(entry.timestamp);
      const pad = (n: number) => String(n).padStart(2, "0");
      ts = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, "0")}`;
    } catch {
      ts = entry.timestamp;
    }
    return (
      <>
        <span className="text-slate-400 select-text">{ts}</span>
        <span className="text-slate-400 select-none">{"  "}</span>
        <span className="text-sky-600/80 select-text">{src.padEnd(15)}</span>
        <span className="text-slate-400 select-none">{"  "}</span>
        <span className={cn("select-text", terminalLevelClass(lvl))}>{lvl.padEnd(5)}</span>
        <span className="text-slate-400 select-none">{"  "}</span>
        <span className={cn("select-text", terminalMsgClass(lvl))}>{highlightLine(msg, isActive)}</span>
      </>
    );
  }

  return (
    <div className="relative h-full flex flex-col bg-white">
      <div
        ref={outerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto overflow-x-auto"
      >
        {entries.length === 0 ? (
          <div className="flex items-center justify-center h-full min-h-[120px]">
            <span className="text-slate-400 text-xs font-mono animate-pulse">Waiting for log entries…</span>
          </div>
        ) : wrapLines ? (
          /* Wrap mode: variable-height virtual list via @tanstack/react-virtual */
          <div style={{ height: wrapVirtualizer.getTotalSize(), position: "relative" }}>
            {wrapVirtualizer.getVirtualItems().map((vRow) => {
              const entry = entries[vRow.index];
              const count = dupeCounts?.get(vRow.index) ?? 1;
              const isActive = activeMatchIndex === vRow.index;
              const isCtxAnchor = contextAnchorIdx === vRow.index;
              const isRowExpanded = expandedRows.has(vRow.index);
              return (
                // Outer div: stable key + measureElement for virtualizer
                <div
                  key={vRow.index}
                  data-index={vRow.index}
                  ref={wrapVirtualizer.measureElement}
                  style={{ position: "absolute", top: vRow.start, left: 0, right: 0 }}
                >
                  {/* Inner div: re-keyed on flashKey so CSS animation re-fires on each navigation */}
                  <div
                    key={isActive ? flashKey : undefined}
                    onClick={() => toggleRow(vRow.index)}
                    onDoubleClick={() => onEntryDoubleClick?.(vRow.index)}
                    className={cn(
                      "px-3 py-px font-mono text-[11px] select-text leading-snug border-b border-slate-200 cursor-pointer",
                      vRow.index % 2 === 0 && "bg-slate-100/60",
                      isActive && "border-l-[3px] border-amber-400 pl-2.5 bg-amber-50 ring-1 ring-inset ring-amber-400/40 animate-match-flash",
                      isCtxAnchor && !isActive && "border-l-[3px] border-violet-400 pl-2.5 bg-violet-50",
                    )}
                  >
                    <span className={cn(
                      "whitespace-pre-wrap break-all",
                      !isRowExpanded && "line-clamp-3",
                    )}>
                      {renderStructuredLine(entry, isActive)}
                    </span>
                    {count > 1 && (
                      <span className="ml-2 inline-block px-1.5 py-0 rounded bg-amber-100 text-amber-700 text-[10px] font-semibold align-middle">
                        ×{count}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          /* Nowrap mode: fixed row height — virtual list for performance */
          <div style={{ height: totalH, position: "relative" }}>
            <div style={{ position: "absolute", top: startIdx * TERMINAL_ROW_H, left: 0, right: 0 }}>
              {entries.slice(startIdx, endIdx + 1).map((entry, i) => {
                const absIdx = startIdx + i;
                const count = dupeCounts?.get(absIdx) ?? 1;
                const isActive = activeMatchIndex === absIdx;
                const isCtxAnchor = contextAnchorIdx === absIdx;
                return (
                  <div
                    key={isActive ? `flash-${flashKey}` : absIdx}
                    onDoubleClick={() => onEntryDoubleClick?.(absIdx)}
                    style={{ height: TERMINAL_ROW_H, lineHeight: `${TERMINAL_ROW_H}px` }}
                    className={cn(
                      "px-3 font-mono text-[11px] whitespace-nowrap select-text border-b border-slate-200",
                      absIdx % 2 === 0 && "bg-slate-100/60",
                      isActive && "border-l-[3px] border-amber-400 pl-2.5 bg-amber-50 ring-1 ring-inset ring-amber-400/40 animate-match-flash",
                      isCtxAnchor && !isActive && "border-l-[3px] border-violet-400 pl-2.5 bg-violet-50",
                    )}
                  >
                    {renderStructuredLine(entry, isActive)}
                    {count > 1 && (
                      <span className="ml-2 inline-block px-1.5 rounded bg-amber-100 text-amber-700 text-[10px] font-semibold align-middle">
                        ×{count}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
      {!atBottom && (
        <button
          type="button"
          onClick={() => {
            const el = outerRef.current;
            if (el) { el.scrollTop = el.scrollHeight; atBottomRef.current = true; setAtBottom(true); }
          }}
          className="absolute bottom-4 right-4 px-3 py-1.5 text-xs bg-sky-600 text-white rounded-full shadow-lg hover:bg-sky-700 transition-colors z-10"
        >
          ↓ Jump to bottom
        </button>
      )}
    </div>
  );
});

// ── Entry row ────────────────────────────────────────────────────────────────

const EntryRow = memo(function EntryRow({
  entry,
  source,
  expanded,
  onToggle,
  searchTerm,
  keywords,
  onTransactionClick,
  onTimestampClick,
  onContextClick,
  fullscreen = false,
  showFullMessage = false,
  highlighted = false,
  isContextAnchor = false,
  rowIdx,
  matchCase = false,
  wholeWord = false,
  dupeCount = 1,
}: {
  entry: LogEntry;
  source: string;
  expanded: boolean;
  onToggle: () => void;
  searchTerm: string;
  keywords: string[];
  onTransactionClick: (txId: string) => void;
  onTimestampClick?: (timestamp: string, source: string) => void;
  onContextClick?: () => void;
  fullscreen?: boolean;
  showFullMessage?: boolean;
  highlighted?: boolean;
  isContextAnchor?: boolean;
  rowIdx?: number;
  matchCase?: boolean;
  wholeWord?: boolean;
  dupeCount?: number;
}) {
  const [txCopied, setTxCopied] = useState(false);
  const tz = useContext(TzContext);
  const effectiveSource = entry.source ?? source;
  const level = getLevel(entry);
  const message = getMessage(entry);
  const component = getComponent(entry, effectiveSource);
  const transactionId = getTransactionId(entry);
  const userId = getUserId(entry);
  const status = getStatus(entry);
  const { date, time } = formatTs(entry.timestamp, tz);
  const isText = isTextEntry(entry);

  function highlight(text: string) {
    const terms = [searchTerm, ...keywords].filter(Boolean);
    if (terms.length === 0) return <>{text}</>;
    const escaped = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const wrapped = wholeWord ? escaped.map((k) => `\\b${k}\\b`) : escaped;
    const flags = matchCase ? "g" : "gi";
    const regex = new RegExp(`(${wrapped.join("|")})`, flags);
    const parts = text.split(regex);
    if (parts.length === 1) return <>{text}</>;
    const testRe = new RegExp(`^(?:${wrapped.join("|")})$`, matchCase ? "" : "i");
    return (
      <>
        {parts.map((part, i) =>
          testRe.test(part) ? (
            <mark key={i} className="bg-yellow-200 text-inherit rounded-sm px-0.5">{part}</mark>
          ) : (
            part
          )
        )}
      </>
    );
  }

  return (
    <Fragment>
      <tr
        onClick={onToggle}
        onDoubleClick={(e) => { e.stopPropagation(); onContextClick?.(); }}
        data-row-idx={rowIdx}
        className={cn(
          "cursor-pointer text-xs border-b border-slate-200 hover:bg-slate-100/60 transition-colors",
          !expanded && !highlighted && !isContextAnchor && rowIdx != null && rowIdx % 2 === 0 && "bg-slate-100/60",
          expanded && "bg-slate-50",
          highlighted && "ring-1 ring-inset ring-sky-400 bg-sky-50",
          isContextAnchor && !highlighted && "ring-1 ring-inset ring-violet-400 bg-violet-50",
        )}
      >
        <td className="px-3 py-2 font-mono text-slate-400 whitespace-nowrap align-top">
          {onTimestampClick ? (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onTimestampClick(entry.timestamp, effectiveSource); }}
              className="hover:text-sky-600 hover:underline transition-colors text-left"
              title="Open ±1 min context in new tab"
            >
              <span className="text-slate-300 text-[10px]">{date} </span>{time}
            </button>
          ) : (
            <><span className="text-slate-300 text-[10px]">{date} </span>{time}</>
          )}
        </td>
        <td className="px-2 py-2 whitespace-nowrap align-top">
          <SourceBadge source={effectiveSource} />
        </td>
        <td className="px-2 py-2 whitespace-nowrap align-top">
          <LevelBadge level={level} />
        </td>
        {isText ? (
          <td colSpan={2} className="px-2 py-2 text-slate-700 align-top font-mono text-[11px]">
            {dupeCount > 1 && (
              <span className="mr-2 inline-block px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 text-[10px] font-semibold align-middle">
                ×{dupeCount}
              </span>
            )}
            <span className={cn("break-all whitespace-pre-wrap", !showFullMessage && "line-clamp-2")}>{highlight(message)}</span>
          </td>
        ) : (
          <>
            <td className="px-2 py-2 whitespace-nowrap align-top">
              {transactionId ? (
                <span className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onTransactionClick(transactionId); }}
                    className={cn(
                      "font-mono text-[10px] text-sky-600 hover:text-sky-800 hover:underline block",
                      fullscreen ? "break-all whitespace-normal" : "truncate max-w-[130px]"
                    )}
                    title={transactionId}
                  >
                    {fullscreen ? transactionId : transactionId.length > 20 ? `${transactionId.slice(0, 8)}…${transactionId.slice(-8)}` : transactionId}
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      navigator.clipboard.writeText(transactionId).then(() => {
                        setTxCopied(true);
                        setTimeout(() => setTxCopied(false), 1500);
                      });
                    }}
                    className={cn("shrink-0", txCopied ? "text-emerald-500" : "text-slate-300 hover:text-slate-500")}
                    title="Copy transaction ID"
                  >
                    {txCopied ? (
                      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                    ) : (
                      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                      </svg>
                    )}
                  </button>
                </span>
              ) : null}
            </td>
            <td className="px-2 py-2 text-slate-800 align-top">
              {dupeCount > 1 && (
                <span className="mr-2 inline-block px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 text-[10px] font-semibold align-middle">
                  ×{dupeCount}
                </span>
              )}
              <span className={cn("break-all", !showFullMessage && "line-clamp-2")}>{highlight(message)}</span>
              <span className="flex items-center gap-2 mt-0.5">
                {userId && (
                  <span className="text-slate-400 font-mono text-[10px]">{highlight(userId)}</span>
                )}
                {status && (
                  <span className={cn(
                    "text-[10px] font-mono px-1 py-0.5 rounded leading-none",
                    status === "SUCCESSFUL" ? "text-emerald-700 bg-emerald-50" : status === "FAILED" ? "text-red-700 bg-red-50" : "text-slate-500 bg-slate-50"
                  )}>
                    {status}
                  </span>
                )}
              </span>
            </td>
          </>
        )}
        <td className="px-2 py-2 text-slate-300 align-top text-center">
          <span className={cn("inline-block transition-transform text-[10px]", expanded && "rotate-90")}>▶</span>
        </td>
      </tr>
      {expanded && (
        <tr className="bg-slate-950 border-b border-slate-700">
          <td colSpan={6} className="p-0">
            <pre className="p-4 text-xs font-mono text-green-300 overflow-x-auto whitespace-pre-wrap break-all max-h-96 overflow-y-auto leading-5">
              {isText ? getTextPayload(entry) : JSON.stringify(entry.payload, null, 2)}
            </pre>
          </td>
        </tr>
      )}
    </Fragment>
  );
});

// ── Transaction drill-down modal ────────────────────────────────────────────

function TransactionDrilldown({
  transactionId,
  env,
  availableSources,
  onClose,
}: {
  transactionId: string;
  env: string;
  availableSources: string[];
  onClose: () => void;
}) {
  const [entries, setEntries] = useState<(LogEntry & { source: string })[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);
  const tz = useContext(TzContext);

  // Prefer aggregate sources for full coverage; fall back to individual sources
  const AM_INDIVIDUAL = ["am-access", "am-authentication", "am-core"];
  const IDM_INDIVIDUAL = ["idm-access", "idm-activity", "idm-authentication"];
  const amSources = availableSources.includes("am-everything")
    ? ["am-everything"]
    : AM_INDIVIDUAL.filter((s) => availableSources.includes(s));
  const idmSources = availableSources.includes("idm-everything")
    ? ["idm-everything"]
    : IDM_INDIVIDUAL.filter((s) => availableSources.includes(s));
  const sources = [...amSources, ...idmSources];

  useEffect(() => {
    if (sources.length === 0) {
      setError("No relevant log sources available for this environment.");
      setLoading(false);
      return;
    }

    // Use the indexed transactionId param — Ping searches the full retention window
    Promise.all(
      sources.map((src) =>
        fetch("/api/logs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ env, source: src, transactionId, pageSize: 1000 }),
        })
          .then((r) => r.json())
          .then((data): (LogEntry & { source: string })[] => {
            if (data.error || !Array.isArray(data.result)) return [];
            return (data.result as LogEntry[]).map((e) => ({ ...e, source: src }));
          })
          .catch(() => [] as (LogEntry & { source: string })[])
      )
    ).then((results) => {
      const merged = results
        .flat()
        .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
      setEntries(merged);
      setLoading(false);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transactionId]);

  const sourcesQueried = sources.length;
  const sourcesWithHits = new Set(entries.map((e) => e.source)).size;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50" onClick={onClose}>
      <div
        className="bg-white rounded-lg border border-slate-200 shadow-xl w-full max-w-4xl max-h-[80vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 bg-slate-50 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm font-semibold text-slate-700 shrink-0">Transaction Trace</span>
            <code className="text-xs font-mono text-slate-500 bg-slate-100 px-1.5 py-0.5 rounded truncate">
              {transactionId}
            </code>
          </div>
          <button onClick={onClose} className="ml-4 shrink-0 text-slate-400 hover:text-slate-700 text-lg leading-none">✕</button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="p-8 text-center text-sm text-slate-400">Querying {sourcesQueried} source{sourcesQueried !== 1 ? "s" : ""}…</div>
          ) : error ? (
            <div className="p-8 text-center text-sm text-red-500">{error}</div>
          ) : entries.length === 0 ? (
            <div className="p-8 text-center text-sm text-slate-400">No entries found for this transaction ID.</div>
          ) : (
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200 text-left sticky top-0">
                  <th className="px-3 py-2 font-semibold text-slate-500 whitespace-nowrap">Timestamp</th>
                  <th className="px-2 py-2 font-semibold text-slate-500">Source</th>
                  <th className="px-2 py-2 font-semibold text-slate-500">Level</th>
                  <th className="px-2 py-2 font-semibold text-slate-500">Message</th>
                  <th className="w-6" />
                </tr>
              </thead>
              <tbody>
                {entries.map((entry, i) => {
                  const level = getLevel(entry);
                  const message = getMessage(entry);
                  const { date, time } = formatTs(entry.timestamp, tz);
                  return (
                    <Fragment key={i}>
                      <tr
                        onClick={() => setExpandedIdx(expandedIdx === i ? null : i)}
                        className={cn("cursor-pointer border-b border-slate-100 hover:bg-slate-50 transition-colors", expandedIdx === i && "bg-slate-50")}
                      >
                        <td className="px-3 py-2 font-mono text-slate-400 whitespace-nowrap">
                          <span className="text-slate-300 text-[10px]">{date} </span>{time}
                        </td>
                        <td className="px-2 py-2 whitespace-nowrap"><SourceBadge source={entry.source} /></td>
                        <td className="px-2 py-2 whitespace-nowrap"><LevelBadge level={level} /></td>
                        <td className="px-2 py-2 text-slate-800 break-all">{message}</td>
                        <td className="px-2 py-2 text-slate-300 text-center">
                          <span className={cn("inline-block transition-transform text-[10px]", expandedIdx === i && "rotate-90")}>▶</span>
                        </td>
                      </tr>
                      {expandedIdx === i && (
                        <tr className="bg-slate-950 border-b border-slate-700">
                          <td colSpan={5} className="p-0">
                            <pre className="p-4 text-xs font-mono text-green-300 overflow-x-auto whitespace-pre-wrap break-all max-h-64 overflow-y-auto leading-5">
                              {JSON.stringify(entry.payload, null, 2)}
                            </pre>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
        {!loading && !error && (
          <div className="px-4 py-2 border-t border-slate-100 bg-slate-50/50 shrink-0 text-xs text-slate-400">
            {entries.length} {entries.length === 1 ? "entry" : "entries"} across{" "}
            {sourcesWithHits} of {sourcesQueried} source{sourcesQueried !== 1 ? "s" : ""}
          </div>
        )}
      </div>
    </div>
  );
}

// ── LogsExplorer (tab content — no controls, receives config from parent) ───

export function LogsExplorer({
  environments,
  config,
  onConfigChange,
  onLabelChange,
  isActive = true,
  tabs = [],
  activeTabId,
  onTabSwitch,
  fullscreen = false,
  onFullscreenChange,
  txSearchId,
  onOpenContextTab,
  onOpenEntryContextTab,
  anchorTimestamp,
}: {
  environments: EnvWithLogApi[];
  config: TabConfig;
  onConfigChange: (updates: Partial<TabConfig>) => void;
  onLabelChange?: (label: string) => void;
  isActive?: boolean;
  tabs?: { id: number; label: string }[];
  activeTabId?: number;
  onTabSwitch?: (id: number) => void;
  fullscreen?: boolean;
  onFullscreenChange?: (v: boolean) => void;
  txSearchId?: { id: string; seq: number };
  onOpenContextTab?: (timestamp: string, source: string) => void;
  onOpenEntryContextTab?: (anchorTimestamp: string, beginTimestamp: string, endTimestamp: string) => void;
  anchorTimestamp?: string;
}) {
  const { env, selectedSources, sourcesError, levelFilter, mode, tailSecs, tailing, loading, preset, customBegin, customEnd, searchSeq, searching } = config;
  const { confirm } = useDialog();
  const tz = useContext(TzContext);
  const tailBufferMax = useContext(TailBufferContext);
  const tailBufferMaxRef = useRef(tailBufferMax);
  useEffect(() => { tailBufferMaxRef.current = tailBufferMax; }, [tailBufferMax]);
  // Derived: sources used for tail mode — all selected sources are tailed concurrently.
  // `tailSource` (singular) is kept as the first for UI affordances that still expect one.
  const tailSources = selectedSources;
  const tailSource = selectedSources[0] ?? "";

  const [keywordsRaw, setKeywordsRaw] = useState("");
  const keywordsRawRef = useRef("");
  const [keywordsActive, setKeywordsActive] = useState(""); // debounced — drives actual highlighting
  const keywordsDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Search-mode only: keywords sent to AIC as the server-side _queryFilter (separate
  // from the client-side Highlight box, which only colors matches).
  const [searchKeywordsRaw, setSearchKeywordsRaw] = useState("");
  const searchKeywordsRawRef = useRef("");
  // Snapshot of the Search keywords (and their case/word options) as of the
  // last executed search. Edits to the input do NOT alter the displayed
  // results — those terms are only re-read when the search is executed again.
  const [searchKeywordsApplied, setSearchKeywordsApplied] = useState<{
    raw: string; matchCase: boolean; wholeWord: boolean;
  }>({ raw: "", matchCase: false, wholeWord: false });
  const [matchCursor, setMatchCursor] = useState(-1); // index into matchRows; -1 = none selected
  const [activeMatchKey, setActiveMatchKey] = useState<string | null>(null);
  const [matchScrollNonce, setMatchScrollNonce] = useState(0);
  const [highlightedTableIdx, setHighlightedTableIdx] = useState<number | null>(null); // filtered idx to highlight in table view
  const [highlightMatchCase, setHighlightMatchCase] = useState(false);
  const [highlightWholeWord, setHighlightWholeWord] = useState(false);
  // Per-field case/word toggles. Each field's predicate honours its own pair;
  // the renderer applies a single uniform setting (Highlight's), so visual
  // coloring of Filter / Search auto-highlighted terms uses Highlight's settings.
  const [filterMatchCase, setFilterMatchCase] = useState(false);
  const [filterWholeWord, setFilterWholeWord] = useState(false);
  const [searchMatchCase, setSearchMatchCase] = useState(false);
  const [searchWholeWord, setSearchWholeWord] = useState(false);
  const highlightInputRef = useRef<HTMLInputElement>(null);



  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [error, setError] = useState("");
  const [fetched, setFetched] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const [showFullMessage, setShowFullMessage] = useState(false);
  // View prefs live in TabConfig so they persist per tab across reloads.
  const viewMode: "terminal" | "table" | "json" =
    config.viewMode ?? (config.terminalView === false ? "table" : "terminal");
  const terminalView = viewMode === "terminal";
  const wrapLines = config.wrapLines ?? false;
  const dedupe = config.dedupe ?? false;
  const autoScroll = config.autoScroll ?? true;
  const setViewMode = useCallback((v: "terminal" | "table" | "json") => {
    // Also write terminalView for backward compat with any pre-existing persisted state.
    onConfigChange({ viewMode: v, terminalView: v === "terminal" });
  }, [onConfigChange]);
  const setWrapLines = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    onConfigChange({ wrapLines: typeof v === "function" ? v(wrapLines) : v });
  }, [onConfigChange, wrapLines]);
  const setDedupe = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    onConfigChange({ dedupe: typeof v === "function" ? v(dedupe) : v });
  }, [onConfigChange, dedupe]);
  const setAutoScroll = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    onConfigChange({ autoScroll: typeof v === "function" ? v(autoScroll) : v });
  }, [onConfigChange, autoScroll]);
  const [rawSearch, setRawSearch] = useState("");   // what's in the input box
  const [search, setSearch] = useState("");          // active filter (3+ chars or Enter)
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function applySearch(val: string) {
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    setSearch(val);
    setExpandedTableRows(new Set());
  }
  function handleFilterChange(val: string) {
    setRawSearch(val);
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    if (val.length === 0) {
      applySearch("");
    } else if (val.length >= 3) {
      searchDebounceRef.current = setTimeout(() => applySearch(val), 400);
    }
    // 1–2 chars: leave active filter unchanged until threshold or Enter
  }
  function clearSearch() {
    setRawSearch("");
    applySearch("");
    // Also collapse any auto-expanded rows in terminal wrap view.
    setExpandCmd({ kind: "none", nonce: Date.now() });
  }
  function clearHighlight() {
    if (keywordsDebounceRef.current) clearTimeout(keywordsDebounceRef.current);
    setKeywordsRaw("");
    keywordsRawRef.current = "";
    setKeywordsActive("");
    setExpandedTableRows(new Set());
    setExpandCmd({ kind: "none", nonce: Date.now() });
  }

  const [colWidths, setColWidths] = useState<Record<string, number>>({ ...DEFAULT_COL_WIDTHS });
  const handleColResize = useCallback((key: string, width: number) => {
    setColWidths((prev) => ({ ...prev, [key]: width }));
  }, []);
  // Set of currently-expanded row indices (table view). Replaces a single
  // expandedIdx so we can auto-expand every matching row when Filter or
  // Highlight is active.
  const [expandedTableRows, setExpandedTableRows] = useState<Set<number>>(new Set());
  const toggleTableRow = useCallback((idx: number) => {
    setExpandedTableRows((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx); else next.add(idx);
      return next;
    });
  }, []);
  // Bulk expand/collapse signal for terminal+wrap view (handled inside TailTerminal).
  const [expandCmd, setExpandCmd] = useState<{ kind: "all" | "none"; nonce: number } | null>(null);

  // ── Pagination ──
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(100);
  // Tracks whether we've already jumped to the first keyword/search match for the current filter.
  // While true, page is not auto-advanced so the user can browse.
  const firstMatchJumpedRef = useRef(false);

  // ── Copy to clipboard ──
  const [copied, setCopied] = useState(false);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  // Tail auto-scroll only kicks in when the user is already pinned to the
  // bottom. If they've scrolled up (e.g. to inspect a highlighted keyword)
  // we leave the viewport alone so new entries don't yank it.
  const scrollAtBottomRef = useRef(true);
  // Ignore the onScroll events that fire as a consequence of our own
  // programmatic scrolls (auto-scroll-to-bottom, scrollIntoView to a match)
  // so they can't flip scrollAtBottomRef the wrong way.
  const lastProgrammaticScrollAtRef = useRef(0);

  // ── Resize ──
  const [tableHeight, setTableHeight] = useState(() => {
    try { const v = localStorage.getItem("log-table-height"); return v ? parseInt(v, 10) : 420; } catch { return 420; }
  });
  function saveHeight(h: number) { try { localStorage.setItem("log-table-height", String(h)); } catch { /* ignore */ } }
  const grow = () => setTableHeight((h) => { const next = Math.min(window.innerHeight - 100, h + 50); saveHeight(next); return next; });
  const shrink = () => setTableHeight((h) => { const next = Math.max(200, h - 50); saveHeight(next); return next; });

  // ── Transaction drill-down (from clicking inline txId in table) ──
  const [drilldown, setDrilldown] = useState<{ txId: string } | null>(null);

  // ── Transaction search from control section → load into main table ──
  const prevTxSeq = useRef(0);
  useEffect(() => {
    if (!txSearchId || !env) return;
    if (txSearchId.seq <= prevTxSeq.current) return;
    prevTxSeq.current = txSearchId.seq;

    // Stop any active tail
    onConfigChange({ tailing: false });
    workerRef.current?.postMessage({ type: "tail-stop" });

    setError("");
    onConfigChange({ loading: true });
    setEntries([]);
    setFetched(false);
    setExpandedTableRows(new Set());

    // Query all selected sources (or both if none selected)
    const querySources = selectedSources.length > 0 ? selectedSources : [...LOG_SOURCES];

    Promise.all(
      querySources.map((src) =>
        fetch("/api/logs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ env, source: src, transactionId: txSearchId.id, pageSize: 1000 }),
        })
          .then((r) => r.json())
          .then((data): LogEntry[] => {
            if (data.error || !Array.isArray(data.result)) return [];
            return (data.result as LogEntry[]).map((e) => ({ ...e, source: e.source ?? src }));
          })
          .catch(() => [] as LogEntry[])
      )
    ).then((results) => {
      const merged = results.flat().sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
      setEntries(merged);
      setFetched(true);
      setLastUpdated(new Date());
      setPage(Infinity);
      onConfigChange({ loading: false });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [txSearchId]);

  const deferredIsActive = useDeferredValue(isActive);

  // ── Web Worker ──
  const workerRef = useRef<Worker | null>(null);
  const [tailTotalReceived, setTailTotalReceived] = useState(0);

  const [fetchProgress, setFetchProgress] = useState<{ loaded: number; page: number; done: boolean; paused: boolean; source?: string; window?: string; sourceIdx?: number; sourceCount?: number; lastTimestamp?: string; overallBegin?: string; overallEnd?: string } | null>(null);
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const worker = new Worker(`/log-worker.js?v=${Date.now()}`);
    worker.onmessage = (e: MessageEvent) => {
      const msg = e.data as
        | { type: "entries"; entries: LogEntry[]; append: boolean }
        | { type: "status"; loading: boolean }
        | { type: "progress"; loaded: number; page: number; done: boolean; paused: boolean; source?: string; window?: string; sourceIdx?: number; sourceCount?: number; lastTimestamp?: string; overallBegin?: string; overallEnd?: string }
        | { type: "error"; message: string; transient?: boolean };

      if (msg.type === "entries") {
        if (msg.append) {
          setTailTotalReceived((n) => n + msg.entries.length);
        }
        // A successful batch means whatever fetch error was showing is stale.
        if (errorTimerRef.current) { clearTimeout(errorTimerRef.current); errorTimerRef.current = null; }
        setError("");
        startTransition(() => {
          setEntries((prev) => {
            const combined = msg.append ? [...prev, ...msg.entries] : msg.entries;
            // Circular buffer: drop oldest when over cap (tail mode only)
            const cap = tailBufferMaxRef.current;
            if (msg.append && combined.length > cap) {
              return combined.slice(-cap);
            }
            return combined;
          });
          setFetched(true);
          setLastUpdated(new Date());
          if (!msg.append) { setExpandedTableRows(new Set()); }
          // Page changes are driven by the filtered.length useEffect below
        });
      } else if (msg.type === "status") {
        onConfigChange({ loading: msg.loading });
      } else if (msg.type === "progress") {
        setFetchProgress({ loaded: msg.loaded, page: msg.page, done: msg.done, paused: msg.paused, source: msg.source, window: msg.window, sourceIdx: msg.sourceIdx, sourceCount: msg.sourceCount, lastTimestamp: msg.lastTimestamp, overallBegin: msg.overallBegin, overallEnd: msg.overallEnd });
        onConfigChange({ searching: !msg.done });
      } else if (msg.type === "error") {
        if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
        setError(msg.message);
        if (msg.transient) {
          errorTimerRef.current = setTimeout(() => setError(""), 5000);
        } else {
          // Always clear loading+searching on a terminal error so the UI doesn't stay stuck
          onConfigChange({ loading: false, searching: false });
        }
      }
    };
    workerRef.current = worker;
    return () => worker.terminate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);


  // ── Sync tab label ──
  useEffect(() => {
    const sourceLabel =
      selectedSources.length >= 2 ? "both"
        : selectedSources.length === 1 ? selectedSources[0]
          : env;
    onLabelChange?.(`${sourceLabel} (${env})`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [env, selectedSources]);

  // ── Reset entries when env changes (but not on the first mount, so refresh keeps prior logs) ──
  const prevEnvRef = useRef<string | null>(null);
  useEffect(() => {
    if (!env) return;
    if (prevEnvRef.current === null) {
      prevEnvRef.current = env;
      return;
    }
    if (prevEnvRef.current === env) return;
    prevEnvRef.current = env;
    workerRef.current?.postMessage({ type: "cancel" });
    onConfigChange({ sourcesError: "", tailing: false });
    setEntries([]);
    setFetched(false);
    setTailTotalReceived(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [env]);

  // ── Clear searching flag when fetch completes ──
  const prevDone = useRef(false);
  useEffect(() => {
    const done = !!fetchProgress?.done;
    if (done && !prevDone.current) {
      onConfigChange({ searching: false });
    }
    prevDone.current = done;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchProgress?.done]);

  // ── Auto-scroll when tailing ──
  useEffect(() => {
    if (autoScroll && tailing && entries.length > 0 && isActive && scrollAtBottomRef.current) {
      const el = scrollContainerRef.current;
      if (el) {
        lastProgrammaticScrollAtRef.current = Date.now();
        el.scrollTop = el.scrollHeight;
      }
    }
  }, [entries, tailing, isActive, autoScroll]);

  // ── React to tailing / tailSecs / levelFilter changes from parent config ──
  const prevTailing = useRef(false);

  useEffect(() => {
    const levels = resolveLevels(levelFilter);
    if (tailing && !prevTailing.current) {
      // Start tail
      setTailTotalReceived(0);
      setEntries([]);
      setFetched(false);
      setError("");
      workerRef.current?.postMessage({ type: "tail-start", env, sources: tailSources, tailSecs, levels });
    } else if (!tailing && prevTailing.current) {
      // Stop tail
      workerRef.current?.postMessage({ type: "tail-stop" });
    } else if (tailing && prevTailing.current) {
      // Restart tail (tailSecs, selected sources, or levelFilter changed)
      workerRef.current?.postMessage({ type: "tail-start", env, sources: tailSources, tailSecs, levels });
    }
    prevTailing.current = tailing;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tailing, tailSecs, levelFilter, tailSources.join(",")]);

  // ── React to search mode fetch trigger ──
  const prevSearchSeq = useRef(0);

  useEffect(() => {
    if (searchSeq <= prevSearchSeq.current) return;
    prevSearchSeq.current = searchSeq;
    if (!env || selectedSources.length === 0) return;
    // Cleanup resets prevSearchSeq so the effect re-fires if the component remounts
    // (React Strict Mode runs effects twice in development; this makes auto-search work correctly).
    // In production there is no remount so the cleanup is harmless.
    const capturedSeq = searchSeq;
    const doCleanup = () => { if (prevSearchSeq.current >= capturedSeq) prevSearchSeq.current = capturedSeq - 1; };

    // Stop tail if running
    if (tailing) {
      onConfigChange({ tailing: false });
      workerRef.current?.postMessage({ type: "tail-stop" });
    }

    // Compute time range
    let beginTime: string;
    let endTime: string;
    if (preset === "custom") {
      beginTime = fromDatetimeLocal(customBegin, tz);
      endTime = fromDatetimeLocal(customEnd, tz);
      if (!beginTime || !endTime) {
        setError("Custom range requires both a start and end time.");
        onConfigChange({ searching: false });
        return doCleanup;
      }
      if (new Date(endTime).getTime() <= new Date(beginTime).getTime()) {
        setError("End time must be after start time.");
        onConfigChange({ searching: false });
        return doCleanup;
      }
    } else {
      const ms = PRESETS.find((p) => p.value === preset)!.ms;
      const now = new Date();
      beginTime = new Date(now.getTime() - ms).toISOString();
      endTime = now.toISOString();
    }

    // Build server-side _queryFilter from the dedicated Search keywords box (search mode only).
    // The Filter and Highlight boxes are client-side only — do NOT include them here.
    // This mirrors KYID Utilities' approach: only matching entries are returned by AIC,
    // dramatically reducing page count and eliminating rate-limit risk on long ranges.
    function escapeFilterValue(v: string) { return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"'); }
    // Parse the Search keywords box and pull out positive leaf terms. Server-side filtering is
    // a conservative OR over leaves; the client predicate (Filter box) still enforces && / () precisely.
    const parsed = parseQuery(
      normalizeSearchKeywords(searchKeywordsRawRef.current),
      { matchCase: searchMatchCase, wholeWord: searchWholeWord },
    );
    const allTerms = parsed.error ? [] : parsed.highlightTerms;
    const queryFilter = allTerms.length > 0
      ? allTerms.map((t) => {
        const v = escapeFilterValue(t);
        return `(/payload co "${v}") or (/payload/message co "${v}") or (/payload/eventName co "${v}")`;
      }).join(" or ")
      : undefined;

    setError("");
    setEntries([]);
    setFetched(false);
    setExpandedTableRows(new Set());
    setFetchProgress(null);
    // Freeze the Search keywords + per-field options for this run so subsequent
    // edits to the input don't re-filter the loaded results.
    setSearchKeywordsApplied({
      raw: searchKeywordsRawRef.current,
      matchCase: searchMatchCase,
      wholeWord: searchWholeWord,
    });
    onConfigChange({ searching: true });
    workerRef.current?.postMessage({ type: "fetch", env, sources: selectedSources, beginTime, endTime, queryFilter, levels: resolveLevels(levelFilter) });
    return doCleanup;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchSeq]);

  // Entries dropped from the in-memory circular buffer (tail mode only)
  const tailDropped = tailing ? Math.max(0, tailTotalReceived - entries.length) : 0;



  // ── Filtered entries ──
  const levelFiltered = useMemo(() =>
    levelFilter === "ALL"
      ? entries
      : entries.filter((e) => levelPassesFilter(getLevel(e), levelFilter)),
    [entries, levelFilter]);

  // Pre-compute searchable strings once per levelFiltered change
  const defaultSourceForNav = selectedSources[0] ?? "";
  const entryStrings = useMemo(() =>
    levelFiltered.map((e) => ({
      json: JSON.stringify(e),
      line: formatTerminalLine(e, defaultSourceForNav),
    })),
    [levelFiltered, defaultSourceForNav]);

  // Parse the Filter box as a boolean query supporting && / || / ( ) and quoted phrases.
  // Comma is also accepted as `||` for backwards compatibility with older usage.
  const filterQuery = useMemo(
    () => parseQuery(search ?? "", { matchCase: filterMatchCase, wholeWord: filterWholeWord }),
    [search, filterMatchCase, filterWholeWord],
  );

  // Same for the Highlight box. The positive leaf terms drive per-token <mark>
  // rendering; the predicate drives match navigation.
  const highlightQuery = useMemo(
    () => parseQuery(keywordsActive, { matchCase: highlightMatchCase, wholeWord: highlightWholeWord }),
    [keywordsActive, highlightMatchCase, highlightWholeWord],
  );
  // Parsed Search keywords as of the last executed search (search mode only).
  // Drives both the client-side AND/OR enforcement and auto-highlighting; live
  // edits to the input are ignored until the user runs the search again.
  const searchKeywordsParsed = useMemo(
    () => parseQuery(normalizeSearchKeywords(searchKeywordsApplied.raw), {
      matchCase: searchKeywordsApplied.matchCase,
      wholeWord: searchKeywordsApplied.wholeWord,
    }),
    [searchKeywordsApplied],
  );
  // Auto-highlight terms = union of Highlight + Filter + Search keyword leaves.
  // Rendering uses Highlight's matchCase / wholeWord (uniform regex required).
  const keywords = useMemo(() => {
    const out: string[] = [];
    const seen = new Set<string>();
    const push = (terms: string[]) => {
      for (const t of terms) {
        if (!t) continue;
        const key = highlightMatchCase ? t : t.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(t);
      }
    };
    if (!highlightQuery.empty && !highlightQuery.error) push(highlightQuery.highlightTerms);
    if (!filterQuery.empty && !filterQuery.error) push(filterQuery.highlightTerms);
    if (mode === "search" && !searchKeywordsParsed.empty && !searchKeywordsParsed.error) {
      push(searchKeywordsParsed.highlightTerms);
    }
    return out;
  }, [highlightQuery, filterQuery, searchKeywordsParsed, mode, highlightMatchCase]);

  const rawFilteredWithIdx = useMemo(() => {
    // Server-side _queryFilter is a conservative OR over leaves of the Search box,
    // so in search mode we also need to enforce the parsed Search query (which can
    // contain && / () precedence) client-side. The Filter box query is always applied.
    const applySearch =
      mode === "search" && !searchKeywordsParsed.empty && !searchKeywordsParsed.error;
    if (filterQuery.empty && !applySearch) return levelFiltered.map((e, i) => ({ e, i }));
    if (filterQuery.error) return [] as { e: LogEntry; i: number }[];
    return levelFiltered.reduce<{ e: LogEntry; i: number }[]>((acc, e, i) => {
      const json = entryStrings[i].json;
      if (!filterQuery.test(json)) return acc;
      if (applySearch && !searchKeywordsParsed.test(json)) return acc;
      acc.push({ e, i });
      return acc;
    }, []);
  }, [levelFiltered, entryStrings, filterQuery, mode, searchKeywordsParsed]);

  // Dedupe pass — collapses exact-match duplicates to the first occurrence and tracks counts.
  // Key: source + level + message text. When off, dupeCounts is empty and everything passes through.
  const { filteredWithIdx, dupeCounts } = useMemo(() => {
    if (!dedupe) return { filteredWithIdx: rawFilteredWithIdx, dupeCounts: new Map<number, number>() };
    const seen = new Map<string, number>(); // key → position in result
    const result: { e: LogEntry; i: number }[] = [];
    const counts = new Map<number, number>();
    for (const row of rawFilteredWithIdx) {
      const msg = getMessage(row.e);
      const level = getLevel(row.e);
      const key = `${row.e.source ?? ""}|${level}|${msg}`;
      const firstPos = seen.get(key);
      if (firstPos === undefined) {
        seen.set(key, result.length);
        result.push(row);
      } else {
        counts.set(firstPos, (counts.get(firstPos) ?? 1) + 1);
      }
    }
    return { filteredWithIdx: result, dupeCounts: counts };
  }, [rawFilteredWithIdx, dedupe]);

  // ── Anchor highlight — find the entry closest to anchorTimestamp for violet highlight ──
  const contextAnchorDisplay = useMemo(() => {
    if (!anchorTimestamp || filteredWithIdx.length === 0) return null;
    const targetTs = new Date(anchorTimestamp).getTime();
    let bestIdx = 0;
    let bestDiff = Infinity;
    for (let i = 0; i < filteredWithIdx.length; i++) {
      const diff = Math.abs(new Date(filteredWithIdx[i].e.timestamp).getTime() - targetTs);
      if (diff < bestDiff) { bestDiff = diff; bestIdx = i; }
    }
    return bestIdx;
  }, [anchorTimestamp, filteredWithIdx]);

  const filtered = useMemo(() => filteredWithIdx.map(({ e }) => e), [filteredWithIdx]);

  // Compute indices into `filtered` where the highlight query matches the
  // entry's full JSON — so a match in a payload field that's not in the
  // formatted terminal line still counts (visible in Table/JSON view).
  const matchRows = useMemo(() => {
    if (highlightQuery.empty || highlightQuery.error) return [];
    const out: { key: string; index: number }[] = [];
    for (let idx = 0; idx < filteredWithIdx.length; idx++) {
      const { e, i } = filteredWithIdx[idx];
      if (highlightQuery.test(entryStrings[i].json)) {
        out.push({ key: logEntryMatchKey(e, i), index: idx });
      }
    }
    return out;
  }, [filteredWithIdx, entryStrings, highlightQuery]);
  const matchIndices = useMemo(() => matchRows.map((m) => m.index), [matchRows]);

  // Auto-expand rows in table view when Filter or Highlight is active.
  // - Filter active: every visible row matches by definition \u2192 expand them all.
  // - Highlight active: expand each matching row.
  // The user can still toggle individual rows after; clearing Filter/Highlight
  // (via the Clear buttons) collapses everything back.
  useEffect(() => {
    const filterActive = !!search;
    const highlightActive = !highlightQuery.empty && !highlightQuery.error;
    if (filterActive) {
      const all = new Set<number>();
      for (let i = 0; i < filtered.length; i++) all.add(i);
      setExpandedTableRows(all);
    } else if (highlightActive) {
      setExpandedTableRows(new Set(matchIndices));
    }
    // When neither is active, leave expansion alone (user-controlled).
  }, [search, highlightQuery, matchIndices, filtered.length]);

  // Jump to first match when keywords/options change; reset when no matches
  useEffect(() => {
    if (matchRows.length > 0) {
      setMatchCursor(0);
      setActiveMatchKey(matchRows[0].key);
      setMatchScrollNonce((n) => n + 1);
    } else {
      setMatchCursor(-1);
      setActiveMatchKey(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keywordsActive, highlightMatchCase, highlightWholeWord]);

  // When tailing adds entries, keep the current match anchored without issuing
  // a new scroll request. This lets the count update while the viewport stays
  // where the user is inspecting.
  useEffect(() => {
    if (!activeMatchKey) return;
    const nextCursor = matchRows.findIndex((m) => m.key === activeMatchKey);
    if (nextCursor >= 0 && nextCursor !== matchCursor) {
      setMatchCursor(nextCursor);
    } else if (nextCursor < 0) {
      setMatchCursor(-1);
      setActiveMatchKey(null);
    }
  }, [activeMatchKey, matchRows, matchCursor]);

  const activeMatchIndex = matchCursor >= 0 && matchCursor < matchRows.length
    ? matchRows[matchCursor].index
    : null;
  const matchScrollRequest = useMemo(() =>
    activeMatchIndex !== null && matchScrollNonce > 0
      ? { index: activeMatchIndex, nonce: matchScrollNonce }
      : null,
    [activeMatchIndex, matchScrollNonce]);

  function navigateToMatch(nextCursor: number) {
    const row = matchRows[nextCursor];
    if (!row) return;
    setMatchCursor(nextCursor);
    setActiveMatchKey(row.key);
    setMatchScrollNonce((n) => n + 1);

    // Table view: jump to the right page and highlight the row
    if (viewMode === "table") {
      const targetPage = Math.floor(row.index / pageSize) + 1;
      setPage(targetPage);
      setHighlightedTableIdx(row.index);
      setExpandedTableRows(new Set());
      // Scroll into view after React re-renders the page
      requestAnimationFrame(() => {
        const el = scrollContainerRef.current?.querySelector(`[data-row-idx="${row.index}"]`);
        if (el) {
          lastProgrammaticScrollAtRef.current = Date.now();
          el.scrollIntoView({ block: "center" });
          scrollAtBottomRef.current = false;
        }
      });
    }

    // JSON view: scroll to the matched entry block
    if (viewMode === "json") {
      requestAnimationFrame(() => {
        const el = scrollContainerRef.current?.querySelector(`[data-entry-idx="${row.index}"]`);
        if (el) {
          lastProgrammaticScrollAtRef.current = Date.now();
          el.scrollIntoView({ block: "center" });
          scrollAtBottomRef.current = false;
        }
      });
    }
  }

  function goNextMatch() {
    if (matchRows.length === 0) return;
    navigateToMatch((matchCursor + 1) % matchRows.length);
  }
  function goPrevMatch() {
    if (matchRows.length === 0) return;
    navigateToMatch(matchCursor <= 0 ? matchRows.length - 1 : matchCursor - 1);
  }

  // ── Context window — open ±5 seconds around clicked entry in a new tab ──
  const handleContextEntry = useCallback((displayIdx: number) => {
    if (!onOpenEntryContextTab) return;
    const clickedEntry = filteredWithIdx[displayIdx]?.e;
    if (!clickedEntry) return;
    const ts = new Date(clickedEntry.timestamp).getTime();
    const beginTimestamp = new Date(ts - 5000).toISOString();
    const endTimestamp = new Date(ts + 5000).toISOString();
    onOpenEntryContextTab(clickedEntry.timestamp, beginTimestamp, endTimestamp);
  }, [onOpenEntryContextTab, filteredWithIdx]);

  // ── Pagination (page 1 = oldest, last page = newest) ──
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageStartIdx = (currentPage - 1) * pageSize;
  const pageEndIdx = Math.min(currentPage * pageSize, filtered.length);
  const pageEntries = filtered.slice(pageStartIdx, pageEndIdx);

  // Reset jump flag whenever the filter terms change so we jump fresh on the next match
  useEffect(() => { firstMatchJumpedRef.current = false; }, [search, levelFilter]);

  useEffect(() => {
    setExpandedTableRows(new Set());
    if (search && filtered.length > 0 && !firstMatchJumpedRef.current) {
      // First matching entry found — jump to page 1 (oldest = first match) and stay there
      firstMatchJumpedRef.current = true;
      setPage(1);
    } else if (!search) {
      // No filter active — follow the latest page as results stream in
      setPage(Math.max(1, Math.ceil(filtered.length / pageSize)));
    }
    // search active + already jumped: leave page alone so user can browse
  }, [search, levelFilter, filtered.length, pageSize]);

  // Scroll highlighted row into view after switching to table view
  useEffect(() => {
    if (viewMode !== "table" || highlightedTableIdx === null) return;
    const el = scrollContainerRef.current?.querySelector(`[data-row-idx="${highlightedTableIdx}"]`);
    if (el) {
      lastProgrammaticScrollAtRef.current = Date.now();
      el.scrollIntoView({ block: "center" });
      // Landing on a match means we're no longer tailing from the bottom —
      // suppress the next round of auto-scroll so the user stays on the match.
      scrollAtBottomRef.current = false;
    }
  }, [viewMode, highlightedTableIdx]);

  return (
    <div className="space-y-4">
      {/* ── Tail status bar ── */}
      <div className="flex items-center gap-3 flex-wrap">
        {tailing && (
          <div className="flex items-center gap-1.5 text-xs text-slate-500">
            <span className="inline-block w-2 h-2 rounded-full bg-green-400 animate-pulse" />
            {loading ? "Fetching…" : lastUpdated ? `Updated ${lastUpdated.toLocaleTimeString()}` : "Starting…"}
          </div>
        )}
        {(fetched || tailTotalReceived > 0) && (() => {
          const totalReceived = mode === "tail" ? Math.max(entries.length, tailTotalReceived) : entries.length;
          const dedupeHidden = dedupe
            ? Array.from(dupeCounts.values()).reduce((sum, n) => sum + (n - 1), 0)
            : 0;
          return (
            <span className="text-xs text-slate-400">
              {filtered.length}
              {filtered.length !== totalReceived && `/${totalReceived.toLocaleString()}`}{" "}
              {totalReceived === 1 ? "entry" : "entries"}
              {dedupe && dedupeHidden > 0 && (
                <span className="text-amber-600"> · {dedupeHidden.toLocaleString()} deduped</span>
              )}
              {loading && !tailing && " · loading…"}
            </span>
          );
        })()}

        {sourcesError && <span className="text-xs text-red-500">{sourcesError}</span>}
        {error && <span className="text-xs text-red-500">{error}</span>}
      </div>

      {/* ── Log window ── */}
      <div className={cn(
        "bg-white border border-slate-200 flex flex-col",
        fullscreen ? "fixed inset-0 z-50 rounded-none overflow-hidden" : "rounded-lg"
      )}>
        {/* Fullscreen tab bar */}
        {fullscreen && tabs.length > 0 && (
          <div className="flex items-end gap-0 border-b border-slate-200 bg-slate-50 shrink-0">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => onTabSwitch?.(tab.id)}
                className={cn(
                  "px-3 py-2 text-xs border-b-2 transition-colors whitespace-nowrap",
                  tab.id === activeTabId
                    ? "border-sky-600 text-slate-900 font-medium bg-white"
                    : "border-transparent text-slate-500 hover:text-slate-700 hover:bg-white/60"
                )}
              >
                {tab.label}
              </button>
            ))}
          </div>
        )}

        {/* Toolbar */}
        <div className="flex flex-col border-b border-slate-100 bg-slate-50/50 shrink-0">
          {/* Row 1: mode toggle + tail/search controls + keyword highlights */}
          <div className="flex items-center gap-2 px-4 py-2">
            {/* Mode toggle */}
            <div className="flex rounded border border-slate-300 overflow-hidden shrink-0">
              {(["tail", "search"] as LogMode[]).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => {
                    if (tailing) onConfigChange({ tailing: false });
                    onConfigChange({ mode: m });
                  }}
                  disabled={loading || searching}
                  className={cn(
                    "px-2 py-0.5 text-[11px] font-medium transition-colors",
                    mode === m
                      ? "bg-slate-900 text-white"
                      : "bg-white text-slate-500 hover:bg-slate-50"
                  )}
                >
                  {m === "tail" ? "Tail" : "Search"}
                </button>
              ))}
            </div>

            {/* Tail mode controls */}
            {mode === "tail" && (
              <>
                {!tailing ? (
                  <button
                    type="button"
                    onClick={() => onConfigChange({ tailing: true })}
                    disabled={loading || searching || selectedSources.length === 0 || !!sourcesError}
                    className="px-3 py-1 text-xs font-medium bg-sky-600 text-white rounded hover:bg-sky-700 disabled:opacity-50 transition-colors shrink-0"
                  >
                    Tail Logs
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => onConfigChange({ tailing: false })}
                    className="px-3 py-1 text-xs font-medium bg-red-100 text-red-700 rounded hover:bg-red-200 transition-colors shrink-0"
                  >
                    Stop Tail
                  </button>
                )}
              </>
            )}

            {/* Search mode controls */}
            {mode === "search" && (() => {
              const customRangeInvalid = preset === "custom" && !!customBegin && !!customEnd
                && new Date(customEnd).getTime() <= new Date(customBegin).getTime();
              return (
                <div className="flex items-center gap-1.5 flex-1 min-w-0">
                  <select
                    value={preset}
                    onChange={(e) => onConfigChange({ preset: e.target.value as Preset })}
                    disabled={searching}
                    className="rounded border border-slate-300 px-1.5 py-0.5 text-[11px] text-slate-700 focus:outline-none focus:ring-1 focus:ring-sky-500 disabled:opacity-50"
                  >
                    {PRESETS.map((p) => (
                      <option key={p.value} value={p.value}>{p.label}</option>
                    ))}
                  </select>
                  {preset === "custom" && (
                    <>
                      <input
                        type="datetime-local"
                        step="1"
                        value={customBegin}
                        onChange={(e) => onConfigChange({ customBegin: e.target.value })}
                        disabled={searching}
                        className={cn(
                          "rounded border px-1.5 py-0.5 text-[11px] font-mono focus:outline-none focus:ring-1",
                          customRangeInvalid ? "border-rose-400 focus:ring-rose-400" : "border-slate-300 focus:ring-sky-500",
                        )}
                      />
                      <span className="text-slate-400 text-[11px]">→</span>
                      <input
                        type="datetime-local"
                        step="1"
                        value={customEnd}
                        onChange={(e) => onConfigChange({ customEnd: e.target.value })}
                        disabled={searching}
                        className={cn(
                          "rounded border px-1.5 py-0.5 text-[11px] font-mono focus:outline-none focus:ring-1",
                          customRangeInvalid ? "border-rose-400 focus:ring-rose-400" : "border-slate-300 focus:ring-sky-500",
                        )}
                      />
                      {customRangeInvalid && (
                        <span className="text-[11px] text-rose-600 whitespace-nowrap" title="End time must be after start time">
                          End must be after start
                        </span>
                      )}
                    </>
                  )}
                  <button
                    type="button"
                    onClick={() => onConfigChange({ searchSeq: (searchSeq ?? 0) + 1 })}
                    disabled={loading || searching || selectedSources.length === 0 || !!sourcesError || customRangeInvalid}
                    className="px-3 py-1 text-xs font-medium bg-sky-600 text-white rounded hover:bg-sky-700 disabled:opacity-50 transition-colors flex items-center gap-1"
                  >
                    {searching ? (
                      <>
                        <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                        </svg>
                        Running…
                      </>
                    ) : (
                      "Search"
                    )}
                  </button>
                  {searching && (
                    <button
                      type="button"
                      onClick={() => workerRef.current?.postMessage({ type: "fetch-stop" })}
                      className="px-3 py-1 text-xs font-medium bg-red-100 text-red-700 rounded hover:bg-red-200 transition-colors"
                    >
                      Stop
                    </button>
                  )}
                  {/* Server-side search keywords — sent to AIC as _queryFilter, runs at fetch time. */}
                  <span className="text-slate-300 select-none">|</span>
                  <label className="text-xs font-medium text-slate-500">Keywords</label>
                  <input
                    type="text"
                    value={searchKeywordsRaw}
                    onChange={(e) => {
                      const val = e.target.value;
                      setSearchKeywordsRaw(val);
                      searchKeywordsRawRef.current = val;
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !searching && !customRangeInvalid && selectedSources.length > 0 && !sourcesError) {
                        e.preventDefault();
                        onConfigChange({ searchSeq: (searchSeq ?? 0) + 1 });
                      }
                    }}
                    disabled={searching}
                    placeholder="Server-side keywords (||, &quot;phrase&quot;)…"
                    title="Sent to AIC as _queryFilter — restricts what's downloaded. Leave blank to fetch everything in the time range."
                    className="flex-1 min-w-0 text-xs rounded border border-slate-300 px-2.5 py-1 font-mono focus:outline-none focus:ring-2 focus:ring-sky-500 focus:border-sky-500 disabled:opacity-50"
                  />
                  {/* Per-field Aa/[W] for Search keywords. Note: AIC's _queryFilter is
                      always case-insensitive substring; these toggles control how the
                      same terms are auto-highlighted in the rendered results. */}
                  <div className="flex rounded border border-slate-300 overflow-hidden shrink-0">
                    <button
                      type="button"
                      title="Case sensitive (auto-highlight only — AIC server is always case-insensitive)"
                      onClick={() => setSearchMatchCase((v) => !v)}
                      className={cn(
                        "px-2 py-0.5 text-[11px] font-medium font-mono transition-colors",
                        searchMatchCase ? "bg-slate-900 text-white" : "bg-white text-slate-500 hover:bg-slate-50"
                      )}
                    >Aa</button>
                    <button
                      type="button"
                      title="Whole word (auto-highlight only — AIC server has no whole-word operator)"
                      onClick={() => setSearchWholeWord((v) => !v)}
                      className={cn(
                        "px-2 py-0.5 text-[11px] font-medium font-mono border-l border-slate-300 transition-colors",
                        searchWholeWord ? "bg-slate-900 text-white" : "bg-white text-slate-500 hover:bg-slate-50"
                      )}
                    >[W]</button>
                  </div>
                </div>
              );
            })()}

          </div>

          {/* Row 2: Query — Filter and Highlight side-by-side; share one Aa/[W] toggle pair and the match navigator */}
          <div className="flex items-center gap-2 px-4 py-2 border-t border-slate-100">
            <label className="text-xs font-medium text-slate-500 shrink-0">Filter</label>
            <input
              type="text"
              value={rawSearch}
              onChange={(e) => handleFilterChange(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") applySearch(rawSearch); }}
              placeholder="Filter entries… (space=AND, ||, ( ), &quot;phrase&quot;; 3+ chars or Enter)"
              className={cn(
                "flex-1 min-w-0 text-xs rounded border px-2.5 py-1 font-mono focus:outline-none focus:ring-2",
                filterQuery.error
                  ? "border-rose-300 focus:ring-rose-400"
                  : rawSearch && !search
                    ? "border-amber-300 focus:ring-amber-400"   // typed but not yet active
                    : "border-slate-300 focus:ring-sky-500"
              )}
            />
            {filterQuery.error && (
              <span className="text-xs text-rose-600 whitespace-nowrap" title={filterQuery.error}>
                {filterQuery.error}
              </span>
            )}
            {rawSearch && (
              <button type="button" onClick={clearSearch} className="text-xs text-slate-400 hover:text-slate-600 shrink-0">
                Clear
              </button>
            )}
            {/* Per-field Aa/[W] for the Filter predicate */}
            <div className="flex rounded border border-slate-300 overflow-hidden shrink-0">
              <button
                type="button"
                title="Case sensitive (Filter predicate)"
                onClick={() => setFilterMatchCase((v) => !v)}
                className={cn(
                  "px-2 py-0.5 text-[11px] font-medium font-mono transition-colors",
                  filterMatchCase ? "bg-slate-900 text-white" : "bg-white text-slate-500 hover:bg-slate-50"
                )}
              >Aa</button>
              <button
                type="button"
                title="Whole word (Filter predicate)"
                onClick={() => setFilterWholeWord((v) => !v)}
                className={cn(
                  "px-2 py-0.5 text-[11px] font-medium font-mono border-l border-slate-300 transition-colors",
                  filterWholeWord ? "bg-slate-900 text-white" : "bg-white text-slate-500 hover:bg-slate-50"
                )}
              >[W]</button>
            </div>
            <span className="text-slate-300 select-none shrink-0">|</span>
            <label className="text-xs font-medium text-slate-500 shrink-0">Highlight</label>
            <input
              ref={highlightInputRef}
              type="text"
              value={keywordsRaw}
              onChange={(e) => {
                const val = e.target.value;
                setKeywordsRaw(val);
                keywordsRawRef.current = val;
                if (keywordsDebounceRef.current) clearTimeout(keywordsDebounceRef.current);
                keywordsDebounceRef.current = setTimeout(() => setKeywordsActive(val), 300);
              }}
              onKeyDown={(e) => {
                if (matchIndices.length > 0 && e.key === "Enter") {
                  e.preventDefault();
                  if (e.shiftKey) goPrevMatch(); else goNextMatch();
                }
              }}
              placeholder="Highlight (space=AND, ||, ( ), &quot;phrase&quot;)…"
              className={cn(
                "flex-1 min-w-0 text-xs rounded border px-2.5 py-1 font-mono focus:outline-none focus:ring-2",
                highlightQuery.error
                  ? "border-rose-300 focus:ring-rose-400 focus:border-rose-400"
                  : "border-slate-200 focus:ring-amber-400 focus:border-amber-400",
              )}
            />
            {highlightQuery.error ? (
              <span className="text-xs text-rose-600 whitespace-nowrap" title={highlightQuery.error}>
                {highlightQuery.error}
              </span>
            ) : keywordsRaw && (
              <span className="text-xs text-amber-600 whitespace-nowrap">
                {keywords.length} keyword{keywords.length !== 1 ? "s" : ""}
              </span>
            )}
            {keywordsRaw && (
              <button type="button" onClick={clearHighlight} className="text-xs text-slate-400 hover:text-slate-600 shrink-0">
                Clear
              </button>
            )}
            <div className="flex rounded border border-slate-300 overflow-hidden shrink-0" title="Highlight predicate; also drives auto-highlight rendering for Filter and Search terms">
              <button
                type="button"
                title="Case sensitive (Highlight predicate; also controls how all auto-highlighted terms are rendered)"
                onClick={() => setHighlightMatchCase((v) => !v)}
                className={cn(
                  "px-2 py-0.5 text-[11px] font-medium font-mono transition-colors",
                  highlightMatchCase ? "bg-slate-900 text-white" : "bg-white text-slate-500 hover:bg-slate-50"
                )}
              >Aa</button>
              <button
                type="button"
                title="Whole word (Highlight predicate; also controls how all auto-highlighted terms are rendered)"
                onClick={() => setHighlightWholeWord((v) => !v)}
                className={cn(
                  "px-2 py-0.5 text-[11px] font-medium font-mono border-l border-slate-300 transition-colors",
                  highlightWholeWord ? "bg-slate-900 text-white" : "bg-white text-slate-500 hover:bg-slate-50"
                )}
              >[W]</button>
            </div>
            {matchIndices.length > 0 && (
              <>
                <div className="flex items-center gap-1 text-[11px] text-slate-400 whitespace-nowrap tabular-nums shrink-0">
                  <input
                    type="number"
                    min={1}
                    max={matchIndices.length}
                    value={matchCursor >= 0 ? matchCursor + 1 : ""}
                    placeholder="–"
                    onChange={(e) => {
                      const n = parseInt(e.target.value, 10);
                      if (!isNaN(n) && n >= 1 && n <= matchRows.length) navigateToMatch(n - 1);
                    }}
                    className="w-12 text-center text-[11px] rounded border border-slate-300 px-1 py-0.5 font-mono focus:outline-none focus:ring-1 focus:ring-sky-400 focus:border-sky-400 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                  />
                  <span>/ {matchIndices.length}</span>
                </div>
                <div className="flex rounded border border-slate-300 overflow-hidden shrink-0">
                  <button
                    type="button"
                    title="Previous match (Shift+Enter)"
                    onClick={goPrevMatch}
                    className="px-2 py-0.5 text-[11px] font-medium bg-white text-slate-500 hover:bg-slate-50 transition-colors"
                  >↑ Prev</button>
                  <button
                    type="button"
                    title="Next match (Enter)"
                    onClick={goNextMatch}
                    className="px-2 py-0.5 text-[11px] font-medium bg-white text-slate-500 hover:bg-slate-50 border-l border-slate-300 hover:bg-slate-50 transition-colors"
                  >↓ Next</button>
                </div>
              </>
            )}
          </div>

          {/* Row 3: view toggles + count + height controls + fullscreen */}
          <div className="flex items-center gap-3 px-4 py-2 border-t border-slate-100">
            {/* Terminal / Table / JSON toggle — available in all modes */}
            <div className="flex rounded border border-slate-300 overflow-hidden shrink-0">
              <button
                type="button"
                onClick={() => setViewMode("terminal")}
                className={cn(
                  "px-2 py-0.5 text-[11px] font-medium transition-colors",
                  viewMode === "terminal" ? "bg-slate-900 text-white" : "bg-white text-slate-500 hover:bg-slate-50"
                )}
              >
                Terminal
              </button>
              <button
                type="button"
                onClick={() => {
                  setViewMode("table");
                  if (activeMatchIndex !== null) {
                    setHighlightedTableIdx(activeMatchIndex);
                    setPage(Math.floor(activeMatchIndex / pageSize) + 1);
                    setExpandedTableRows(new Set());
                  }
                }}
                className={cn(
                  "px-2 py-0.5 text-[11px] font-medium border-l border-slate-300 transition-colors",
                  viewMode === "table" ? "bg-slate-900 text-white" : "bg-white text-slate-500 hover:bg-slate-50"
                )}
              >
                Table
              </button>
              <button
                type="button"
                onClick={() => setViewMode("json")}
                className={cn(
                  "px-2 py-0.5 text-[11px] font-medium border-l border-slate-300 transition-colors",
                  viewMode === "json" ? "bg-slate-900 text-white" : "bg-white text-slate-500 hover:bg-slate-50"
                )}
                title="Show all entries as one JSON document"
              >
                JSON
              </button>
            </div>
            {/* Wrap toggle — available in terminal and JSON views */}
            {(viewMode === "terminal" || viewMode === "json") && (
              <button
                type="button"
                onClick={() => setWrapLines((w) => !w)}
                title={wrapLines ? "Disable line wrap" : "Wrap long lines"}
                className={cn(
                  "px-2 py-0.5 text-[11px] font-medium rounded border transition-colors shrink-0",
                  wrapLines
                    ? "bg-slate-900 text-white border-slate-900"
                    : "bg-white text-slate-500 border-slate-300 hover:bg-slate-50"
                )}
              >
                Wrap
              </button>
            )}
            {/* Auto-scroll toggle — visible during tailing in terminal view */}
            {viewMode === "terminal" && (
              <button
                type="button"
                onClick={() => setAutoScroll((v) => !v)}
                title={autoScroll ? "Pause auto-scroll (stay at current position)" : "Resume auto-scroll to latest entries"}
                className={cn(
                  "px-2 py-0.5 text-[11px] font-medium rounded border transition-colors shrink-0",
                  autoScroll
                    ? "bg-slate-900 text-white border-slate-900"
                    : "bg-white text-slate-500 border-slate-300 hover:bg-slate-50"
                )}
              >
                Auto-scroll
              </button>
            )}
            <button
              type="button"
              onClick={() => setDedupe((v) => !v)}
              title={dedupe ? "Show all entries" : "Collapse exact-match duplicates"}
              className={cn(
                "px-2 py-0.5 text-[11px] font-medium rounded border transition-colors shrink-0",
                dedupe
                  ? "bg-slate-900 text-white border-slate-900"
                  : "bg-white text-slate-500 border-slate-300 hover:bg-slate-50"
              )}
            >
              Dedupe
            </button>
            {/* Bulk expand / collapse — only meaningful when rows are line-clamped (terminal + wrap) */}
            {viewMode === "terminal" && wrapLines && filtered.length > 0 && (
              <div className="flex rounded border border-slate-300 overflow-hidden shrink-0">
                <button
                  type="button"
                  title="Expand all entries"
                  onClick={() => setExpandCmd({ kind: "all", nonce: Date.now() })}
                  className="px-2 py-0.5 text-[11px] font-medium bg-white text-slate-500 hover:bg-slate-50 transition-colors"
                >
                  Expand all
                </button>
                <button
                  type="button"
                  title="Collapse all entries"
                  onClick={() => setExpandCmd({ kind: "none", nonce: Date.now() })}
                  className="px-2 py-0.5 text-[11px] font-medium bg-white text-slate-500 hover:bg-slate-50 border-l border-slate-300 transition-colors"
                >
                  Collapse all
                </button>
              </div>
            )}
            {viewMode === "table" && (
              <label className="flex items-center gap-1.5 text-xs text-slate-500 whitespace-nowrap cursor-pointer shrink-0">
                <input
                  type="checkbox"
                  checked={showFullMessage}
                  onChange={(e) => setShowFullMessage(e.target.checked)}
                  className="rounded border-slate-300 text-sky-600 focus:ring-sky-500"
                />
                Full message
              </label>
            )}
            <span className="text-xs text-slate-400 whitespace-nowrap">
              {(() => {
                const totalReceived = mode === "tail" ? Math.max(entries.length, tailTotalReceived) : entries.length;
                const dedupeHidden = dedupe
                  ? Array.from(dupeCounts.values()).reduce((sum, n) => sum + (n - 1), 0)
                  : 0;
                return (
                  <>
                    {filtered.length} / {totalReceived.toLocaleString()}
                    {dedupe && dedupeHidden > 0 && (
                      <span className="text-amber-600"> (−{dedupeHidden.toLocaleString()})</span>
                    )}
                  </>
                );
              })()}
            </span>
            {!fullscreen && (
              <div className="flex items-center gap-0.5 shrink-0">
                <button
                  type="button"
                  onClick={shrink}
                  title="Shrink"
                  className="text-slate-400 hover:text-slate-600 transition-colors p-0.5"
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 12h14" />
                  </svg>
                </button>
                <button
                  type="button"
                  onClick={grow}
                  title="Grow"
                  className="text-slate-400 hover:text-slate-600 transition-colors p-0.5"
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 5v14m-7-7h14" />
                  </svg>
                </button>
              </div>
            )}
            {fetched && (
              <>
                <button
                  type="button"
                  onClick={() => {
                    // Export is ALWAYS JSON regardless of the active view (Terminal/Table/JSON).
                    // We export the full filtered entry objects (what the user currently sees in
                    // the buffer after Level/Filter/Search). `deepUnescapeJson` expands nested
                    // stringified-JSON payloads so the file matches the JSON view's rendering
                    // and is directly machine-parseable without a second JSON.parse pass.
                    const filtersActive = !!search || levelFilter !== "ALL";
                    const data = JSON.stringify(filtered.map((e) => deepUnescapeJson(e)), null, 2);
                    const blob = new Blob([data], { type: "application/json" });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    const ts = new Date().toISOString().slice(0, 19).replace(/:/g, "");
                    const suffix = filtersActive ? "-filtered" : "";
                    a.download = `logs-${selectedSources.join("-")}-${ts}${suffix}.json`;
                    a.click();
                    URL.revokeObjectURL(url);
                  }}
                  className="text-xs text-slate-400 hover:text-slate-600 transition-colors shrink-0"
                  title="Download visible entries as JSON (full payload, regardless of current view)"
                >
                  Export
                </button>
                <button
                  type="button"
                  onClick={() => {
                    let text: string;
                    if (viewMode === "json") {
                      text = JSON.stringify(filtered, null, 2);
                    } else if (viewMode === "table") {
                      text = filtered.map((e) => {
                        const src = (e.source ?? selectedSources[0] ?? "").padEnd(15);
                        const lvl = getLevel(e).padEnd(5);
                        const msg = getMessage(e);
                        return `${e.timestamp}  ${src}  ${lvl}  ${msg}`;
                      }).join("\n");
                    } else {
                      text = filtered.map((e) => formatTerminalLine(e, tailSource)).join("\n");
                    }
                    navigator.clipboard.writeText(text).then(() => {
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1500);
                    }).catch(() => { });
                  }}
                  className="text-xs text-slate-400 hover:text-slate-600 transition-colors shrink-0"
                >
                  {copied ? "Copied!" : "Copy"}
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    const ok = await confirm({
                      title: "Clear log entries",
                      message: `Clear all ${entries.length} log entries from the screen?`,
                      confirmLabel: "Clear",
                      variant: "warning",
                    });
                    if (ok) {
                      setEntries([]); setFetched(false); setError(""); clearSearch(); setExpandedTableRows(new Set()); setFetchProgress(null); setTailTotalReceived(0);
                    }
                  }}
                  className="text-xs text-slate-400 hover:text-slate-600 transition-colors shrink-0"
                >
                  Clear
                </button>
              </>
            )}
            <button
              type="button"
              onClick={() => onFullscreenChange?.(!fullscreen)}
              title={fullscreen ? "Exit fullscreen (Esc)" : "Fullscreen"}
              className="text-slate-400 hover:text-slate-600 transition-colors shrink-0"
            >
              {fullscreen ? (
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 9V4.5M9 9H4.5M9 9L3.75 3.75M9 15v4.5M9 15H4.5M9 15l-5.25 5.25M15 9h4.5M15 9V4.5M15 9l5.25-5.25M15 15h4.5M15 15v4.5m0-4.5l5.25 5.25" />
                </svg>
              ) : (
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15" />
                </svg>
              )}
            </button>
          </div>
        </div>

        {/* Scrollable log window — CSS resize handle at bottom-right corner */}
        <div
          ref={scrollContainerRef}
          onScroll={(e) => {
            // Within ~400ms of a programmatic scroll, skip the at-bottom
            // update so the cascade of scroll events from that scroll can't
            // flip the flag the wrong way.
            if (Date.now() - lastProgrammaticScrollAtRef.current < 400) return;
            const el = e.currentTarget;
            scrollAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
          }}
          onMouseUp={() => {
            if (fullscreen) return;
            const el = scrollContainerRef.current;
            if (!el) return;
            const h = el.clientHeight;
            if (h >= 200) { setTableHeight(h); saveHeight(h); }
          }}
          className={cn(
            terminalView || viewMode === "json" ? "overflow-hidden" : "overflow-y-auto overflow-x-auto",
            fullscreen ? "flex-1" : "resize-y min-h-[200px]"
          )}
          style={fullscreen ? undefined : { height: tableHeight }}
        >
          {viewMode === "terminal" ? (
            !fetched && !tailing ? (
              <div className="flex items-center justify-center h-full min-h-[160px]">
                <p className="text-sm text-slate-400 font-mono">
                  {anchorTimestamp ? "Loading context…" : "Select sources and start tailing or run a search"}
                </p>
              </div>
            ) : deferredIsActive && filtered.length === 0 && fetched && !searching ? (
              <div className="flex items-center justify-center h-full min-h-[160px]">
                <p className="text-sm text-slate-400 font-mono">
                  {entries.length === 0 ? "No log entries returned." : "No entries match the filter."}
                </p>
              </div>
            ) : (
              <TailTerminal
                entries={filtered}
                defaultSource={tailSource}
                searchTerm={search}
                keywords={keywords}
                wrapLines={wrapLines}
                dupeCounts={dupeCounts}
                scrollRequest={matchScrollRequest}
                activeMatchIndex={activeMatchIndex}
                matchCase={highlightMatchCase}
                wholeWord={highlightWholeWord}
                autoScroll={autoScroll}
                onEntryDoubleClick={handleContextEntry}
                contextAnchorIdx={contextAnchorDisplay}
                expandCommand={expandCmd}
                matchIndices={matchIndices}
                filterActive={!!search}
              />
            )
          ) : viewMode === "json" ? (
            !fetched ? (
              <div className="flex items-center justify-center h-full min-h-[160px]">
                <p className="text-sm text-slate-400">Select at least one source and click Tail Logs or Search</p>
              </div>
            ) : !deferredIsActive ? null : filtered.length === 0 && !searching ? (
              <div className="p-8 text-center text-sm text-slate-400">
                {entries.length === 0 ? "No log entries returned for this time range." : "No entries match the filter."}
              </div>
            ) : (
              <JsonLogView
                entries={filtered}
                wrapLines={wrapLines}
                keywords={keywords}
                searchTerm={search}
                activeEntryIdx={activeMatchIndex ?? -1}
                matchIndices={matchIndices}
                matchCase={highlightMatchCase}
                wholeWord={highlightWholeWord}
                onEntryDoubleClick={handleContextEntry}
                contextAnchorIdx={contextAnchorDisplay ?? -1}
              />
            )
          ) : !fetched ? (
            <div className="flex items-center justify-center h-full min-h-[160px]">
              <p className="text-sm text-slate-400">Select at least one source and click Tail Logs or Search</p>
            </div>
          ) : !deferredIsActive ? null : filtered.length === 0 && !searching ? (
            <div className="p-8 text-center text-sm text-slate-400">
              {entries.length === 0 ? "No log entries returned for this time range." : "No entries match the filter."}
            </div>
          ) : (
            <table className="text-xs border-collapse" style={{ tableLayout: "fixed", width: "100%", minWidth: 700 }}>
              <thead className="sticky top-0 z-10">
                <tr className="bg-slate-50 border-b border-slate-200 text-left">
                  <ResizableHeader label="Timestamp" colKey="timestamp" widths={colWidths} onResize={handleColResize} className="px-3" />
                  <ResizableHeader label="Source" colKey="source" widths={colWidths} onResize={handleColResize} />
                  <ResizableHeader label="Level" colKey="level" widths={colWidths} onResize={handleColResize} />
                  <ResizableHeader label="Transaction" colKey="transaction" widths={colWidths} onResize={handleColResize} />
                  <th className="px-2 py-2 font-semibold text-slate-500">Message</th>
                  <th style={{ width: 24 }} />
                </tr>
              </thead>
              <tbody>
                {pageEntries.map((entry, i) => {
                  const globalIdx = pageStartIdx + i;
                  return (
                    <EntryRow
                      key={globalIdx}
                      entry={entry}
                      source={tailSource}
                      expanded={expandedTableRows.has(globalIdx)}
                      onToggle={() => toggleTableRow(globalIdx)}
                      searchTerm={search}
                      keywords={keywords}
                      onTransactionClick={(txId) => setDrilldown({ txId })}
                      onTimestampClick={onOpenContextTab}
                      onContextClick={() => handleContextEntry(globalIdx)}
                      fullscreen={fullscreen}
                      showFullMessage={showFullMessage}
                      highlighted={highlightedTableIdx === globalIdx || activeMatchIndex === globalIdx}
                      isContextAnchor={contextAnchorDisplay === globalIdx}
                      rowIdx={globalIdx}
                      matchCase={highlightMatchCase}
                      wholeWord={highlightWholeWord}
                      dupeCount={dupeCounts.get(globalIdx) ?? 1}
                    />
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Pagination controls — table view only */}
        {viewMode === "table" && fetched && filtered.length > 0 && (
          <div className="flex items-center justify-between px-4 py-2 border-t border-slate-100 bg-slate-50/50 shrink-0">
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-500">
                Showing {pageStartIdx + 1}–{pageEndIdx} of {filtered.length}
                {currentPage === totalPages && " (latest)"}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <select
                value={pageSize}
                onChange={(e) => { setPageSize(Number(e.target.value)); setPage(Infinity); setExpandedTableRows(new Set()); }}
                className="text-xs rounded border border-slate-300 px-2 py-1 focus:outline-none focus:ring-2 focus:ring-sky-500"
              >
                {[50, 100, 200, 500].map((s) => (
                  <option key={s} value={s}>{s} / page</option>
                ))}
              </select>
              <div className="flex items-center gap-1">
                <button type="button" onClick={() => { setPage(1); setExpandedTableRows(new Set()); scrollContainerRef.current?.scrollTo(0, 0); }} disabled={currentPage <= 1} className="px-2 py-1 text-xs rounded border border-slate-300 text-slate-600 hover:bg-slate-50 disabled:opacity-30 disabled:cursor-not-allowed transition-colors" title="Oldest (page 1)">Oldest</button>
                <button type="button" onClick={() => { setPage((p) => Math.max(1, p - 1)); setExpandedTableRows(new Set()); scrollContainerRef.current?.scrollTo(0, 0); }} disabled={currentPage <= 1} className="px-2 py-1 text-xs rounded border border-slate-300 text-slate-600 hover:bg-slate-50 disabled:opacity-30 disabled:cursor-not-allowed transition-colors" title="Older entries">← Older</button>
                <span className="text-xs text-slate-500 px-2 tabular-nums">{currentPage} / {totalPages}</span>
                <button type="button" onClick={() => { setPage((p) => Math.min(totalPages, p + 1)); setExpandedTableRows(new Set()); scrollContainerRef.current?.scrollTo(0, 0); }} disabled={currentPage >= totalPages} className="px-2 py-1 text-xs rounded border border-slate-300 text-slate-600 hover:bg-slate-50 disabled:opacity-30 disabled:cursor-not-allowed transition-colors" title="Newer entries">Newer →</button>
                <button type="button" onClick={() => { setPage(totalPages); setExpandedTableRows(new Set()); scrollContainerRef.current?.scrollTo(0, 0); }} disabled={currentPage >= totalPages} className="px-2 py-1 text-xs rounded border border-slate-300 text-slate-600 hover:bg-slate-50 disabled:opacity-30 disabled:cursor-not-allowed transition-colors" title="Latest (last page)">Latest</button>
              </div>
            </div>
          </div>
        )}

        {/* Search completed indicator */}
        {mode === "search" && fetchProgress && fetchProgress.done && (
          <div className={cn("flex items-center gap-2 px-4 py-2 border-t border-slate-100 shrink-0", fetchProgress.loaded > 0 ? "bg-emerald-50/50" : "bg-slate-50/50")}>
            {fetchProgress.loaded > 0 ? (
              <svg className="w-3.5 h-3.5 text-emerald-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            ) : (
              <svg className="w-3.5 h-3.5 text-slate-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z" />
              </svg>
            )}
            <span className="text-xs text-slate-600">
              {fetchProgress.loaded > 0
                ? `Search complete — ${fetchProgress.loaded.toLocaleString()} entries loaded`
                : "Search complete — no entries found for this time range"}
            </span>
          </div>
        )}

        {/* Search progress indicator */}
        {(searching || (fetchProgress && !fetchProgress.done)) && (() => {
          // Compute time-based progress percentage across sources
          let pct: number | null = null;
          if (fetchProgress && fetchProgress.overallBegin && fetchProgress.overallEnd && fetchProgress.sourceCount) {
            const rangeStart = new Date(fetchProgress.overallBegin).getTime();
            const rangeEnd = new Date(fetchProgress.overallEnd).getTime();
            const totalRange = rangeEnd - rangeStart;
            if (totalRange > 0) {
              const si = fetchProgress.sourceIdx ?? 0;
              const sc = fetchProgress.sourceCount;
              // Within this source, how far through the time range are we?
              const sourceFrac = fetchProgress.lastTimestamp
                ? Math.max(0, Math.min(1, (new Date(fetchProgress.lastTimestamp).getTime() - rangeStart) / totalRange))
                : 0;
              // Overall: evenly weight each source
              pct = Math.min(99, Math.round(((si + sourceFrac) / sc) * 100));
            }
          }
          return (
            <div className="border-t border-slate-100 bg-sky-50/50 shrink-0">
              {/* Progress bar */}
              {pct !== null && (
                <div className="h-1 bg-slate-100">
                  <div
                    className="h-full bg-sky-500 transition-all duration-300"
                    style={{ width: `${pct}%` }}
                  />
                </div>
              )}
              <div className="flex items-center justify-between px-4 py-2">
                <div className="flex items-center gap-2">
                  {fetchProgress?.paused ? (
                    <span className="inline-block w-2 h-2 rounded-full bg-amber-400 shrink-0" />
                  ) : (
                    <svg className="w-3 h-3 animate-spin text-sky-600 shrink-0" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                  )}
                  <span className="text-xs text-slate-600">
                    {!fetchProgress
                      ? "Starting search…"
                      : fetchProgress.paused
                        ? `Paused — ${fetchProgress.loaded.toLocaleString()} entries loaded`
                        : [
                          fetchProgress.source && `[${fetchProgress.source}]`,
                          fetchProgress.window && fetchProgress.window,
                          fetchProgress.loaded > 0 && `${fetchProgress.loaded.toLocaleString()} entries`,
                          pct !== null && `${pct}%`,
                        ].filter(Boolean).join(' · ')}
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  {fetchProgress?.paused ? (
                    <button
                      type="button"
                      onClick={() => workerRef.current?.postMessage({ type: "fetch-resume" })}
                      className="px-2.5 py-1 text-xs font-medium bg-sky-600 text-white rounded hover:bg-sky-700 transition-colors"
                    >
                      Resume
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => workerRef.current?.postMessage({ type: "fetch-pause" })}
                      className="px-2.5 py-1 text-xs font-medium bg-amber-100 text-amber-700 rounded hover:bg-amber-200 transition-colors"
                    >
                      Pause
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => workerRef.current?.postMessage({ type: "fetch-stop" })}
                    className="px-2.5 py-1 text-xs font-medium bg-red-100 text-red-700 rounded hover:bg-red-200 transition-colors"
                  >
                    Stop
                  </button>
                </div>
              </div>
            </div>
          );
        })()}

        {/* Tail status indicator */}
        {tailing && (
          <div className="flex items-center justify-between px-4 py-2 border-t border-slate-200 bg-slate-50 shrink-0">
            <div className="flex items-center gap-2">
              <span className="inline-block w-2 h-2 rounded-full bg-emerald-500 animate-pulse shrink-0" />
              <span className="text-xs text-slate-600 font-mono">
                {loading
                  ? `Fetching…`
                  : lastUpdated
                    ? `Updated ${lastUpdated.toLocaleTimeString()}`
                    : `Starting…`}
              </span>
              {tailTotalReceived > 0 && (
                <span className="text-xs text-slate-400 font-mono">
                  · {tailTotalReceived.toLocaleString()} total
                  {tailDropped > 0 && ` · ${entries.length.toLocaleString()} in buffer`}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  try {
                    const lines = entries.map((e) => formatTerminalLine(e, tailSource)).join("\n");
                    const blob = new Blob([lines], { type: "text/plain" });
                    const url = URL.createObjectURL(blob);
                    const a = Object.assign(document.createElement("a"), {
                      href: url,
                      download: `tail-${new Date().toISOString().slice(0, 19).replace(/:/g, "")}.log`,
                    });
                    a.click();
                    URL.revokeObjectURL(url);
                  } catch { /* ignore */ }
                }}
                className="px-2.5 py-1 text-xs font-medium bg-slate-200 text-slate-700 rounded hover:bg-slate-300 transition-colors"
              >
                Export session
              </button>
              <button
                type="button"
                onClick={() => onConfigChange({ tailing: false })}
                className="px-2.5 py-1 text-xs font-medium bg-red-100 text-red-700 rounded hover:bg-red-200 transition-colors"
              >
                Stop
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ── Transaction drill-down modal ── */}
      {
        drilldown && (
          <TransactionDrilldown
            transactionId={drilldown.txId}
            env={env}
            availableSources={[...LOG_SOURCES]}
            onClose={() => setDrilldown(null)}
          />
        )
      }
    </div >
  );
}

// ── Tabs wrapper with shared controls above ──────────────────────────────────

interface TabDef {
  id: number;
  label: string;
  config: TabConfig;
  /** Timestamp of the anchor entry — context tabs highlight after API fetch */
  anchorTimestamp?: string;
}

function makeDefaultConfig(environments: EnvWithLogApi[]): TabConfig {
  const defaultEnv = environments.find((e) => e.hasLogApi) ?? environments[0];
  return {
    env: defaultEnv?.name ?? "",
    selectedSources: ["am-everything", "idm-everything"],
    sourcesError: "",
    levelFilter: "ALL",
    mode: "tail",
    tailSecs: 5,
    tailing: false,
    loading: false,
    preset: "1h",
    customBegin: toDatetimeLocal(new Date(Date.now() - 3600000).toISOString()),
    customEnd: toDatetimeLocal(new Date().toISOString()),
    searchSeq: 0,
    searching: false,
  };
}

let _nextTabId = 2;

const LOGS_STATE_KEY = "logs-explorer-state-v1";

function sanitizeConfigForPersist(cfg: TabConfig): TabConfig {
  return {
    ...cfg,
    tailing: false,
    loading: false,
    searching: false,
    sourcesError: "",
    searchSeq: 0,
  };
}

export function LogsExplorerTabs({ environments }: { environments: EnvWithLogApi[] }) {
  const [mounted, setMounted] = useState(false);
  const [tabs, setTabs] = useState<TabDef[]>([
    { id: 1, label: "Tab 1", config: makeDefaultConfig(environments) },
  ]);
  const [activeId, setActiveId] = useState(1);
  const [fullscreen, setFullscreen] = useState(false);
  const [tzMode, setTzMode] = useState<TzMode>("local");
  const [tailBufferMax, setTailBufferMax] = useState<number>(TAIL_BUFFER_DEFAULT);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(LOGS_STATE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as { tabs?: TabDef[]; activeId?: number; tzMode?: TzMode; tailBufferMax?: number };
        if (parsed.tzMode && TZ_OPTIONS.some((o) => o.value === parsed.tzMode)) {
          setTzMode(parsed.tzMode);
        }
        if (typeof parsed.tailBufferMax === "number" && TAIL_BUFFER_OPTIONS.some((o) => o.value === parsed.tailBufferMax)) {
          setTailBufferMax(parsed.tailBufferMax);
        }
        if (Array.isArray(parsed.tabs) && parsed.tabs.length > 0) {
          const validEnvNames = new Set(environments.map((e) => e.name));
          const defaultCfg = makeDefaultConfig(environments);
          const restored = parsed.tabs.map((t) => {
            const merged = { ...defaultCfg, ...t.config };
            // Reset env if the stored value no longer exists
            if (!validEnvNames.has(merged.env)) merged.env = defaultCfg.env;
            // Reset tailSecs if the stored value is no longer a valid option
            if (!TAIL_SECS_OPTIONS.some((o) => o.value === merged.tailSecs)) {
              merged.tailSecs = defaultCfg.tailSecs;
            }
            return { ...t, config: sanitizeConfigForPersist(merged) };
          });
          setTabs(restored);
          const maxId = Math.max(...restored.map((t) => t.id));
          _nextTabId = maxId + 1;
          if (parsed.activeId && restored.some((t) => t.id === parsed.activeId)) {
            setActiveId(parsed.activeId);
          } else {
            setActiveId(restored[0].id);
          }
        }
      }
    } catch { /* ignore */ }
    setMounted(true);
  }, [environments]);

  useEffect(() => {
    if (!mounted) return;
    try {
      const payload = {
        tabs: tabs.map((t) => ({ id: t.id, label: t.label, config: sanitizeConfigForPersist(t.config) })),
        activeId,
        tzMode,
        tailBufferMax,
      };
      localStorage.setItem(LOGS_STATE_KEY, JSON.stringify(payload));
    } catch { /* ignore */ }
  }, [mounted, tabs, activeId, tzMode, tailBufferMax]);

  useEffect(() => {
    if (!fullscreen) return;
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") setFullscreen(false); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [fullscreen]);

  const activeTab = tabs.find((t) => t.id === activeId) ?? tabs[0];
  const cfg = activeTab?.config;

  const [txInput, setTxInput] = useState("");
  // txSearch is stamped with the originating tabId so the search only loads
  // into that tab. Without `tabId`, switching back to a previously-active
  // tab would re-deliver the latest search and clobber its results.
  const [txSearch, setTxSearch] = useState<{ id: string; seq: number; tabId: number } | undefined>(undefined);

  function submitTxSearch() {
    const id = txInput.trim();
    if (id && activeId != null) setTxSearch((prev) => ({ id, seq: (prev?.seq ?? 0) + 1, tabId: activeId }));
  }

  const updateActiveConfig = useCallback((updates: Partial<TabConfig>) => {
    setTabs((prev) =>
      prev.map((t) =>
        t.id === activeId ? { ...t, config: { ...t.config, ...updates } } : t
      )
    );
  }, [activeId]);

  function addTab() {
    const id = _nextTabId++;
    setTabs((prev) => [...prev, { id, label: `Tab ${id}`, config: makeDefaultConfig(environments) }]);
    setActiveId(id);
  }

  function openContextTab(timestamp: string, source: string) {
    const id = _nextTabId++;
    const ts = new Date(timestamp).getTime();
    const begin = toDatetimeLocal(new Date(ts - 60000).toISOString(), tzMode);
    const end = toDatetimeLocal(new Date(ts + 60000).toISOString(), tzMode);
    const isIDM = source.startsWith("idm-");
    const contextSources = isIDM ? ["idm-everything"] : ["am-everything"];
    const shortTime = new Date(timestamp).toLocaleTimeString(undefined, { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const sourceLabel = isIDM ? "idm-everything" : "am-everything";
    const tabEnv = tabs.find((t) => t.id === activeId)?.config.env ?? "";
    const label = `${sourceLabel} (${tabEnv}) ±1m @${shortTime}`;
    const baseConfig = makeDefaultConfig(environments);
    const config: TabConfig = {
      ...baseConfig,
      env: (tabs.find((t) => t.id === activeId)?.config.env) ?? baseConfig.env,
      selectedSources: contextSources,
      mode: "search",
      preset: "custom",
      customBegin: begin,
      customEnd: end,
      searchSeq: 1,
      searching: false,
    };
    setTabs((prev) => [...prev, { id, label, config }]);
    setActiveId(id);
  }

  function openEntryContextTab(anchorTs: string, beginTs: string, endTs: string) {
    const id = _nextTabId++;
    const tabEnv = tabs.find((t) => t.id === activeId)?.config.env ?? "";
    const tabSources = tabs.find((t) => t.id === activeId)?.config.selectedSources ?? ["am-everything", "idm-everything"];
    const shortTime = new Date(anchorTs).toLocaleTimeString(undefined, { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const label = `±5s @${shortTime} (${tabEnv})`;
    const begin = toDatetimeLocal(beginTs, tzMode);
    const end = toDatetimeLocal(endTs, tzMode);
    const baseConfig = makeDefaultConfig(environments);
    const config: TabConfig = {
      ...baseConfig,
      env: tabEnv || baseConfig.env,
      selectedSources: tabSources,
      mode: "search",
      preset: "custom",
      customBegin: begin,
      customEnd: end,
      searchSeq: 1,
      searching: false,
    };
    setTabs((prev) => [...prev, { id, label, config, anchorTimestamp: anchorTs }]);
    setActiveId(id);
  }

  function closeTab(id: number) {
    setTabs((prev) => {
      const next = prev.filter((t) => t.id !== id);
      if (activeId === id) {
        const idx = prev.findIndex((t) => t.id === id);
        const fallback = prev[idx + 1] ?? prev[idx - 1];
        if (fallback) setActiveId(fallback.id);
      }
      configUpdatersRef.current.delete(id);
      return next;
    });
  }

  function updateLabel(id: number, label: string) {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, label } : t)));
  }

  // Stable per-tab config updaters — avoids creating new closures every render
  const configUpdatersRef = useRef(new Map<number, (updates: Partial<TabConfig>) => void>());
  const getConfigUpdater = useCallback((tabId: number) => {
    let fn = configUpdatersRef.current.get(tabId);
    if (!fn) {
      fn = (updates: Partial<TabConfig>) =>
        setTabs((prev) =>
          prev.map((t) =>
            t.id === tabId ? { ...t, config: { ...t.config, ...updates } } : t
          )
        );
      configUpdatersRef.current.set(tabId, fn);
    }
    return fn;
  }, []);

  // Stable tabs summary for child LogsExplorer tab-switcher UI
  const tabsSummary = useMemo(() => tabs.map((t) => ({ id: t.id, label: t.label })), [tabs]);

  const selectedEnv = environments.find((e) => e.name === cfg?.env);

  if (!mounted) {
    return <div className="h-64 flex items-center justify-center text-sm text-slate-400">Loading…</div>;
  }

  return (
    <TzContext.Provider value={tzMode}>
      <TailBufferContext.Provider value={tailBufferMax}>
        <div className="space-y-0">
          {/* ── Controls (above tabs) ── */}
          {cfg && (
            <div className="card-padded space-y-4 rounded-b-none border-b-0">
              {/* Row 1: env + source + level */}
              <div className="flex flex-wrap items-end gap-4">
                <div className="space-y-1">
                  <label className="label-xs">Environment</label>
                  <select
                    value={cfg.env}
                    onChange={(e) => updateActiveConfig({ env: e.target.value, tailing: false })}
                    disabled={cfg.loading || cfg.tailing}
                    className="block px-3 py-2.5 rounded-lg border border-slate-200 text-[13px] outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 disabled:opacity-50 bg-white"
                  >
                    {environments.map((e) => (
                      <option key={e.name} value={e.name} disabled={!e.hasLogApi}>
                        {e.label}{!e.hasLogApi ? " (no credentials)" : ""}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="space-y-1">
                  <label className="label-xs">Log Source</label>
                  <div className="flex gap-3 py-1">
                    {LOG_SOURCES.map((s) => (
                      <label key={s} className={cn("flex items-center gap-1.5 text-sm cursor-pointer select-none", (cfg.loading || cfg.tailing) ? "opacity-50 cursor-not-allowed" : "")}>
                        <input
                          type="checkbox"
                          checked={cfg.selectedSources.includes(s)}
                          disabled={cfg.loading || cfg.tailing}
                          onChange={(e) => {
                            const next = e.target.checked
                              ? [...cfg.selectedSources, s]
                              : cfg.selectedSources.filter((x) => x !== s);
                            updateActiveConfig({ selectedSources: next, tailing: false });
                          }}
                          className="rounded border-slate-300 text-sky-600 focus:ring-sky-500"
                        />
                        <span className="font-mono text-xs">{s}</span>
                      </label>
                    ))}
                  </div>
                </div>

                <div className="space-y-1">
                  <label className="label-xs">Min Level</label>
                  <select
                    value={cfg.levelFilter}
                    onChange={(e) => updateActiveConfig({ levelFilter: e.target.value })}
                    className="block px-3 py-2.5 rounded-lg border border-slate-200 text-[13px] outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 bg-white"
                  >
                    {LEVEL_FILTERS.map((l) => (
                      <option key={l.value} value={l.value}>{l.label}</option>
                    ))}
                  </select>
                </div>

                <div className="space-y-1">
                  <label className="label-xs">Timezone</label>
                  <select
                    value={tzMode}
                    onChange={(e) => setTzMode(e.target.value as TzMode)}
                    className="block px-3 py-2.5 rounded-lg border border-slate-200 text-[13px] outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 bg-white"
                  >
                    {TZ_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </div>

                <div className="space-y-1">
                  <label className="label-xs" title="Maximum number of tail entries kept in memory; older entries are dropped">Tail buffer</label>
                  <select
                    value={tailBufferMax}
                    onChange={(e) => setTailBufferMax(Number(e.target.value))}
                    className="block px-3 py-2.5 rounded-lg border border-slate-200 text-[13px] outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 bg-white"
                  >
                    {TAIL_BUFFER_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </div>

                <div className="space-y-1">
                  <label className="label-xs" title="How often to poll AIC for new tail entries. Backlogs are drained inside one tick before the next poll.">Poll every</label>
                  <select
                    value={cfg.tailSecs}
                    onChange={(e) => updateActiveConfig({ tailSecs: Number(e.target.value) as TailSecs })}
                    className="block px-3 py-2.5 rounded-lg border border-slate-200 text-[13px] outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 bg-white"
                  >
                    {TAIL_SECS_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </div>

                {selectedEnv && (
                  <div className="pb-0.5">
                    <EnvironmentBadge env={selectedEnv} />
                  </div>
                )}
              </div>

              {/* Row 2: transaction ID search */}
              <div className="flex items-center gap-2">
                <label className="label-xs shrink-0">Transaction ID</label>
                <input
                  type="text"
                  value={txInput}
                  onChange={(e) => setTxInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") submitTxSearch(); }}
                  placeholder="Paste a transaction ID to trace…"
                  className="px-3 py-2.5 rounded-lg border border-slate-200 text-[13px] outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 font-mono w-96"
                />
                <button
                  type="button"
                  onClick={submitTxSearch}
                  disabled={!txInput.trim() || !cfg?.env || cfg?.loading}
                  className="btn-primary disabled:opacity-40 flex items-center gap-1.5"
                >
                  {cfg?.loading && txSearch ? (
                    <>
                      <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                      </svg>
                      Tracing…
                    </>
                  ) : (
                    "Trace"
                  )}
                </button>
                {txInput && (
                  <button type="button" onClick={() => { setTxInput(""); setTxSearch(undefined); }} className="text-xs text-slate-400 hover:text-slate-600 transition-colors">
                    Clear
                  </button>
                )}
              </div>
            </div>
          )}

          {/* ── Tab bar ── */}
          <div className="flex items-end gap-0 border-b border-slate-200 bg-white border-x border-slate-200">
            {tabs.map((tab) => (
              <div
                key={tab.id}
                className={cn(
                  "flex items-center gap-1.5 px-3 py-2 text-xs border-b-2 cursor-pointer select-none transition-colors",
                  tab.id === activeId
                    ? "border-sky-600 text-slate-900 font-medium bg-white"
                    : "border-transparent text-slate-500 hover:text-slate-700 hover:bg-slate-50"
                )}
              >
                <span onClick={() => setActiveId(tab.id)} className="max-w-[160px] truncate">
                  {tab.label}
                </span>
                {tabs.length > 1 && (
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); closeTab(tab.id); }}
                    className="text-slate-300 hover:text-slate-500 leading-none text-sm ml-0.5"
                    title="Close tab"
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
            <button
              type="button"
              onClick={addTab}
              className="px-3 py-2 text-slate-400 hover:text-slate-700 hover:bg-slate-50 text-base leading-none transition-colors"
              title="New tab"
            >
              +
            </button>
          </div>

          {/* ── Tab panels ── */}
          {tabs.map((tab) => (
            <div key={tab.id} className={tab.id === activeId ? "" : "hidden"}>
              <div className="pt-4">
                <LogsExplorer
                  environments={environments}
                  config={tab.config}
                  onConfigChange={getConfigUpdater(tab.id)}
                  isActive={tab.id === activeId}
                  onLabelChange={(label) => updateLabel(tab.id, label)}
                  tabs={tabsSummary}
                  activeTabId={activeId}
                  onTabSwitch={setActiveId}
                  fullscreen={fullscreen}
                  onFullscreenChange={setFullscreen}
                  txSearchId={txSearch && txSearch.tabId === tab.id ? { id: txSearch.id, seq: txSearch.seq } : undefined}
                  onOpenContextTab={openContextTab}
                  onOpenEntryContextTab={openEntryContextTab}
                  anchorTimestamp={tab.anchorTimestamp}
                />
              </div>
            </div>
          ))}
        </div>
      </TailBufferContext.Provider>
    </TzContext.Provider>
  );
}
