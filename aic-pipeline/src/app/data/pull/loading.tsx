export default function Loading() {
    return (
        <div className="space-y-4 animate-pulse">
            <div className="flex items-end gap-3">
                <div className="flex flex-col gap-1">
                    <div className="h-3 w-20 bg-slate-200 rounded" />
                    <div className="h-8 w-44 bg-slate-200 rounded" />
                </div>
            </div>
            <div className="flex flex-wrap gap-2 pb-2">
                {Array.from({ length: 8 }, (_, i) => (
                    <div key={i} className="h-7 w-32 bg-slate-200 rounded" />
                ))}
            </div>
            <div className="bg-white border border-slate-200 rounded-lg h-[400px]" />
        </div>
    );
}
