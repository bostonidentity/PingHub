export default function Loading() {
    return (
        <div className="space-y-6">
            <header>
                <h1 className="page-title">Browse</h1>
                <p className="section-subtitle mt-1">Explore the pulled configuration tree.</p>
            </header>
            <div className="animate-pulse">
                {/* Env selector + scope filter bar */}
                <div className="flex items-center gap-3 mb-4">
                    <div className="h-8 w-44 bg-slate-200 rounded" />
                    <div className="h-8 w-32 bg-slate-200 rounded" />
                </div>
                {/* Two-panel layout */}
                <div className="flex gap-6">
                    {/* Left panel skeleton */}
                    <div className="w-72 shrink-0 bg-white rounded-lg border border-slate-200 overflow-hidden">
                        <div className="px-3 py-2 border-b border-slate-100">
                            <div className="h-3 w-48 bg-slate-200 rounded" />
                        </div>
                        <div className="p-2 space-y-1.5">
                            {Array.from({ length: 12 }, (_, i) => (
                                <div key={i} className="h-5 bg-slate-100 rounded" style={{ width: `${60 + (i % 3) * 15}%` }} />
                            ))}
                        </div>
                    </div>
                    {/* Right panel skeleton */}
                    <div className="flex-1 bg-slate-900 rounded-lg border border-slate-200 min-h-[500px]" />
                </div>
            </div>
        </div>
    );
}
