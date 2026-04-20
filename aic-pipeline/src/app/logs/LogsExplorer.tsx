"use client";

import { useState, useEffect, useRef, Fragment, startTransition, useDeferredValue, useCallback, useMemo, memo } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Environment } from "@/lib/fr-config-types";
import { EnvironmentBadge } from "@/components/EnvironmentBadge";
import { useDialog } from "@/components/ConfirmDialog";
import { cn } from "@/lib/utils";

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

type TailSecs = 5 | 10 | 30;

// Client-side level filter
const LEVEL_ORDER = ["FATAL", "SEVERE", "ERROR", "WARN", "WARNING", "INFO", "INFORMATION", "CONFIG", "DEBUG", "FINE", "FINER", "TRACE", "FINEST"];

const LEVEL_FILTERS = [
  { value: "ERROR", label: "ERROR+" },
  { value: "WARN",  label: "WARN+" },
  { value: "INFO",  label: "INFO+" },
  { value: "DEBUG", label: "DEBUG+" },
  { value: "ALL",   label: "ALL" },
];

function levelPassesFilter(level: string, minLevel: string): boolean {
  if (minLevel === "ALL") return true;
  const idx = LEVEL_ORDER.indexOf(level.toUpperCase());
  const minIdx = LEVEL_ORDER.indexOf(minLevel.toUpperCase());
  if (idx === -1) return true;
  if (minIdx === -1) return true;
  return idx <= minIdx;
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
  { label: "15 min",   value: "15m",  ms: 15 * 60 * 1000 },
  { label: "1 hour",   value: "1h",   ms: 60 * 60 * 1000 },
  { label: "6 hours",  value: "6h",   ms: 6 * 60 * 60 * 1000 },
  { label: "24 hours", value: "24h",  ms: 24 * 60 * 60 * 1000 },
  { label: "3 days",   value: "3d",   ms: 3 * 24 * 60 * 60 * 1000 },
  { label: "5 days",   value: "5d",   ms: 5 * 24 * 60 * 60 * 1000 },
  { label: "7 days",   value: "7d",   ms: 7 * 24 * 60 * 60 * 1000 },
  { label: "1 month",  value: "30d",  ms: 30 * 24 * 60 * 60 * 1000 },
  { label: "Custom",   value: "custom", ms: 0 },
];

const LOG_SOURCES = ["am-everything", "idm-everything"] as const;

const TAIL_BUFFER_MAX  = 50_000; // entries kept in memory; older ones are dropped
const TERMINAL_ROW_H   = 20;     // px — fixed height per row (nowrap lines)
const TERMINAL_OVERSCAN = 15;    // extra rows rendered above/below viewport

// ── IndexedDB tail session persistence ───────────────────────────────────────
const IDB_NAME  = "ky-pipeline-logs";
const IDB_VER   = 1;
const IDB_STORE = "tail-batches";
const IDB_MAX_SESSIONS = 10;

function openLogDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        const s = db.createObjectStore(IDB_STORE, { keyPath: "id", autoIncrement: true });
        s.createIndex("sessionId", "sessionId");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror  = () => reject(req.error);
  });
}

function idbWriteBatch(db: IDBDatabase, sessionId: string, entries: LogEntry[]): void {
  try {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).add({ sessionId, entries, ts: Date.now() });
    tx.onerror = () => {};
  } catch { /* ignore */ }
}

function idbReadSession(db: IDBDatabase, sessionId: string): Promise<LogEntry[]> {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(IDB_STORE, "readonly");
    const req = tx.objectStore(IDB_STORE).index("sessionId").getAll(sessionId);
    req.onsuccess = () => {
      const batches = (req.result as { entries: LogEntry[]; ts: number }[]).sort((a, b) => a.ts - b.ts);
      resolve(batches.flatMap((b) => b.entries));
    };
    req.onerror = () => reject(req.error);
  });
}

function idbDeleteSession(db: IDBDatabase, sessionId: string): void {
  try {
    const tx = db.transaction(IDB_STORE, "readwrite");
    const req = tx.objectStore(IDB_STORE).index("sessionId").openCursor(IDBKeyRange.only(sessionId));
    req.onsuccess = function () {
      const cursor = (req.result as IDBCursorWithValue | null);
      if (cursor) { cursor.delete(); cursor.continue(); }
    };
    tx.onerror = () => {};
  } catch { /* ignore */ }
}

function idbRegisterSession(db: IDBDatabase, sessionId: string): void {
  try {
    const raw  = localStorage.getItem("tail-session-ids");
    const ids: string[] = raw ? JSON.parse(raw) : [];
    ids.push(sessionId);
    const toDelete = ids.splice(0, Math.max(0, ids.length - IDB_MAX_SESSIONS));
    localStorage.setItem("tail-session-ids", JSON.stringify(ids));
    toDelete.forEach((id) => idbDeleteSession(db, id));
  } catch { /* ignore */ }
}

function toDatetimeLocal(iso: string): string {
  // Format in LOCAL time so <input type="datetime-local"> shows and stores the right value.
  // Slicing a UTC ISO string directly would be off by the local UTC offset.
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fromDatetimeLocal(val: string): string { return val ? new Date(val).toISOString() : ""; }

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
  /** IndexedDB session id — survives reload so entries can be rehydrated */
  sessionId?: string;
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

function formatTs(ts: string): { date: string; time: string } {
  try {
    const d = new Date(ts);
    const date = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    const time = d.toLocaleTimeString(undefined, { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" })
      + "." + String(d.getMilliseconds()).padStart(3, "0");
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
// Single pretty-printed JSON document over all filtered entries. Filters, level
// filter, and dedupe are already applied by the caller; this just serializes.
function JsonLogView({ entries, wrapLines = false }: { entries: LogEntry[]; wrapLines?: boolean }) {
  const text = useMemo(() => JSON.stringify(entries, null, 2), [entries]);
  const [copied, setCopied] = useState(false);
  const onCopy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  };
  return (
    <div className="relative">
      <button
        type="button"
        onClick={onCopy}
        className="sticky top-2 float-right mr-2 px-2 py-1 text-[11px] font-medium rounded border border-slate-300 bg-white/90 backdrop-blur text-slate-600 hover:bg-slate-50 z-10 shadow-sm"
        title="Copy JSON to clipboard"
      >
        {copied ? "Copied" : "Copy JSON"}
      </button>
      <pre
        className={cn(
          "p-4 pt-2 font-mono text-[12px] leading-5 text-slate-700",
          wrapLines ? "whitespace-pre-wrap break-all" : "whitespace-pre",
        )}
      >
        {text}
      </pre>
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
    case "ERROR": case "SEVERE":  return "text-red-400";
    case "WARN":  case "WARNING": return "text-yellow-300";
    case "INFO":  case "INFORMATION": return "text-green-300";
    case "DEBUG": case "FINE": case "FINER": case "FINEST": case "TRACE": return "text-slate-400";
    default: return "text-slate-300";
  }
}

function TailTerminal({
  entries, defaultSource, searchTerm, keywords, wrapLines = false,
  scrollToIndex = null, activeMatchIndex = null, matchCase = false, wholeWord = false,
  dupeCounts,
}: {
  entries: LogEntry[];
  defaultSource: string;
  searchTerm: string;
  keywords: string[];
  dupeCounts?: Map<number, number>;
  wrapLines?: boolean;
  scrollToIndex?: number | null;
  activeMatchIndex?: number | null;
  matchCase?: boolean;
  wholeWord?: boolean;
}) {
  const outerRef    = useRef<HTMLDivElement>(null);
  const [viewH, setViewH]       = useState(400);
  const [scrollTop, setScrollTop] = useState(0);
  const atBottomRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);

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
    if (!atBottomRef.current) return;
    if (wrapLines) {
      if (entries.length > 0) wrapVirtualizer.scrollToIndex(entries.length - 1, { align: "end" });
    } else if (outerRef.current) {
      outerRef.current.scrollTop = outerRef.current.scrollHeight;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries.length, wrapLines]);

  // Scroll to match index
  useEffect(() => {
    if (scrollToIndex === null || scrollToIndex < 0) return;
    if (wrapLines) {
      wrapVirtualizer.scrollToIndex(scrollToIndex, { align: "center" });
    } else if (outerRef.current) {
      outerRef.current.scrollTop = scrollToIndex * TERMINAL_ROW_H - outerRef.current.clientHeight / 2 + TERMINAL_ROW_H / 2;
    }
    atBottomRef.current = false;
    setAtBottom(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollToIndex, wrapLines]);

  function handleScroll(e: React.UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    const atBot = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    setScrollTop(el.scrollTop);
    if (atBot !== atBottomRef.current) {
      atBottomRef.current = atBot;
      setAtBottom(atBot);
    }
  }

  // Virtual list window
  const totalH   = entries.length * TERMINAL_ROW_H;
  const startIdx = Math.max(0, Math.floor(scrollTop / TERMINAL_ROW_H) - TERMINAL_OVERSCAN);
  const endIdx   = Math.min(entries.length - 1, startIdx + Math.ceil(viewH / TERMINAL_ROW_H) + TERMINAL_OVERSCAN * 2);

  // Flash key: increments each time we navigate to a match, re-triggers the CSS animation
  const [flashKey, setFlashKey] = useState(0);
  useEffect(() => {
    if (scrollToIndex !== null && scrollToIndex >= 0) setFlashKey((k) => k + 1);
  }, [scrollToIndex]);

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
                : "bg-sky-400/50 text-white rounded-sm"
              }>{part}</mark>
            : part
        )}
      </>
    );
  }

  return (
    <div className="relative h-full flex flex-col bg-slate-950">
      <div
        ref={outerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto overflow-x-auto"
      >
        {entries.length === 0 ? (
          <div className="flex items-center justify-center h-full min-h-[120px]">
            <span className="text-slate-500 text-xs font-mono animate-pulse">Waiting for log entries…</span>
          </div>
        ) : wrapLines ? (
          /* Wrap mode: variable-height virtual list via @tanstack/react-virtual */
          <div style={{ height: wrapVirtualizer.getTotalSize(), position: "relative" }}>
            {wrapVirtualizer.getVirtualItems().map((vRow) => {
              const entry = entries[vRow.index];
              const level = getLevel(entry);
              const line  = formatTerminalLine(entry, defaultSource);
              const count = dupeCounts?.get(vRow.index) ?? 1;
              const isActive = activeMatchIndex === vRow.index;
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
                    className={cn(
                      "px-3 py-px font-mono text-[11px] whitespace-pre-wrap break-all select-text leading-snug",
                      terminalLevelClass(level),
                      isActive && "border-l-[3px] border-amber-400 pl-2.5 bg-amber-400/15 ring-1 ring-inset ring-amber-400/40 shadow-[0_0_0_1px_rgba(251,191,36,0.25)] animate-match-flash",
                    )}
                  >
                    {highlightLine(line, isActive)}
                    {count > 1 && (
                      <span className="ml-2 inline-block px-1.5 py-0 rounded bg-amber-900/60 text-amber-300 text-[10px] font-semibold align-middle">
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
                const level = getLevel(entry);
                const line  = formatTerminalLine(entry, defaultSource);
                const count = dupeCounts?.get(absIdx) ?? 1;
                const isActive = activeMatchIndex === absIdx;
                return (
                  <div
                    key={isActive ? flashKey : absIdx}
                    style={{ height: TERMINAL_ROW_H, lineHeight: `${TERMINAL_ROW_H}px` }}
                    className={cn(
                      "px-3 font-mono text-[11px] whitespace-nowrap select-text",
                      terminalLevelClass(level),
                      isActive && "border-l-[3px] border-amber-400 pl-2.5 bg-amber-400/15 ring-1 ring-inset ring-amber-400/40 shadow-[0_0_0_1px_rgba(251,191,36,0.25)] animate-match-flash",
                    )}
                  >
                    {highlightLine(line, isActive)}
                    {count > 1 && (
                      <span className="ml-2 inline-block px-1.5 rounded bg-amber-900/60 text-amber-300 text-[10px] font-semibold align-middle">
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
          className="absolute bottom-4 right-4 px-3 py-1.5 text-xs bg-sky-700 text-white rounded-full shadow-lg hover:bg-sky-600 transition-colors z-10"
        >
          ↓ Jump to bottom
        </button>
      )}
    </div>
  );
}

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
  highlighted = false,
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
  fullscreen?: boolean;
  showFullMessage?: boolean;
  highlighted?: boolean;
  rowIdx?: number;
  matchCase?: boolean;
  wholeWord?: boolean;
  dupeCount?: number;
}) {
  const [txCopied, setTxCopied] = useState(false);
  const effectiveSource = entry.source ?? source;
  const level = getLevel(entry);
  const message = getMessage(entry);
  const component = getComponent(entry, effectiveSource);
  const transactionId = getTransactionId(entry);
  const userId = getUserId(entry);
  const status = getStatus(entry);
  const { date, time } = formatTs(entry.timestamp);
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
        data-row-idx={rowIdx}
        className={cn(
          "cursor-pointer text-xs border-b border-slate-100 hover:bg-slate-50 transition-colors",
          expanded && "bg-slate-50",
          highlighted && "ring-1 ring-inset ring-sky-400 bg-sky-50"
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
                  const { date, time } = formatTs(entry.timestamp);
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
}) {
  const { env, selectedSources, sourcesError, levelFilter, mode, tailSecs, tailing, loading, preset, customBegin, customEnd, searchSeq, searching } = config;
  const { confirm } = useDialog();
  // Derived: sources used for tail mode — all selected sources are tailed concurrently.
  // `tailSource` (singular) is kept as the first for UI affordances that still expect one.
  const tailSources = selectedSources;
  const tailSource = selectedSources[0] ?? "";

  const [keywordsRaw, setKeywordsRaw] = useState("");
  const keywordsRawRef = useRef("");
  const [keywordsActive, setKeywordsActive] = useState(""); // debounced — drives actual highlighting
  const keywordsDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keywords = keywordsActive
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
  const [matchCursor, setMatchCursor] = useState(-1); // index into matchIndices; -1 = none selected
  const [highlightedTableIdx, setHighlightedTableIdx] = useState<number | null>(null); // filtered idx to highlight in table view
  const [matchCase, setMatchCase] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const highlightInputRef = useRef<HTMLInputElement>(null);

  // ── Auto-save helper (summary-only; entry payloads no longer persisted) ──
  const autoSaveToHistory = useCallback((logMode: "search" | "tail" | "transaction", logEntries: unknown[], extra?: { transactionId?: string }) => {
    if (logEntries.length === 0) return;
    fetch("/api/history", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "log-search",
        environment: env,
        scopes: [],
        status: "success",
        startedAt: new Date().toISOString(),
        durationMs: 0,
        summary: logMode === "transaction"
          ? `${logEntries.length} entries for tx:${extra?.transactionId?.slice(0, 16) ?? ""}…`
          : `${logEntries.length} entries from ${selectedSources.join("+")}`,
        logSource: selectedSources.join("+"),
        logMode,
        logPreset: logMode === "search" ? preset : undefined,
        logEntryCount: logEntries.length,
      }),
    }).then(() => {
      setSaveFlash(true);
      setTimeout(() => setSaveFlash(false), 10000);
    }).catch(() => {});
  }, [env, selectedSources, preset]);

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
  const [rawSearch, setRawSearch] = useState("");   // what's in the input box
  const [search, setSearch] = useState("");          // active filter (3+ chars or Enter)
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function applySearch(val: string) {
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    setSearch(val);
    setExpandedIdx(null);
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
  }
  const [saveFlash, setSaveFlash] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyRecords, setHistoryRecords] = useState<{ id: string; completedAt: string; environment: string; logSource?: string; logMode?: string; logEntryCount?: number; logPreset?: string; summary: string }[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [colWidths, setColWidths] = useState<Record<string, number>>({ ...DEFAULT_COL_WIDTHS });
  const handleColResize = useCallback((key: string, width: number) => {
    setColWidths((prev) => ({ ...prev, [key]: width }));
  }, []);
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);

  // ── Pagination ──
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(100);
  // Tracks whether we've already jumped to the first keyword/search match for the current filter.
  // While true, page is not auto-advanced so the user can browse.
  const firstMatchJumpedRef = useRef(false);

  const scrollContainerRef = useRef<HTMLDivElement>(null);

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
  useEffect(() => {
    if (!txSearchId || !env) return;

    // Stop any active tail
    onConfigChange({ tailing: false });
    workerRef.current?.postMessage({ type: "tail-stop" });

    setError("");
    onConfigChange({ loading: true });
    setEntries([]);
    setFetched(false);
    setExpandedIdx(null);

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
      // Auto-save transaction search
      autoSaveToHistory("transaction", merged, { transactionId: txSearchId.id });
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [txSearchId]);

  const deferredIsActive = useDeferredValue(isActive);

  // ── Web Worker ──
  const workerRef = useRef<Worker | null>(null);
  const idbRef            = useRef<IDBDatabase | null>(null);
  const sessionId         = config.sessionId;
  const sessionIdRef      = useRef<string | undefined>(sessionId);
  sessionIdRef.current = sessionId;
  const [tailTotalReceived, setTailTotalReceived] = useState(0);
  const [hydrated, setHydrated] = useState(false);

  const [fetchProgress, setFetchProgress] = useState<{ loaded: number; page: number; done: boolean; paused: boolean; source?: string; window?: string } | null>(null);
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const worker = new Worker(`/log-worker.js?v=${Date.now()}`);
    worker.onmessage = (e: MessageEvent) => {
      const msg = e.data as
        | { type: "entries"; entries: LogEntry[]; append: boolean }
        | { type: "status"; loading: boolean }
        | { type: "progress"; loaded: number; page: number; done: boolean; paused: boolean; source?: string; window?: string }
        | { type: "error"; message: string; transient?: boolean };

      if (msg.type === "entries") {
        if (idbRef.current && sessionIdRef.current && msg.entries.length > 0) {
          // Persist every incoming batch to IndexedDB (fire-and-forget)
          idbWriteBatch(idbRef.current, sessionIdRef.current, msg.entries);
        }
        if (msg.append) {
          setTailTotalReceived((n) => n + msg.entries.length);
        }
        startTransition(() => {
          setEntries((prev) => {
            const combined = msg.append ? [...prev, ...msg.entries] : msg.entries;
            // Circular buffer: drop oldest when over cap (tail mode only)
            if (msg.append && combined.length > TAIL_BUFFER_MAX) {
              return combined.slice(-TAIL_BUFFER_MAX);
            }
            return combined;
          });
          setFetched(true);
          setLastUpdated(new Date());
          if (!msg.append) { setExpandedIdx(null); }
          // Page changes are driven by the filtered.length useEffect below
        });
      } else if (msg.type === "status") {
        onConfigChange({ loading: msg.loading });
      } else if (msg.type === "progress") {
        setFetchProgress({ loaded: msg.loaded, page: msg.page, done: msg.done, paused: msg.paused, source: msg.source, window: msg.window });
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

  // ── Open IndexedDB and rehydrate prior session entries ──
  useEffect(() => {
    let cancelled = false;
    openLogDb().then(async (db) => {
      if (cancelled) { db.close(); return; }
      idbRef.current = db;
      const sid = sessionIdRef.current;
      if (sid) {
        try {
          const prev = await idbReadSession(db, sid);
          if (!cancelled && prev.length > 0) {
            const trimmed = prev.length > TAIL_BUFFER_MAX ? prev.slice(-TAIL_BUFFER_MAX) : prev;
            startTransition(() => {
              setEntries(trimmed);
              setFetched(true);
              setTailTotalReceived(prev.length);
              setLastUpdated(new Date());
            });
          }
        } catch { /* ignore */ }
      }
      if (!cancelled) setHydrated(true);
    }).catch(() => { if (!cancelled) setHydrated(true); });
    return () => { cancelled = true; idbRef.current?.close(); idbRef.current = null; };
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
    onConfigChange({ sourcesError: "", tailing: false, sessionId: undefined });
    if (idbRef.current && sessionIdRef.current) idbDeleteSession(idbRef.current, sessionIdRef.current);
    setEntries([]);
    setFetched(false);
    setTailTotalReceived(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [env]);

  // ── Fetch search history when panel opens ──
  useEffect(() => {
    if (!historyOpen) return;
    setHistoryLoading(true);
    fetch("/api/history?type=log-search")
      .then((r) => r.json())
      .then((data) => setHistoryRecords(Array.isArray(data) ? data : []))
      .catch(() => setHistoryRecords([]))
      .finally(() => setHistoryLoading(false));
  }, [historyOpen]);

  // ── Auto-save search results when complete ──
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const prevDone = useRef(false);
  useEffect(() => {
    const done = !!fetchProgress?.done;
    if (done && !prevDone.current) {
      // Belt-and-suspenders: ensure searching is cleared whenever fetch completes
      onConfigChange({ searching: false });
      if (mode === "search") {
        // Delay slightly to ensure entries state has settled
        setTimeout(() => {
          if (entriesRef.current.length > 0) {
            autoSaveToHistory("search", entriesRef.current);
          }
        }, 500);
      }
    }
    prevDone.current = done;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchProgress?.done, mode, autoSaveToHistory]);

  // ── Auto-scroll when tailing ──
  useEffect(() => {
    if (tailing && entries.length > 0 && isActive) {
      const el = scrollContainerRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
  }, [entries, tailing, isActive]);

  // ── React to tailing / tailSecs changes from parent config ──
  const prevTailing = useRef(false);

  useEffect(() => {
    if (tailing && !prevTailing.current) {
      // Start tail — new session (replace any previous session for this tab)
      if (idbRef.current && sessionIdRef.current) idbDeleteSession(idbRef.current, sessionIdRef.current);
      const newSession = `tail-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      onConfigChange({ sessionId: newSession });
      sessionIdRef.current = newSession;
      if (idbRef.current) idbRegisterSession(idbRef.current, newSession);
      setTailTotalReceived(0);
      setEntries([]);
      setFetched(false);
      setError("");
      workerRef.current?.postMessage({ type: "tail-start", env, sources: tailSources, tailSecs });
    } else if (!tailing && prevTailing.current) {
      // Stop tail
      workerRef.current?.postMessage({ type: "tail-stop" });
    } else if (tailing && prevTailing.current) {
      // Restart tail (tailSecs or selected sources changed)
      workerRef.current?.postMessage({ type: "tail-start", env, sources: tailSources, tailSecs });
    }
    prevTailing.current = tailing;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tailing, tailSecs, tailSources.join(",")]);

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
      beginTime = fromDatetimeLocal(customBegin);
      endTime = fromDatetimeLocal(customEnd);
    } else {
      const ms = PRESETS.find((p) => p.value === preset)!.ms;
      const now = new Date();
      beginTime = new Date(now.getTime() - ms).toISOString();
      endTime = now.toISOString();
    }

    // Build server-side _queryFilter from highlight keywords only.
    // The Filter entries box is client-side only — do NOT include it here.
    // This mirrors KYID Utilities' approach: only matching entries are returned by AIC,
    // dramatically reducing page count and eliminating rate-limit risk on long ranges.
    function escapeFilterValue(v: string) { return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"'); }
    const allTerms = keywordsRawRef.current.split(",").map((k) => k.trim()).filter(Boolean);
    const queryFilter = allTerms.length > 0
      ? allTerms.map((t) => {
          const v = escapeFilterValue(t);
          return `(/payload co "${v}") or (/payload/message co "${v}") or (/payload/eventName co "${v}")`;
        }).join(" or ")
      : undefined;

    setError("");
    setEntries([]);
    setFetched(false);
    setExpandedIdx(null);
    setFetchProgress(null);
    // New search session — replace any previously persisted entries for this tab
    if (idbRef.current && sessionIdRef.current) idbDeleteSession(idbRef.current, sessionIdRef.current);
    const newSession = `search-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    sessionIdRef.current = newSession;
    if (idbRef.current) idbRegisterSession(idbRef.current, newSession);
    onConfigChange({ searching: true, sessionId: newSession });
    workerRef.current?.postMessage({ type: "fetch", env, sources: selectedSources, beginTime, endTime, queryFilter });
    return doCleanup;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchSeq]);

  // Entries dropped from the in-memory circular buffer (tail mode only)
  const tailDropped = tailing ? Math.max(0, tailTotalReceived - entries.length) : 0;

  // Export the full tail session (all batches) from IndexedDB as a .log text file
  async function exportTailSession() {
    if (!idbRef.current || !sessionIdRef.current) return;
    try {
      const all   = await idbReadSession(idbRef.current, sessionIdRef.current);
      const lines = all.map((e) => formatTerminalLine(e, tailSource)).join("\n");
      const blob  = new Blob([lines], { type: "text/plain" });
      const url   = URL.createObjectURL(blob);
      const a     = Object.assign(document.createElement("a"), {
        href: url,
        download: `tail-${new Date().toISOString().slice(0, 19).replace(/:/g, "")}.log`,
      });
      a.click();
      URL.revokeObjectURL(url);
    } catch { /* ignore */ }
  }

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

  const rawFilteredWithIdx = useMemo(() => {
    if (!search) return levelFiltered.map((e, i) => ({ e, i }));
    const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = wholeWord ? `\\b${escaped}\\b` : escaped;
    const flags = matchCase ? "g" : "gi";
    const re = new RegExp(pattern, flags);
    return levelFiltered.reduce<{ e: LogEntry; i: number }[]>((acc, e, i) => {
      if (re.test(entryStrings[i].json)) acc.push({ e, i });
      return acc;
    }, []);
  }, [levelFiltered, entryStrings, search, matchCase, wholeWord]);

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

  const filtered = useMemo(() => filteredWithIdx.map(({ e }) => e), [filteredWithIdx]);

  // ── Match navigation (terminal view, keyword highlighting) ──
  // Compute indices into `filtered` where any keyword matches the formatted line
  const matchIndices = useMemo<number[]>(() => {
    if (keywords.length === 0) return [];
    const escaped = keywords.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const wrapped = wholeWord ? escaped.map((k) => `\\b${k}\\b`) : escaped;
    const flags = matchCase ? "g" : "gi";
    const re = new RegExp(wrapped.join("|"), flags);
    const result: number[] = [];
    for (let fi = 0; fi < filteredWithIdx.length; fi++) {
      if (re.test(entryStrings[filteredWithIdx[fi].i].line)) result.push(fi);
    }
    return result;
  }, [filteredWithIdx, entryStrings, keywords, matchCase, wholeWord]);

  // Jump to first match when keywords/options change; reset when no matches
  useEffect(() => {
    setMatchCursor(matchIndices.length > 0 ? 0 : -1);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keywordsActive, matchCase, wholeWord]);

  const scrollToIndex = matchCursor >= 0 && matchCursor < matchIndices.length
    ? matchIndices[matchCursor]
    : null;
  const activeMatchIndex = scrollToIndex;

  function goNextMatch() {
    if (matchIndices.length === 0) return;
    setMatchCursor((c) => (c + 1) % matchIndices.length);
  }
  function goPrevMatch() {
    if (matchIndices.length === 0) return;
    setMatchCursor((c) => (c <= 0 ? matchIndices.length - 1 : c - 1));
  }

  // ── Pagination (page 1 = oldest, last page = newest) ──
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageStartIdx = (currentPage - 1) * pageSize;
  const pageEndIdx = Math.min(currentPage * pageSize, filtered.length);
  const pageEntries = filtered.slice(pageStartIdx, pageEndIdx);

  // Reset jump flag whenever the filter terms change so we jump fresh on the next match
  useEffect(() => { firstMatchJumpedRef.current = false; }, [search, levelFilter]);

  useEffect(() => {
    setExpandedIdx(null);
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
    if (el) el.scrollIntoView({ block: "center" });
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
        {saveFlash && <span className="text-xs text-emerald-500 font-medium">Saved to history</span>}
        {sourcesError && <span className="text-xs text-red-500">{sourcesError}</span>}
        {error && <span className="text-xs text-red-500">{error}</span>}
      </div>

      {/* ── Search history panel ── */}
      {historyOpen && (
        <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
          <div className="px-4 py-2.5 border-b border-slate-100 bg-slate-50/50 flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-600">Search History</span>
            <button type="button" onClick={() => setHistoryOpen(false)} className="text-xs text-slate-400 hover:text-slate-600">Close</button>
          </div>
          {historyLoading ? (
            <div className="p-6 text-center text-xs text-slate-400">Loading…</div>
          ) : historyRecords.length === 0 ? (
            <div className="p-6 text-center text-xs text-slate-400">No saved searches yet.</div>
          ) : (
            <div className="divide-y divide-slate-100 max-h-64 overflow-y-auto">
              {historyRecords.map((rec) => {
                const age = Date.now() - new Date(rec.completedAt).getTime();
                const ageStr = age < 60000 ? "just now"
                  : age < 3600000 ? `${Math.floor(age / 60000)}m ago`
                  : age < 86400000 ? `${Math.floor(age / 3600000)}h ago`
                  : `${Math.floor(age / 86400000)}d ago`;
                return (
                  <div key={rec.id} className="flex items-center gap-3 px-4 py-2 hover:bg-slate-50 transition-colors text-xs">
                    <span className={cn(
                      "shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium",
                      rec.logMode === "search" ? "bg-sky-100 text-sky-700"
                        : rec.logMode === "tail" ? "bg-emerald-100 text-emerald-700"
                        : "bg-violet-100 text-violet-700"
                    )}>
                      {rec.logMode ?? "search"}
                    </span>
                    <span className="text-slate-500 font-mono text-[11px] shrink-0">{rec.logSource ?? rec.environment}</span>
                    <span className="text-slate-700 flex-1 truncate">
                      {rec.summary}
                    </span>
                    <span className="text-slate-400 shrink-0">{ageStr}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

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
              {mode === "search" && (
                <div className="flex items-center gap-1.5 shrink-0">
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
                        value={customBegin}
                        onChange={(e) => onConfigChange({ customBegin: e.target.value })}
                        disabled={searching}
                        className="rounded border border-slate-300 px-1.5 py-0.5 text-[11px] font-mono focus:outline-none focus:ring-1 focus:ring-sky-500"
                      />
                      <span className="text-slate-400 text-[11px]">→</span>
                      <input
                        type="datetime-local"
                        value={customEnd}
                        onChange={(e) => onConfigChange({ customEnd: e.target.value })}
                        disabled={searching}
                        className="rounded border border-slate-300 px-1.5 py-0.5 text-[11px] font-mono focus:outline-none focus:ring-1 focus:ring-sky-500"
                      />
                    </>
                  )}
                  <button
                    type="button"
                    onClick={() => onConfigChange({ searchSeq: (searchSeq ?? 0) + 1 })}
                    disabled={loading || searching || selectedSources.length === 0 || !!sourcesError}
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
                </div>
              )}

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
                  if (terminalView && matchIndices.length > 0) {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      if (e.shiftKey) goPrevMatch(); else goNextMatch();
                    }
                  }
                }}
                placeholder="Keywords to highlight, comma-separated…"
                className="flex-1 text-xs rounded border border-slate-200 px-2.5 py-1 font-mono focus:outline-none focus:ring-2 focus:ring-amber-400 focus:border-amber-400"
              />
              {keywordsRaw && (
                <span className="text-xs text-amber-600 whitespace-nowrap">
                  {keywords.length} keyword{keywords.length !== 1 ? "s" : ""}
                </span>
              )}
              <div className="flex rounded border border-slate-300 overflow-hidden shrink-0">
                <button
                  type="button"
                  title="Case sensitive"
                  onClick={() => setMatchCase((v) => !v)}
                  className={cn(
                    "px-2 py-0.5 text-[11px] font-medium font-mono transition-colors",
                    matchCase ? "bg-slate-900 text-white" : "bg-white text-slate-500 hover:bg-slate-50"
                  )}
                >Aa</button>
                <button
                  type="button"
                  title="Whole word"
                  onClick={() => setWholeWord((v) => !v)}
                  className={cn(
                    "px-2 py-0.5 text-[11px] font-medium font-mono border-l border-slate-300 transition-colors",
                    wholeWord ? "bg-slate-900 text-white" : "bg-white text-slate-500 hover:bg-slate-50"
                  )}
                >[W]</button>
              </div>
              {terminalView && matchIndices.length > 0 && (
                <>
                  <div className="flex items-center gap-1 text-[11px] text-slate-400 whitespace-nowrap tabular-nums">
                    <input
                      type="number"
                      min={1}
                      max={matchIndices.length}
                      value={matchCursor >= 0 ? matchCursor + 1 : ""}
                      placeholder="–"
                      onChange={(e) => {
                        const n = parseInt(e.target.value, 10);
                        if (!isNaN(n) && n >= 1 && n <= matchIndices.length) setMatchCursor(n - 1);
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

            {/* Row 2: view toggle + filter + count + height controls + fullscreen */}
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
                      setExpandedIdx(null);
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
              <input
                type="text"
                value={rawSearch}
                onChange={(e) => handleFilterChange(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") applySearch(rawSearch); }}
                placeholder="Filter entries… (3+ chars or Enter)"
                className={cn(
                  "flex-1 text-xs rounded border px-3 py-1.5 font-mono focus:outline-none focus:ring-2 focus:ring-sky-500",
                  rawSearch && !search
                    ? "border-amber-300 focus:ring-amber-400"   // typed but not yet active
                    : "border-slate-300"
                )}
              />
              {rawSearch && (
                <button type="button" onClick={clearSearch} className="text-xs text-slate-400 hover:text-slate-600">
                  Clear
                </button>
              )}
              <div className="flex rounded border border-slate-300 overflow-hidden shrink-0">
                <button
                  type="button"
                  title="Case sensitive"
                  onClick={() => setMatchCase((v) => !v)}
                  className={cn(
                    "px-2 py-0.5 text-[11px] font-medium font-mono transition-colors",
                    matchCase ? "bg-slate-900 text-white" : "bg-white text-slate-500 hover:bg-slate-50"
                  )}
                >Aa</button>
                <button
                  type="button"
                  title="Whole word"
                  onClick={() => setWholeWord((v) => !v)}
                  className={cn(
                    "px-2 py-0.5 text-[11px] font-medium font-mono border-l border-slate-300 transition-colors",
                    wholeWord ? "bg-slate-900 text-white" : "bg-white text-slate-500 hover:bg-slate-50"
                  )}
                >[W]</button>
              </div>
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
                      const data = JSON.stringify(filtered.map((e) => ({ timestamp: e.timestamp, source: e.source, type: e.type, payload: e.payload })), null, 2);
                      const blob = new Blob([data], { type: "application/json" });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement("a");
                      a.href = url;
                      a.download = `logs-${selectedSources.join("-")}-${new Date().toISOString().slice(0, 19).replace(/:/g, "")}.json`;
                      a.click();
                      URL.revokeObjectURL(url);
                    }}
                    className="text-xs text-slate-400 hover:text-slate-600 transition-colors shrink-0"
                  >
                    Export
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      autoSaveToHistory(mode as "tail" | "search", entries);
                      setSaveFlash(true);
                      setTimeout(() => setSaveFlash(false), 10000);
                    }}
                    className="text-xs text-slate-400 hover:text-slate-600 transition-colors shrink-0"
                  >
                    {saveFlash ? "Saved!" : "Save"}
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
                        if (idbRef.current && sessionIdRef.current) idbDeleteSession(idbRef.current, sessionIdRef.current);
                        sessionIdRef.current = undefined;
                        onConfigChange({ sessionId: undefined });
                        setEntries([]); setFetched(false); setError(""); clearSearch(); setExpandedIdx(null); setFetchProgress(null); setTailTotalReceived(0);
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
                onClick={() => setHistoryOpen((o) => !o)}
                className={cn("text-xs transition-colors shrink-0", historyOpen ? "text-sky-600" : "text-slate-400 hover:text-slate-600")}
                title="Search history"
              >
                History
              </button>
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
            onMouseUp={() => {
              if (fullscreen) return;
              const el = scrollContainerRef.current;
              if (!el) return;
              const h = el.clientHeight;
              if (h >= 200) { setTableHeight(h); saveHeight(h); }
            }}
            className={cn(
              terminalView ? "overflow-hidden" : "overflow-y-auto overflow-x-auto",
              fullscreen ? "flex-1" : "resize-y min-h-[200px]"
            )}
            style={fullscreen ? undefined : { height: tableHeight }}
          >
            {viewMode === "terminal" ? (
              !fetched && !tailing ? (
                <div className="flex items-center justify-center h-full min-h-[160px] bg-slate-950">
                  <p className="text-sm text-slate-500 font-mono">Select sources and start tailing or run a search</p>
                </div>
              ) : deferredIsActive && filtered.length === 0 && fetched && !searching ? (
                <div className="flex items-center justify-center h-full min-h-[160px] bg-slate-950">
                  <p className="text-sm text-slate-500 font-mono">
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
                  scrollToIndex={scrollToIndex}
                  activeMatchIndex={activeMatchIndex}
                  matchCase={matchCase}
                  wholeWord={wholeWord}
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
                <JsonLogView entries={filtered} wrapLines={wrapLines} />
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
                        expanded={expandedIdx === globalIdx}
                        onToggle={() => setExpandedIdx(expandedIdx === globalIdx ? null : globalIdx)}
                        searchTerm={search}
                        keywords={keywords}
                        onTransactionClick={(txId) => setDrilldown({ txId })}
                        onTimestampClick={onOpenContextTab}
                        fullscreen={fullscreen}
                        showFullMessage={showFullMessage}
                        highlighted={highlightedTableIdx === globalIdx}
                        rowIdx={globalIdx}
                        matchCase={matchCase}
                        wholeWord={wholeWord}
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
                  onChange={(e) => { setPageSize(Number(e.target.value)); setPage(Infinity); setExpandedIdx(null); }}
                  className="text-xs rounded border border-slate-300 px-2 py-1 focus:outline-none focus:ring-2 focus:ring-sky-500"
                >
                  {[50, 100, 200, 500].map((s) => (
                    <option key={s} value={s}>{s} / page</option>
                  ))}
                </select>
                <div className="flex items-center gap-1">
                  <button type="button" onClick={() => { setPage(1); setExpandedIdx(null); scrollContainerRef.current?.scrollTo(0, 0); }} disabled={currentPage <= 1} className="px-2 py-1 text-xs rounded border border-slate-300 text-slate-600 hover:bg-slate-50 disabled:opacity-30 disabled:cursor-not-allowed transition-colors" title="Oldest (page 1)">Oldest</button>
                  <button type="button" onClick={() => { setPage((p) => Math.max(1, p - 1)); setExpandedIdx(null); scrollContainerRef.current?.scrollTo(0, 0); }} disabled={currentPage <= 1} className="px-2 py-1 text-xs rounded border border-slate-300 text-slate-600 hover:bg-slate-50 disabled:opacity-30 disabled:cursor-not-allowed transition-colors" title="Older entries">← Older</button>
                  <span className="text-xs text-slate-500 px-2 tabular-nums">{currentPage} / {totalPages}</span>
                  <button type="button" onClick={() => { setPage((p) => Math.min(totalPages, p + 1)); setExpandedIdx(null); scrollContainerRef.current?.scrollTo(0, 0); }} disabled={currentPage >= totalPages} className="px-2 py-1 text-xs rounded border border-slate-300 text-slate-600 hover:bg-slate-50 disabled:opacity-30 disabled:cursor-not-allowed transition-colors" title="Newer entries">Newer →</button>
                  <button type="button" onClick={() => { setPage(totalPages); setExpandedIdx(null); scrollContainerRef.current?.scrollTo(0, 0); }} disabled={currentPage >= totalPages} className="px-2 py-1 text-xs rounded border border-slate-300 text-slate-600 hover:bg-slate-50 disabled:opacity-30 disabled:cursor-not-allowed transition-colors" title="Latest (last page)">Latest</button>
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
          {(searching || (fetchProgress && !fetchProgress.done)) && (
            <div className="flex items-center justify-between px-4 py-2 border-t border-slate-100 bg-sky-50/50 shrink-0">
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
          )}

          {/* Tail status indicator */}
          {tailing && (
            <div className="flex items-center justify-between px-4 py-2 border-t border-slate-700 bg-slate-900 shrink-0">
              <div className="flex items-center gap-2">
                <span className="inline-block w-2 h-2 rounded-full bg-emerald-400 animate-pulse shrink-0" />
                <span className="text-xs text-slate-300 font-mono">
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
                    {" · saved to IndexedDB"}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={exportTailSession}
                  className="px-2.5 py-1 text-xs font-medium bg-slate-700 text-slate-200 rounded hover:bg-slate-600 transition-colors"
                >
                  Export session
                </button>
                <button
                  type="button"
                  onClick={() => onConfigChange({ tailing: false })}
                  className="px-2.5 py-1 text-xs font-medium bg-red-900/60 text-red-300 rounded hover:bg-red-900 transition-colors"
                >
                  Stop
                </button>
              </div>
            </div>
          )}
        </div>

      {/* ── Transaction drill-down modal ── */}
      {drilldown && (
        <TransactionDrilldown
          transactionId={drilldown.txId}
          env={env}
          availableSources={[...LOG_SOURCES]}
          onClose={() => setDrilldown(null)}
        />
      )}
    </div>
  );
}

// ── Tabs wrapper with shared controls above ──────────────────────────────────

interface TabDef {
  id: number;
  label: string;
  config: TabConfig;
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

  useEffect(() => {
    try {
      const raw = localStorage.getItem(LOGS_STATE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as { tabs?: TabDef[]; activeId?: number };
        if (Array.isArray(parsed.tabs) && parsed.tabs.length > 0) {
          const restored = parsed.tabs.map((t) => ({
            ...t,
            config: sanitizeConfigForPersist({ ...makeDefaultConfig(environments), ...t.config }),
          }));
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
        tabs: tabs.map((t) => ({ ...t, config: sanitizeConfigForPersist(t.config) })),
        activeId,
      };
      localStorage.setItem(LOGS_STATE_KEY, JSON.stringify(payload));
    } catch { /* ignore */ }
  }, [mounted, tabs, activeId]);

  useEffect(() => {
    if (!fullscreen) return;
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") setFullscreen(false); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [fullscreen]);

  const activeTab = tabs.find((t) => t.id === activeId) ?? tabs[0];
  const cfg = activeTab?.config;

  const [txInput, setTxInput] = useState("");
  const [txSearch, setTxSearch] = useState<{ id: string; seq: number } | undefined>(undefined);

  function submitTxSearch() {
    const id = txInput.trim();
    if (id) setTxSearch((prev) => ({ id, seq: (prev?.seq ?? 0) + 1 }));
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
    const begin = toDatetimeLocal(new Date(ts - 60000).toISOString());
    const end   = toDatetimeLocal(new Date(ts + 60000).toISOString());
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

  function closeTab(id: number) {
    setTabs((prev) => {
      const next = prev.filter((t) => t.id !== id);
      if (activeId === id) {
        const idx = prev.findIndex((t) => t.id === id);
        const fallback = prev[idx + 1] ?? prev[idx - 1];
        if (fallback) setActiveId(fallback.id);
      }
      return next;
    });
  }

  function updateLabel(id: number, label: string) {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, label } : t)));
  }

  const selectedEnv = environments.find((e) => e.name === cfg?.env);

  if (!mounted) {
    return <div className="h-64 flex items-center justify-center text-sm text-slate-400">Loading…</div>;
  }

  return (
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
              onConfigChange={(updates) =>
                setTabs((prev) =>
                  prev.map((t) =>
                    t.id === tab.id ? { ...t, config: { ...t.config, ...updates } } : t
                  )
                )
              }
              isActive={tab.id === activeId}
              onLabelChange={(label) => updateLabel(tab.id, label)}
              tabs={tabs.map((t) => ({ id: t.id, label: t.label }))}
              activeTabId={activeId}
              onTabSwitch={setActiveId}
              fullscreen={fullscreen}
              onFullscreenChange={setFullscreen}
              txSearchId={tab.id === activeId ? txSearch : undefined}
              onOpenContextTab={openContextTab}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
