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

function DepRow({ node, root, depth, checked, onToggle }: {
    node: JourneyDepNode; root: string; depth: number; checked: Set<string>; onToggle: (name: string) => void;
}) {
    const selectable = !node.missing && node.name !== root;
    return (
        <>
            <label
                className={`flex items-center gap-2 text-xs ${node.missing ? "text-slate-400" : "text-slate-700"}`}
                style={{ paddingLeft: depth * 16 }}
            >
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
                </span>
            </label>
            {node.children.map((c) => (
                <DepRow key={`${node.name}>${c.name}`} node={c} root={root} depth={depth + 1} checked={checked} onToggle={onToggle} />
            ))}
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
export function JourneyDepPicker({ env, parents, checked, onChange }: {
    env: string;
    parents: string[];
    checked: string[];
    onChange: (next: string[]) => void;
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

    const sections = parents.filter((parent) => (trees[parent]?.children.length ?? 0) > 0);
    if (sections.length === 0) return null;

    return (
        <div className="space-y-2 rounded border border-slate-200 bg-white px-3 py-2">
            {sections.map((parent) => {
                const tree = trees[parent]!;
                const names = selectableNames(tree);
                const allOn = names.length > 0 && names.every((n) => checkedSet.has(n));
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
                        </div>
                        {tree.children.map((c) => (
                            <DepRow key={`${parent}>${c.name}`} node={c} root={parent} depth={0} checked={checkedSet} onToggle={toggle} />
                        ))}
                    </div>
                );
            })}
            <p className="text-[11px] text-slate-500">
                Checked inner journeys are pulled with the report so their nodes can nest under the parent&apos;s evaluator rows.
            </p>
        </div>
    );
}
