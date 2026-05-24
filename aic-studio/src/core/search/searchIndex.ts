// src/core/search/searchIndex.ts
import type { Database } from "better-sqlite3";
import { listEnvironments } from "../db/environments";
import { listActiveTasks } from "../db/promotionTasks";
import {
  listRealmsInLatest,
  listJourneysInLatest,
  listFederationTypesInLatest,
  listFederationIdsInLatest
} from "../snapshots/reader";

export interface SearchItem {
  label: string;
  detail: string;
  kind: "env" | "journey" | "federation" | "promotionTask";
  uri?: string;
  taskId?: number;
}

export function buildSearchIndex(db: Database, globalStoragePath: string): SearchItem[] {
  const items: SearchItem[] = [];
  for (const env of listEnvironments(db)) {
    items.push({ label: env.label, detail: env.name, kind: "env" });
    for (const realm of listRealmsInLatest(globalStoragePath, env.name)) {
      for (const jid of listJourneysInLatest(globalStoragePath, env.name, realm)) {
        items.push({
          label: jid,
          detail: `${env.name} · ${realm} · journey`,
          kind: "journey",
          uri: `aic://${env.name}/${realm}/journey/${jid}`
        });
      }
      for (const type of listFederationTypesInLatest(globalStoragePath, env.name, realm)) {
        for (const fid of listFederationIdsInLatest(globalStoragePath, env.name, realm, type)) {
          items.push({
            label: fid,
            detail: `${env.name} · ${realm} · ${type}`,
            kind: "federation",
            uri: `aic://${env.name}/${realm}/federation/${type}/${fid}`
          });
        }
      }
    }
  }
  for (const t of listActiveTasks(db)) {
    items.push({
      label: t.name,
      detail: `promotion task · from ${t.sourceEnv}`,
      kind: "promotionTask",
      taskId: t.id
    });
  }
  return items;
}

export function queryIndex(index: SearchItem[], q: string): SearchItem[] {
  if (!q) return index;
  const norm = q.toLowerCase();
  return index.filter((i) =>
    i.label.toLowerCase().includes(norm) ||
    i.detail.toLowerCase().includes(norm)
  );
}
