// src/lib/scheduler/types.ts
import type { ConfigScope } from "@/lib/fr-config";

export interface SyncStep { type: "sync"; environments: string[]; scopes: ConfigScope[]; }
export interface PullDataStep { type: "pull-data"; environments: string[]; managedObjects: string[]; }
export interface GitPushStep { type: "git-push"; message?: string; force?: boolean; }
export type Step = SyncStep | PullDataStep | GitPushStep;

export type Preset =
  | { every: "hour"; minute: number }
  | { every: "day"; time: string }            // "HH:mm"
  | { every: "week"; days: number[]; time: string }; // days: 0-6 (Sun=0)

export interface Trigger {
  kind: "preset" | "cron";
  preset?: Preset;
  cron?: string;
  timezone: string; // IANA tz
}

export interface ScheduleRunRef {
  at: string;
  status: "success" | "failed" | "partial" | "skipped-overlap";
  runId?: string;
}

export interface Schedule {
  id: string;
  name: string;
  enabled: boolean;
  trigger: Trigger;
  steps: Step[];
  onError: "stop" | "continue";
  catchUpIfMissed: boolean;
  lastRun?: ScheduleRunRef;
  nextRunAt: string;   // ISO
  createdAt: string;
  updatedAt: string;
}

/** Fields a client may send when creating/updating; server fills the rest. */
export interface ScheduleInput {
  name: string;
  enabled: boolean;
  trigger: Trigger;
  steps: Step[];
  onError: "stop" | "continue";
  catchUpIfMissed: boolean;
}
