export default function Loading() {
    return (
        <div className="space-y-6 animate-pulse">
            <div>
                <div className="h-7 w-48 bg-slate-200 rounded" />
                <div className="h-4 w-72 bg-slate-200 rounded mt-2" />
            </div>
            <div className="bg-white border border-slate-200 rounded-lg h-[500px]" />
        </div>
    );
}
