import { ServerStatusView } from "./ServerStatusView";

export default function ServerStatusPage() {
    return (
        <div className="space-y-4">
            <p className="text-slate-500 text-sm">
                Configurable HTTP health checks. Add URLs grouped by category and check them on-demand or via auto-refresh.
            </p>
            <ServerStatusView />
        </div>
    );
}
