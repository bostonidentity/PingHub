"use client";

import { useEffect, useMemo, useRef, useState } from "react";

export interface JourneyDepNode {
    name: string;
    children: JourneyDepNode[];
    missing?: true;
    repeated?: true;
}

/** Selectable (non-missing) names in a dep tree, excluding the root journey. */
function selectableNames(root: JourneyDepNode): string[] {
    const out = new Set<string>();
    const walk = (n: JourneyDepNode) => {
        if (!n.missing && n.name !== root.name) out.add(n.name);
        for (const c of n.children) walk(c);
    };
    for (const c of root.children) walk(c);
    return [...out];
}

/** Paths (rooted at the section's parent journey) of every branch row — i.e.
 *  nodes with children — under `root`. These are the keys expand/collapse uses. */
function branchPaths(root: JourneyDepNode, rootPath: string): string[] {
    const out: string[] = [];
    const walk = (n: JourneyDepNode, path: string) => {
        if (n.children.length === 0) return;
        out.push(path);
        for (const c of n.children) walk(c, `${path}>${c.name}`);
    };
    for (const c of root.children) walk(c, `${rootPath}>${c.name}`);
    return out;
}

/** Distinct checked names hidden below `node` (its own checkbox excluded). */
function checkedDescendants(node: JourneyDepNode, root: string, checked: Set<string>): number {
    const names = new Set<string>();
    const walk = (n: JourneyDepNode) => {
        for (const c of n.children) {
            if (!c.missing && c.name !== root && checked.has(c.name)) names.add(c.name);
            walk(c);
        }
    };
    walk(node);
    return names.size;
}

function DepRow({ node, root, path, depth, checked, open, onToggle, onToggleBranch }: {
    node: JourneyDepNode; root: string; path: string; depth: number;
    checked: Set<string>; open: Set<string>;
    onToggle: (name: string) => void; onToggleBranch: (path: string) => void;
}) {
    const selectable = !node.missing && node.name !== root;
    const hasChildren = node.children.length > 0;
    const expanded = open.has(path);
    const hiddenChecked = hasChildren && !expanded ? checkedDescendants(node, root, checked) : 0;
    return (
        <>
            <div className="flex items-center gap-2" style={{ paddingLeft: depth * 16 }}>
                {hasChildren ? (
                    <button
                        type="button"
                        className="w-3 text-slate-400 text-[10px]"
                        aria-label={expanded ? `Collapse ${node.name}` : `Expand ${node.name}`}
                        onClick={() => onToggleBranch(path)}
                    >
                        {expanded ? "▾" : "▸"}
                    </button>
                ) : <span className="w-3" />}
                <label className={`flex items-center gap-2 text-xs ${node.missing ? "text-slate-400" : "text-slate-700"}`}>
                    <input
                        type="checkbox"
                        className="accent-sky-600"
                        disabled={!selectable}
                        checked={checked.has(node.name)}
                        onChange={() => onToggle(node.name)}
                    />
                    <span>
                        {node.name}
                        {node.missing ? " (not in config)" : node.repeated ? " (repeated)" : ""}
                        {hiddenChecked > 0 ? <span className="text-sky-700"> · {hiddenChecked} selected</span> : null}
                    </span>
                </label>
            </div>
            {expanded ? node.children.map((c) => (
                <DepRow
                    key={`${node.name}>${c.name}`} node={c} root={root} path={`${path}>${c.name}`} depth={depth + 1}
                    checked={checked} open={open} onToggle={onToggle} onToggleBranch={onToggleBranch}
                />
            )) : null}
        </>
    );
}

/**
 * Inner-journey checklist for the Journey History report. For each selected
 * journey, shows its inner-journey closure (resolved from pulled config) as an
 * indented checkbox tree. Checked names are pulled along with the parents —
 * a journey filter otherwise hides inner journeys' events, because inner trees
 * log under their own treeName (docs/journey-report-node-outcomes.md §3.5).
 */
export function JourneyDepPicker({ env, parents, checked, onChange, excludedParents, onExcludedChange }: {
    env: string;
    parents: string[];
    checked: string[];
    onChange: (next: string[]) => void;
    /** Selected parents whose own events are excluded from the pull. */
    excludedParents: string[];
    /** Replace the excluded-parents list (same replace-wholesale contract as onChange). */
    onExcludedChange: (next: string[]) => void;
}) {
    // parent journey → its dep tree (absent while loading/failed). State is
    // keyed by env so a tenant switch starts from an empty map without a
    // synchronous reset effect.
    const [treesByEnv, setTreesByEnv] = useState<{ env: string; trees: Record<string, JourneyDepNode> }>(
        { env, trees: {} },
    );
    const trees = useMemo<Record<string, JourneyDepNode>>(
        () => (treesByEnv.env === env ? treesByEnv.trees : {}),
        [treesByEnv, env],
    );
    // Parents already requested for the current env. A ref (not state) so the
    // fetch effect doesn't depend on its own writes; replaced wholesale on env
    // change, which also marks any still-pending fetches as stale.
    const requestedRef = useRef<{ env: string; names: Set<string> }>({ env, names: new Set() });

    useEffect(() => {
        if (requestedRef.current.env !== env) requestedRef.current = { env, names: new Set() };
        const requested = requestedRef.current;
        for (const parent of parents) {
            if (requested.names.has(parent)) continue;
            requested.names.add(parent);
            fetch(`/api/analyze/journey-deps?env=${encodeURIComponent(env)}&journey=${encodeURIComponent(parent)}`)
                .then((r) => (r.ok ? r.json() : null))
                .then((d: { tree: JourneyDepNode } | null) => {
                    // Apply only if this request set is still current (env unchanged).
                    if (requestedRef.current !== requested || !d?.tree) return;
                    setTreesByEnv((s) => ({ env, trees: { ...(s.env === env ? s.trees : {}), [parent]: d.tree } }));
                })
                .catch(() => { /* tree stays absent — section simply doesn't render */ });
        }
    }, [env, parents]);

    const checkedSet = useMemo(() => new Set(checked), [checked]);
    // Names allowed to stay checked: union of current parents' closures.
    const allowed = useMemo(() => {
        const out = new Set<string>();
        for (const parent of parents) {
            const tree = trees[parent];
            if (tree) for (const n of selectableNames(tree)) out.add(n);
        }
        return out;
    }, [parents, trees]);

    // Drop checked entries whose parent journey was deselected.
    useEffect(() => {
        const pruned = checked.filter((c) => allowed.has(c));
        if (pruned.length !== checked.length) onChange(pruned);
    }, [allowed, checked, onChange]);

    const toggle = (name: string) => {
        onChange(checkedSet.has(name) ? checked.filter((c) => c !== name) : [...checked, name]);
    };

    const excludedSet = useMemo(() => new Set(excludedParents), [excludedParents]);
    const toggleParent = (name: string) => {
        onExcludedChange(excludedSet.has(name) ? excludedParents.filter((p) => p !== name) : [...excludedParents, name]);
    };

    // Expanded branch rows, keyed by path from the section's parent journey —
    // path-keyed so a reused inner journey collapses independently per branch.
    // Collapsed by default (first level is always visible). Ephemeral.
    const [openBranches, setOpenBranches] = useState<Set<string>>(new Set());
    const toggleBranch = (path: string) => setOpenBranches((prev) => {
        const next = new Set(prev);
        if (next.has(path)) next.delete(path); else next.add(path);
        return next;
    });

    const sections = parents.filter((parent) => (trees[parent]?.children.length ?? 0) > 0);
    if (sections.length === 0) return null;

    return (
        <div className="space-y-2 rounded border border-slate-200 bg-white px-3 py-2">
            {sections.map((parent) => {
                const tree = trees[parent]!;
                const names = selectableNames(tree);
                const allOn = names.length > 0 && names.every((n) => checkedSet.has(n));
                const branches = branchPaths(tree, parent);
                const allExpanded = branches.length > 0 && branches.every((p) => openBranches.has(p));
                return (
                    <div key={parent} className="space-y-1">
                        <div className="flex items-center gap-2">
                            <span className="text-xs font-semibold text-slate-600">Inner journeys of {parent}</span>
                            <button
                                type="button"
                                className="text-[11px] text-sky-700 hover:underline"
                                onClick={() => onChange(allOn
                                    ? checked.filter((c) => !names.includes(c))
                                    : [...new Set([...checked, ...names])])}
                            >
                                {allOn ? "Clear" : "Select all"}
                            </button>
                            {branches.length > 0 ? (
                                <button
                                    type="button"
                                    className="text-[11px] text-sky-700 hover:underline"
                                    onClick={() => setOpenBranches((prev) => {
                                        const next = new Set(prev);
                                        for (const p of branches) { if (allExpanded) next.delete(p); else next.add(p); }
                                        return next;
                                    })}
                                >
                                    {allExpanded ? "Collapse all" : "Expand all"}
                                </button>
                            ) : null}
                        </div>
                        {/* Layout mirrors DepRow's depth-0 row so the parent aligns with its children. */}
                        <div className="flex items-center gap-2">
                            <span className="w-3" />
                            <label className="flex items-center gap-2 text-xs text-slate-700">
                                <input
                                    type="checkbox"
                                    className="accent-sky-600"
                                    checked={!excludedSet.has(parent)}
                                    onChange={() => toggleParent(parent)}
                                />
                                <span>
                                    {parent}
                                    <span className="text-slate-500"> (include this journey&apos;s own events)</span>
                                </span>
                            </label>
                        </div>
                        {tree.children.map((c) => (
                            <DepRow
                                key={`${parent}>${c.name}`} node={c} root={parent} path={`${parent}>${c.name}`} depth={0}
                                checked={checkedSet} open={openBranches} onToggle={toggle} onToggleBranch={toggleBranch}
                            />
                        ))}
                    </div>
                );
            })}
            <p className="text-[11px] text-slate-500">
                Checked inner journeys are pulled with the report so their nodes can nest under the parent&apos;s evaluator rows.
                An unchecked parent is used for structure and picking only — its own events are not pulled.
            </p>
        </div>
    );
}
