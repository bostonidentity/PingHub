export type JobStatus =
  | "queued"
  | "running"
  | "aborting"
  | "completed"
  | "failed"
  | "aborted";

export type PerTypeProgress = {
  type: string;
  status: "pending" | "running" | "done" | "failed";
  fetched: number;
  total: number | null;
  error?: string;
};

export type DataPullJob = {
  id: string;
  env: string;
  types: string[];
  startedAt: number;
  finishedAt?: number;
  status: JobStatus;
  progress: PerTypeProgress[];
  fatalError?: string;
};

export type DisplayFields = {
  title: string;
  searchFields: string[];
};

export type SnapshotType = {
  name: string;
  count: number;
  pulledAt: number;
};

export type SnapshotRecordListItem = {
  id: string;
  title: string;
};

export type SnapshotRecordPage = {
  total: number;
  page: number;
  limit: number;
  records: SnapshotRecordListItem[];
  /** Union of top-level keys sampled from the snapshot (for the display picker). */
  fields: string[];
};
