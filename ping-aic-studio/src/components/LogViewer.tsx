"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { LogEntry } from "@/hooks/useStreamingLogs";
import { cn } from "@/lib/utils";

interface LogViewerProps {
  logs: LogEntry[];
  running: boolean;
  exitCode: number | null;
  onClear?: () => void;
  /** Full list of scopes the caller queued up, so the pill row is pre-populated. */
  expectedScopes?: string[];
}

type ScopeStatus = "pending" | "running" | "done" | "failed";

function deriveScopeStatuses(
  logs: LogEntry[],
  expectedScopes: string[],
): { name: string; status: ScopeStatus; code: number | null }[] {
  // Pill row is only rendered when the caller supplies expectedScopes.
  // Callers that render their own scope progress UI (e.g. SyncForm) should
  // omit the prop; in that case this returns [] and LogViewer hides the row.
  if (expectedScopes.length === 0) return [];

  const map = new Map<string, { name: string; status: ScopeStatus; code: number | null }>();
  const order: string[] = [];

  for (const s of expectedScopes) {
    if (!map.has(s)) {
      map.set(s, { name: s, status: "pending", code: null });
      order.push(s);
    }
  }

  for (const entry of logs) {
    if (entry.type === "scope-start" && entry.scope) {
      const row = map.get(entry.scope);
      if (row && row.status === "pending") row.status = "running";
    } else if (entry.type === "scope-end" && entry.scope) {
      const row = map.get(entry.scope);
      if (row) {
        const code = entry.code ?? 0;
        row.status = code === 0 ? "done" : "failed";
        row.code = code;
      }
    }
  }

  return order.map((s) => map.get(s)!);
}

function formatScopeLabel(name: string): string {
  return name.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function statusGlyph(status: ScopeStatus): string {
  if (status === "pending") return "○";
  if (status === "running") return "◐";
  if (status === "done") return "✓";
  return "✗";
}

function pillClasses(status: ScopeStatus): string {
  if (status === "done") return "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200";
  if (status === "failed") return "bg-rose-50 text-rose-700 ring-1 ring-rose-200";
  if (status === "running") return "bg-amber-50 text-amber-700 ring-1 ring-amber-200 animate-pulse";
  return "bg-slate-100 text-slate-500 ring-1 ring-slate-200";
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function highlightMatches(
  text: string,
  query: string,
  startIdx: number,
  activeIdx: number,
): React.ReactNode {
  if (!query || !text) return text;
  const regex = new RegExp(`(${escapeRegex(query)})`, "gi");
  const parts = text.split(regex);
  if (parts.length === 1) return text;
  let matchIdx = startIdx;
  return parts.map((part, i) => {
    if (i % 2 === 0) return part;
    const isActive = matchIdx === activeIdx;
    const el = (
      <mark
        key={i}
        data-match-idx={matchIdx}
        className={cn(
          "rounded-sm px-0.5",
          isActive
            ? "bg-amber-300 text-slate-900 ring-1 ring-amber-200"
            : "bg-yellow-400/40 text-yellow-100",
        )}
      >
        {part}
      </mark>
    );
    matchIdx++;
    return el;
  });
}

function countMatches(text: string, query: string): number {
  if (!query || !text) return 0;
  const lower = query.toLowerCase();
  const haystack = text.toLowerCase();
  let count = 0;
  let idx = 0;
  while (true) {
    idx = haystack.indexOf(lower, idx);
    if (idx === -1) break;
    count++;
    idx += lower.length;
  }
  return count;
}

export function LogViewer({ logs, running, exitCode, onClear, expectedScopes }: LogViewerProps) {
  const mainPaneRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState(false);
  const [rawSearch, setRawSearch] = useState("");   // input value
  const [search, setSearch] = useState("");          // applied query (drives highlight + filter)
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [filterMode, setFilterMode] = useState(false);
  const [currentMatch, setCurrentMatch] = useState(0);
  const [jumpInput, setJumpInput] = useState("");

  const applySearch = (val: string) => {
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    setSearch(val);
  };
  const handleSearchChange = (val: string) => {
    setRawSearch(val);
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    if (val.length === 0) {
      applySearch("");
    } else if (val.length >= 3) {
      searchDebounceRef.current = setTimeout(() => applySearch(val), 400);
    }
    // 1–2 chars: leave active query alone until threshold or Enter.
  };

  // SyncForm mutates the logs array in place and bumps a tick to re-render,
  // so the array reference is stable but length grows. Keying these memos on
  // logs.length (plus reference, to catch clear/reset) ensures recompute.
  const scopeRows = useMemo(
    () => deriveScopeStatuses(logs, expectedScopes ?? []),
    [logs, logs.length, expectedScopes],
  );

  // Flat log view: all stdout/stderr/error lines in arrival order, plus
  // subtle separators for scope-start / scope-end and the final exit line.
  const flatLines = useMemo(
    () => logs.filter((e) => e.type === "stdout" || e.type === "stderr" || e.type === "error" || e.type === "exit" || e.type === "scope-start" || e.type === "scope-end"),
    [logs, logs.length],
  );

  // lineStart[i] = running match index at the start of flatLines[i];
  // total match count is the running total after the last line.
  const { lineStart, matchCount } = useMemo(() => {
    const arr = new Array<number>(flatLines.length).fill(0);
    if (!search) return { lineStart: arr, matchCount: 0 };
    let acc = 0;
    for (let i = 0; i < flatLines.length; i++) {
      arr[i] = acc;
      const e = flatLines[i];
      if (e.type === "stdout" || e.type === "stderr" || e.type === "error") {
        acc += countMatches(e.data ?? "", search);
      }
    }
    return { lineStart: arr, matchCount: acc };
  }, [flatLines, search]);

  const handleCopy = () => {
    const text = logs
      .map((e) => {
        if (e.type === "exit") return `\n[Process exited with code ${e.code}]`;
        if (e.type === "scope-start" && e.scope) return `\n=== ${e.scope} ===\n`;
        if (e.type === "scope-end" && e.scope) return `--- ${e.scope} (exit ${e.code ?? 0}) ---\n`;
        return e.data ?? "";
      })
      .join("");
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  // Auto-scroll to bottom on every new line, but stay out of the user's way
  // while they're navigating match highlights.
  useEffect(() => {
    if (search) return;
    const el = mainPaneRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [logs, logs.length, search]);

  useEffect(() => {
    if (logs.length === 0) {
      setRawSearch("");
      applySearch("");
      setSearchOpen(false);
      setFilterMode(false);
      setCurrentMatch(0);
    }
  }, [logs.length]);

  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);

  // Reset active match when the query changes; clamp when the match set shrinks
  // (e.g. new lines arrived that changed counts, or filter toggled).
  useEffect(() => {
    setCurrentMatch(0);
  }, [search]);
  useEffect(() => {
    if (matchCount === 0) {
      setCurrentMatch(0);
    } else if (currentMatch >= matchCount) {
      setCurrentMatch(matchCount - 1);
    }
  }, [matchCount, currentMatch]);

  // Sync the numeric jump input with the active match.
  useEffect(() => {
    setJumpInput(matchCount > 0 ? String(currentMatch + 1) : "");
  }, [currentMatch, matchCount]);

  // Scroll the active match into view when it changes.
  useEffect(() => {
    if (!search || matchCount === 0) return;
    const pane = mainPaneRef.current;
    if (!pane) return;
    const el = pane.querySelector(
      `[data-match-idx="${currentMatch}"]`,
    ) as HTMLElement | null;
    if (el) el.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [currentMatch, search, matchCount, filterMode, logs.length]);

  const handleToggleSearch = () => {
    if (searchOpen) {
      setRawSearch("");
      applySearch("");
      setSearchOpen(false);
    } else {
      setSearchOpen(true);
    }
  };

  const goPrev = () => {
    if (matchCount === 0) return;
    setCurrentMatch((i) => (i - 1 + matchCount) % matchCount);
  };
  const goNext = () => {
    if (matchCount === 0) return;
    setCurrentMatch((i) => (i + 1) % matchCount);
  };
  const commitJump = () => {
    if (matchCount === 0) return;
    const n = parseInt(jumpInput, 10);
    if (Number.isNaN(n)) {
      setJumpInput(String(currentMatch + 1));
      return;
    }
    const clamped = Math.max(1, Math.min(matchCount, n));
    setCurrentMatch(clamped - 1);
  };

  const statusText =
    exitCode === null
      ? running
        ? "Running..."
        : "Ready"
      : exitCode === 0
      ? "Completed successfully"
      : `Completed with errors (exit code ${exitCode})`;

  const counts = scopeRows.reduce(
    (acc, s) => {
      acc[s.status]++;
      return acc;
    },
    { pending: 0, running: 0, done: 0, failed: 0 } as Record<ScopeStatus, number>,
  );

  return (
    <div className="card flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-2.5 bg-slate-50 border-b border-slate-200/60 rounded-t-xl">
        <span
          className={cn(
            "inline-block w-2 h-2 rounded-full shrink-0",
            running ? "bg-amber-400 animate-pulse"
              : exitCode === 0 ? "bg-emerald-400"
              : exitCode !== null ? "bg-rose-400"
              : "bg-slate-300",
          )}
        />
        <span
          className={cn(
            "text-[12px] font-medium",
            exitCode === null
              ? (running ? "text-amber-700" : "text-slate-500")
              : exitCode === 0 ? "text-emerald-700" : "text-rose-700",
          )}
        >
          {statusText}
        </span>
        {scopeRows.length > 0 && (
          <span className="text-[11px] text-slate-500">
            {counts.done} of {scopeRows.length} done{counts.failed ? ` · ${counts.failed} failed` : ""}
          </span>
        )}
        {logs.length > 0 && (
          <div className="ml-auto flex items-center gap-3 text-[11px] text-slate-500">
            <button
              onClick={handleToggleSearch}
              className={cn(
                "transition-colors",
                searchOpen ? "text-sky-600 hover:text-sky-700" : "hover:text-slate-800",
              )}
              title="Search logs"
            >
              Search
            </button>
            <button onClick={handleCopy} className="hover:text-slate-800 transition-colors">
              {copied ? "Copied" : "Copy"}
            </button>
            {!running && onClear && (
              <button onClick={onClear} className="hover:text-slate-800 transition-colors">Clear</button>
            )}
          </div>
        )}
      </div>

      {/* Search bar — filter/highlight log lines by keyword. */}
      {searchOpen && (
        <div className="flex items-center gap-2 px-4 py-1.5 bg-slate-50 border-b border-slate-200/60">
          <svg className="w-3.5 h-3.5 text-slate-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            ref={searchInputRef}
            type="text"
            value={rawSearch}
            onChange={(e) => handleSearchChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                handleToggleSearch();
              } else if (e.key === "Enter") {
                e.preventDefault();
                if (rawSearch !== search) {
                  applySearch(rawSearch);
                } else if (matchCount > 0) {
                  if (e.shiftKey) goPrev();
                  else goNext();
                }
              }
            }}
            placeholder="Search logs — Enter to apply"
            className="flex-1 bg-transparent text-[12px] font-mono text-slate-700 placeholder-slate-400 outline-none"
          />
          {rawSearch && rawSearch !== search && (
            <span
              className="text-[10px] font-mono text-slate-400 shrink-0"
              title="Press Enter to search"
            >
              Enter ↵
            </span>
          )}
          {search && (
            <div className="flex items-center gap-1 text-[10px] font-mono text-slate-500 shrink-0">
              <button
                onClick={goPrev}
                disabled={matchCount === 0}
                className="px-1 py-0.5 rounded hover:bg-slate-200 disabled:opacity-40 disabled:hover:bg-transparent"
                title="Previous match (Shift+Enter)"
                aria-label="Previous match"
              >
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                </svg>
              </button>
              <input
                type="text"
                inputMode="numeric"
                value={jumpInput}
                onChange={(e) => setJumpInput(e.target.value.replace(/[^\d]/g, ""))}
                onBlur={commitJump}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    commitJump();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    setJumpInput(matchCount > 0 ? String(currentMatch + 1) : "");
                    searchInputRef.current?.focus();
                  }
                }}
                disabled={matchCount === 0}
                className="w-8 bg-transparent text-center text-slate-600 outline-none rounded disabled:opacity-40 focus:bg-white focus:ring-1 focus:ring-sky-300"
                title="Jump to match"
                aria-label="Jump to match"
              />
              <span className="text-slate-400">of {matchCount}</span>
              <button
                onClick={goNext}
                disabled={matchCount === 0}
                className="px-1 py-0.5 rounded hover:bg-slate-200 disabled:opacity-40 disabled:hover:bg-transparent"
                title="Next match (Enter)"
                aria-label="Next match"
              >
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                </svg>
              </button>
            </div>
          )}
          <button
            onClick={() => setFilterMode((f) => !f)}
            className={cn(
              "text-[10px] px-1.5 py-0.5 rounded transition-colors shrink-0",
              filterMode
                ? "bg-sky-600 text-white"
                : "text-slate-500 hover:text-slate-700",
            )}
            title={filterMode ? "Showing only matching lines" : "Showing all lines with highlights"}
          >
            Filter
          </button>
          <button
            onClick={() => {
              setRawSearch("");
              applySearch("");
              searchInputRef.current?.focus();
            }}
            className="text-slate-400 hover:text-slate-600 shrink-0"
            title="Clear search"
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}

      {/* Scope pills — compact status row above the log pane. */}
      {scopeRows.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-4 py-2.5 bg-white border-b border-slate-200/60">
          {scopeRows.map((row) => (
            <span
              key={row.name}
              title={row.status === "failed" && row.code !== null ? `exit ${row.code}` : row.status}
              className={cn(
                "inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium",
                pillClasses(row.status),
              )}
            >
              <span className="text-[10px]">{statusGlyph(row.status)}</span>
              {formatScopeLabel(row.name)}
            </span>
          ))}
        </div>
      )}

      {/* Main log pane — flat stream of stdout/stderr/error/scope markers. */}
      <div ref={mainPaneRef} className="overflow-y-auto bg-slate-900 p-4 font-mono text-[12px] leading-5 min-h-[320px] max-h-[560px] rounded-b-xl">
        {flatLines.length === 0 && !running && (
          <span className="text-slate-500">No output yet. Run a command to see logs.</span>
        )}
        {flatLines.map((entry, i) => {
          if (entry.type === "scope-start") {
            return (
              <div key={i} className="mt-2 text-cyan-400/90 font-semibold">
                ━━━ {formatScopeLabel(entry.scope ?? "")} ━━━
              </div>
            );
          }
          if (entry.type === "scope-end") {
            const ok = (entry.code ?? 0) === 0;
            return (
              <div
                key={i}
                className={cn("text-[11px] italic", ok ? "text-emerald-500/80" : "text-rose-400/90")}
              >
                {ok ? "✓ " : "✗ "}{formatScopeLabel(entry.scope ?? "")} finished{ok ? "" : ` (exit ${entry.code})`}
              </div>
            );
          }
          if (entry.type === "exit") {
            return (
              <div
                key={i}
                className={cn(
                  "whitespace-pre-wrap break-all mt-2 font-bold",
                  entry.code === 0 ? "text-green-400" : "text-red-400",
                )}
              >
                {`\n[Process exited with code ${entry.code}]`}
              </div>
            );
          }
          if (filterMode && search && !(entry.data ?? "").toLowerCase().includes(search.toLowerCase())) {
            return null;
          }
          return (
            <div
              key={i}
              className={cn(
                "whitespace-pre-wrap break-all",
                entry.type === "error" && "text-red-400",
                entry.type === "stderr" && "text-amber-300/90",
                entry.type === "stdout" && "text-slate-100",
              )}
            >
              {search
                ? highlightMatches(entry.data ?? "", search, lineStart[i] ?? 0, currentMatch)
                : entry.data}
            </div>
          );
        })}
      </div>
    </div>
  );
}
