export type Category =
  | "journey"
  | "script-library"
  | "script-library-config"
  | "custom-endpoint"
  | "workflow"
  | "iga-assignment"
  | "iga-form"
  | "managed-object-config"
  | "sync-mapping"
  | "scheduler"
  | "internal-role"
  | "access-config"
  | "connector-agent"
  | "other";

const CATEGORY_TABLE: { test: RegExp; category: Exclude<Category, "other"> }[] = [
  { test: /(?:^|\/)(?:[^/]+\/)?journeys\/.+\.json$/, category: "journey" },
  { test: /(?:^|\/)(?:[^/]+\/)?scripts\/scripts-content\/.+\.js$/, category: "script-library" },
  { test: /(?:^|\/)(?:[^/]+\/)?scripts\/scripts-config\/.+\.json$/, category: "script-library-config" },
  { test: /(?:^|\/)endpoints\/.+\.(?:json|js)$/, category: "custom-endpoint" },
  { test: /(?:^|\/)iga\/workflows\/.+\.json$/, category: "workflow" },
  { test: /(?:^|\/)iga\/assignments\/.+\.json$/, category: "iga-assignment" },
  { test: /(?:^|\/)iga\/forms\/.+\.json$/, category: "iga-form" },
  { test: /(?:^|\/)(?:[^/]+\/)?managed-objects\/.+\.(?:json|js)$/, category: "managed-object-config" },
  { test: /(?:^|\/)sync\/mappings\/.+\.json$/, category: "sync-mapping" },
  { test: /(?:^|\/)schedules\/.+\.json$/, category: "scheduler" },
  { test: /(?:^|\/)internal-roles\/.+\.json$/, category: "internal-role" },
  { test: /(?:^|\/)access-config\//, category: "access-config" },
  { test: /(?:^|\/)agents\//, category: "connector-agent" },
];

export function categorizeFilePath(relPath: string): Category {
  const normalized = relPath.replace(/\\/g, "/");
  for (const row of CATEGORY_TABLE) {
    if (row.test.test(normalized)) return row.category;
  }
  return "other";
}

const FIELD_LOOKBACK_BYTES = 4096;

export function findNearestJsonFieldName(src: string, offset: number): string | null {
  const start = Math.max(0, offset - FIELD_LOOKBACK_BYTES);
  const window = src.slice(start, offset);
  const keyRe = /"([^"\\\n]{1,128})"\s*:/g;
  let lastKey: string | null = null;
  for (const m of window.matchAll(keyRe)) {
    lastKey = m[1];
  }
  return lastKey;
}
