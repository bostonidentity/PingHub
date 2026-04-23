export default function Loading() {
    return (
        <div className="space-y-4 animate-pulse">
            <div className="flex items-end gap-3">
                <div className="flex flex-col gap-1">
                    <div className="h-3 w-20 bg-slate-200 rounded" />
                    <div className="h-8 w-44 bg-slate-200 rounded" />
                </div>
                <div className="flex-1 min-w-[240px] flex flex-col gap-1">
                    <div className="h-3 w-28 bg-slate-200 rounded" />
                    <div className="h-8 bg-slate-200 rounded" />
                </div>
            </div>
            <div className="flex flex-wrap gap-1 pb-2">
                {Array.from({ length: 6 }, (_, i) => (
                    <div key={i} className="h-7 w-28 bg-slate-200 rounded" />
                ))}
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] gap-4">
                <div className="bg-white border border-slate-200 rounded-lg h-[500px]" />
                <div className="bg-white border border-slate-200 rounded-lg h-[500px]" />
            </div>
        </div>
    );
}
