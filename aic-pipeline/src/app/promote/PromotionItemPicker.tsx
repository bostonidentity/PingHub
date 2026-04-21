"use client";

import { useEffect, useRef, useState } from "react";
import { ConfigScope, CONFIG_SCOPES } from "@/lib/fr-config-types";
import type { Environment, ScopeSelection } from "@/lib/fr-config-types";
import { ItemViewer } from "@/app/push/ItemViewer";
import { cn } from "@/lib/utils";

// ── Types ─────────────────────────────────────────────────────────────────────

interface AuditItem { id: string; label: string; }
interface AuditEntry { scope: string; fileCount: number; exists: boolean; items: AuditItem[]; selectable: boolean; }

// Internal representation while editing: scope → null (all items) | string[] (specific items)
type Selections = Record<string, string[] | null>;

// ── Helpers ───────────────────────────────────────────────────────────────────

const CLI_SCOPES = CONFIG_SCOPES
  .filter((s) => s.cliSupported !== false)
  .map((s) => s.value as ConfigScope);

function scopeLabel(s: string) {
  return CONFIG_SCOPES.find((c) => c.value === s)?.label ?? s;
}

function scopeGroup(s: string): string {
  return CONFIG_SCOPES.find((c) => c.value === s)?.group ?? "Other";
}

// Insertion-order-preserving unique groups as they appear in CONFIG_SCOPES.
const SCOPE_GROUPS = Array.from(new Set(CONFIG_SCOPES.map((c) => c.group)));

function toSelections(items: ScopeSelection[]): Selections {
  const rec: Selections = {};
  for (const { scope, items: si } of items) rec[scope] = si ?? null;
  return rec;
}

function fromSelections(rec: Selections): ScopeSelection[] {
  return Object.entries(rec).map(([scope, si]) => ({
    scope: scope as ConfigScope,
    ...(si !== null ? { items: si } : {}),
  }));
}

// ── Scope row ─────────────────────────────────────────────────────────────────

const PAGE_SIZE = 50;

function ScopeRow({
  entry,
  included,
  selectedItems,
  onToggleScope,
  onToggleItem,
  onViewItem,
}: {
  entry: AuditEntry;
  included: boolean;
  selectedItems: string[] | null;
  onToggleScope: (v: boolean) => void;
  onToggleItem: (item: string, checked: boolean) => void;
  onViewItem: (item: AuditItem) => void;
}) {
  const [open, setOpen] = useState(true);
  const [filter, setFilter] = useState("");
  const [page, setPage] = useState(0);
  const filterRef = useRef<HTMLInputElement>(null);

  // allSelected only when the scope is actually included AND selectedItems is null (all items)
  const allSelected = included && selectedItems === null;
  const selectedSet = new Set(selectedItems ?? []);
  const checkedCount = allSelected ? entry.items.length : selectedSet.size;
  const query = filter.trim().toLowerCase();
  const filtered = query ? entry.items.filter((i) => i.label.toLowerCase().includes(query)) : entry.items;

  // Selected items float to the top inside the list
  const sorted = allSelected
    ? filtered
    : [...filtered].sort((a, b) => {
        const aChecked = selectedSet.has(a.id) ? 0 : 1;
        const bChecked = selectedSet.has(b.id) ? 0 : 1;
        return aChecked - bChecked;
      });

  const pageCount = Math.ceil(sorted.length / PAGE_SIZE);
  const safePage = Math.min(page, Math.max(0, pageCount - 1));
  const visible = sorted.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);
  const needsPagination = sorted.length > PAGE_SIZE;


  const headerIsToggle = !entry.selectable;

  return (
    <div className="border-b border-slate-200 last:border-b-0">
      {/* Header — the full bar is clickable for expand/collapse */}
      <div
        className={cn(
          "flex items-center gap-2.5 px-3 py-3 border-l-4 transition-colors",
          entry.items.length > 0 ? "cursor-pointer select-none" : "cursor-default",
          included
            ? "bg-sky-50 border-l-sky-500 hover:bg-sky-100"
            : "bg-slate-50 border-l-transparent hover:bg-slate-100",
        )}
        onClick={entry.items.length > 0 ? () => setOpen((o) => !o) : undefined}
      >
        {/* Non-selectable: check indicator — click toggles scope inclusion */}
        {headerIsToggle && (
          <span
            className={cn(
              "w-4 h-4 rounded border-2 shrink-0 flex items-center justify-center transition-colors",
              included ? "bg-sky-600 border-sky-600" : "border-slate-400 bg-white",
            )}
            onClick={(e) => { e.stopPropagation(); onToggleScope(!included); }}
          >
            {included && (
              <svg className="w-2.5 h-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            )}
          </span>
        )}

        <span className={cn(
          "flex-1 text-xs font-semibold tracking-wide",
          included ? "text-sky-900" : "text-slate-500",
        )}>
          {scopeLabel(entry.scope)}
        </span>

        {/* Selectable: count + select-all */}
        {entry.selectable && entry.items.length > 0 && (
          <>
            <span className={cn("text-[10px] tabular-nums font-mono", checkedCount > 0 ? "text-sky-700 font-semibold" : "text-slate-400")}>
              {checkedCount > 0 ? `${checkedCount}/${entry.items.length}` : `0/${entry.items.length}`}
            </span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                if (allSelected) onToggleItem("__none__", false);
                else onToggleItem("__all__", true);
              }}
              className="text-[10px] text-sky-600 hover:text-sky-800 shrink-0"
            >
              {allSelected ? "Deselect all" : "Select all"}
            </button>
          </>
        )}

        {/* Non-selectable: "all files" badge */}
        {headerIsToggle && entry.items.length > 0 && (
          <span className="text-[10px] text-slate-500 bg-slate-200 px-1.5 py-0.5 rounded">all files</span>
        )}

        {/* Chevron — visual only, whole header is the click target */}
        {entry.items.length > 0 ? (
          <svg className={cn("w-3.5 h-3.5 transition-transform shrink-0", included ? "text-sky-500" : "text-slate-400", open ? "" : "-rotate-90")} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        ) : (
          <span className="text-[10px] text-slate-400">empty</span>
        )}
      </div>

      {/* Filter */}
      {open && entry.items.length > 0 && (
        <div className="flex items-center gap-1.5 px-3 py-1.5 bg-white border-b border-slate-100">
          <svg className="w-3 h-3 text-slate-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z" />
          </svg>
          <input
            ref={filterRef}
            type="text"
            value={filter}
            onChange={(e) => { setFilter(e.target.value); setPage(0); }}
            placeholder={`Filter ${entry.items.length} item${entry.items.length !== 1 ? "s" : ""}…`}
            className="flex-1 text-[11px] bg-transparent text-slate-700 placeholder-slate-400 outline-none min-w-0"
          />
          {filter && (
            <button type="button" onClick={() => { setFilter(""); setPage(0); filterRef.current?.focus(); }} className="text-slate-400 hover:text-slate-600">
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
          {query && (
            <span className="text-[10px] text-slate-400 tabular-nums shrink-0">{filtered.length}/{entry.items.length}</span>
          )}
        </div>
      )}

      {/* Items */}
      {open && entry.items.length > 0 && (
        <div className="px-3 pb-2 pt-0.5 bg-slate-50/60">
          {visible.length === 0 ? (
            <p className="text-[11px] text-slate-400 py-2 text-center">No matches</p>
          ) : (
            // Multi-column responsive grid so wide item lists use the
            // horizontal space instead of scrolling vertically. Pagination
            // below is unchanged — sorted.slice(page * PAGE_SIZE, …) still
            // caps at PAGE_SIZE items per page.
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-4 gap-y-0.5">
              {visible.map((item) => {
                const checked = allSelected || selectedSet.has(item.id);
                return (
                  <div key={item.id} className="flex items-center gap-2 py-0.5 min-w-0">
                    {entry.selectable ? (
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => onToggleItem(item.id, e.target.checked)}
                        className="w-3 h-3 accent-sky-600 shrink-0 cursor-pointer"
                      />
                    ) : (
                      <span className="w-3 h-3 shrink-0" />
                    )}
                    <button
                      type="button"
                      onClick={() => onViewItem(item)}
                      className={cn(
                        "text-[11px] truncate text-left hover:underline hover:text-sky-600 transition-colors min-w-0",
                        checked ? "text-slate-600" : "text-slate-400",
                      )}
                    >
                      {item.label}
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          {/* Pagination */}
          {needsPagination && (
            <div className="flex items-center justify-between pt-1.5 mt-1 border-t border-slate-200">
              <span className="text-[10px] text-slate-400 tabular-nums">
                {safePage * PAGE_SIZE + 1}–{Math.min((safePage + 1) * PAGE_SIZE, sorted.length)} of {sorted.length}
              </span>
              <div className="flex items-center gap-0.5">
                <button
                  type="button"
                  onClick={() => setPage(0)}
                  disabled={safePage === 0}
                  className="p-0.5 text-slate-400 hover:text-slate-600 disabled:opacity-30 disabled:cursor-not-allowed"
                  title="First page"
                >
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M11 19l-7-7 7-7M18 19l-7-7 7-7" />
                  </svg>
                </button>
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  disabled={safePage === 0}
                  className="p-0.5 text-slate-400 hover:text-slate-600 disabled:opacity-30 disabled:cursor-not-allowed"
                  title="Previous page"
                >
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                  </svg>
                </button>
                <span className="text-[10px] text-slate-500 tabular-nums px-1">
                  {safePage + 1}/{pageCount}
                </span>
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                  disabled={safePage >= pageCount - 1}
                  className="p-0.5 text-slate-400 hover:text-slate-600 disabled:opacity-30 disabled:cursor-not-allowed"
                  title="Next page"
                >
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                  </svg>
                </button>
                <button
                  type="button"
                  onClick={() => setPage(pageCount - 1)}
                  disabled={safePage >= pageCount - 1}
                  className="p-0.5 text-slate-400 hover:text-slate-600 disabled:opacity-30 disabled:cursor-not-allowed"
                  title="Last page"
                >
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M13 5l7 7-7 7M6 5l7 7-7 7" />
                  </svg>
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function PromotionItemPicker({
  environment,
  environments = [],
  value,
  onChange,
}: {
  environment: string;
  environments?: Environment[];
  value: ScopeSelection[];
  onChange: (v: ScopeSelection[]) => void;
}) {
  const [browseEnv, setBrowseEnv] = useState(environment);
  const [auditData, setAuditData] = useState<AuditEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [activeScope, setActiveScope] = useState<string | null>(null);
  const [viewerItem, setViewerItem] = useState<{ scope: string; item: AuditItem } | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const scopeRefs = useRef<Record<string, HTMLDivElement | null>>({});

  // Sync browseEnv if the source environment prop changes
  useEffect(() => { setBrowseEnv(environment); }, [environment]);

  const selections = toSelections(value);

  // Fetch all CLI scopes on mount / browseEnv change
  useEffect(() => {
    if (!browseEnv) return;
    setLoading(true);
    const params = new URLSearchParams({ environment: browseEnv, scopes: CLI_SCOPES.join(",") });
    fetch(`/api/push/audit?${params}`)
      .then((r) => r.ok ? r.json() : null)
      .then((data) => { if (data) setAuditData(data); })
      .finally(() => setLoading(false));
  }, [browseEnv]);

  // IntersectionObserver for sidebar highlight
  useEffect(() => {
    const container = contentRef.current;
    if (!container || !auditData) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible.length > 0) setActiveScope(visible[0].target.getAttribute("data-scope"));
      },
      { root: container, threshold: 0.1 }
    );
    for (const el of Object.values(scopeRefs.current)) {
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [auditData]);

  const scrollToScope = (scope: string) => {
    scopeRefs.current[scope]?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const handleScopeToggle = (scope: ConfigScope, included: boolean) => {
    const next = { ...selections };
    if (included) next[scope] = null;   // include all by default
    else delete next[scope];
    onChange(fromSelections(next));
  };

  const handleItemToggle = (scope: ConfigScope, item: string, checked: boolean) => {
    if (item === "__all__") { onChange(fromSelections({ ...selections, [scope]: null })); return; }
    if (item === "__none__") {
      // Deselect all → remove scope entirely
      const next = { ...selections };
      delete next[scope];
      onChange(fromSelections(next));
      return;
    }

    const entry = auditData?.find((e) => e.scope === scope);
    if (!entry) return;

    const current = selections[scope];
    const allIds = entry.items.map((i) => i.id);
    const currentSet = new Set(current === null ? allIds : (current ?? []));
    if (checked) currentSet.add(item);
    else currentSet.delete(item);

    if (currentSet.size === 0) {
      // Last item unchecked → remove scope from selection
      const next = { ...selections };
      delete next[scope];
      onChange(fromSelections(next));
      return;
    }

    const allNowSelected = allIds.every((id) => currentSet.has(id));
    onChange(fromSelections({ ...selections, [scope]: allNowSelected ? null : [...currentSet] }));
  };

  // Order matches CONFIG_SCOPES (i.e. groups appear in their defined order, and
  // scopes within each group keep their natural order). The left-nav group
  // headers and the right-content scope rows use this same ordering, so
  // clicking a nav entry always scrolls to a predictable position.
  const sortedAuditData = auditData
    ? [...auditData].sort((a, b) => {
        const orderOf = (s: string) => {
          const i = CONFIG_SCOPES.findIndex((c) => c.value === s);
          return i < 0 ? Number.MAX_SAFE_INTEGER : i;
        };
        return orderOf(a.scope) - orderOf(b.scope);
      })
    : null;

  const [searchQuery, setSearchQuery] = useState("");

  const includedCount = Object.keys(selections).length;
  const totalItems = auditData
    ? auditData.reduce((sum, e) => {
        if (!Object.prototype.hasOwnProperty.call(selections, e.scope)) return sum;
        const sel = selections[e.scope];
        return sum + (sel === null ? e.items.length : sel.length);
      }, 0)
    : 0;

  return (
    <>
      {viewerItem && (
        <ItemViewer
          environment={environment}
          scope={viewerItem.scope}
          item={viewerItem.item}
          onClose={() => setViewerItem(null)}
        />
      )}

      <div className="rounded-md border border-slate-200 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between gap-2 px-3 py-2 bg-slate-50 border-b border-slate-200">
          <span className="text-xs font-medium text-slate-700 shrink-0">Items to Promote</span>
          <div className="flex items-center gap-2 min-w-0">
            {environments.length > 1 && (
              <div className="flex items-center gap-1 shrink-0">
                <span className="text-[10px] text-slate-400">Browse:</span>
                <select
                  value={browseEnv}
                  onChange={(e) => setBrowseEnv(e.target.value)}
                  className="text-[11px] rounded border border-slate-300 px-1.5 py-0.5 bg-white focus:outline-none focus:ring-1 focus:ring-sky-500"
                >
                  {environments.map((env) => (
                    <option key={env.name} value={env.name}>{env.label}</option>
                  ))}
                </select>
                {browseEnv !== environment && (
                  <button
                    type="button"
                    onClick={() => setBrowseEnv(environment)}
                    className="text-[10px] text-sky-600 hover:text-sky-800"
                    title="Reset to source environment"
                  >
                    ↩ source
                  </button>
                )}
              </div>
            )}
            {!loading && auditData && includedCount > 0 && (
              <span className="text-xs text-slate-400 tabular-nums shrink-0">
                {includedCount} scope{includedCount !== 1 ? "s" : ""} · {totalItems} item{totalItems !== 1 ? "s" : ""}
              </span>
            )}
            {!loading && auditData && includedCount === 0 && (
              <span className="text-xs text-slate-400 shrink-0">No scopes selected</span>
            )}
          </div>
        </div>

        {/* Body */}
        <div className="flex overflow-hidden" style={{ maxHeight: 460 }}>
          {/* Left nav */}
          <div className="w-52 shrink-0 border-r border-slate-200 flex flex-col bg-slate-50">
            <div className="px-2 py-1.5 border-b border-slate-200">
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search…"
                className="w-full text-[10px] px-2 py-1 rounded border border-slate-200 bg-white text-slate-700 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-sky-400"
              />
            </div>
            <div className="overflow-y-auto flex-1">
              {loading ? (
                Array.from({ length: 8 }).map((_, i) => (
                  <div key={i} className="h-7 mx-2 my-1 rounded bg-slate-200 animate-pulse" />
                ))
              ) : (() => {
                // Filter the audit entries by the active search query, then
                // bucket by CONFIG_SCOPES group so the nav mirrors the Browse
                // tab's grouped layout (small uppercase heading per group,
                // scope buttons underneath).
                const q = searchQuery.trim().toLowerCase();
                const visible = (sortedAuditData ?? []).filter((entry) => {
                  if (!q) return true;
                  if (scopeLabel(entry.scope).toLowerCase().includes(q)) return true;
                  return entry.items.some((i) => i.label.toLowerCase().includes(q) || i.id.toLowerCase().includes(q));
                });
                const byGroup = new Map<string, AuditEntry[]>();
                for (const entry of visible) {
                  const g = scopeGroup(entry.scope);
                  if (!byGroup.has(g)) byGroup.set(g, []);
                  byGroup.get(g)!.push(entry);
                }
                return SCOPE_GROUPS.filter((g) => byGroup.has(g)).map((group) => {
                  const entries = byGroup.get(group)!;
                  return (
                    <div key={group}>
                      <p className="px-2 pt-2 pb-0.5 text-[9px] font-semibold text-slate-400 uppercase tracking-wider">
                        {group}
                      </p>
                      {entries.map((entry) => {
                        const included = Object.prototype.hasOwnProperty.call(selections, entry.scope);
                        return (
                          <button
                            key={entry.scope}
                            type="button"
                            onClick={() => scrollToScope(entry.scope)}
                            className={cn(
                              "w-full text-left px-2.5 py-1.5 text-[11px] leading-tight transition-colors border-l-2 flex items-center justify-between gap-1.5",
                              activeScope === entry.scope
                                ? "border-sky-500 bg-sky-50 text-sky-700 font-medium"
                                : included
                                  ? "border-transparent text-slate-700 hover:bg-slate-100"
                                  : "border-transparent text-slate-400 hover:bg-slate-100 hover:text-slate-500"
                            )}
                          >
                            <span className="truncate">{scopeLabel(entry.scope)}</span>
                            {included && (
                              <span className="shrink-0 w-1.5 h-1.5 rounded-full bg-indigo-500" title="Included in this task" />
                            )}
                          </button>
                        );
                      })}
                    </div>
                  );
                });
              })()}
            </div>
          </div>

          {/* Scope rows */}
          <div ref={contentRef} className="flex-1 overflow-y-auto divide-y divide-slate-100 min-w-0">
            {loading
              ? Array.from({ length: 6 }).map((_, i) => (
                  <div key={i} className="flex items-center gap-3 px-3 py-2.5 animate-pulse">
                    <div className="w-3.5 h-3.5 rounded bg-slate-200 shrink-0" />
                    <div className="h-3 flex-1 bg-slate-100 rounded" />
                  </div>
                ))
              : (sortedAuditData ?? [])
                  .filter((entry) => {
                    if (!searchQuery.trim()) return true;
                    const q = searchQuery.toLowerCase();
                    if (scopeLabel(entry.scope).toLowerCase().includes(q)) return true;
                    return entry.items.some((i) => i.label.toLowerCase().includes(q) || i.id.toLowerCase().includes(q));
                  })
                  .map((entry) => (
                  <div
                    key={entry.scope}
                    data-scope={entry.scope}
                    ref={(el) => { scopeRefs.current[entry.scope] = el; }}
                  >
                    <ScopeRow
                      entry={entry}
                      included={Object.prototype.hasOwnProperty.call(selections, entry.scope)}
                      selectedItems={selections[entry.scope] ?? null}
                      onToggleScope={(v) => handleScopeToggle(entry.scope as ConfigScope, v)}
                      onToggleItem={(item, checked) => handleItemToggle(entry.scope as ConfigScope, item, checked)}
                      onViewItem={(item) => setViewerItem({ scope: entry.scope, item })}
                    />
                  </div>
                ))
            }
          </div>
        </div>
      </div>
    </>
  );
}
