"use client";

import { useEffect, useRef, useState, useMemo } from "react";
import { LogEntry } from "@/hooks/useStreamingLogs";
import { CONFIG_SCOPES } from "@/lib/fr-config-types";
import { cn } from "@/lib/utils";

// ── Data helpers ──────────────────────────────────────────────────────────────

interface ScopeSection {
  scope: string;
  status: "running" | "success" | "failed";
  exitCode: number | null;
  lines: LogEntry[];
  startTs: number;
  endTs: number | null;
}

function buildSections(logs: LogEntry[]): ScopeSection[] {
  const sections: ScopeSection[] = [];
  let current: ScopeSection | null = null;

  for (const entry of logs) {
    if (entry.type === "scope-start") {
      current = {
        scope: entry.scope ?? "unknown",
        status: "running",
        exitCode: null,
        lines: [],
        startTs: entry.ts,
        endTs: null,
      };
      sections.push(current);
    } else if (entry.type === "scope-end" && current) {
      current.status = (entry.code ?? 1) === 0 ? "success" : "failed";
      current.exitCode = entry.code ?? null;
      current.endTs = entry.ts;
      current = null;
    } else if (current && (entry.type === "stdout" || entry.type === "stderr" || entry.type === "error")) {
      current.lines.push(entry);
    }
  }

  return sections;
}

function scopeLabel(scope: string): string {
  if (scope === "all") return "Full sync";
  const found = CONFIG_SCOPES.find((s) => s.value === scope);
  return (
    found?.label ??
    scope.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

// ── Search helpers ───────────────────────────────────────────────────────────

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function highlightMatches(text: string, query: string): React.ReactNode {
  if (!query || !text) return text;
  const regex = new RegExp(`(${escapeRegex(query)})`, "gi");
  const parts = text.split(regex);
  if (parts.length === 1) return text;
  return parts.map((part, i) =>
    regex.test(part) ? (
      <mark key={i} className="bg-yellow-400/30 text-yellow-200 rounded-sm px-0.5">{part}</mark>
    ) : (
      part
    )
  );
}

function lineMatches(entry: LogEntry, query: string): boolean {
  if (!query) return true;
  const lower = query.toLowerCase();
  return (entry.data ?? "").toLowerCase().includes(lower);
}

function countMatches(lines: LogEntry[], query: string): number {
  if (!query) return 0;
  const lower = query.toLowerCase();
  let count = 0;
  for (const l of lines) {
    const data = l.data ?? "";
    let idx = 0;
    while (true) {
      idx = data.toLowerCase().indexOf(lower, idx);
      if (idx === -1) break;
      count++;
      idx += lower.length;
    }
  }
  return count;
}

// ── SectionDetails — auto-scrolls as new lines arrive ────────────────────────

function SectionDetails({ lines, search, filterMode }: { lines: LogEntry[]; search: string; filterMode: boolean }) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [lines.length]);

  const visibleLines = filterMode && search
    ? lines.filter((l) => lineMatches(l, search))
    : lines;

  return (
    <div className="border-t border-slate-800 bg-slate-950/60 px-4 py-2 font-mono text-xs overflow-y-auto max-h-64">
      {visibleLines.map((entry, i) => (
        <div
          key={i}
          className={cn(
            "whitespace-pre-wrap break-all leading-5 animate-log-line",
            entry.type === "error" && "text-red-400",
            entry.type === "stderr" && "text-amber-300/90",
            entry.type === "stdout" && "text-slate-300",
          )}
        >
          {search ? highlightMatches(entry.data ?? "", search) : entry.data}
        </div>
      ))}
      {filterMode && search && visibleLines.length === 0 && (
        <div className="text-slate-600 py-2">No matching lines</div>
      )}
      <div ref={bottomRef} />
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

interface ScopedLogViewerProps {
  logs: LogEntry[];
  running: boolean;
  exitCode: number | null;
  onClear?: () => void;
}

export function ScopedLogViewer({
  logs,
  running,
  exitCode,
  onClear,
}: ScopedLogViewerProps) {
  const userManagedRef = useRef<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [copied, setCopied] = useState(false);
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [filterMode, setFilterMode] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const sections = buildSections(logs);

  // Duration: time between first scope-start and exit event
  const firstStartTs = logs.find((e) => e.type === "scope-start")?.ts ?? null;
  const exitTs = logs.find((e) => e.type === "exit")?.ts ?? null;
  const duration =
    firstStartTs !== null && exitTs !== null ? exitTs - firstStartTs : null;

  // Total match count
  const allLines = useMemo(() => sections.flatMap((s) => s.lines), [sections]);
  const matchCount = useMemo(() => countMatches(allLines, search), [allLines, search]);

  // Sections with matches (for badge display)
  const sectionMatchCounts = useMemo(() => {
    if (!search) return new Map<string, number>();
    const map = new Map<string, number>();
    for (const s of sections) {
      const c = countMatches(s.lines, search);
      if (c > 0) map.set(s.scope, c);
    }
    return map;
  }, [sections, search]);

  // Reset when logs are cleared
  useEffect(() => {
    if (logs.length === 0) {
      userManagedRef.current = new Set();
      setExpanded(new Set());
      setSearch("");
      setSearchOpen(false);
    }
  }, [logs.length]);

  // Auto-expand running scope, auto-collapse on success, keep open on failure
  useEffect(() => {
    const sects = buildSections(logs);
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const s of sects) {
        if (userManagedRef.current.has(s.scope)) continue;
        if (s.status === "running") next.add(s.scope);
        else if (s.status === "success" || s.status === "failed") next.delete(s.scope);
      }
      return next;
    });
  }, [logs]);

  // Focus search input when opened
  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);

  const toggleSection = (scope: string) => {
    userManagedRef.current.add(scope);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(scope)) next.delete(scope);
      else next.add(scope);
      return next;
    });
  };

  const handleCopy = () => {
    const text = sections
      .map(
        (s) =>
          `\n=== ${scopeLabel(s.scope)} ===\n` +
          s.lines.map((l) => l.data ?? "").join("")
      )
      .join("");
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const handleToggleSearch = () => {
    if (searchOpen) {
      setSearch("");
      setSearchOpen(false);
    } else {
      setSearchOpen(true);
    }
  };

  const completedCount = sections.filter((s) => s.status !== "running").length;
  const failedSections = sections.filter((s) => s.status === "failed");
  const runningSection = sections.find((s) => s.status === "running");

  const overallStatus: "idle" | "running" | "success" | "failed" =
    exitCode !== null
      ? exitCode === 0
        ? "success"
        : "failed"
      : running
      ? "running"
      : "idle";

  const statusDotClass = {
    idle: "bg-slate-600",
    running: "bg-yellow-400 animate-pulse",
    success: "bg-green-400",
    failed: "bg-red-400",
  }[overallStatus];

  const statusTextColor = {
    idle: "text-slate-500",
    running: "text-yellow-300",
    success: "text-green-400",
    failed: "text-red-400",
  }[overallStatus];

  const successCount = sections.length - failedSections.length;

  const statusText =
    overallStatus === "running"
      ? sections.length > 1
        ? `Running (${completedCount + 1}/${sections.length})${runningSection ? ` — ${scopeLabel(runningSection.scope)}` : ""}`
        : runningSection
        ? `Running — ${scopeLabel(runningSection.scope)}`
        : "Starting…"
      : overallStatus === "success"
      ? `Completed${duration !== null ? ` in ${formatDuration(duration)}` : ""} — ${completedCount} scope${completedCount !== 1 ? "s" : ""}`
      : overallStatus === "failed"
      ? failedSections.length < sections.length
        ? `Completed with errors${duration !== null ? ` in ${formatDuration(duration)}` : ""} — ${successCount} succeeded, ${failedSections.length} failed`
        : `Failed${duration !== null ? ` in ${formatDuration(duration)}` : ""} — ${failedSections.length} scope${failedSections.length !== 1 ? "s" : ""}`
      : "Ready";

  const hasSections = sections.length > 0;
  const flatLogs = logs.filter(
    (e) => e.type === "stdout" || e.type === "stderr" || e.type === "error"
  );

  return (
    <div className="flex flex-col">
      {/* ── Progress bar ─────────────────────────────────────────────────── */}
      <div className="h-0.5 bg-slate-700 overflow-hidden">
        {running && (
          <div className="h-full w-1/5 bg-sky-500 rounded-full animate-progress-slide" />
        )}
      </div>

      {/* ── Header ───────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 px-3 py-2 bg-slate-800 border-b border-slate-700">
        <span className={cn("inline-block w-2 h-2 rounded-full shrink-0", statusDotClass)} />
        <span className={cn("text-xs font-mono font-medium", statusTextColor)}>
          {statusText}
        </span>
        {logs.length > 0 && (
          <div className="ml-auto flex items-center gap-3">
            {/* Search toggle */}
            <button
              onClick={handleToggleSearch}
              className={cn(
                "text-xs transition-colors",
                searchOpen ? "text-sky-400 hover:text-sky-300" : "text-slate-400 hover:text-slate-200"
              )}
              title="Search logs"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            </button>
            <button
              onClick={handleCopy}
              className="text-xs text-slate-400 hover:text-slate-200 transition-colors"
            >
              {copied ? "Copied!" : "Copy"}
            </button>
            {!running && onClear && (
              <button
                onClick={onClear}
                className="text-xs text-slate-400 hover:text-slate-200 transition-colors"
              >
                Clear
              </button>
            )}
          </div>
        )}
      </div>

      {/* ── Search bar ───────────────────────────────────────────────────── */}
      {searchOpen && (
        <div className="flex items-center gap-2 px-3 py-1.5 bg-slate-800 border-b border-slate-700">
          <svg className="w-3.5 h-3.5 text-slate-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            ref={searchInputRef}
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") handleToggleSearch(); }}
            placeholder="Search logs…"
            className="flex-1 bg-transparent text-xs font-mono text-slate-200 placeholder-slate-600 outline-none"
          />
          {search && (
            <span className="text-[10px] font-mono text-slate-500 shrink-0">
              {matchCount} match{matchCount !== 1 ? "es" : ""}
            </span>
          )}
          <button
            onClick={() => setFilterMode((f) => !f)}
            className={cn(
              "text-[10px] px-1.5 py-0.5 rounded transition-colors shrink-0",
              filterMode
                ? "bg-sky-600 text-white"
                : "text-slate-500 hover:text-slate-300"
            )}
            title={filterMode ? "Showing only matching lines" : "Showing all lines with highlights"}
          >
            Filter
          </button>
          <button
            onClick={() => { setSearch(""); searchInputRef.current?.focus(); }}
            className="text-slate-500 hover:text-slate-300 shrink-0"
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}

      {/* ── Git commit banners (pre-pull) ─────────────────────────────── */}
      {logs.filter((e) => e.type === "git" && e.action?.startsWith("pre-pull")).map((e, i) => {
        const isError = e.action === "pre-pull-commit-error";
        return (
          <div
            key={`pre-${i}`}
            className={cn(
              "flex items-center gap-2 px-4 py-2 border-b text-xs font-mono",
              isError
                ? "bg-red-950/40 border-red-900/50 text-red-300"
                : "bg-emerald-950/40 border-emerald-900/50 text-emerald-300"
            )}
          >
            <svg className="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              {isError
                ? <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                : <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />}
            </svg>
            <span>{e.message}</span>
            {e.hash && <code className={cn("ml-auto px-1.5 py-0.5 rounded", isError ? "text-red-400/70 bg-red-950/60" : "text-emerald-400/70 bg-emerald-950/60")}>{e.hash}</code>}
          </div>
        );
      })}

      {/* ── Scope sections ───────────────────────────────────────────────── */}
      <div className="bg-slate-900">
        {hasSections ? (
          sections.map((section) => {
            const isOpen = expanded.has(section.scope);
            const hasLines = section.lines.length > 0;
            const sectionDuration =
              section.endTs !== null
                ? section.endTs - section.startTs
                : null;
            const sectionMatches = sectionMatchCounts.get(section.scope);

            return (
              <div
                key={section.scope}
                className="border-b border-slate-800 last:border-b-0"
              >
                {/* Row */}
                <div
                  className={cn(
                    "flex items-center gap-3 px-4 py-2.5 transition-colors",
                    hasLines && "cursor-pointer hover:bg-slate-800/50",
                    section.status === "running" && "bg-slate-800/40"
                  )}
                  onClick={() => hasLines && toggleSection(section.scope)}
                >
                  {/* Status icon */}
                  <span className="w-4 shrink-0 flex justify-center">
                    {section.status === "running" ? (
                      <span className="w-2 h-2 rounded-full bg-yellow-400 animate-pulse inline-block" />
                    ) : section.status === "success" ? (
                      <svg
                        className="w-3.5 h-3.5 text-green-400"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={3}
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M5 13l4 4L19 7"
                        />
                      </svg>
                    ) : (
                      <svg
                        className="w-3.5 h-3.5 text-red-400"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={3}
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M6 18L18 6M6 6l12 12"
                        />
                      </svg>
                    )}
                  </span>

                  {/* Label */}
                  <span
                    className={cn(
                      "text-xs font-mono flex-1",
                      section.status === "running" && "text-yellow-200",
                      section.status === "success" && "text-slate-300",
                      section.status === "failed" && "text-red-300"
                    )}
                  >
                    {scopeLabel(section.scope)}
                  </span>

                  {/* Search match count badge */}
                  {sectionMatches !== undefined && sectionMatches > 0 && (
                    <span className="text-[10px] font-mono text-yellow-400 bg-yellow-400/10 px-1.5 py-0.5 rounded">
                      {sectionMatches}
                    </span>
                  )}

                  {/* Duration badge */}
                  {sectionDuration !== null && (
                    <span className="text-xs text-slate-600 font-mono tabular-nums">
                      {formatDuration(sectionDuration)}
                    </span>
                  )}

                  {/* Exit code badge on failure */}
                  {section.status === "failed" &&
                    section.exitCode !== null && (
                      <span className="text-xs text-red-400 font-mono bg-red-950/60 px-1.5 py-0.5 rounded">
                        exit {section.exitCode}
                      </span>
                    )}

                  {/* Expand / collapse toggle */}
                  {hasLines && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleSection(section.scope);
                      }}
                      className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-300 transition-colors"
                    >
                      <svg
                        className={cn(
                          "w-3 h-3 transition-transform",
                          isOpen ? "" : "-rotate-90"
                        )}
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={2}
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M19 9l-7 7-7-7"
                        />
                      </svg>
                      {isOpen ? "Hide" : "Details"}
                    </button>
                  )}
                </div>

                {/* Expanded output with auto-scroll */}
                {isOpen && hasLines && (
                  <SectionDetails lines={section.lines} search={search} filterMode={filterMode} />
                )}
              </div>
            );
          })
        ) : (
          /* Flat fallback or idle placeholder */
          <div className="px-4 font-mono text-xs">
            {flatLogs.length > 0 ? (
              <div className="py-2">
                {flatLogs.map((entry, i) => (
                  <div
                    key={i}
                    className={cn(
                      "whitespace-pre-wrap break-all leading-5 animate-log-line",
                      entry.type === "error" && "text-red-400",
                      entry.type === "stderr" && "text-amber-300/90",
                      entry.type === "stdout" && "text-slate-200",
                    )}
                  >
                    {search ? highlightMatches(entry.data ?? "", search) : entry.data}
                  </div>
                ))}
              </div>
            ) : (
              <div className="py-6 text-center text-slate-600 select-none">
                {running ? "Starting…" : "Ready — select scopes and run to start"}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Result summary banner ─────────────────────────────────────────── */}
      {exitCode !== null && sections.length > 0 && (
        <div
          className={cn(
            "flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 border-t text-xs font-mono",
            exitCode === 0
              ? "border-emerald-900 bg-emerald-950/50 text-emerald-300"
              : "border-red-900 bg-red-950/50 text-red-300"
          )}
        >
          {/* Icon + main message */}
          <span className="flex items-center gap-2 font-medium">
            {exitCode === 0 ? (
              <svg className="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            ) : (
              <svg className="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            )}
            {exitCode === 0 ? "All scopes completed" : "Run failed"}
          </span>

          {/* Stats */}
          <span className="text-slate-400">
            {sections.length} scope{sections.length !== 1 ? "s" : ""}
          </span>
          {duration !== null && (
            <span className="text-slate-400">
              {formatDuration(duration)}
            </span>
          )}
          {failedSections.length > 0 && (
            <span className="text-red-400">
              Failed: {failedSections.map((s) => scopeLabel(s.scope)).join(", ")}
            </span>
          )}
        </div>
      )}

      {/* ── Git commit banners (post-pull) ────────────────────────────── */}
      {logs.filter((e) => e.type === "git" && e.action?.startsWith("post-pull")).map((e, i) => {
        const isError = e.action === "post-pull-commit-error";
        const isClean = e.action === "post-pull-clean";
        return (
          <div
            key={`post-${i}`}
            className={cn(
              "flex items-center gap-2 px-4 py-2 border-b text-xs font-mono",
              isError
                ? "bg-red-950/40 border-red-900/50 text-red-300"
                : isClean
                ? "bg-emerald-950/40 border-emerald-900/50 text-emerald-300"
                : "bg-sky-950/40 border-sky-900/50 text-sky-300"
            )}
          >
            <svg className="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              {isError
                ? <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                : <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />}
            </svg>
            <span>{e.message}</span>
            {e.hash && <code className={cn("ml-auto px-1.5 py-0.5 rounded", isError ? "text-red-400/70 bg-red-950/60" : "text-sky-400/70 bg-sky-950/60")}>{e.hash}</code>}
          </div>
        );
      })}

      {/* Debug (stderr) is now rendered inline inside each scope section. */}
    </div>
  );
}
