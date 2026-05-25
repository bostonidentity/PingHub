import { getEnvironments } from "@/lib/fr-config";
import { AnalyzePanel } from "./AnalyzePanel";

export default function AnalyzePage() {
  const environments = getEnvironments();
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Analyze</h1>
        <p className="text-slate-500 mt-1">
          Explore journey dependency relationships and config usage patterns.
        </p>
      </div>
      <AnalyzePanel environments={environments} />
    </div>
  );
}
