"use client";

import { useState, useEffect, useLayoutEffect, useRef, Fragment, startTransition, useDeferredValue, useCallback, useMemo, memo, createContext, useContext, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Environment } from "@/lib/fr-config-types";
import { useDialog } from "@/components/ConfirmDialog";
import { cn } from "@/lib/utils";
import { logEntryMatchKey } from "@/lib/log-match-navigation";
import { parseQuery } from "@/lib/log-query";
import { parsePastedTimestamp } from "@/lib/log-time-paste";
import { appendClause, buildClause, flattenPayload, operatorsFor, type FilterOp, type PayloadField } from "@/lib/log-filter-builder";
import { useBusyState } from "@/hooks/useBusyState";
import { DownloadMenu } from "./DownloadMenu";
import { SourcePicker } from "./SourcePicker";
import { FALLBACK_LOG_SOURCES } from "@/lib/logs/log-source-groups";
import { DEFAULT_LOG_SOURCES } from "@/lib/logs/log-sources";

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

/**
 * True when the user has an active text selection (e.g. click-and-drag to
 * highlight text inside a log row). Used by row click handlers to suppress
 * expand/collapse toggles so that text selection across rows isn't disrupted.
 */
function isUserSelectingText(): boolean {
  if (typeof window === "undefined") return false;
  const sel = window.getSelection();
  return !!sel && !sel.isCollapsed && sel.toString().length > 0;
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

type LogMode = "tail" | "search" | "transaction";
type Preset = "15m" | "1h" | "2h" | "3h" | "4h" | "5h" | "6h" | "24h" | "3d" | "5d" | "7d" | "30d" | "custom";

const PRESETS: { label: string; value: Preset; ms: number }[] = [
  { label: "15 min", value: "15m", ms: 15 * 60 * 1000 },
  { label: "1 hour", value: "1h", ms: 60 * 60 * 1000 },
  { label: "2 hours", value: "2h", ms: 2 * 60 * 60 * 1000 },
  { label: "3 hours", value: "3h", ms: 3 * 60 * 60 * 1000 },
  { label: "4 hours", value: "4h", ms: 4 * 60 * 60 * 1000 },
  { label: "5 hours", value: "5h", ms: 5 * 60 * 60 * 1000 },
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
// Browsers enforce a minimum scrollbar thumb size (~16-20px). When content is
// so tall that the natural thumb size (clientHeight^2 / scrollHeight) falls
// below this minimum, the cursor-to-thumb mapping becomes non-linear: the
// browser shrinks the thumb to the minimum, so dragging the cursor through
// the full track no longer corresponds to traversing the full scroll range
// proportionally — the thumb visibly drifts away from the cursor.
//
// To keep the mapping LINEAR (so the thumb tracks the cursor pixel-perfect),
// we cap nowrap scrollHeight so the natural thumb size never falls below
// this minimum. Above the cap we scale-map scrollTop -> virtual row position
// and translate the rendered row group manually.
const NOWRAP_MIN_THUMB_H = 40; // safe margin above browser minimum
function computeNowrapScrollCap(clientH: number): number {
  // thumb_h = clientH^2 / scrollH; require thumb_h >= NOWRAP_MIN_THUMB_H
  return Math.max(clientH + 1, Math.floor((clientH * clientH) / NOWRAP_MIN_THUMB_H));
}



/** `keepMs` appends non-zero milliseconds (`.fff`), which datetime-local values allow. */
function toDatetimeLocal(iso: string, tz: TzMode = "local", keepMs = false): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  const ms = keepMs && d.getMilliseconds() ? `.${String(d.getMilliseconds()).padStart(3, "0")}` : "";
  if (tz === "epoch") {
    // datetime-local input can't show epoch; fall back to UTC representation
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}${ms}`;
  }
  if (tz === "utc") {
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}${ms}`;
  }
  // local
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${ms}`;
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
  // Transaction mode
  /** Transaction ID input value (per-tab). */
  txQuery?: string;
  /** Incremented to trigger a transaction trace fetch. */
  txSeq?: number;
  // View prefs (persisted per tab)
  viewMode?: "terminal" | "table" | "raw" | "json"; // "json": removed view, may still be saved; read as table
  /** @deprecated — use viewMode. Retained so old persisted tabs still open on the right view. */
  terminalView?: boolean;
  wrapLines?: boolean;
  dedupe?: boolean;
  autoScroll?: boolean;
  /** Search-mode data source: live AIC ("remote") or the local archive ("local"). */
  dataSource?: "remote" | "local";

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

/** Expand the Logs source picker's aliases to the archive's real sources. */
function toArchiveSources(selected: string[]): string[] {
    const out = new Set<string>();
    for (const s of selected) {
        if (s === "am-everything") DEFAULT_LOG_SOURCES.filter((x) => x.startsWith("am-")).forEach((x) => out.add(x));
        else if (s === "idm-everything") DEFAULT_LOG_SOURCES.filter((x) => x.startsWith("idm-")).forEach((x) => out.add(x));
        else if (DEFAULT_LOG_SOURCES.includes(s)) out.add(s);
    }
    return [...out];
}

/** Map an archive query row (payloadJson = full entry JSON) to a displayed LogEntry. */
function mapArchiveRowToEntry(row: { payloadJson: string; timestamp: string; source: string }): LogEntry & { source: string } {
    try {
        const e = JSON.parse(row.payloadJson) as { timestamp?: string; type?: string; source?: string; payload?: unknown };
        return {
            timestamp: e.timestamp ?? row.timestamp,
            type: e.type ?? "",
            source: e.source ?? row.source,
            payload: (e.payload ?? {}) as Record<string, unknown> | string,
        };
    } catch {
        return { timestamp: row.timestamp, type: "", source: row.source, payload: { __raw: row.payloadJson } };
    }
}

/** Page the archive query (capped) and return mapped entries + total. */
async function fetchLocalSearchEntries(params: {
    env: string; sources: string[]; from: string; to: string; text?: string; level?: string;
}): Promise<{ entries: (LogEntry & { source: string })[]; total: number; capped: boolean }> {
    const LIMIT = 1000;
    const MAX = 5000;
    const entries: (LogEntry & { source: string })[] = [];
    let total = 0;
    let offset = 0;
    for (;;) {
        const res = await fetch("/api/logs/archive/query", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...params, offset, limit: LIMIT }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
        total = typeof data.total === "number" ? data.total : 0;
        const rows: { payloadJson: string; timestamp: string; source: string }[] = Array.isArray(data.rows) ? data.rows : [];
        for (const r of rows) entries.push(mapArchiveRowToEntry(r));
        offset += rows.length;
        if (rows.length < LIMIT || entries.length >= MAX || offset >= total) break;
    }
    return { entries, total, capped: entries.length < total };
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
    const date = d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: tzOpt });
    const time = d.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: tzOpt })
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

/**
 * ScrollbarOverlay — visually consistent custom vertical scrollbar that
 * mirrors and drives a native scroll container's scrollTop. Renders via
 * portal in fixed positioning so it doesn't fight parent stacking contexts
 * or get clipped by the container's `overflow`. Pair with the
 * `scrollbar-hidden` CSS class on the container to suppress the native bar.
 */
function ScrollbarOverlay({ containerRef }: { containerRef: RefObject<HTMLElement | null> }) {
  const [layout, setLayout] = useState<{
    top: number; height: number; left: number;
    st: number; sh: number; ch: number;
  } | null>(null);
  const dragRef = useRef<{ startY: number; startTop: number; travel: number; scrollable: number } | null>(null);

  const measure = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setLayout((prev) => {
      const next = {
        top: r.top, height: r.height, left: r.right,
        st: el.scrollTop, sh: el.scrollHeight, ch: el.clientHeight,
      };
      if (
        prev &&
        prev.top === next.top && prev.height === next.height && prev.left === next.left &&
        prev.st === next.st && prev.sh === next.sh && prev.ch === next.ch
      ) return prev;
      return next;
    });
  }, [containerRef]);

  // Initial + listeners.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    measure();
    const onScroll = () => measure();
    el.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener("resize", measure);
    // Capture any ancestor scroll so our fixed position stays correct.
    window.addEventListener("scroll", measure, true);
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [containerRef, measure]);

  // Re-measure after every render of the parent (catches content height changes).
  useLayoutEffect(() => { measure(); });

  if (!layout) return null;
  const scrollable = Math.max(0, layout.sh - layout.ch);
  if (scrollable <= 0 || layout.height <= 0) return null;

  const trackH = layout.ch;
  const thumbH = Math.max(24, Math.min(trackH, (layout.ch / layout.sh) * trackH));
  const thumbTravel = Math.max(1, trackH - thumbH);
  const thumbTop = (layout.st / scrollable) * thumbTravel;

  const onThumbPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const el = containerRef.current;
    if (!el) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const sc = Math.max(0, el.scrollHeight - el.clientHeight);
    const travel = Math.max(1, el.clientHeight - thumbH);
    dragRef.current = { startY: e.clientY, startTop: el.scrollTop, travel, scrollable: sc };
  };
  const onThumbPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const el = containerRef.current;
    if (!el) return;
    const next = d.startTop + (e.clientY - d.startY) * (d.scrollable / d.travel);
    el.scrollTop = Math.min(d.scrollable, Math.max(0, next));
  };
  const onThumbPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    dragRef.current = null;
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  };
  const onTrackPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return; // ignore clicks on the thumb
    const el = containerRef.current;
    if (!el) return;
    const trackTop = (e.currentTarget as HTMLElement).getBoundingClientRect().top;
    const clickY = e.clientY - trackTop;
    const page = el.clientHeight * 0.9;
    const sc = Math.max(0, el.scrollHeight - el.clientHeight);
    el.scrollTop = Math.min(sc, Math.max(0, el.scrollTop + (clickY < thumbTop ? -page : page)));
  };

  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      onPointerDown={onTrackPointerDown}
      className="bg-slate-100/40 hover:bg-slate-100/70 transition-colors"
      style={{
        position: "fixed",
        top: layout.top, height: layout.height,
        left: layout.left,
        width: 12,
        zIndex: 50,
        touchAction: "none",
        pointerEvents: "auto",
      }}
    >
      <div
        onPointerDown={onThumbPointerDown}
        onPointerMove={onThumbPointerMove}
        onPointerUp={onThumbPointerUp}
        onPointerCancel={onThumbPointerUp}
        className="absolute left-0.5 right-0.5 rounded bg-slate-400/70 hover:bg-slate-500/80 active:bg-slate-600 cursor-grab active:cursor-grabbing"
        style={{ top: thumbTop, height: thumbH, touchAction: "none" }}
      />
    </div>,
    document.body,
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
    const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, "0")}`;
    return `${date} ${time}  ${src}  ${lvl}  ${msg}`;
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
  dupeCounts, autoScroll = true, onEntryClick, onTimestampClick, contextAnchorIdx = null,
  expandCommand = null, matchIndices = null, filterActive = false, selectedEntryIdx = null,
  evictedCount = 0,
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
  onEntryClick?: (idx: number) => void;
  /** Click on the formatted timestamp opens a ±5s context tab for that entry. */
  onTimestampClick?: (idx: number) => void;
  contextAnchorIdx?: number | null;
  /** Bulk expand/collapse signal from parent. Bumped via nonce to retrigger. */
  expandCommand?: { kind: "all" | "none"; nonce: number } | null;
  /** Highlight match indices into `entries`; when set, all match rows auto-expand. */
  matchIndices?: number[] | null;
  /** Whether the parent Filter is active. When true, every visible row matches → expand all. */
  filterActive?: boolean;
  /** Entry index currently selected by user click (sky highlight, distinct from match-amber). */
  selectedEntryIdx?: number | null;
  /** Cumulative count of entries evicted from the front of the parent buffer. Used
   *  to keep the viewport visually stable when autoScroll is off and the circular
   *  buffer trims the oldest entries during tailing. */
  evictedCount?: number;
}) {
  const outerRef = useRef<HTMLDivElement>(null);
  const [viewH, setViewH] = useState(400);
  // Debug logger — enable in console with:
  //   localStorage.setItem('debug-tail','1'); location.reload();
  // Disable with: localStorage.removeItem('debug-tail'); location.reload();
  const tdbg = useCallback((label: string, data?: Record<string, unknown>) => {
    if (typeof window === "undefined") return;
    try {
      if (window.localStorage?.getItem("debug-tail") !== "1") return;
    } catch { return; }
    // Single-line shape so it's easy to grep in DevTools
    // eslint-disable-next-line no-console
    console.log(`[TailTerminal] ${label}`, data ?? {});
  }, []);
  // Initial atBottom state: when there's a pending
  // scroll request on mount (user switched view with a highlight/selection
  // active), start NOT at bottom — otherwise the auto-tail effect (which
  // fires before scroll-to-match in declaration order) would yank the
  // viewport to the end and a concurrent new tail batch could flash the
  // bottom before scroll-to-match overrides it.
  // NOTE: atBottomRef now means "auto-scroll is FOLLOWING". It starts true
  // (we're following on mount) and is demoted to false on any user
  // interaction (manual scroll, click on a row, scroll-to-match). It is
  // ONLY re-promoted to true by the user clicking the "Jump to bottom"
  // button — never automatically. This matches the user's mental model:
  // any manual intervention pauses tailing until they explicitly resume.
  const atBottomRef = useRef(scrollRequest == null);
  const [atBottom, setAtBottom] = useState(scrollRequest == null);
  // Nowrap virtual list: track only the computed startIdx to avoid re-renders
  // on every scroll pixel.  Raw scrollTop is kept in a ref.
  const scrollTopRef = useRef(0);
  // Lazy initial startIdx: when mounted with a pending scrollRequest (e.g.
  // user switched view back to terminal with a row highlighted), render the
  // window AROUND the target row on the very first paint. Otherwise the first
  // paint shows rows 0..viewport (highlight not present), then the
  // scroll-to-request effect below jumps the viewport — a visible flash where
  // the highlight "disappears" momentarily.
  const [startIdx, setStartIdx] = useState(() => {
    const idx = scrollRequest?.index;
    if (idx == null || idx < 0) return 0;
    // 400 = initial viewH guess (matches viewH initial state); good enough for
    // first paint; handleScroll will refine after layout measures the real
    // height.
    const viewportRows = Math.ceil(400 / TERMINAL_ROW_H);
    return Math.max(0, idx - Math.floor(viewportRows / 2) - TERMINAL_OVERSCAN);
  });
  // Ref to the absolutely-positioned row group inside the nowrap container.
  // We translate it via DOM (no re-render) so the rendered rows stay glued to
  // the viewport even when the scroll surface is scaled to cap scrollHeight.
  const nowrapGroupRef = useRef<HTMLDivElement>(null);
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

  // Variable-height virtualizer for wrap mode. Running-average estimateSize +
  // per-index height freeze keeps scrollHeight stable so the scrollbar thumb
  // tracks the cursor while dragging instead of falling behind as rows mount
  // and re-measure.
  const wrapAvgRef = useRef(32);
  const wrapSumRef = useRef(0);
  // Sample average of measured rows for the estimate. We always trust the
  // latest getBoundingClientRect for actual measurements (no per-row cache),
  // so row content changes — line-clamp toggle, ring/border on click highlight
  // — propagate immediately and the virtualizer reflows the rows below.
  const wrapMeasuredSetRef = useRef<Set<number>>(new Set());
  const wrapVirtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => outerRef.current,
    estimateSize: () => wrapAvgRef.current,
    measureElement: (el) => {
      const idxAttr = el.getAttribute("data-index");
      const idx = idxAttr != null ? Number(idxAttr) : NaN;
      const h = el.getBoundingClientRect().height;
      if (Number.isFinite(idx)) {
        const seen = wrapMeasuredSetRef.current;
        if (!seen.has(idx)) {
          seen.add(idx);
          wrapSumRef.current += h;
          if (seen.size >= 5 && seen.size < 60) {
            wrapAvgRef.current = wrapSumRef.current / seen.size;
          }
        }
      }
      return h;
    },
    overscan: TERMINAL_OVERSCAN,
    enabled: wrapLines,
  });

  // Helper: convert virtual scroll position (in row-pixel space) to actual
  // scrollTop pixels accounting for nowrap scrollHeight capping.
  const virtualToActualScrollTop = useCallback((virtual: number) => {
    const el = outerRef.current;
    if (!el) return virtual;
    const intrinsicH = entries.length * TERMINAL_ROW_H;
    const cap = computeNowrapScrollCap(el.clientHeight);
    if (intrinsicH <= cap) return virtual;
    const intrinsicScroll = Math.max(1, intrinsicH - el.clientHeight);
    const actualScroll = Math.max(1, cap - el.clientHeight);
    return Math.max(0, (virtual / intrinsicScroll) * actualScroll);
  }, [entries.length]);

  // Auto-scroll to bottom when new entries arrive.
  // Must be a useLayoutEffect (not useEffect) for the nowrap path: setting
  // scrollTop in a post-paint effect produces a one-frame "white flash"
  // because the row slice (anchored at the old startIdx) doesn't match the
  // new scrollTop until handleScroll lands. The render-time effectiveStartIdx
  // below also bottom-anchors the slice while at-bottom + autoScroll, so the
  // transform stays coherent even before this effect runs.
  useLayoutEffect(() => {
    if (!autoScroll || !atBottomRef.current) {
      tdbg("auto-scroll skip", { autoScroll, atBottomRef: atBottomRef.current, entriesLen: entries.length });
      return;
    }
    lastProgrammaticScrollRef.current = Date.now();
    if (wrapLines) {
      if (entries.length > 0) {
        wrapVirtualizer.scrollToIndex(entries.length - 1, { align: "end" });
        tdbg("auto-scroll wrap", { toIndex: entries.length - 1 });
      }
    } else if (outerRef.current) {
      const before = outerRef.current.scrollTop;
      outerRef.current.scrollTop = outerRef.current.scrollHeight;
      tdbg("auto-scroll nowrap", { entriesLen: entries.length, scrollTopBefore: before, scrollTopAfter: outerRef.current.scrollTop, scrollHeight: outerRef.current.scrollHeight });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries.length, wrapLines, autoScroll]);

  // Anchor virtual scroll position when entries grow while auto-scroll is
  // PAUSED (atBottomRef.current === false). The nowrap scrollHeight cap
  // (computeNowrapScrollCap) means the same actual scrollTop maps to a
  // different virtual position whenever intrinsicH (= entries.length * H)
  // changes — specifically, when entries grow, the same scrollTop now
  // points to a LATER virtual row, so the user's view silently shifts
  // downward ("scrollbar moved down" sensation) and can drift back into
  // the bottom-detection zone, re-engaging auto-scroll.
  //
  // Fix: snapshot the virtual position BEFORE entries grow and recompute
  // scrollTop so the same virtual row stays under the same pixel.
  const prevEntriesLenRef = useRef(entries.length);
  useLayoutEffect(() => {
    const prevLen = prevEntriesLenRef.current;
    prevEntriesLenRef.current = entries.length;
    if (entries.length <= prevLen) return;             // only handle growth
    if (wrapLines) return;                             // wrap virtualizer self-anchors via measureElement
    if (autoScroll && atBottomRef.current) return;     // auto-scroll path handles bottom-following
    const el = outerRef.current;
    if (!el) return;

    const clientH = el.clientHeight;
    const cap = computeNowrapScrollCap(clientH);
    const intrinsicHNew = entries.length * TERMINAL_ROW_H;
    const intrinsicHOld = prevLen * TERMINAL_ROW_H;
    const denomNew = Math.max(1, Math.min(intrinsicHNew, cap) - clientH);
    const denomOld = Math.max(1, Math.min(intrinsicHOld, cap) - clientH);
    const intrinsicScrollNew = Math.max(1, intrinsicHNew - clientH);
    const intrinsicScrollOld = Math.max(1, intrinsicHOld - clientH);
    // Virtual position the user was looking at before growth
    const virtualOld = intrinsicHOld > cap
      ? (el.scrollTop / denomOld) * intrinsicScrollOld
      : el.scrollTop;
    // scrollTop that yields the same virtual position post-growth
    const newScrollTop = intrinsicHNew > cap
      ? (virtualOld / intrinsicScrollNew) * denomNew
      : virtualOld;
    const drift = Math.abs(newScrollTop - el.scrollTop);
    tdbg("anchor-on-growth", {
      prevLen, newLen: entries.length, scrollTop: el.scrollTop, newScrollTop,
      virtualOld, intrinsicHOld, intrinsicHNew, capped: intrinsicHNew > cap, drift,
    });
    if (drift > 0.5) {
      lastProgrammaticScrollRef.current = Date.now();
      el.scrollTop = newScrollTop;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries.length, wrapLines, autoScroll]);

  // Stabilize viewport when buffer evicts from the front. When autoScroll is
  // off (or the user has scrolled away from bottom), every front-eviction
  // shifts every row up by N indices. Without compensation the same scrollTop
  // now reveals different content — that's the "jiggle". We subtract the
  // dropped row height from scrollTop so the rows the user is looking at stay
  // anchored on screen.
  const prevEvictedRef = useRef(evictedCount);
  useEffect(() => {
    const delta = evictedCount - prevEvictedRef.current;
    prevEvictedRef.current = evictedCount;
    if (delta <= 0) return;
    // Re-key the wrap-mode measured-index set so seen indices shift with
    // evictions. (Heights aren't cached per-row anymore; we only track which
    // indices have contributed to the average estimate.)
    const seen = wrapMeasuredSetRef.current;
    if (seen.size > 0) {
      const next = new Set<number>();
      for (const idx of seen) {
        const shifted = idx - delta;
        if (shifted >= 0) next.add(shifted);
      }
      wrapMeasuredSetRef.current = next;
    }
    if (autoScroll && atBottomRef.current) return; // following tail — separate effect handles scroll
    const el = outerRef.current;
    if (!el) return;
    lastProgrammaticScrollRef.current = Date.now();
    if (wrapLines) {
      el.scrollTop = Math.max(0, el.scrollTop - delta * wrapAvgRef.current);
    } else {
      // Translate the equivalent virtual delta (delta * ROW_H) into actual
      // scroll px, respecting the nowrap scrollHeight cap.
      const intrinsicH = entries.length * TERMINAL_ROW_H;
      const cap = computeNowrapScrollCap(el.clientHeight);
      const scale = intrinsicH > cap ? cap / intrinsicH : 1;
      el.scrollTop = Math.max(0, el.scrollTop - delta * TERMINAL_ROW_H * scale);
    }
  }, [evictedCount, autoScroll, wrapLines, entries.length, wrapVirtualizer]);

  // Scroll to match index. Uses useLayoutEffect (not useEffect) so the
  // scrollTop assignment happens after DOM commit but BEFORE the browser
  // paints — eliminating the "highlight gone" flash on initial mount when
  // switching views with a selection active.
  const scrollRequestIndex = scrollRequest?.index;
  const scrollRequestNonce = scrollRequest?.nonce;
  useLayoutEffect(() => {
    if (scrollRequestIndex == null || scrollRequestIndex < 0) return;
    lastProgrammaticScrollRef.current = Date.now();
    if (wrapLines) {
      wrapVirtualizer.scrollToIndex(scrollRequestIndex, { align: "center" });
    } else if (outerRef.current) {
      const virtualCenter = scrollRequestIndex * TERMINAL_ROW_H
        - outerRef.current.clientHeight / 2 + TERMINAL_ROW_H / 2;
      outerRef.current.scrollTop = virtualToActualScrollTop(virtualCenter);
    }
    tdbg("pause auto-scroll (scroll-to-match)", { scrollRequestIndex, nonce: scrollRequestNonce });
    atBottomRef.current = false;
    setAtBottom(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollRequestNonce, wrapLines]);

  function handleScroll(e: React.UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    scrollTopRef.current = el.scrollTop;
    // Only re-render when the visible row window actually shifts
    if (!wrapLines) {
      const intrinsicH = entries.length * TERMINAL_ROW_H;
      const cap = computeNowrapScrollCap(el.clientHeight);
      const denom = Math.max(1, Math.min(intrinsicH, cap) - el.clientHeight);
      const intrinsicScroll = Math.max(1, intrinsicH - el.clientHeight);
      const virtualScrollTop = intrinsicH > cap
        ? (el.scrollTop / denom) * intrinsicScroll
        : el.scrollTop;
      const newStart = Math.max(0, Math.floor(virtualScrollTop / TERMINAL_ROW_H) - TERMINAL_OVERSCAN);
      setStartIdx((prev) => (prev === newStart ? prev : newStart));
      // Update the imperative transform now so the rendered rows track the
      // scroll position immediately during drag (before React reconciles).
      syncNowrapTransformRef.current?.(newStart);
    }
    // Demote-only: any time the user scrolls AWAY from the bottom, pause
    // auto-scroll. Never auto-promote based on scroll position — the only
    // way to RESUME auto-scroll is to click the "Jump to bottom" button.
    // This matches the requested UX: any manual intervention (scroll, row
    // click, scroll-to-match) pauses tailing; resume is explicit.
    //
    // We still skip the demote within ~400ms of a programmatic scroll, so
    // a programmatic scroll-to-bottom (auto-tail) doesn't immediately get
    // demoted by its own cascade of scroll events that briefly land
    // off-bottom while content layout is still settling.
    if (Date.now() - lastProgrammaticScrollRef.current < 400) {
      tdbg("handleScroll suppress", { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight });
      return;
    }
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const atBot = distFromBottom < 60;
    if (!atBot && atBottomRef.current) {
      tdbg("pause auto-scroll (user scrolled away)", { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, distFromBottom });
      atBottomRef.current = false;
      setAtBottom(false);
    }
  }

  // Wheel handler. When the nowrap cap is engaged, the browser's native wheel
  // behaviour adds deltaY to el.scrollTop, which is in *capped* coordinates.
  // Our virtual mapping then multiplies that by (intrinsic/cap) — so 100 px of
  // wheel = many rows. Instead, treat deltaY as a *virtual* delta directly so
  // wheel feels the same as it would without the cap (smooth, row-friendly).
  // Must be a native non-passive listener so preventDefault works (React's
  // synthetic onWheel is passive by default).
  useEffect(() => {
    if (wrapLines) return;
    const el = outerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const intrinsicH = entries.length * TERMINAL_ROW_H;
      const cap = computeNowrapScrollCap(el.clientHeight);
      if (intrinsicH <= cap) return; // not capped — native wheel is fine
      e.preventDefault();
      let dy = e.deltaY;
      if (e.deltaMode === 1) dy *= TERMINAL_ROW_H;
      else if (e.deltaMode === 2) dy *= el.clientHeight;
      const intrinsicScroll = Math.max(1, intrinsicH - el.clientHeight);
      const actualScroll = Math.max(1, cap - el.clientHeight);
      const virtualScrollTop = (el.scrollTop / actualScroll) * intrinsicScroll;
      const newVirtual = Math.max(0, Math.min(intrinsicScroll, virtualScrollTop + dy));
      el.scrollTop = (newVirtual / intrinsicScroll) * actualScroll;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [wrapLines, entries.length]);

  // Imperatively compute and apply the nowrap row-group transform. Called from
  // both onScroll (so drag tracks the cursor) and a useLayoutEffect (so React
  // re-renders don't clobber it). Stored in a ref so handleScroll can call
  // the latest closure without re-binding on every render.
  const syncNowrapTransformRef = useRef<((nextStart?: number) => void) | null>(null);
  syncNowrapTransformRef.current = (nextStart?: number) => {
    if (wrapLines) return;
    const group = nowrapGroupRef.current;
    const el = outerRef.current;
    if (!group || !el) return;
    const intrinsicH = entries.length * TERMINAL_ROW_H;
    const cap = computeNowrapScrollCap(el.clientHeight);
    const denom = Math.max(1, Math.min(intrinsicH, cap) - el.clientHeight);
    const intrinsicScroll = Math.max(1, intrinsicH - el.clientHeight);
    const virtualScrollTop = intrinsicH > cap
      ? (el.scrollTop / denom) * intrinsicScroll
      : el.scrollTop;
    // Prefer the render-time effectiveStartIdx (defined below) so the
    // transform stays coherent with the rendered slice even when state
    // (startIdx) lags behind props (entries.length) — e.g. a tail batch lands
    // and the auto-scroll bottom-anchors the slice in the same commit before
    // the scroll event has had a chance to setStartIdx.
    const s = nextStart ?? effectiveStartIdxRef.current;
    const groupTop = el.scrollTop + (s * TERMINAL_ROW_H - virtualScrollTop);
    group.style.transform = `translateY(${groupTop}px)`;
  };
  // After every render, re-sync the transform so changes to entries / startIdx
  // / selection state don't leave the row group at a stale offset (which is
  // what caused the visible row overlap).
  useLayoutEffect(() => {
    syncNowrapTransformRef.current?.();
  });

  // Virtual list window — startIdx is state-driven (updated by handleScroll
  // when the user scrolls). When auto-tail is following, we override it at
  // render time with a bottom-anchored value so the slice and the imperative
  // transform stay coherent in every commit — without this, a tail batch can
  // arrive (entries.length jumps) before startIdx state catches up, leaving
  // the syncNowrapTransform layout effect to compute a groupTop that
  // translates the row group entirely above the viewport (white flash).
  // We also clamp to entries.length so a buffer eviction never points
  // startIdx past the end of the array.
  const intrinsicNowrapH = entries.length * TERMINAL_ROW_H;
  const nowrapCap = computeNowrapScrollCap(viewH);
  const totalH = Math.min(intrinsicNowrapH, nowrapCap);
  const visibleRowCount = Math.ceil(viewH / TERMINAL_ROW_H);
  const effectiveStartIdx = entries.length === 0
    ? 0
    : (autoScroll && atBottomRef.current)
      ? Math.max(0, entries.length - visibleRowCount - TERMINAL_OVERSCAN * 2)
      : Math.min(startIdx, Math.max(0, entries.length - 1));
  // Mirror into a ref so syncNowrapTransformRef (defined above) can read the
  // latest value without depending on render-order closures.
  const effectiveStartIdxRef = useRef(effectiveStartIdx);
  effectiveStartIdxRef.current = effectiveStartIdx;
  const endIdx = Math.min(entries.length - 1, effectiveStartIdx + visibleRowCount + TERMINAL_OVERSCAN * 2);

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

  function renderStructuredLine(entry: LogEntry, isActive: boolean, idx: number) {
    const src = entry.source ?? defaultSource;
    const lvl = getLevel(entry);
    const msg = getMessage(entry);
    let ts: string;
    try {
      const d = new Date(entry.timestamp);
      const pad = (n: number) => String(n).padStart(2, "0");
      const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, "0")}`;
      ts = `${date} ${time}`;
    } catch {
      ts = entry.timestamp;
    }
    return (
      <>
        {onTimestampClick ? (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onTimestampClick(idx); }}
            title="Open ±5s context in new tab"
            className="text-slate-400 select-text hover:text-sky-600 hover:underline transition-colors"
          >
            {ts}
          </button>
        ) : (
          <span className="text-slate-400 select-text">{ts}</span>
        )}
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
        className="flex-1 overflow-y-auto overflow-x-auto scrollbar-hidden mr-3"
      >
        {entries.length === 0 ? (
          <div className="flex items-center justify-center h-full min-h-[120px]">
            <span className="text-slate-400 text-xs animate-pulse">Waiting for log entries…</span>
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
                    onClick={() => {
                      // Click-and-drag to highlight text inside a row must
                      // NOT toggle the row's expand/collapse state — the
                      // collapse would yank the selected text out from
                      // under the cursor.
                      if (isUserSelectingText()) return;
                      // Clicking an entry pauses auto-tail so the inspected
                      // row stays in view; user resumes via Jump-to-bottom.
                      if (atBottomRef.current) { atBottomRef.current = false; setAtBottom(false); }
                      onEntryClick?.(vRow.index);
                      toggleRow(vRow.index);
                    }}
                    className={cn(
                      "px-3 py-px font-mono text-[11px] select-text leading-snug border-b border-slate-200 cursor-pointer",
                      vRow.index % 2 === 0 && "bg-slate-100/60",
                      // Selection (blue) wins over match (amber) and ctx (violet)
                      selectedEntryIdx === vRow.index && "border-l-[3px] border-sky-400 pl-2.5 bg-sky-50 ring-1 ring-inset ring-sky-400/40",
                      selectedEntryIdx !== vRow.index && isActive && "border-l-[3px] border-amber-400 pl-2.5 bg-amber-50 ring-1 ring-inset ring-amber-400/40 animate-match-flash",
                      selectedEntryIdx !== vRow.index && !isActive && isCtxAnchor && "border-l-[3px] border-violet-400 pl-2.5 bg-violet-50",
                    )}
                  >
                    <span className={cn(
                      "whitespace-pre-wrap break-all",
                      !isRowExpanded && "line-clamp-3",
                    )}>
                      {renderStructuredLine(entry, isActive, vRow.index)}
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
            <div
              ref={nowrapGroupRef}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                right: 0,
                // transform is set imperatively by syncNowrapTransformRef which
                // runs in a useLayoutEffect after every render AND from onScroll.
                // We avoid setting it in JSX so React re-renders don't reset it
                // to a value based on stale scrollTopRef (which would cause the
                // rows to visually overlap each other).
                willChange: "transform",
              }}
            >
              {entries.slice(effectiveStartIdx, endIdx + 1).map((entry, i) => {
                const absIdx = effectiveStartIdx + i;
                const count = dupeCounts?.get(absIdx) ?? 1;
                const isActive = activeMatchIndex === absIdx;
                const isCtxAnchor = contextAnchorIdx === absIdx;
                return (
                  <div
                    key={isActive ? `flash-${flashKey}` : absIdx}
                    onClick={() => {
                      if (atBottomRef.current) { atBottomRef.current = false; setAtBottom(false); }
                      onEntryClick?.(absIdx);
                    }}
                    style={{ height: TERMINAL_ROW_H, lineHeight: `${TERMINAL_ROW_H}px` }}
                    className={cn(
                      "px-3 font-mono text-[11px] whitespace-nowrap select-text border-b border-slate-200 cursor-pointer",
                      absIdx % 2 === 0 && "bg-slate-100/60",
                      // Selection (blue) wins over match (amber) and ctx (violet)
                      selectedEntryIdx === absIdx && "border-l-[3px] border-sky-400 pl-2.5 bg-sky-50 ring-1 ring-inset ring-sky-400/40",
                      selectedEntryIdx !== absIdx && isActive && "border-l-[3px] border-amber-400 pl-2.5 bg-amber-50 ring-1 ring-inset ring-amber-400/40 animate-match-flash",
                      selectedEntryIdx !== absIdx && !isActive && isCtxAnchor && "border-l-[3px] border-violet-400 pl-2.5 bg-violet-50",
                    )}
                  >
                    {renderStructuredLine(entry, isActive, absIdx)}
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
            if (el) {
              tdbg("resume auto-scroll (Jump to bottom)", { scrollTopBefore: el.scrollTop, scrollHeight: el.scrollHeight });
              lastProgrammaticScrollRef.current = Date.now();
              el.scrollTop = el.scrollHeight;
              atBottomRef.current = true;
              setAtBottom(true);
            }
          }}
          className="absolute bottom-4 right-4 px-3 py-1.5 text-xs bg-sky-600 text-white rounded-full shadow-lg hover:bg-sky-700 transition-colors z-10"
        >
          ↓ Jump to bottom
        </button>
      )}
      <ScrollbarOverlay containerRef={outerRef} />
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
  fullscreen = false,
  showFullMessage = false,
  selected = false,
  activeMatch = false,
  isContextAnchor = false,
  rowIdx,
  matchCase = false,
  wholeWord = false,
  dupeCount = 1,
  onPickField,
  pickedKey = null,
}: {
  entry: LogEntry;
  source: string;
  expanded: boolean;
  onToggle: () => void;
  searchTerm: string;
  keywords: string[];
  onTransactionClick: (txId: string) => void;
  onTimestampClick?: (timestamp: string, source: string) => void;
  fullscreen?: boolean;
  showFullMessage?: boolean;
  /** User explicitly clicked this row — wins visually over an active match. */
  selected?: boolean;
  /** This row is the current keyword-highlight cursor (Next/Prev match). */
  activeMatch?: boolean;
  isContextAnchor?: boolean;
  rowIdx?: number;
  matchCase?: boolean;
  wholeWord?: boolean;
  dupeCount?: number;
  /** Clicking a field value in the expanded row picks it for the filter
   *  builder; `part` is the selected substring of a string value, if any. */
  onPickField?: (field: PayloadField, part?: string) => void;
  /** `pickedFieldKey()` of the field currently in the builder. */
  pickedKey?: string | null;
}) {
  const [txCopied, setTxCopied] = useState(false);
  const [rawView, setRawView] = useState(false);
  const fields = useMemo(() => (expanded ? flattenPayload(entry.payload) : []), [expanded, entry]);
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
    // Matches in the active-match row render with amber (the Next/Prev
    // cursor row); matches in every other row render with the lighter
    // yellow, matching the terminal viewer's visual scheme.
    const markClass = activeMatch
      ? "bg-amber-400 text-black rounded-sm px-0.5"
      : "bg-yellow-200 text-inherit rounded-sm px-0.5";
    return (
      <>
        {parts.map((part, i) =>
          testRe.test(part) ? (
            <mark key={i} className={markClass}>{part}</mark>
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
        data-row-idx={rowIdx}
        className={cn(
          "cursor-pointer text-xs border-b border-slate-200 hover:bg-slate-100/60 transition-colors",
          !expanded && !selected && !activeMatch && !isContextAnchor && rowIdx != null && rowIdx % 2 === 0 && "bg-slate-100/60",
          expanded && "bg-slate-50",
          // Selection (blue) wins over active-match (amber) and ctx anchor
          // (violet) so the user always sees their explicitly-clicked row as
          // the focus, matching terminal-view behavior.
          selected && "ring-1 ring-inset ring-sky-400 bg-sky-50",
          !selected && activeMatch && "ring-1 ring-inset ring-amber-300 bg-amber-50",
          !selected && !activeMatch && isContextAnchor && "ring-1 ring-inset ring-violet-400 bg-violet-50",
        )}
      >
        <td className="px-3 py-2 font-mono text-slate-400 whitespace-nowrap align-top">
          {onTimestampClick ? (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onTimestampClick(entry.timestamp, effectiveSource); }}
              className="hover:text-sky-600 hover:underline transition-colors text-left"
              title="Open ±5s context in new tab"
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
                    "text-[10px] px-1 py-0.5 rounded leading-none",
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
        <tr className="bg-slate-950 code-surface border-b border-slate-700">
          <td colSpan={6} className="p-0">
            <div className="flex items-center gap-2 px-4 pt-2">
              {onPickField && !rawView && (
                <span className="text-[10px] text-slate-400">
                  Click a field or value to build a queryFilter clause — select part of a text value to use just that part
                </span>
              )}
              <div className="seg-sm ml-auto">
                {(["Fields", "Raw"] as const).map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setRawView(v === "Raw")}
                    className={cn("seg-sm-item", rawView === (v === "Raw") && "seg-sm-item-active")}
                  >
                    {v}
                  </button>
                ))}
              </div>
            </div>
            {rawView ? (
              <pre className="p-4 text-xs font-mono text-green-300 overflow-x-auto whitespace-pre-wrap break-all max-h-96 overflow-y-auto leading-5">
                {highlight(isText ? getTextPayload(entry) : JSON.stringify(entry.payload, null, 2))}
              </pre>
            ) : (
              <div className="px-2 pt-1 pb-3 max-h-96 overflow-y-auto">
                <table className="w-full text-xs font-mono leading-5">
                  <tbody>
                    {fields.map((f, i) => (
                      <tr key={i} className={cn("align-top", pickedKey === pickedFieldKey(f) && "bg-sky-900/60")}>
                        <td
                          className={cn("px-2 text-slate-400 whitespace-nowrap", onPickField && "cursor-pointer hover:bg-slate-800")}
                          title={f.path}
                          onClick={onPickField && (() => onPickField(f))}
                        >
                          {f.path.replace(/^\/payload\/?/, "") || "payload"}
                        </td>
                        <td
                          className={cn(
                            "px-2 w-full break-all whitespace-pre-wrap",
                            f.type === "number" ? "text-amber-300" : f.type === "boolean" ? "text-sky-300" : "text-green-300",
                            onPickField && "cursor-pointer hover:bg-slate-800",
                          )}
                          onClick={onPickField && ((e) => {
                            // A selection inside this cell narrows the value to just that part.
                            const sel = window.getSelection();
                            const cell = e.currentTarget;
                            const part = sel && !sel.isCollapsed && cell.contains(sel.anchorNode) && cell.contains(sel.focusNode)
                              ? sel.toString()
                              : "";
                            onPickField(f, f.type === "string" && part && part !== f.value ? part : undefined);
                          })}
                        >
                          {highlight(f.value)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </td>
        </tr>
      )}
    </Fragment>
  );
});

// ── Server filter builder ───────────────────────────────────────────────────

// Every operator is listed in the builder; ones that don't fit the picked
// value's type are shown disabled so it's clear they exist.
const ALL_FILTER_OPS: FilterOp[] = ["eq", "co", "sw", "gt", "ge", "lt", "le", "pr"];

// Shortcuts into the filter builder while nothing is loaded yet (there are no
// rows to pick fields from). Paths common to the AIC JSON log sources.
const START_FILTER_PATHS = ["/payload/eventName", "/payload/transactionId", "/payload/userId", "/payload/level", "/payload/response/status"];

function FilterStartFields({ onPick }: { onPick: (field: PayloadField) => void }) {
  return (
    <div className="flex flex-wrap items-center justify-center gap-1.5 mt-3 text-xs">
      <span className="text-slate-400">Build a queryFilter from:</span>
      {START_FILTER_PATHS.map((path) => (
        <button key={path} type="button" onClick={() => onPick({ path, value: "", type: "string" })} className="toggle-chip font-mono">
          {path}
        </button>
      ))}
      <button type="button" onClick={() => onPick({ path: "/payload/", value: "", type: "string" })} className="toggle-chip">
        Other field…
      </button>
    </div>
  );
}

function pickedFieldKey(f: PayloadField): string {
  return `${f.path}\u0000${f.value}`;
}

/**
 * Builds one `_queryFilter` clause from a field picked in an expanded table
 * row: optional `!`, an editable path, an operator valid for the value's
 * type, and an editable value. The type stays the picked value's even if the
 * path is edited. Keyed by the parent on each pick so its state resets.
 */
function FilterBuilderBar({
  field,
  part,
  hasFilter,
  onAdd,
  onClose,
}: {
  field: PayloadField;
  /** Selected substring of a string value; defaults the operator to `co`. */
  part?: string;
  /** Whether the Server filter already has content (shows the and/or join). */
  hasFilter: boolean;
  onAdd: (clause: string, join: "and" | "or") => void;
  onClose: () => void;
}) {
  const [op, setOp] = useState<FilterOp>(part ? "co" : "eq");
  const [negate, setNegate] = useState(false);
  const [path, setPath] = useState(field.path);
  const [value, setValue] = useState(part ?? field.value);
  const [join, setJoin] = useState<"and" | "or">("and");
  const p = path.trim();
  const v = value.trim();
  const pathInvalid = !p.startsWith("/");
  const valueInvalid = op !== "pr" && (
    field.type === "number" ? v === "" || !Number.isFinite(Number(v))
      : field.type === "boolean" ? v !== "true" && v !== "false"
        : value === ""
  );
  const clause = buildClause({ path: p, op, value, type: field.type, negate });

  const allowed = operatorsFor(field.type);

  return (
    <div className="flex items-center gap-2 px-4 py-2 border-t border-slate-100 text-xs">
      <button
        type="button"
        onClick={() => setNegate((n) => !n)}
        title="NOT — wrap the clause in !( )"
        className={cn("toggle-chip font-mono shrink-0", negate && "toggle-chip-on")}
      >
        !
      </button>
      <input
        type="text"
        value={path}
        onChange={(e) => setPath(e.target.value)}
        title="Field path (JSON pointer), e.g. /payload/eventName"
        className={cn(
          "w-64 min-w-0 rounded border px-2 py-0.5 font-mono focus:outline-none focus:ring-1",
          pathInvalid ? "border-rose-400 focus:ring-rose-400" : "border-slate-300 focus:ring-sky-500",
        )}
      />
      <div className="seg-sm">
        {ALL_FILTER_OPS.map((o) => (
          <button
            key={o}
            type="button"
            onClick={() => setOp(o)}
            disabled={!allowed.includes(o)}
            title={allowed.includes(o) ? undefined
              : o === "co" || o === "sw" ? "Text values only" : "Numeric values only"}
            className={cn(
              "seg-sm-item font-mono disabled:opacity-25 disabled:line-through",
              op === o && "seg-sm-item-active",
            )}
          >
            {o}
          </button>
        ))}
      </div>
      {op !== "pr" && (
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className={cn(
            "w-56 min-w-0 rounded border px-2 py-0.5 font-mono focus:outline-none focus:ring-1",
            valueInvalid ? "border-rose-400 focus:ring-rose-400" : "border-slate-300 focus:ring-sky-500",
          )}
        />
      )}
      <span className="flex-1 min-w-0 truncate text-[11px] text-slate-400" title={clause}>
        → <code className="font-mono text-slate-500">{clause}</code>
      </span>
      {hasFilter && (
        <div className="seg-sm shrink-0" title="How to join this clause with the existing queryFilter">
          {(["and", "or"] as const).map((j) => (
            <button
              key={j}
              type="button"
              onClick={() => setJoin(j)}
              className={cn("seg-sm-item font-mono", join === j && "seg-sm-item-active")}
            >
              {j}
            </button>
          ))}
        </div>
      )}
      <button
        type="button"
        onClick={() => onAdd(clause, join)}
        disabled={pathInvalid || valueInvalid}
        className="px-3 py-1 text-xs font-medium bg-sky-600 text-white rounded hover:bg-sky-700 disabled:opacity-50 transition-colors shrink-0"
      >
        Add to queryFilter
      </button>
      <button
        type="button"
        onClick={onClose}
        title="Close"
        className="px-1.5 text-slate-400 hover:text-slate-600 shrink-0"
      >
        ×
      </button>
    </div>
  );
}

// ── Custom time range input ─────────────────────────────────────────────────

/**
 * One end of the custom time range. `value` is always a datetime-local string
 * in the display zone; "text" mode edits it as a typed or pasted timestamp
 * (e.g. a log entry's `2026-10-13T02:08:30.383Z`) and writes "" while the text
 * doesn't parse, so Search reports the range as incomplete. Keyed by mode so
 * the text draft restarts from `value` on each switch.
 */
function CustomTimeInput({ mode, value, onChange, tz, invalid, disabled }: {
  mode: "pick" | "text";
  value: string;
  onChange: (v: string) => void;
  tz: TzMode;
  invalid: boolean;
  disabled: boolean;
}) {
  const [draft, setDraft] = useState(() => (value ? fromDatetimeLocal(value, tz) : ""));
  const draftInvalid = mode === "text" && draft.trim() !== "" && !value;
  const cls = cn(
    "rounded border px-1.5 py-0.5 text-[11px] font-mono focus:outline-none focus:ring-1",
    invalid || draftInvalid ? "border-rose-400 focus:ring-rose-400" : "border-slate-300 focus:ring-sky-500",
  );
  if (mode === "pick") {
    return (
      <input type="datetime-local" step="1" value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} className={cls} />
    );
  }
  return (
    <input
      type="text"
      value={draft}
      onChange={(e) => {
        setDraft(e.target.value);
        const d = parsePastedTimestamp(e.target.value, tz === "local" ? "local" : "utc");
        onChange(d ? toDatetimeLocal(d.toISOString(), tz, true) : "");
      }}
      placeholder="2026-10-13T02:08:30.383Z"
      title={draftInvalid
        ? "Not a timestamp. Use e.g. 2026-10-13T02:08:30.383Z, 2026-10-13 02:08:30, or epoch seconds/ms."
        : "ISO timestamp (Z or ±hh:mm), a zoneless time in the current time zone, or epoch seconds/ms."}
      disabled={disabled}
      className={cn(cls, "w-48")}
    />
  );
}

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
                        <tr className="bg-slate-950 code-surface border-b border-slate-700">
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
  onOpenContextTab?: (timestamp: string, source: string) => void;
  onOpenEntryContextTab?: (anchorTimestamp: string, beginTimestamp: string, endTimestamp: string) => void;
  anchorTimestamp?: string;
}) {
  const { env, selectedSources, sourcesError, levelFilter, mode, tailSecs, tailing, loading, preset, customBegin, customEnd, searchSeq, searching } = config;
  const { confirm } = useDialog();
  const tz = useContext(TzContext);
  // Custom time range: date picker or a typed / pasted timestamp.
  const [timeInputMode, setTimeInputMode] = useState<"pick" | "text">("pick");
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
  // Server filter: a raw CREST _queryFilter sent to AIC as-is by Search and Tail
  // (Remote). In Local mode the same box is the archive's text search. Read at
  // search / tail start; Enter while tailing bumps tailFilterSeq to restart.
  const [serverFilterRaw, setServerFilterRaw] = useState("");
  const serverFilterRawRef = useRef("");
  const [tailFilterSeq, setTailFilterSeq] = useState(0);
  // Field picked from an expanded table row for the filter builder. `nonce`
  // keys the builder so re-picking (even the same field) resets its state.
  const [pickedField, setPickedField] = useState<{ field: PayloadField; part?: string; nonce: number } | null>(null);
  const handlePickField = useCallback((field: PayloadField, part?: string) => {
    setPickedField((p) => ({ field, part, nonce: (p?.nonce ?? 0) + 1 }));
  }, []);
  const addToServerFilter = useCallback((clause: string, join: "and" | "or") => {
    const next = appendClause(serverFilterRawRef.current, clause, join);
    setServerFilterRaw(next);
    serverFilterRawRef.current = next;
    setPickedField(null);
  }, []);
  const [matchCursor, setMatchCursor] = useState(-1); // index into matchRows; -1 = none selected
  const [activeMatchKey, setActiveMatchKey] = useState<string | null>(null);
  const [matchScrollNonce, setMatchScrollNonce] = useState(0);
  // Unified "selected entry" — driven by single-click in either view (terminal,
  // table). Persists across view switches. Click only updates the index
  // (no scroll — viewport stays put). selectedScrollNonce is bumped only when
  // the view mode changes (or when explicitly jumping from match-nav), so a
  // view switch auto-scrolls the new view to the previously selected entry.
  const [selectedEntryIdx, setSelectedEntryIdx] = useState<number | null>(null); // index into `filtered`
  const [selectedScrollNonce, setSelectedScrollNonce] = useState(0);
  const handleEntrySelect = useCallback((displayIdx: number) => {
    setSelectedEntryIdx(displayIdx);
    // Clicking an entry to inspect it pauses Table-view auto-tail so the
    // selected row stays in view. The autoScroll toggle stays on; user
    // resumes by clicking the floating Jump-to-bottom button. The terminal
    // viewer manages its own atBottom flag in its click handler.
    if (scrollAtBottomRef.current) {
      scrollAtBottomRef.current = false;
      setTableAtBottom(false);
    }
    // Pin the table page so the page-tracking effect doesn't snap back to
    // the latest page when new tail batches arrive — that snap-back would
    // override the selectedEntryIdx scroll effect's setPage(targetPage) on
    // a terminal -> table switch and leave the viewport on a
    // different page than the one containing the selected row.
    tableManualPagingRef.current = true;
    // Intentionally do NOT bump selectedScrollNonce — clicking should not move
    // the viewport. Scroll-to-selection only fires on view-mode switch.
  }, []);
  const [highlightMatchCase, setHighlightMatchCase] = useState(false);
  const [highlightWholeWord, setHighlightWholeWord] = useState(false);
  // Per-field case/word toggles. Each field's predicate honours its own pair;
  // the renderer applies a single uniform setting (Highlight's), so visual
  // coloring of Filter / Search auto-highlighted terms uses Highlight's settings.
  const [filterMatchCase, setFilterMatchCase] = useState(false);
  const [filterWholeWord, setFilterWholeWord] = useState(false);
  const highlightInputRef = useRef<HTMLInputElement>(null);



  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [error, setError] = useState("");
  const [fetched, setFetched] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const [showFullMessage, setShowFullMessage] = useState(false);
  // View prefs live in TabConfig so they persist per tab across reloads.
  // A tab saved with the removed JSON view ("json") opens in Table.
  const savedViewMode = config.viewMode ?? (config.terminalView === false ? "table" : "terminal");
  const viewMode: "terminal" | "table" | "raw" =
    savedViewMode === "terminal" || savedViewMode === "raw" ? savedViewMode : "table";
  const terminalView = viewMode === "terminal";
  const wrapLines = config.wrapLines ?? false;
  const dedupe = config.dedupe ?? false;
  // The Auto-scroll toggle is a Tail control. Search and Transaction results
  // always follow the newest page as it streams in; scrolling away or clicking
  // an entry still pauses that, and Jump to bottom resumes it.
  const autoScroll = mode !== "tail" || (config.autoScroll ?? true);
  const setViewMode = useCallback((v: "terminal" | "table" | "raw") => {
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
  // True when the user has manually paginated or expanded a row in Table
  // view. While set, new tail entries don't yank the page back to "latest"
  // (so expanded rows stay visible and Older/Newer navigation isn't fought
  // by the auto-tail effect). Cleared when the user explicitly returns to
  // the latest page (Latest button / Jump to bottom) or changes filter.
  const tableManualPagingRef = useRef(false);
  const toggleTableRow = useCallback((idx: number) => {
    setExpandedTableRows((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx); else next.add(idx);
      // Expanding any row pins the current page so tail updates don't
      // shift the expanded entry off-screen. Collapsing the last row
      // re-arms auto-follow.
      tableManualPagingRef.current = next.size > 0;
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
  // Mirror of scrollAtBottomRef in React state — drives the visibility of
  // the floating Jump-to-bottom button for Table view (where the parent
  // container is the scroll surface). The terminal view renders its
  // own button using its internal atBottom state.
  const [tableAtBottom, setTableAtBottom] = useState(true);
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

  // ── Transaction search from per-tab Transaction mode → load into main table ──
  // Triggered by bumping `config.txSeq` (the Trace button or Enter in the
  // transaction-mode input). Uses `config.txQuery` as the ID. Replaces the
  // earlier global top-bar search — each tab now owns its own input.
  const prevTxSeq = useRef(0);
  useEffect(() => {
    const seq = config.txSeq ?? 0;
    const txId = (config.txQuery ?? "").trim();
    if (mode !== "transaction") return;
    if (!txId || !env) return;
    if (seq === 0 || seq <= prevTxSeq.current) return;
    prevTxSeq.current = seq;

    // Stop any active tail
    onConfigChange({ tailing: false });
    workerRef.current?.postMessage({ type: "tail-stop" });

    setError("");
    onConfigChange({ loading: true });
    setEntries([]);
    setFetched(false);
    setExpandedTableRows(new Set());

    // Query all selected sources (or both broad sources if none selected)
    const querySources = selectedSources.length > 0 ? selectedSources : [...LOG_SOURCES];

    Promise.all(
      querySources.map((src) =>
        fetch("/api/logs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ env, source: src, transactionId: txId, pageSize: 1000 }),
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
  }, [config.txSeq, mode]);

  const deferredIsActive = useDeferredValue(isActive);

  // ── Web Worker ──
  const workerRef = useRef<Worker | null>(null);
  const [tailTotalReceived, setTailTotalReceived] = useState(0);

  const [fetchProgress, setFetchProgress] = useState<{ loaded: number; page: number; done: boolean; paused: boolean; source?: string; window?: string; sourceIdx?: number; sourceCount?: number; lastTimestamp?: string; overallBegin?: string; overallEnd?: string } | null>(null);
  // Local "pending" flags so the UI can show "Pausing…" / "Stopping…"
  // immediately when the user clicks, even though the worker may take up to
  // a few seconds to actually pause (waiting for an in-flight HTTP request,
  // a rate-limit sleep, or a 429 backoff to finish).
  const [pausePending, setPausePending] = useState(false);
  const [stopPending, setStopPending] = useState(false);
  // Per-page rate-limit delay (ms) — kept in sync with the worker. The worker
  // owns the source of truth; this state only mirrors what the worker reports
  // via "rate-limit-delay" messages (initial broadcast + auto-bumps on 429 +
  // explicit user changes). Defaults match the worker's default of 1100 ms
  // until the worker confirms.
  const [rateLimitDelayMs, setRateLimitDelayMs] = useState<number>(1100);
  // Last reason the delay changed — used to flash the input briefly when the
  // worker auto-bumps it after a 429.
  const [rateLimitFlash, setRateLimitFlash] = useState<string | null>(null);
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const worker = new Worker(`/log-worker.js?v=${Date.now()}`);
    worker.onmessage = (e: MessageEvent) => {
      const msg = e.data as
        | { type: "entries"; entries: LogEntry[]; append: boolean }
        | { type: "status"; loading: boolean }
        | { type: "progress"; loaded: number; page: number; done: boolean; paused: boolean; source?: string; window?: string; sourceIdx?: number; sourceCount?: number; lastTimestamp?: string; overallBegin?: string; overallEnd?: string }
        | { type: "rate-limit-delay"; value: number; reason: string }
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
      } else if (msg.type === "rate-limit-delay") {
        setRateLimitDelayMs(msg.value);
        setRateLimitFlash(msg.reason);
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
    // Ask the worker to broadcast its current rate-limit delay so the UI
    // mirror starts off in sync (in case the worker default ever drifts from
    // the UI default).
    worker.postMessage({ type: "get-rate-limit-delay" });
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

  // ── Clear pause/stop pending flags when worker has acknowledged ──
  // Pause is acknowledged once the worker reports paused:true. Stop is
  // acknowledged once the worker reports done:true (or searching flips off).
  useEffect(() => {
    if (fetchProgress?.paused) setPausePending(false);
    if (fetchProgress?.done) {
      setStopPending(false);
      setPausePending(false);
    }
  }, [fetchProgress?.paused, fetchProgress?.done]);
  useEffect(() => {
    if (!searching) {
      setStopPending(false);
      setPausePending(false);
    }
  }, [searching]);

  // Briefly highlight the rate-limit input when the worker auto-bumps it
  // after a 429, so the user notices the change.
  useEffect(() => {
    if (!rateLimitFlash) return;
    // Auto-bumps deserve a longer dwell so the inline notice is readable;
    // user/init updates clear quickly because they don't need a notice.
    const ms = rateLimitFlash !== "user" && rateLimitFlash !== "init" ? 6000 : 1500;
    const id = setTimeout(() => setRateLimitFlash(null), ms);
    return () => clearTimeout(id);
  }, [rateLimitFlash]);

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
    const queryFilter = serverFilterRawRef.current.trim() || undefined;
    if (tailing && !prevTailing.current) {
      // Start tail
      setTailTotalReceived(0);
      setEntries([]);
      setFetched(false);
      setError("");
      workerRef.current?.postMessage({ type: "tail-start", env, sources: tailSources, tailSecs, levels, queryFilter });
    } else if (!tailing && prevTailing.current) {
      // Stop tail
      workerRef.current?.postMessage({ type: "tail-stop" });
    } else if (tailing && prevTailing.current) {
      // Restart tail (tailSecs, selected sources, levelFilter or server filter changed)
      workerRef.current?.postMessage({ type: "tail-start", env, sources: tailSources, tailSecs, levels, queryFilter });
    }
    prevTailing.current = tailing;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tailing, tailSecs, levelFilter, tailSources.join(","), tailFilterSeq]);

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

    // The Server filter box is sent to AIC verbatim as _queryFilter, so only
    // matching entries are downloaded. The Filter and Highlight boxes are
    // client-side only — do NOT include them here.
    const queryFilter = serverFilterRawRef.current.trim() || undefined;

    setError("");
    setEntries([]);
    setFetched(false);
    setExpandedTableRows(new Set());
    setFetchProgress(null);
    onConfigChange({ searching: true });

        if (config.dataSource === "local") {
            const text = queryFilter;
            const lv = resolveLevels(levelFilter);
            const level = lv && lv.length === 1 ? lv[0] : undefined;
            const archiveSources = toArchiveSources(selectedSources);
            void fetchLocalSearchEntries({ env, sources: archiveSources, from: beginTime, to: endTime, text, level })
                .then(({ entries, total, capped }) => {
                    setEntries(entries);
                    setFetched(true);
                    setLastUpdated(new Date());
                    setFetchProgress({
                        loaded: entries.length,
                        page: 1,
                        done: true,
                        paused: false,
                        source: "local archive",
                        window: capped ? `first ${entries.length.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} — refine to see more` : undefined,
                    });
                    onConfigChange({ searching: false });
                })
                .catch((err) => {
                    setError(err instanceof Error ? err.message : String(err));
                    onConfigChange({ searching: false });
                });
            return doCleanup; // skip the worker (remote) path
        }

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

  // Lazy per-entry JSON cache. JSON.stringify is the hottest op (used by
  // filterQuery/highlightQuery .test calls). At 200k
  // entries an eager parallel array re-stringifies the whole buffer on every
  // tail tick — hundreds of MB churned per second. WeakMap keyed on the entry
  // object survives across re-renders; entries dropped from the circular
  // buffer are GC'd automatically. We also only stringify on demand: if no
  // filter / search / highlight is active, no entry is stringified at all.
  const entryJsonCacheRef = useRef<WeakMap<LogEntry, string>>(new WeakMap());
  const getEntryJson = useCallback((e: LogEntry): string => {
    const cache = entryJsonCacheRef.current;
    let s = cache.get(e);
    if (s === undefined) { s = JSON.stringify(e); cache.set(e, s); }
    return s;
  }, []);

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
  // Auto-highlight terms = union of Highlight + Filter leaves.
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
    return out;
  }, [highlightQuery, filterQuery, highlightMatchCase]);

  const rawFilteredWithIdx = useMemo(() => {
    // Fast path: no filter active — return a single shared identity-mapped
    // array. Avoids allocating 200k wrapper objects on every tail tick when
    // the user isn't filtering.
    if (filterQuery.empty) {
      return levelFiltered.map((e, i) => ({ e, i }));
    }
    if (filterQuery.error) return [] as { e: LogEntry; i: number }[];
    return levelFiltered.reduce<{ e: LogEntry; i: number }[]>((acc, e, i) => {
      if (!filterQuery.test(getEntryJson(e))) return acc;
      acc.push({ e, i });
      return acc;
    }, []);
  }, [levelFiltered, filterQuery, getEntryJson]);

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

  // Fast path: when no filter / search / dedupe altered the data, reuse the
  // levelFiltered array reference directly instead of allocating a new O(n)
  // unwrapped copy on every tail tick.
  const filtered = useMemo(() => {
    if (
      filteredWithIdx.length === levelFiltered.length &&
      filteredWithIdx.length > 0 &&
      filteredWithIdx[0].e === levelFiltered[0] &&
      filteredWithIdx[filteredWithIdx.length - 1].e === levelFiltered[levelFiltered.length - 1]
    ) {
      return levelFiltered;
    }
    return filteredWithIdx.map(({ e }) => e);
  }, [filteredWithIdx, levelFiltered]);

  // Track cumulative count of entries evicted from the front of `filtered`.
  // Passed to viewers so they can compensate scrollTop and keep the viewport
  // stable while the circular buffer trims the oldest entries during tail.
  // Algorithm: between renders, locate the previous tail's last entry in the
  // new array. If it shifted toward index 0, that's the eviction count.
  const filteredEvictedRef = useRef(0);
  const prevFilteredRef = useRef<LogEntry[] | null>(null);
  const [filteredEvictedCount, setFilteredEvictedCount] = useState(0);
  useEffect(() => {
    const prev = prevFilteredRef.current;
    prevFilteredRef.current = filtered;
    if (!prev || prev === filtered || prev.length === 0) return;
    // Use the last entry of prev as anchor — it's almost certainly still
    // present (eviction happens at the head, not the tail).
    const anchor = prev[prev.length - 1];
    // The anchor (prev's last entry) sits near the end of `filtered` since
    // tail only appends to the back. Scan backward from the end with a
    // bounded window so this stays O(batch) instead of O(buffer).
    let newPos = -1;
    const SCAN_LIMIT = 5000;
    const lo = Math.max(0, filtered.length - SCAN_LIMIT);
    for (let k = filtered.length - 1; k >= lo; k--) {
      if (filtered[k] === anchor) { newPos = k; break; }
    }
    if (newPos < 0) return; // anchor not found in window — skip this round
    const evicted = (prev.length - 1) - newPos;
    if (evicted > 0) {
      filteredEvictedRef.current += evicted;
      setFilteredEvictedCount(filteredEvictedRef.current);
    }
  }, [filtered]);

  // Compute indices into `filtered` where the highlight query matches the
  // entry's full JSON — so a match in a payload field that's not in the
  // formatted terminal line still counts (visible in an expanded Table row).
  const matchRows = useMemo(() => {
    if (highlightQuery.empty || highlightQuery.error) return [];
    const out: { key: string; index: number }[] = [];
    for (let idx = 0; idx < filteredWithIdx.length; idx++) {
      const { e, i } = filteredWithIdx[idx];
      if (highlightQuery.test(getEntryJson(e))) {
        out.push({ key: logEntryMatchKey(e, i), index: idx });
      }
    }
    return out;
  }, [filteredWithIdx, highlightQuery, getEntryJson]);
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
    // Pre-emptively pause Table-view auto-tail. Without this, a tail batch
    // arriving between the rAF schedule below and its callback would yank
    // the container to the bottom before scrollIntoView corrects it.
    if (viewMode === "table") {
      scrollAtBottomRef.current = false;
      setTableAtBottom(false);
    }

    // Table view: jump to the right page and highlight the row
    if (viewMode === "table") {
      const targetPage = Math.floor(row.index / pageSize) + 1;
      setPage(targetPage);
      setSelectedEntryIdx(row.index);
      // Auto-expand only the active match (collapses any previously-expanded
      // matches so stepping through never leaves the page littered).
      setExpandedTableRows(new Set([row.index]));
      // Scroll into view after React re-renders the page. Use manual
      // scrollTop on the inner container instead of element.scrollIntoView
      // — the latter scrolls every ancestor (including the page) which
      // visibly moves the outer browser scrollbar.
      requestAnimationFrame(() => {
        const container = scrollContainerRef.current;
        const el = container?.querySelector(`[data-row-idx="${row.index}"]`) as HTMLElement | null;
        if (container && el) {
          lastProgrammaticScrollAtRef.current = Date.now();
          const containerRect = container.getBoundingClientRect();
          const rowRect = el.getBoundingClientRect();
          const currentTop = rowRect.top - containerRect.top;
          const desiredTop = (container.clientHeight - rowRect.height) / 2;
          container.scrollTop += currentTop - desiredTop;
          scrollAtBottomRef.current = false;
          setTableAtBottom(false);
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

  // Reset expanded rows only when the *filter context* changes (user changed
  // search/level filter, or initial load). New tail entries must NOT collapse
  // the rows the user has manually expanded for inspection.
  useEffect(() => {
    setExpandedTableRows(new Set());
    tableManualPagingRef.current = false;
  }, [search, levelFilter]);

  // Page tracking on tail / filter changes (separate from expanded-row reset
  // so streaming entries don't keep collapsing inspected rows).
  useEffect(() => {
    if (search && filtered.length > 0 && !firstMatchJumpedRef.current) {
      // First matching entry found — jump to page 1 (oldest = first match) and stay there
      firstMatchJumpedRef.current = true;
      setPage(1);
    } else if (!search && autoScroll && !tableManualPagingRef.current) {
      // No filter active and auto-scroll on — follow the latest page as results stream in.
      // When auto-scroll is off, or the user has manually paginated / expanded
      // a row, leave the page alone so the inspected view stays stable.
      setPage(Math.max(1, Math.ceil(filtered.length / pageSize)));
    }
    // search active + already jumped: leave page alone so user can browse
  }, [search, levelFilter, filtered.length, pageSize, autoScroll]);

  // When the buffer evicts from the front, the global indices that
  // expandedTableRows is keyed on shift down by the eviction delta. Remap
  // the Set so the same logical entries stay expanded, and drop any indices
  // that fell off the front of the buffer.
  const prevEvictedForExpandRef = useRef(filteredEvictedCount);
  useEffect(() => {
    const delta = filteredEvictedCount - prevEvictedForExpandRef.current;
    prevEvictedForExpandRef.current = filteredEvictedCount;
    if (delta <= 0) return;
    setExpandedTableRows((prev) => {
      if (prev.size === 0) return prev;
      const next = new Set<number>();
      for (const i of prev) {
        const shifted = i - delta;
        if (shifted >= 0) next.add(shifted);
      }
      return next;
    });
  }, [filteredEvictedCount]);

  // Stabilize table view when buffer evicts from the front. Each evicted
  // entry shifts every entry's index, so the same `page` would now show
  // different rows. When autoScroll is off, decrement the page index to
  // keep the user's content in view (best-effort, integer-page granularity).
  const prevEvictedForPageRef = useRef(filteredEvictedCount);
  useEffect(() => {
    const delta = filteredEvictedCount - prevEvictedForPageRef.current;
    prevEvictedForPageRef.current = filteredEvictedCount;
    if (delta <= 0) return;
    if (autoScroll) return; // auto-tail effect already handles page tracking
    const pagesShift = Math.floor(delta / pageSize);
    if (pagesShift > 0) setPage((p) => Math.max(1, p - pagesShift));
  }, [filteredEvictedCount, autoScroll, pageSize]);

  // Bump scroll nonce whenever the view mode changes (with a selection set),
  // so each viewer's scroll-to-selection effect re-fires in the new view.
  // Click-driven selection deliberately does not bump this; only view switches.
  useEffect(() => {
    if (selectedEntryIdx === null) return;
    setSelectedScrollNonce((n) => n + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode]);

  // Scroll selected entry into view after switching view modes (table only;
  // the terminal viewer handles its own scroll via scrollRequest). The row is
  // also expanded, so an entry picked in Terminal lands ready to build a filter.
  useEffect(() => {
    if (selectedEntryIdx === null) return;
    if (viewMode !== "table") return; // table is the only one parent-scrolled
    setExpandedTableRows((prev) => prev.has(selectedEntryIdx) ? prev : new Set(prev).add(selectedEntryIdx));
    // Pre-emptively pause auto-tail synchronously, before the rAF below.
    // The parent auto-tail effect depends on `entries`, so any new tail
    // batch arriving in the gap between commit and rAF would otherwise
    // yank the container to the bottom and flash before scrollIntoView
    // corrects it. Clearing the flag now makes auto-tail return early.
    scrollAtBottomRef.current = false;
    setTableAtBottom(false);
    // Make sure the right page is loaded so the row exists in the DOM.
    const targetPage = Math.floor(selectedEntryIdx / pageSize) + 1;
    if (targetPage !== page) setPage(targetPage);
    // Double rAF: when switching view modes (e.g. terminal -> table) the
    // table just mounted, and if setPage above just changed the page React
    // hasn't committed yet. A single rAF can fire before the new page rows
    // are in the DOM, so the querySelector returns null and no scroll
    // happens — leaving the viewport on whatever the previous effect ran
    // (such as the highlight cursor's match row). The second rAF waits one
    // more frame, by which time the updated page has rendered.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const container = scrollContainerRef.current;
        const el = container?.querySelector(`[data-row-idx="${selectedEntryIdx}"]`) as HTMLElement | null;
        if (container && el) {
          lastProgrammaticScrollAtRef.current = Date.now();
          // Manual scrollTop instead of element.scrollIntoView — the latter
          // scrolls every ancestor (including the outer page), which visibly
          // jumps the browser scrollbar. We only want the inner container.
          const containerRect = container.getBoundingClientRect();
          const rowRect = el.getBoundingClientRect();
          const currentTop = rowRect.top - containerRect.top;
          const desiredTop = (container.clientHeight - rowRect.height) / 2;
          container.scrollTop += currentTop - desiredTop;
          scrollAtBottomRef.current = false;
          setTableAtBottom(false);
        }
      });
    });
    // viewMode is intentionally a dep so a switch to table re-fires the scroll.
    // `page` is intentionally NOT a dep: this effect calls setPage to bring
    // the selected row's page into view; including `page` would cause it to
    // immediately undo any manual Older/Newer pagination after a row has
    // been clicked/highlighted.
    // `selectedEntryIdx` is intentionally NOT a dep either: a row click
    // changes selectedEntryIdx without bumping selectedScrollNonce, and we
    // explicitly don't want clicks to move the viewport (the user would
    // see expand/collapse re-center the row). The effect still reads the
    // latest selectedEntryIdx via closure when nonce or viewMode change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode, selectedScrollNonce, pageSize]);

  // When the view mode changes and there's an active match (highlight cursor),
  // re-scroll to that match in the new view. Two reasons this is needed:
  //   1. Terminal view's scroll-to-match effect keys off matchScrollNonce, so
  //      the nonce must change for it to re-fire after the view re-mounts.
  //   2. The table view's existing per-view-switch scroll effect only handles
  //      selectedEntryIdx, so it needs an imperative scroll here.
  // Auto-scroll-to-bottom is intentionally overridden — when the user has a
  // highlight active, they care about the highlighted entry, not the tail.
  useEffect(() => {
    if (activeMatchIndex === null) return;
    // User selection takes precedence over the highlight cursor on
    // view-switch. If the user has clicked a row that isn't the current
    // active match, defer to the selectedEntryIdx scroll effect above so
    // the new view lands on what the user explicitly picked.
    if (selectedEntryIdx !== null && selectedEntryIdx !== activeMatchIndex) return;
    // Pre-emptively pause Table-view auto-tail (see the selectedEntryIdx
    // effect above for the same rationale). For terminal the in-viewer
    // scroll-to-match effect clears its own atBottomRef.
    scrollAtBottomRef.current = false;
    setTableAtBottom(false);
    // Bump the match-scroll nonce so terminal view re-issues its scroll.
    setMatchScrollNonce((n) => n + 1);
    if (viewMode === "table") {
      const targetPage = Math.floor(activeMatchIndex / pageSize) + 1;
      if (targetPage !== page) setPage(targetPage);
      // Auto-expand only the active match in table view; collapses any
      // previously-expanded match row.
      setExpandedTableRows(new Set([activeMatchIndex]));
      // Double rAF: the new view must mount + commit before querySelector
      // can find the row (especially for table when we just changed page).
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const container = scrollContainerRef.current;
          const el = container?.querySelector(`[data-row-idx="${activeMatchIndex}"]`) as HTMLElement | null;
          if (container && el) {
            lastProgrammaticScrollAtRef.current = Date.now();
            const containerRect = container.getBoundingClientRect();
            const rowRect = el.getBoundingClientRect();
            const currentTop = rowRect.top - containerRect.top;
            const desiredTop = (container.clientHeight - rowRect.height) / 2;
            container.scrollTop += currentTop - desiredTop;
            scrollAtBottomRef.current = false;
            setTableAtBottom(false);
          }
        });
      });
    }
    // Only fire on view-mode switches; don't re-scroll just because the active
    // match index moved (navigateToMatch already handles that case).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode]);

  // Server filter input, shared by the Tail and Search toolbars. Local search
  // reuses it as the archive's plain-text search.
  const localSearch = mode === "search" && config.dataSource === "local";
  // Picking fields only makes sense where the Server filter is a CREST filter.
  const canBuildFilter = (mode === "tail" || mode === "search") && !localSearch;
  // onClear runs after the box is emptied (Tail uses it to restart right away).
  const renderServerFilter = (onEnter: () => void, disabled: boolean, onClear?: () => void) => (
    <>
      <span className="text-slate-300 select-none">|</span>
      <label className="text-xs font-medium text-slate-500 whitespace-nowrap">
        {localSearch ? "Text" : "queryFilter"}
      </label>
      <input
        type="text"
        value={serverFilterRaw}
        onChange={(e) => {
          setServerFilterRaw(e.target.value);
          serverFilterRawRef.current = e.target.value;
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !disabled) {
            e.preventDefault();
            onEnter();
          }
        }}
        disabled={disabled}
        placeholder={localSearch ? "Text search in the local archive…" : '_queryFilter, e.g. /payload/eventName eq "AM-ACCESS-ATTEMPT"'}
        title={localSearch
          ? "Plain-text search over the local archive's indexed fields."
          : "Sent to AIC as-is as _queryFilter (CREST syntax: eq co sw lt le gt ge pr, and / or / !( )). Pick fields from an expanded table row to build it. Leave blank for everything."}
        className="flex-1 min-w-0 text-xs rounded border border-slate-300 px-2.5 py-1 font-mono focus:outline-none focus:ring-2 focus:ring-sky-500 focus:border-sky-500 disabled:opacity-50"
      />
      {serverFilterRaw !== "" && (
        <button
          type="button"
          onClick={() => {
            setServerFilterRaw("");
            serverFilterRawRef.current = "";
            onClear?.();
          }}
          disabled={disabled}
          title={onClear ? "Clear the filter" : "Clear the filter (press Enter or Search to apply)"}
          className="px-2 py-1 text-xs text-slate-500 rounded hover:bg-slate-100 hover:text-slate-700 disabled:opacity-50 shrink-0"
        >
          Clear
        </button>
      )}
    </>
  );

  return (
    <div className="space-y-4">
      {/* ── Tail status bar ── */}
      <div className="flex items-center gap-3 flex-wrap">
        {tailing && (
          <div className="flex items-center gap-1.5 text-xs text-slate-500">
            <span className="inline-block w-2 h-2 rounded-full bg-green-400 animate-pulse" />
            {loading ? "Fetching…" : lastUpdated ? `Updated ${lastUpdated.toLocaleTimeString("en-US")}` : "Starting…"}
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
              {filtered.length !== totalReceived && `/${totalReceived.toLocaleString("en-US")}`}{" "}
              {totalReceived === 1 ? "entry" : "entries"}
              {dedupe && dedupeHidden > 0 && (
                <span className="text-amber-600"> · {dedupeHidden.toLocaleString("en-US")} deduped</span>
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

        {/* Toolbar — pinned under the app header while the page scrolls, so the
            queryFilter and filter builder stay reachable next to the logs. */}
        <div className={cn(
          "flex flex-col border-b border-slate-100 shrink-0",
          fullscreen ? "bg-slate-50/50" : "sticky top-[var(--app-header-h,58px)] z-30 bg-slate-50 rounded-t-lg",
        )}>
          {/* Row 1: mode toggle + tail/search controls + keyword highlights */}
          <div className="flex items-center gap-2 px-4 py-2">
            {/* Mode toggle */}
            <div className="seg-sm">
              {(["tail", "search", "transaction"] as LogMode[]).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => {
                    if (tailing) onConfigChange({ tailing: false });
                    onConfigChange({ mode: m });
                  }}
                  disabled={loading || searching}
                  className={cn(
                    "seg-sm-item",
                    mode === m && "seg-sm-item-active"
                  )}
                >
                  {m === "tail" ? "Tail" : m === "search" ? "Search" : "Transaction"}
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
                {renderServerFilter(
                  () => {
                    if (tailing) setTailFilterSeq((n) => n + 1);
                    else if (selectedSources.length > 0 && !sourcesError) onConfigChange({ tailing: true });
                  },
                  loading || searching,
                  () => { if (tailing) setTailFilterSeq((n) => n + 1); },
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
                      <div className="seg-sm" title="Pick a time, or type / paste a timestamp such as 2026-10-13T02:08:30.383Z">
                        {(["pick", "text"] as const).map((m) => (
                          <button
                            key={m}
                            type="button"
                            onClick={() => setTimeInputMode(m)}
                            disabled={searching}
                            className={cn("seg-sm-item", timeInputMode === m && "seg-sm-item-active")}
                          >
                            {m === "pick" ? "Pick" : "Text"}
                          </button>
                        ))}
                      </div>
                      <CustomTimeInput
                        key={`begin-${timeInputMode}`}
                        mode={timeInputMode}
                        value={customBegin}
                        onChange={(v) => onConfigChange({ customBegin: v })}
                        tz={tz}
                        invalid={customRangeInvalid}
                        disabled={searching}
                      />
                      <span className="text-slate-400 text-[11px]">→</span>
                      <CustomTimeInput
                        key={`end-${timeInputMode}`}
                        mode={timeInputMode}
                        value={customEnd}
                        onChange={(v) => onConfigChange({ customEnd: v })}
                        tz={tz}
                        invalid={customRangeInvalid}
                        disabled={searching}
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
                      onClick={() => {
                        setStopPending(true);
                        workerRef.current?.postMessage({ type: "fetch-stop" });
                      }}
                      disabled={stopPending}
                      title={stopPending ? "Waiting for the in-flight request to finish…" : "Stop the search"}
                      className="px-3 py-1 text-xs font-medium bg-red-100 text-red-700 rounded hover:bg-red-200 disabled:opacity-60 disabled:cursor-wait transition-colors flex items-center gap-1"
                    >
                      {stopPending ? (
                        <>
                          <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                          </svg>
                          Stopping…
                        </>
                      ) : (
                        "Stop"
                      )}
                    </button>
                  )}
                  {renderServerFilter(
                    () => {
                      if (!customRangeInvalid && selectedSources.length > 0 && !sourcesError) {
                        onConfigChange({ searchSeq: (searchSeq ?? 0) + 1 });
                      }
                    },
                    searching,
                  )}
                  <div className="seg-sm">
                    {(["remote", "local"] as const).map((ds) => (
                      <button
                        key={ds}
                        type="button"
                        onClick={() => onConfigChange({ dataSource: ds })}
                        disabled={loading || searching}
                        title={ds === "local"
                          ? "Search the local archive (offline; text matches indexed fields only — pull data first via Data → Pull → Logs)"
                          : "Search live AIC"}
                        className={cn(
                          "seg-sm-item",
                          (config.dataSource ?? "remote") === ds && "seg-sm-item-active",
                        )}
                      >
                        {ds === "remote" ? "Remote" : "Local"}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })()}

            {/* Transaction mode controls */}
            {mode === "transaction" && (() => {
              const txQuery = config.txQuery ?? "";
              const txTrim = txQuery.trim();
              const submit = () => {
                if (!txTrim || !env || loading) return;
                onConfigChange({ txSeq: (config.txSeq ?? 0) + 1 });
              };
              return (
                <div className="flex items-center gap-1.5 flex-1 min-w-0">
                  <input
                    type="text"
                    value={txQuery}
                    onChange={(e) => onConfigChange({ txQuery: e.target.value })}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } }}
                    placeholder="Paste a transaction ID to trace…"
                    disabled={loading}
                    className="flex-1 min-w-0 text-xs rounded border border-slate-300 px-2.5 py-1 font-mono focus:outline-none focus:ring-2 focus:ring-sky-500 focus:border-sky-500 disabled:opacity-50"
                  />
                  <button
                    type="button"
                    onClick={submit}
                    disabled={!txTrim || !env || loading}
                    className="px-3 py-1 text-xs font-medium bg-sky-600 text-white rounded hover:bg-sky-700 disabled:opacity-50 transition-colors flex items-center gap-1 shrink-0"
                  >
                    {loading ? (
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
                  {txQuery && (
                    <button
                      type="button"
                      onClick={() => onConfigChange({ txQuery: "" })}
                      className="text-xs text-slate-400 hover:text-slate-600 shrink-0"
                    >
                      Clear
                    </button>
                  )}
                  <span
                    className="text-[10px] text-slate-400 ml-1 whitespace-nowrap"
                    title="Transaction-ID search is indexed by AIC and scans the full retention window — time range is ignored."
                  >
                    full retention
                  </span>
                </div>
              );
            })()}

          </div>

          {canBuildFilter && pickedField && (
            <FilterBuilderBar
              key={pickedField.nonce}
              field={pickedField.field}
              part={pickedField.part}
              hasFilter={serverFilterRaw.trim() !== ""}
              onAdd={addToServerFilter}
              onClose={() => setPickedField(null)}
            />
          )}

          {/* Row 2: Query — Filter and Highlight side-by-side; share one Aa/[W] toggle pair and the match navigator */}
          <div className="flex items-center gap-2 px-4 py-2 border-t border-slate-100">
            <label
              className="text-xs font-medium text-slate-500 shrink-0"
              title="Narrows the logs already loaded on this page, in the browser. Does not query AIC — use queryFilter for that."
            >
              Search loaded
            </label>
            <input
              type="text"
              value={rawSearch}
              onChange={(e) => handleFilterChange(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") applySearch(rawSearch); }}
              placeholder='error timeout · error || warn · "exact phrase"'
              title="Shows only loaded entries that match. Space = all words, || = either side, &quot;quotes&quot; = exact phrase. Applies after 3 characters or on Enter."
              className={cn(
                "flex-1 min-w-0 text-xs rounded border px-2.5 py-1 font-mono focus:outline-none focus:ring-2",
                filterQuery.error
                  ? "border-rose-300 focus:ring-rose-400"
                  : rawSearch && !search
                    ? "border-amber-300 focus:ring-amber-400"   // typed but not yet active
                    : "border-slate-300 focus:ring-sky-500"
              )}
            />
            {search && !filterQuery.error && (
              <span className="text-xs text-slate-500 whitespace-nowrap tabular-nums" title="Loaded entries that match / all loaded entries">
                {filtered.length.toLocaleString("en-US")} of {levelFiltered.length.toLocaleString("en-US")}
              </span>
            )}
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
            <div className="seg-sm">
              <button
                type="button"
                title="Case sensitive (Filter predicate)"
                onClick={() => setFilterMatchCase((v) => !v)}
                className={cn(
                  "seg-sm-item font-mono",
                  filterMatchCase && "seg-sm-item-active"
                )}
              >Aa</button>
              <button
                type="button"
                title="Whole word (Filter predicate)"
                onClick={() => setFilterWholeWord((v) => !v)}
                className={cn(
                  "seg-sm-item font-mono",
                  filterWholeWord && "seg-sm-item-active"
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
              placeholder='error timeout · error || warn · "exact phrase"'
              title="Space = all words, || = either side, &quot;quotes&quot; = exact phrase. Enter / Shift+Enter steps through matches."
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
            <div className="seg-sm" title="Highlight predicate; also drives auto-highlight rendering for Filter and Search terms">
              <button
                type="button"
                title="Case sensitive (Highlight predicate; also controls how all auto-highlighted terms are rendered)"
                onClick={() => setHighlightMatchCase((v) => !v)}
                className={cn(
                  "seg-sm-item font-mono",
                  highlightMatchCase && "seg-sm-item-active"
                )}
              >Aa</button>
              <button
                type="button"
                title="Whole word (Highlight predicate; also controls how all auto-highlighted terms are rendered)"
                onClick={() => setHighlightWholeWord((v) => !v)}
                className={cn(
                  "seg-sm-item font-mono",
                  highlightWholeWord && "seg-sm-item-active"
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
                    className="w-12 text-center text-[11px] rounded border border-slate-300 px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-sky-400 focus:border-sky-400 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                  />
                  <span>/ {matchIndices.length}</span>
                </div>
                <div className="seg-sm">
                  <button
                    type="button"
                    title="Previous match (Shift+Enter)"
                    onClick={goPrevMatch}
                    className="seg-sm-item"
                  >↑ Prev</button>
                  <button
                    type="button"
                    title="Next match (Enter)"
                    onClick={goNextMatch}
                    className="seg-sm-item"
                  >↓ Next</button>
                </div>
              </>
            )}
          </div>

          {/* Row 3: view toggles + count + height controls + fullscreen */}
          <div className="flex items-center gap-3 px-4 py-2 border-t border-slate-100">
            {/* Terminal / Table toggle — available in all modes */}
            <div className="seg-sm">
              <button
                type="button"
                onClick={() => setViewMode("terminal")}
                className={cn(
                  "seg-sm-item",
                  viewMode === "terminal" && "seg-sm-item-active"
                )}
              >
                Terminal
              </button>
              <button
                type="button"
                onClick={() => {
                  setViewMode("table");
                  if (activeMatchIndex !== null) {
                    setSelectedEntryIdx(activeMatchIndex);
                    setSelectedScrollNonce((n) => n + 1);
                    setPage(Math.floor(activeMatchIndex / pageSize) + 1);
                    setExpandedTableRows(new Set());
                  }
                }}
                className={cn(
                  "seg-sm-item",
                  viewMode === "table" && "seg-sm-item-active"
                )}
              >
                Table
              </button>
              <button
                type="button"
                onClick={() => setViewMode("raw")}
                title="Log entries exactly as AIC returned them, one JSON object per line"
                className={cn(
                  "seg-sm-item",
                  viewMode === "raw" && "seg-sm-item-active"
                )}
              >
                Raw
              </button>
            </div>
            {/* Wrap toggle — terminal view only */}
            {viewMode === "terminal" && (
              <button
                type="button"
                onClick={() => setWrapLines((w) => !w)}
                title={wrapLines ? "Disable line wrap" : "Wrap long lines"}
                className={cn(
                  "toggle-chip",
                  wrapLines && "toggle-chip-on"
                )}
              >
                Wrap
              </button>
            )}
            {/* Auto-scroll toggle — Tail mode, terminal view */}
            {mode === "tail" && viewMode === "terminal" && (
              <button
                type="button"
                onClick={() => setAutoScroll((v) => !v)}
                title={autoScroll ? "Pause auto-scroll (stay at current position)" : "Resume auto-scroll to latest entries"}
                className={cn(
                  "toggle-chip",
                  autoScroll && "toggle-chip-on"
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
                "toggle-chip",
                dedupe && "toggle-chip-on"
              )}
            >
              Dedupe
            </button>
            {/* Scroll to selected — re-anchors viewport on the highlighted row.
                Disabled when no row is selected. Works in all view modes by
                bumping selectedScrollNonce (the same signal used on view-mode
                switches). `ml-auto` pushes this button and everything after
                it to the right edge of the controls row. */}
            <button
              type="button"
              disabled={selectedEntryIdx === null || selectedEntryIdx < 0}
              onClick={() => setSelectedScrollNonce((n) => n + 1)}
              title={
                selectedEntryIdx === null || selectedEntryIdx < 0
                  ? "Select a log entry first to enable this"
                  : "Scroll the highlighted entry back into view"
              }
              className="ml-auto toggle-chip transition-colors shrink-0"
            >
              Scroll to selected
            </button>
            {/* Open a new tab with the ±5-second window around the selected
                entry. Disabled until the user clicks/highlights a log row. */}
            {onOpenEntryContextTab && (
              <button
                type="button"
                disabled={selectedEntryIdx === null || selectedEntryIdx < 0}
                onClick={() => {
                  if (selectedEntryIdx === null || selectedEntryIdx < 0) return;
                  handleContextEntry(selectedEntryIdx);
                }}
                title={
                  selectedEntryIdx === null || selectedEntryIdx < 0
                    ? "Select a log entry first to enable this"
                    : "Open ±5 seconds of context around the selected entry in a new tab"
                }
                className="toggle-chip transition-colors shrink-0"
              >
                Context ±5s
              </button>
            )}
            {/* Bulk expand / collapse — meaningful when rows are line-clamped
                (terminal + wrap) or when expanding payloads in the table view. */}
            {((viewMode === "terminal" && wrapLines) || viewMode === "table") && filtered.length > 0 && (
              <div className="seg-sm">
                <button
                  type="button"
                  title="Expand all entries"
                  onClick={() => {
                    if (viewMode === "table") {
                      const all = new Set<number>();
                      for (let i = 0; i < filtered.length; i++) all.add(i);
                      setExpandedTableRows(all);
                    } else {
                      setExpandCmd({ kind: "all", nonce: Date.now() });
                    }
                  }}
                  className="seg-sm-item"
                >
                  Expand all
                </button>
                <button
                  type="button"
                  title="Collapse all entries"
                  onClick={() => {
                    if (viewMode === "table") {
                      setExpandedTableRows(new Set());
                    } else {
                      setExpandCmd({ kind: "none", nonce: Date.now() });
                    }
                  }}
                  className="seg-sm-item"
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
                    {filtered.length} / {totalReceived.toLocaleString("en-US")}
                    {dedupe && dedupeHidden > 0 && (
                      <span className="text-amber-600"> (−{dedupeHidden.toLocaleString("en-US")})</span>
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
                <DownloadMenu
                  entries={filtered}
                  pageSize={pageSize}
                  currentPage={currentPage}
                  toText={(e) => formatTerminalLine(e, tailSource)}
                  baseName={() => {
                    const ts = new Date().toISOString().slice(0, 19).replace(/:/g, "");
                    const filtersActive = !!search || levelFilter !== "ALL";
                    return `${mode === "tail" ? "tail" : "logs"}-${selectedSources.join("-")}-${ts}${filtersActive ? "-filtered" : ""}`;
                  }}
                />
                <button
                  type="button"
                  onClick={() => {
                    let text: string;
                    if (viewMode === "raw") {
                      text = filtered.map((e) => JSON.stringify(e)).join("\n");
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
            const atBot = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
            scrollAtBottomRef.current = atBot;
            setTableAtBottom((prev) => (prev === atBot ? prev : atBot));
          }}
          onMouseUp={() => {
            if (fullscreen) return;
            const el = scrollContainerRef.current;
            if (!el) return;
            const h = el.clientHeight;
            if (h >= 200) { setTableHeight(h); saveHeight(h); }
          }}
          className={cn(
            terminalView ? "overflow-hidden" : "overflow-y-auto overflow-x-auto scrollbar-hidden mr-3",
            fullscreen ? "flex-1" : "resize-y min-h-[200px]"
          )}
          style={fullscreen ? undefined : { height: tableHeight }}
        >
          {viewMode === "terminal" ? (
            !fetched && !tailing ? (
              <div className="flex flex-col items-center justify-center h-full min-h-[160px] px-4">
                <p className="text-sm text-slate-400">
                  {anchorTimestamp ? "Loading context…" : "Select sources and start tailing or run a search"}
                </p>
                {canBuildFilter && !anchorTimestamp && <FilterStartFields onPick={handlePickField} />}
              </div>
            ) : deferredIsActive && filtered.length === 0 && fetched && !searching ? (
              <div className="flex flex-col items-center justify-center h-full min-h-[160px] px-4">
                <p className="text-sm text-slate-400">
                  {entries.length === 0 ? "No log entries returned." : "No entries match the filter."}
                </p>
                {canBuildFilter && entries.length === 0 && <FilterStartFields onPick={handlePickField} />}
              </div>
            ) : (
              <TailTerminal
                entries={filtered}
                defaultSource={tailSource}
                searchTerm={search}
                keywords={keywords}
                wrapLines={wrapLines}
                dupeCounts={dupeCounts}
                scrollRequest={
                  // User selection wins over the highlight cursor when the
                  // two differ — matches the precedence applied to the
                  // table view's activeMatchIndex scroll effect, so a
                  // view switch reveals what the user explicitly picked.
                  // Otherwise match-nav scrolls take precedence over
                  // selection scrolls; when no active match, fall back to
                  // selection-driven scroll so view-mode switches and
                  // clicks both reveal the row.
                  (selectedEntryIdx !== null
                    && activeMatchIndex !== null
                    && selectedEntryIdx !== activeMatchIndex
                    && selectedScrollNonce > 0)
                    ? { index: selectedEntryIdx, nonce: selectedScrollNonce + 1_000_000 }
                    : matchScrollRequest ?? (selectedEntryIdx !== null && selectedScrollNonce > 0
                      ? { index: selectedEntryIdx, nonce: selectedScrollNonce + 1_000_000 }
                      : null)
                }
                activeMatchIndex={activeMatchIndex}
                matchCase={highlightMatchCase}
                wholeWord={highlightWholeWord}
                autoScroll={autoScroll}
                onEntryClick={handleEntrySelect}
                onTimestampClick={handleContextEntry}
                contextAnchorIdx={contextAnchorDisplay}
                expandCommand={expandCmd}
                matchIndices={matchIndices}
                filterActive={!!search}
                selectedEntryIdx={selectedEntryIdx}
                evictedCount={filteredEvictedCount}
              />
            )
          ) : !fetched ? (
            <div className="flex flex-col items-center justify-center h-full min-h-[160px] px-4">
              <p className="text-sm text-slate-400">Select at least one source and click Tail Logs or Search</p>
              {canBuildFilter && <FilterStartFields onPick={handlePickField} />}
            </div>
          ) : !deferredIsActive ? null : filtered.length === 0 && !searching ? (
            <div className="p-8 text-center text-sm text-slate-400">
              {entries.length === 0 ? "No log entries returned for this time range." : "No entries match the filter."}
              {canBuildFilter && entries.length === 0 && <FilterStartFields onPick={handlePickField} />}
            </div>
          ) : viewMode === "raw" ? (
            // Entries are the Log API `result` items untouched, so this is the raw response.
            <div className="code-surface min-h-full px-4 py-1 bg-slate-900 text-slate-200 font-mono text-xs leading-5 select-text">
              {pageEntries.map((e, i) => (
                <div key={pageStartIdx + i} className="py-1.5 border-b border-slate-800 whitespace-pre-wrap break-all">{JSON.stringify(e)}</div>
              ))}
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
                      onToggle={() => {
                        // Don't toggle expand/collapse while the user is
                        // dragging to highlight text inside a row.
                        if (isUserSelectingText()) return;
                        toggleTableRow(globalIdx);
                        handleEntrySelect(globalIdx);
                      }}
                      searchTerm={search}
                      keywords={keywords}
                      onTransactionClick={(txId) => setDrilldown({ txId })}
                      onTimestampClick={onOpenContextTab}
                      onPickField={canBuildFilter ? handlePickField : undefined}
                      pickedKey={canBuildFilter && pickedField ? pickedFieldKey(pickedField.field) : null}
                      fullscreen={fullscreen}
                      showFullMessage={showFullMessage}
                      selected={selectedEntryIdx === globalIdx}
                      activeMatch={activeMatchIndex === globalIdx}
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
        {viewMode !== "terminal" && <ScrollbarOverlay containerRef={scrollContainerRef} />}
        {/* Floating Jump-to-bottom — Table view only. The terminal viewer renders
            its own button. Visible whenever the user has scrolled
            away from the tail (manual scroll, click-to-inspect, match-nav).
            Click resumes auto-tail by snapping to the latest entries. */}
        {viewMode !== "terminal" && fetched && filtered.length > 0 && !tableAtBottom && (
          <button
            type="button"
            onClick={() => {
              // Land on the latest page so the newest entries are visible,
              // then scroll to the bottom and re-arm auto-tail.
              tableManualPagingRef.current = false;
              if (currentPage !== totalPages) setPage(totalPages);
              requestAnimationFrame(() => {
                const el = scrollContainerRef.current;
                if (el) {
                  lastProgrammaticScrollAtRef.current = Date.now();
                  el.scrollTop = el.scrollHeight;
                }
                scrollAtBottomRef.current = true;
                setTableAtBottom(true);
              });
            }}
            className="absolute bottom-16 right-6 px-3 py-1.5 text-xs bg-sky-600 text-white rounded-full shadow-lg hover:bg-sky-700 transition-colors z-20"
            title={autoScroll && tailing ? "Jump to bottom and resume auto-scroll" : "Jump to bottom"}
          >
            ↓ Jump to bottom
          </button>
        )}

        {/* Pagination controls — Table and Raw views */}
        {viewMode !== "terminal" && fetched && filtered.length > 0 && (
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
                onChange={(e) => { setPageSize(Number(e.target.value)); tableManualPagingRef.current = false; setPage(Infinity); setExpandedTableRows(new Set()); }}
                className="text-xs rounded border border-slate-300 px-2 py-1 focus:outline-none focus:ring-2 focus:ring-sky-500"
              >
                {[50, 100, 200, 500].map((s) => (
                  <option key={s} value={s}>{s} / page</option>
                ))}
              </select>
              <div className="flex items-center gap-1">
                <button type="button" onClick={() => { tableManualPagingRef.current = true; setPage(1); setExpandedTableRows(new Set()); scrollContainerRef.current?.scrollTo(0, 0); }} disabled={currentPage <= 1} className="px-2 py-1 text-xs rounded border border-slate-300 text-slate-600 hover:bg-slate-50 disabled:opacity-30 disabled:cursor-not-allowed transition-colors" title="Oldest (page 1)">Oldest</button>
                <button type="button" onClick={() => { tableManualPagingRef.current = true; setPage((p) => Math.max(1, p - 1)); setExpandedTableRows(new Set()); scrollContainerRef.current?.scrollTo(0, 0); }} disabled={currentPage <= 1} className="px-2 py-1 text-xs rounded border border-slate-300 text-slate-600 hover:bg-slate-50 disabled:opacity-30 disabled:cursor-not-allowed transition-colors" title="Older entries">← Older</button>
                <span className="text-xs text-slate-500 px-2 tabular-nums">{currentPage} / {totalPages}</span>
                <button type="button" onClick={() => { tableManualPagingRef.current = true; setPage((p) => Math.min(totalPages, p + 1)); setExpandedTableRows(new Set()); scrollContainerRef.current?.scrollTo(0, 0); }} disabled={currentPage >= totalPages} className="px-2 py-1 text-xs rounded border border-slate-300 text-slate-600 hover:bg-slate-50 disabled:opacity-30 disabled:cursor-not-allowed transition-colors" title="Newer entries">Newer →</button>
                <button type="button" onClick={() => { tableManualPagingRef.current = false; setPage(totalPages); setExpandedTableRows(new Set()); scrollContainerRef.current?.scrollTo(0, 0); }} disabled={currentPage >= totalPages} className="px-2 py-1 text-xs rounded border border-slate-300 text-slate-600 hover:bg-slate-50 disabled:opacity-30 disabled:cursor-not-allowed transition-colors" title="Latest (last page)">Latest</button>
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
                ? `Search complete — ${fetchProgress.loaded.toLocaleString("en-US")} entries loaded`
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
              {/* Auto-bump notice — shown when the worker raises the
                  rate-limit delay after a 429. Auto-dismissed by the
                  rateLimitFlash useEffect above. */}
              {rateLimitFlash && rateLimitFlash !== "user" && rateLimitFlash !== "init" && (
                <div className="flex items-center gap-2 px-4 py-1.5 bg-amber-50 border-b border-amber-200 text-[11px] text-amber-800">
                  <svg className="w-3.5 h-3.5 shrink-0" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
                    <path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495ZM10 6a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5A.75.75 0 0 1 10 6Zm0 9a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z" clipRule="evenodd" />
                  </svg>
                  <span>
                    Hit a 429 from AIC — per-page delay auto-raised to{" "}
                    <span className="font-semibold">{rateLimitDelayMs} ms</span>
                    . You can override the value in the Delay box.
                  </span>
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
                      : stopPending
                        ? `Stopping — finishing in-flight request…`
                        : pausePending && !fetchProgress.paused
                          ? `Pausing — waiting for in-flight request…`
                          : fetchProgress.paused
                            ? `Paused — ${fetchProgress.loaded.toLocaleString("en-US")} entries loaded`
                            : [
                              fetchProgress.source && `[${fetchProgress.source}]`,
                              fetchProgress.window && fetchProgress.window,
                              fetchProgress.loaded > 0 && `${fetchProgress.loaded.toLocaleString("en-US")} entries`,
                              pct !== null && `${pct}%`,
                            ].filter(Boolean).join(' · ')}
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  {/* Live rate-limit-delay control. The worker owns the
                      authoritative value: it auto-bumps on 429 and broadcasts
                      back here, and accepts user edits while a search is
                      running. Clamped to 200..5000 ms. */}
                  <label
                    className={cn(
                      "flex items-center gap-1 text-[11px] text-slate-600 px-1.5 py-0.5 rounded border transition-colors",
                      rateLimitFlash && rateLimitFlash !== "user" && rateLimitFlash !== "init"
                        ? "border-amber-400 bg-amber-50 text-amber-800"
                        : "border-slate-200 bg-white",
                    )}
                    title={
                      rateLimitFlash && rateLimitFlash !== "user" && rateLimitFlash !== "init"
                        ? `Auto-raised after a 429 (${rateLimitFlash}). You can override the value below.`
                        : "Per-page delay (ms) sent between paginated AIC log requests. AIC caps at ~60 req/min, so values below ~1000 ms are likely to trigger 429s. Editable while a search is running."
                    }
                  >
                    <span className="font-medium">Delay</span>
                    <input
                      type="number"
                      min={200}
                      max={5000}
                      step={50}
                      value={rateLimitDelayMs}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        if (!Number.isFinite(v)) return;
                        const clamped = Math.max(200, Math.min(5000, Math.round(v)));
                        setRateLimitDelayMs(clamped);
                        workerRef.current?.postMessage({ type: "set-rate-limit-delay", value: clamped, reason: "user" });
                      }}
                      className="w-16 text-[11px] px-1 py-0 border border-slate-200 rounded focus:outline-none focus:ring-1 focus:ring-sky-500 bg-white"
                    />
                    <span className="text-slate-400">ms</span>
                  </label>
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
                      onClick={() => {
                        setPausePending(true);
                        workerRef.current?.postMessage({ type: "fetch-pause" });
                      }}
                      disabled={pausePending || stopPending}
                      title={pausePending ? "Waiting for the in-flight request to finish…" : "Pause the search"}
                      className="px-2.5 py-1 text-xs font-medium bg-amber-100 text-amber-700 rounded hover:bg-amber-200 disabled:opacity-60 disabled:cursor-wait transition-colors flex items-center gap-1"
                    >
                      {pausePending ? (
                        <>
                          <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                          </svg>
                          Pausing…
                        </>
                      ) : (
                        "Pause"
                      )}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      setStopPending(true);
                      workerRef.current?.postMessage({ type: "fetch-stop" });
                    }}
                    disabled={stopPending}
                    title={stopPending ? "Waiting for the in-flight request to finish…" : "Stop the search"}
                    className="px-2.5 py-1 text-xs font-medium bg-red-100 text-red-700 rounded hover:bg-red-200 disabled:opacity-60 disabled:cursor-wait transition-colors flex items-center gap-1"
                  >
                    {stopPending ? (
                      <>
                        <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                        </svg>
                        Stopping…
                      </>
                    ) : (
                      "Stop"
                    )}
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
              <span className="text-xs text-slate-600">
                {loading
                  ? `Fetching…`
                  : lastUpdated
                    ? `Updated ${lastUpdated.toLocaleTimeString("en-US")}`
                    : `Starting…`}
              </span>
              {tailTotalReceived > 0 && (
                <span className="text-xs text-slate-400">
                  · {tailTotalReceived.toLocaleString("en-US")} total
                  {tailDropped > 0 && ` · ${entries.length.toLocaleString("en-US")} in buffer`}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
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
    dataSource: "remote",
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
    // Don't re-fire a transaction trace on reload; keep the input value
    // (txQuery) so the user can re-submit.
    txSeq: 0,
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

  // Warn on tab/page navigation while any tab is actively tailing. NavBar
  // observes `busy` from BusyContext and prompts before route changes.
  const { setBusy } = useBusyState();
  const anyTailing = tabs.some((t) => t.config.tailing);
  useEffect(() => {
    setBusy(anyTailing);
    return () => { if (anyTailing) setBusy(false); };
  }, [anyTailing, setBusy]);
  // Browser-level guard: warn on full-page leave (refresh/close/external nav)
  // while tailing is active. NavBar only intercepts in-app links.
  useEffect(() => {
    if (!anyTailing) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [anyTailing]);

  const activeTab = tabs.find((t) => t.id === activeId) ?? tabs[0];
  const cfg = activeTab?.config;

  // The tenant's log sources, per environment (GET /monitoring/logs/sources).
  const [tenantSources, setTenantSources] = useState<Record<string, string[]>>({});
  const activeEnv = cfg?.env;
  useEffect(() => {
    if (!activeEnv || tenantSources[activeEnv]) return;
    let cancelled = false;
    fetch(`/api/logs/sources?env=${encodeURIComponent(activeEnv)}`)
      .then((r) => r.json())
      .then((data) => Array.isArray(data?.result) ? data.result as string[] : FALLBACK_LOG_SOURCES)
      .catch(() => FALLBACK_LOG_SOURCES)
      .then((list) => { if (!cancelled) setTenantSources((prev) => ({ ...prev, [activeEnv]: list })); });
    return () => { cancelled = true; };
  }, [activeEnv, tenantSources]);

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

  function openEntryContextTab(anchorTs: string, beginTs: string, endTs: string) {
    const id = _nextTabId++;
    const tabEnv = tabs.find((t) => t.id === activeId)?.config.env ?? "";
    const tabSources = tabs.find((t) => t.id === activeId)?.config.selectedSources ?? ["am-everything", "idm-everything"];
    const shortTime = new Date(anchorTs).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
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
                    className="block h-9 px-3 rounded-lg border border-slate-200 text-[13px] outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 disabled:opacity-50 bg-white"
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
                  <SourcePicker
                    sources={tenantSources[cfg.env] ?? FALLBACK_LOG_SOURCES}
                    loading={!tenantSources[cfg.env]}
                    selected={cfg.selectedSources}
                    disabled={cfg.loading || cfg.tailing}
                    onChange={(next) => updateActiveConfig({ selectedSources: next, tailing: false })}
                  />
                </div>

                <div className="space-y-1">
                  <label className="label-xs">Min Level</label>
                  <select
                    value={cfg.levelFilter}
                    onChange={(e) => updateActiveConfig({ levelFilter: e.target.value })}
                    className="block h-9 px-3 rounded-lg border border-slate-200 text-[13px] outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 bg-white"
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
                    className="block h-9 px-3 rounded-lg border border-slate-200 text-[13px] outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 bg-white"
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
                    className="block h-9 px-3 rounded-lg border border-slate-200 text-[13px] outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 bg-white"
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
                    className="block h-9 px-3 rounded-lg border border-slate-200 text-[13px] outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 bg-white"
                  >
                    {TAIL_SECS_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </div>

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
                  onOpenContextTab={(timestamp) => {
                    // Plain click on a timestamp opens ±5 seconds of context
                    // in a new tab — same behavior as the "Context ±5s" toolbar button.
                    const ts = new Date(timestamp).getTime();
                    openEntryContextTab(
                      timestamp,
                      new Date(ts - 5000).toISOString(),
                      new Date(ts + 5000).toISOString(),
                    );
                  }}
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
