import { getEnvironments } from "@/lib/fr-config";
import { AnalyzePanel } from "./AnalyzePanel";
import { JourneyHistoryPanel } from "./JourneyHistoryPanel";
import { ReportTabs } from "./ReportTabs";

export default function AnalyzePage() {
  const environments = getEnvironments();
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Report</h1>
        <p className="text-slate-500 mt-1">
          Journey execution history and ESV orphan reference reports.
        </p>
      </div>
      <ReportTabs
        journeyPanel={<JourneyHistoryPanel environments={environments} />}
        esvPanel={<AnalyzePanel environments={environments} />}
      />
    </div>
  );
}
