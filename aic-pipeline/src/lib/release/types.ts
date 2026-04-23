export type ReleaseChannel = "regular" | "rapid";

export interface ReleaseInfo {
  channel: ReleaseChannel;
  currentVersion: string;
  nextUpgrade: string | null;
}

export interface ReleaseCacheEntry {
  fetchedAt: string;
  info?: ReleaseInfo;
  error?: string;
}

export type UpgradeUrgency = "unknown" | "later" | "soon" | "overdue";
