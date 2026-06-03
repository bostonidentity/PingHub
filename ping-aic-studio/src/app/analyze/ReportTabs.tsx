"use client";

import { useState, type ReactNode } from "react";

type TabKey = "esv" | "journeys";

export function ReportTabs({ esvPanel, journeyPanel }: { esvPanel: ReactNode; journeyPanel: ReactNode }) {
    const [tab, setTab] = useState<TabKey>("journeys");
    return (
        <div className="space-y-4">
            <div className="border-b border-slate-200 flex gap-1">
                {([
                    { key: "journeys", label: "Journey execution history" },
                    { key: "esv", label: "ESV orphans" },
                ] as { key: TabKey; label: string }[]).map((t) => (
                    <button
                        key={t.key}
                        type="button"
                        onClick={() => setTab(t.key)}
                        className={
                            `px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${tab === t.key
                                ? "border-sky-600 text-sky-700"
                                : "border-transparent text-slate-600 hover:text-slate-800"
                            }`
                        }
                    >
                        {t.label}
                    </button>
                ))}
            </div>
            <div>{tab === "esv" ? esvPanel : journeyPanel}</div>
        </div>
    );
}
