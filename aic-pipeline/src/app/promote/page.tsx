import { getEnvironments } from "@/lib/fr-config";
import { readActiveTasks, readArchivedTasks } from "@/lib/promotion-tasks";
import { PromoteWorkflow } from "./PromoteWorkflow";

export default function PromotePage() {
  const environments = getEnvironments();
  const tasks = readActiveTasks();
  const archived = readArchivedTasks();
  return (
    <div className="space-y-6">
      <div>
        <h1 className="page-title">Promote Config</h1>
        <p className="section-subtitle mt-1">
          Manage promotion tasks and run workflow operations on Ping AIC tenants.
        </p>
      </div>
      <PromoteWorkflow environments={environments} initialTasks={tasks} initialArchived={archived} />
    </div>
  );
}
