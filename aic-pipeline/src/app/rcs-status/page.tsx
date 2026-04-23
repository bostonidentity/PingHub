import { RcsStatusMatrix } from "./RcsStatusMatrix";

export default function RcsStatusPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">RCS Status</h1>
        <p className="text-slate-500 mt-1">
          Health of Remote Connector Server clusters across environments. Results are on-demand — click Refresh or Check all.
        </p>
      </div>
      <RcsStatusMatrix />
    </div>
  );
}
