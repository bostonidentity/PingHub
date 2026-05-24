// src/core/push/pushPromotionTask.ts
import type { TokenCache } from "../aic/auth";
import type { TaskItem } from "../db/promotionTasks";
import { pushJourneyFromSnapshot } from "./pushJourney";
import { pushFederationFromSnapshot } from "./pushFederation";

export interface PushTaskParams {
  globalStoragePath: string;
  sourceEnvName: string;
  targetTenantUrl: string;
  targetTokenCache: TokenCache;
  items: TaskItem[];
}

export interface ItemFailure {
  item: TaskItem;
  error: string;
}

export interface PushTaskSummary {
  successCount: number;
  failureCount: number;
  skippedCount: number;
  failures: ItemFailure[];
}

export async function pushPromotionTask(params: PushTaskParams): Promise<PushTaskSummary> {
  let successCount = 0;
  let skippedCount = 0;
  const failures: ItemFailure[] = [];

  for (const item of params.items) {
    if (item.resourceType === "journey") {
      try {
        await pushJourneyFromSnapshot({
          globalStoragePath: params.globalStoragePath,
          sourceEnvName: params.sourceEnvName,
          targetTenantUrl: params.targetTenantUrl,
          targetTokenCache: params.targetTokenCache,
          realm: item.realm,
          journeyId: item.resourceId
        });
        successCount += 1;
      } catch (err) {
        failures.push({
          item,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    } else if (item.resourceType.startsWith("federation/")) {
      const type = item.resourceType.slice("federation/".length);
      try {
        await pushFederationFromSnapshot({
          globalStoragePath: params.globalStoragePath,
          sourceEnvName: params.sourceEnvName,
          targetTenantUrl: params.targetTenantUrl,
          targetTokenCache: params.targetTokenCache,
          realm: item.realm,
          type,
          id: item.resourceId
        });
        successCount += 1;
      } catch (err) {
        failures.push({
          item,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    } else {
      skippedCount += 1;
    }
  }

  return { successCount, failureCount: failures.length, skippedCount, failures };
}
