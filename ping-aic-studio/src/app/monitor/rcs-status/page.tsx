import { RcsStatusMatrix } from "../../rcs-status/RcsStatusMatrix";

export default function RcsStatusTabPage() {
    return (
        <div className="space-y-4">
            <p className="text-slate-500 text-sm">
                Health of Remote Connector Server clusters across environments. Results are on-demand — click Refresh or Check all.
            </p>
            <RcsStatusMatrix />
        </div>
    );
}
