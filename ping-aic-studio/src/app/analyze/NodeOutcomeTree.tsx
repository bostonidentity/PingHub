"use client";

import { useMemo, useState, type ReactNode } from "react";
import type { NodeStructure, NodeOutcomeStat, TreeEdge } from "@/lib/reports/journey-history";

/** Map-key separator — must not occur in tree/node names. */
const K = (...parts: string[]) => parts.join(String.fromCharCode(0));

/** Outcome breakdown bars for one node (count + % of its visits). */
function OutcomeBars({ outcomes, visits }: { outcomes: Record<string, number>; visits: number }) {
    const rows = Object.entries(outcomes).sort((a, b) => b[1] - a[1]);
    const palette = ["bg-violet-500", "bg-sky-500", "bg-emerald-600", "bg-amber-600", "bg-rose-600", "bg-cyan-600", "bg-indigo-500"];
    return (
        <div className="space-y-1">
            {rows.map(([value, count], i) => {
                const pct = visits ? Math.round((count / visits) * 100) : 0;
                return (
                    <div key={value} className="flex items-center gap-2 text-xs">
                        <span className="w-40 truncate text-slate-700" title={value}>{value}</span>
                        <span className="flex-1 h-3.5 rounded bg-slate-100 overflow-hidden">
                            <span className={`block h-full rounded ${palette[i % palette.length]}`} style={{ width: `${pct}%` }} />
                        </span>
                        <span className="w-24 text-right tabular-nums text-slate-500">{count.toLocaleString()} · {pct}%</span>
                    </div>
                );
            })}
        </div>
    );
}

type Built = {
    childrenOf: Map<string, TreeEdge[]>;        // treeName -> inner-tree edges
    plainNodesOf: Map<string, NodeOutcomeStat[]>; // treeName -> nodes (excl. evaluators)
    nodeByKey: Map<string, NodeOutcomeStat>;     // treeName\0nodeName -> stat
    roots: string[];
    parentCount: Map<string, number>;            // child treeName -> distinct parents
};

function build(structure: NodeStructure): Built {
    const childrenOf = new Map<string, TreeEdge[]>();
    const parents = new Map<string, Set<string>>();
    for (const e of structure.edges) {
        (childrenOf.get(e.parent) ?? childrenOf.set(e.parent, []).get(e.parent)!).push(e);
        (parents.get(e.child) ?? parents.set(e.child, new Set()).get(e.child)!).add(e.parent);
    }
    const plainNodesOf = new Map<string, NodeOutcomeStat[]>();
    const nodeByKey = new Map<string, NodeOutcomeStat>();
    for (const n of structure.nodes) {
        nodeByKey.set(K(n.treeName, n.nodeName), n);
        if (n.evaluatorForTree) continue; // rendered as the inner-tree row instead
        (plainNodesOf.get(n.treeName) ?? plainNodesOf.set(n.treeName, []).get(n.treeName)!).push(n);
    }
    for (const list of plainNodesOf.values()) list.sort((a, b) => b.visits - a.visits);
    for (const list of childrenOf.values()) list.sort((a, b) => b.invocations - a.invocations);

    const childSet = new Set(structure.edges.map((e) => e.child));
    const allTrees = new Set<string>();
    structure.nodes.forEach((n) => allTrees.add(n.treeName));
    structure.edges.forEach((e) => { allTrees.add(e.parent); allTrees.add(e.child); });
    const roots = structure.outerTrees.length
        ? [...structure.outerTrees]
        : [...allTrees].filter((t) => !childSet.has(t));

    const parentCount = new Map<string, number>();
    for (const [child, set] of parents) parentCount.set(child, set.size);
    return { childrenOf, plainNodesOf, nodeByKey, roots, parentCount };
}

/** Does this tree, or any descendant tree/node, match the query? (cycle-safe) */
function treeMatches(tree: string, q: string, b: Built, seen: Set<string>): boolean {
    if (!q) return true;
    if (tree.toLowerCase().includes(q)) return true;
    if (seen.has(tree)) return false;
    seen.add(tree);
    for (const n of b.plainNodesOf.get(tree) ?? []) if (n.displayName.toLowerCase().includes(q)) return true;
    for (const e of b.childrenOf.get(tree) ?? []) if (treeMatches(e.child, q, b, seen)) return true;
    return false;
}

export function NodeOutcomeTree({ structure }: { structure: NodeStructure }) {
    const b = useMemo(() => build(structure), [structure]);
    // Roots expanded by default. Keys must match renderTree/renderNode exactly:
    // a tree at K(parentKey, "t", name); a node at K(treeKey, "n", nodeName).
    const [open, setOpen] = useState<Set<string>>(() => new Set(b.roots.map((t) => K("root", "t", t))));
    const [query, setQuery] = useState("");
    const q = query.trim().toLowerCase();

    const toggle = (key: string) => setOpen((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key); else next.add(key);
        return next;
    });
    const setAll = (expand: boolean) => {
        if (!expand) { setOpen(new Set()); return; }
        const keys = new Set<string>();
        // Expand every tree row AND every node's outcome breakdown.
        const walk = (tree: string, treeKey: string, seen: Set<string>) => {
            keys.add(treeKey);
            for (const n of b.plainNodesOf.get(tree) ?? []) keys.add(K(treeKey, "n", n.nodeName));
            if (seen.has(tree)) return;
            const s = new Set(seen); s.add(tree);
            for (const e of b.childrenOf.get(tree) ?? []) walk(e.child, K(treeKey, "t", e.child), s);
        };
        for (const r of b.roots) walk(r, K("root", "t", r), new Set());
        setOpen(keys);
    };

    const Row = ({ children, depth, onClick, caret }: { children: ReactNode; depth: number; onClick?: () => void; caret: string }) => (
        <div
            className={`flex items-center gap-2 px-3 py-1.5 border-b border-slate-50 ${onClick ? "cursor-pointer hover:bg-slate-50" : ""}`}
            style={{ paddingLeft: 12 + depth * 18 }}
            onClick={onClick}
        >
            <span className="w-3 text-slate-400 text-[10px]">{caret}</span>
            {children}
        </div>
    );

    // Render an inner-tree (or root) and its subtree. `pathKey` makes the same
    // reused subtree independently collapsible under different parents.
    const renderTree = (tree: string, depth: number, pathKey: string, ancestors: Set<string>, edge?: TreeEdge): ReactNode => {
        const key = K(pathKey, "t", tree);
        const isRoot = depth === 0;
        const expanded = open.has(key) || !!q;
        const cyclic = ancestors.has(tree);
        const reused = (b.parentCount.get(tree) ?? 0) > 1;
        const evalNode = edge?.evaluatorNodeName ? b.nodeByKey.get(K(edge.parent, edge.evaluatorNodeName)) : undefined;

        const header = (
            <Row depth={depth} caret={cyclic ? "" : expanded ? "▾" : "▸"} onClick={cyclic ? undefined : () => toggle(key)}>
                <span>{isRoot ? "🗂️" : "🌳"}</span>
                <span className="font-semibold text-slate-800">{tree}</span>
                <span className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded ${isRoot ? "bg-violet-50 text-violet-700" : "bg-amber-50 text-amber-700"}`}>
                    {isRoot ? "outer" : "inner"}
                </span>
                {reused && !isRoot ? <span className="text-[10px] italic text-amber-700">· reused</span> : null}
                {cyclic ? <span className="text-[10px] italic text-slate-400">↻ shown above</span> : null}
                {edge ? <span className="ml-auto text-xs tabular-nums text-slate-500">{edge.invocations.toLocaleString()}×</span> : null}
            </Row>
        );

        if (cyclic || !expanded) return <div key={key}>{header}</div>;

        const childTrees = b.childrenOf.get(tree) ?? [];
        const nodes = b.plainNodesOf.get(tree) ?? [];
        const nextAnc = new Set(ancestors); nextAnc.add(tree);

        return (
            <div key={key}>
                {header}
                {evalNode ? (
                    <div className="border-b border-slate-50 bg-violet-50/40" style={{ paddingLeft: 12 + (depth + 1) * 18 + 16, paddingRight: 12, paddingTop: 6, paddingBottom: 8 }}>
                        <div className="text-[10px] uppercase tracking-wide text-slate-500 mb-1">
                            Evaluator outcome · <span className="font-mono">{evalNode.displayName}</span> <span className="italic normal-case">(best-effort link)</span>
                        </div>
                        <OutcomeBars outcomes={evalNode.outcomes} visits={evalNode.visits} />
                    </div>
                ) : null}
                {nodes.filter((n) => !q || n.displayName.toLowerCase().includes(q) || tree.toLowerCase().includes(q)).map((n) => renderNode(n, depth + 1, key))}
                {childTrees.filter((e) => treeMatches(e.child, q, b, new Set())).map((e) => renderTree(e.child, depth + 1, key, nextAnc, e))}
            </div>
        );
    };

    const renderNode = (n: NodeOutcomeStat, depth: number, pathKey: string): ReactNode => {
        const key = K(pathKey, "n", n.nodeName);
        const expanded = open.has(key);
        return (
            <div key={key}>
                <Row depth={depth} caret={expanded ? "▾" : "▸"} onClick={() => toggle(key)}>
                    <span className="text-slate-300">•</span>
                    <span className="text-slate-800">{n.displayName}</span>
                    <span className="ml-auto text-xs tabular-nums text-slate-500">{n.visits.toLocaleString()} visits</span>
                </Row>
                {expanded ? (
                    <div className="border-b border-slate-50 bg-slate-50/60" style={{ paddingLeft: 12 + (depth + 1) * 18 + 16, paddingRight: 12, paddingTop: 6, paddingBottom: 8 }}>
                        <OutcomeBars outcomes={n.outcomes} visits={n.visits} />
                    </div>
                ) : null}
            </div>
        );
    };

    return (
        <div className="rounded-md border border-slate-200 bg-white">
            <div className="px-4 py-2 border-b border-slate-200 flex items-center gap-3 flex-wrap">
                <h3 className="text-sm font-semibold text-slate-700">Node outcomes</h3>
                <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Filter nodes / journeys…"
                    className="flex-1 min-w-[180px] px-2 py-1 text-xs border border-slate-300 rounded"
                />
                <button type="button" onClick={() => setAll(true)} className="text-xs font-medium text-violet-700 hover:underline">Expand all</button>
                <button type="button" onClick={() => setAll(false)} className="text-xs font-medium text-violet-700 hover:underline">Collapse all</button>
            </div>
            <div className="max-h-[520px] overflow-y-auto text-sm">
                {b.roots.filter((t) => treeMatches(t, q, b, new Set())).map((t) => renderTree(t, 0, "root", new Set()))}
                {b.roots.length === 0 ? <div className="px-4 py-6 text-center text-slate-500 text-xs">No node data in this report.</div> : null}
            </div>
        </div>
    );
}
