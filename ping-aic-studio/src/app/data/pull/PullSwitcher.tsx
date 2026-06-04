"use client";

import { useState } from "react";
import { PullPanel } from "./PullPanel";
import { LogPullView } from "./LogPullView";
import type { Environment } from "@/lib/fr-config";

export function PullSwitcher({
    environments,
    typesByEnv,
}: {
    environments: Environment[];
    typesByEnv: Record<string, string[]>;
}) {
    const [mode, setMode] = useState<"managed" | "logs">("managed");
    return (
        <div className="space-y-4">
            <div className="inline-flex rounded-md border border-slate-300 overflow-hidden text-sm">
                {(["managed", "logs"] as const).map((m) => (
                    <button
                        key={m}
                        type="button"
                        onClick={() => setMode(m)}
                        className={`px-3 py-1.5 ${mode === m ? "bg-sky-600 text-white" : "bg-white text-slate-600 hover:bg-slate-50"}`}
                    >
                        {m === "managed" ? "Managed objects" : "Logs"}
                    </button>
                ))}
            </div>
            {mode === "managed"
                ? <PullPanel environments={environments} typesByEnv={typesByEnv} />
                : <LogPullView environments={environments} />}
        </div>
    );
}
