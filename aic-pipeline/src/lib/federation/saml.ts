import { X509Certificate } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { parseEnvFile } from "@/lib/env-parser";
import { getAccessToken } from "@/lib/iga-api";
import { getConfigDir, getEnvFileContent } from "@/lib/fr-config";

export type SamlProviderLocation = "hosted" | "remote" | string;
export type SamlProviderSource = "live" | "local";
export type SamlCertStatus = "ok" | "warning" | "expired" | "unknown";

export interface SamlMetadataCert {
  subject: string;
  issuer: string;
  validFrom: string;
  validTo: string;
  daysRemaining: number;
  status: Exclude<SamlCertStatus, "unknown">;
  fingerprint256: string;
}

export interface SamlProviderSummary {
  id: string;
  entityId: string;
  location: SamlProviderLocation;
  realm: string;
  source: SamlProviderSource;
  displayName?: string;
  metadataCertStatus: SamlCertStatus;
  metadataCerts: SamlMetadataCert[];
  localPath?: string;
  hasLocalConfig?: boolean;
}

export interface SamlProviderDetail extends SamlProviderSummary {
  config: unknown | null;
  metadata: string | null;
}

interface SamlListResponse {
  result?: Array<Record<string, unknown>>;
}

const WARN_DAYS = 30;
const CRITICAL_DAYS = 7;

function envVarsFor(environment: string): Record<string, string> {
  return parseEnvFile(getEnvFileContent(environment));
}

function realmsFor(vars: Record<string, string>): string[] {
  if (!vars.REALMS) return ["alpha"];
  try {
    const parsed = JSON.parse(vars.REALMS);
    return Array.isArray(parsed) && parsed.length > 0 ? parsed.map(String) : ["alpha"];
  } catch {
    return vars.REALMS.split(",").map((s) => s.trim()).filter(Boolean);
  }
}

function requireTenantUrl(vars: Record<string, string>): string {
  const tenantUrl = vars.TENANT_BASE_URL?.replace(/\/$/, "");
  if (!tenantUrl) throw new Error("TENANT_BASE_URL is missing for this environment");
  return tenantUrl;
}

function certStatus(daysRemaining: number): Exclude<SamlCertStatus, "unknown"> {
  if (daysRemaining <= CRITICAL_DAYS) return "expired";
  if (daysRemaining <= WARN_DAYS) return "warning";
  return "ok";
}

function certTextToPem(raw: string): string {
  const compact = raw.replace(/\s+/g, "");
  const lines = compact.match(/.{1,64}/g)?.join("\n") ?? compact;
  return `-----BEGIN CERTIFICATE-----\n${lines}\n-----END CERTIFICATE-----`;
}

export function extractMetadataCerts(metadata: string | null | undefined): SamlMetadataCert[] {
  if (!metadata) return [];
  const matches = metadata.matchAll(/<[^>]*X509Certificate[^>]*>([\s\S]*?)<\/[^>]*X509Certificate>/gi);
  const certs: SamlMetadataCert[] = [];
  for (const match of matches) {
    try {
      const cert = new X509Certificate(certTextToPem(match[1]));
      const validToTime = new Date(cert.validTo).getTime();
      const daysRemaining = Math.floor((validToTime - Date.now()) / 86_400_000);
      certs.push({
        subject: cert.subject,
        issuer: cert.issuer,
        validFrom: new Date(cert.validFrom).toISOString(),
        validTo: new Date(cert.validTo).toISOString(),
        daysRemaining,
        status: certStatus(daysRemaining),
        fingerprint256: cert.fingerprint256,
      });
    } catch {
      // Ignore malformed cert blocks so a bad metadata document doesn't hide
      // the rest of the provider inventory.
    }
  }
  return certs;
}

export function aggregateCertStatus(certs: SamlMetadataCert[]): SamlCertStatus {
  if (certs.length === 0) return "unknown";
  if (certs.some((c) => c.status === "expired")) return "expired";
  if (certs.some((c) => c.status === "warning")) return "warning";
  return "ok";
}

async function authedJson<T>(url: string, token: string): Promise<T> {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Accept-API-Version": "protocol=2.1,resource=1.0",
    },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`AIC request failed (${res.status}) ${url}`);
  return res.json() as Promise<T>;
}

async function metadataFor(tenantUrl: string, realm: string, entityId: string): Promise<string | null> {
  const url = new URL(`${tenantUrl}/am/saml2/jsp/exportmetadata.jsp`);
  url.searchParams.set("entityid", entityId);
  url.searchParams.set("realm", `/${realm}`);
  const res = await fetch(url.toString(), { cache: "no-store" });
  if (!res.ok) return null;
  return res.text();
}

export function buildSamlListQuery(query: string): string {
  return query ? `entityId co "${query.replace(/"/g, '\\"')}"` : "true";
}

function liveListUrl(tenantUrl: string, realm: string, query: string, pageSize: number): string {
  const url = new URL(`${tenantUrl}/am/json/realms/root/realms/${encodeURIComponent(realm)}/realm-config/saml2`);
  url.searchParams.set("_queryFilter", buildSamlListQuery(query));
  url.searchParams.set("_pageSize", String(pageSize));
  return url.toString();
}

export async function listLiveSamlProviders({
  environment,
  realm,
  query = "",
  pageSize = 50,
}: {
  environment: string;
  realm: string;
  query?: string;
  pageSize?: number;
}): Promise<SamlProviderSummary[]> {
  const vars = envVarsFor(environment);
  const tenantUrl = requireTenantUrl(vars);
  const token = await getAccessToken(vars);
  const list = await authedJson<SamlListResponse>(liveListUrl(tenantUrl, realm, query, pageSize), token);
  const rows = list.result ?? [];
  const summaries = await Promise.all(rows.map(async (row): Promise<SamlProviderSummary> => {
    const id = String(row._id ?? "");
    const entityId = String(row.entityId ?? id);
    const location = String(row.location ?? "");
    const metadata = entityId ? await metadataFor(tenantUrl, realm, entityId) : null;
    const certs = extractMetadataCerts(metadata);
    return {
      id,
      entityId,
      location,
      realm,
      source: "live",
      displayName: typeof row.name === "string" ? row.name : undefined,
      metadataCertStatus: aggregateCertStatus(certs),
      metadataCerts: certs,
    };
  }));
  return summaries;
}

export async function listSamlProviders({
  environment,
  realm,
  query = "",
  source = "live",
  pageSize = 50,
}: {
  environment: string;
  realm: string;
  query?: string;
  source?: "live" | "local";
  pageSize?: number;
}): Promise<SamlProviderSummary[]> {
  if (source === "local") return listLocalSamlProviders({ environment, realm, query });
  const [live, local] = await Promise.all([
    listLiveSamlProviders({ environment, realm, query, pageSize }),
    listLocalSamlProviders({ environment, realm, query }),
  ]);
  const localByKey = new Map(local.map((p) => [`${p.location}:${p.id}`, p]));
  const localByEntity = new Map(local.map((p) => [`${p.location}:${p.entityId}`, p]));
  return live.map((p) => {
    const match = localByKey.get(`${p.location}:${p.id}`) ?? localByEntity.get(`${p.location}:${p.entityId}`);
    return {
      ...p,
      hasLocalConfig: !!match,
      localPath: match?.localPath,
    };
  });
}

export async function getLiveSamlProvider({
  environment,
  realm,
  location,
  id,
  entityId,
}: {
  environment: string;
  realm: string;
  location: string;
  id: string;
  entityId: string;
}): Promise<SamlProviderDetail> {
  const vars = envVarsFor(environment);
  const tenantUrl = requireTenantUrl(vars);
  const token = await getAccessToken(vars);
  const url = `${tenantUrl}/am/json/realms/root/realms/${encodeURIComponent(realm)}/realm-config/saml2/${encodeURIComponent(location)}/${encodeURIComponent(id)}`;
  const config = await authedJson<Record<string, unknown>>(url, token);
  const metadata = await metadataFor(tenantUrl, realm, entityId);
  const certs = extractMetadataCerts(metadata);
  const local = await getLocalSamlProvider({ environment, realm, location, id })
    ?? await getLocalSamlProvider({ environment, realm, location, id: entityId });
  return {
    id,
    entityId,
    location,
    realm,
    source: "live",
    config,
    metadata,
    metadataCertStatus: aggregateCertStatus(certs),
    metadataCerts: certs,
    hasLocalConfig: !!local,
    localPath: local?.localPath,
  };
}

export async function getSamlProvider({
  environment,
  realm,
  location,
  id,
  entityId,
  source = "live",
}: {
  environment: string;
  realm: string;
  location: string;
  id: string;
  entityId: string;
  source?: "live" | "local";
}): Promise<SamlProviderDetail | null> {
  if (source === "local") return getLocalSamlProvider({ environment, realm, location, id });
  return getLiveSamlProvider({ environment, realm, location, id, entityId });
}

async function readJsonFile(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function localProviderFiles(configDir: string, realm: string): Promise<Array<{ location: string; filePath: string }>> {
  const baseDir = path.join(configDir, "realms", realm, "realm-config", "saml");
  const files: Array<{ location: string; filePath: string }> = [];
  for (const location of ["hosted", "remote"]) {
    const dir = path.join(baseDir, location);
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (name.endsWith(".json")) files.push({ location, filePath: path.join(dir, name) });
    }
  }
  return files;
}

export async function listLocalSamlProviders({
  environment,
  realm,
  query = "",
}: {
  environment: string;
  realm: string;
  query?: string;
}): Promise<SamlProviderSummary[]> {
  const configDir = getConfigDir(environment);
  if (!configDir) return [];
  const files = await localProviderFiles(configDir, realm);
  const needle = query.toLowerCase();
  const rows: SamlProviderSummary[] = [];
  for (const file of files) {
    const raw = await readJsonFile(file.filePath);
    const config = raw?.config as Record<string, unknown> | undefined;
    const id = String(config?._id ?? path.basename(file.filePath, ".json"));
    const entityId = String(config?.entityId ?? id);
    if (needle && !entityId.toLowerCase().includes(needle) && !id.toLowerCase().includes(needle)) continue;
    const metadata = typeof raw?.metadata === "string" ? raw.metadata : null;
    const certs = extractMetadataCerts(metadata);
    rows.push({
      id,
      entityId,
      location: file.location,
      realm,
      source: "local",
      metadataCertStatus: aggregateCertStatus(certs),
      metadataCerts: certs,
      localPath: path.relative(configDir, file.filePath).replace(/\\/g, "/"),
    });
  }
  return rows;
}

export async function getLocalSamlProvider({
  environment,
  realm,
  location,
  id,
}: {
  environment: string;
  realm: string;
  location: string;
  id: string;
}): Promise<SamlProviderDetail | null> {
  const configDir = getConfigDir(environment);
  if (!configDir) return null;
  const files = await localProviderFiles(configDir, realm);
  for (const file of files.filter((f) => f.location === location)) {
    const raw = await readJsonFile(file.filePath);
    const config = raw?.config as Record<string, unknown> | undefined;
    const fileId = String(config?._id ?? path.basename(file.filePath, ".json"));
    const entityId = String(config?.entityId ?? fileId);
    if (fileId !== id && entityId !== id) continue;
    const metadata = typeof raw?.metadata === "string" ? raw.metadata : null;
    const certs = extractMetadataCerts(metadata);
    return {
      id: fileId,
      entityId,
      location,
      realm,
      source: "local",
      config: config ?? raw,
      metadata,
      metadataCertStatus: aggregateCertStatus(certs),
      metadataCerts: certs,
      localPath: path.relative(configDir, file.filePath).replace(/\\/g, "/"),
    };
  }
  return null;
}

export function realmsForEnvironment(environment: string): string[] {
  return realmsFor(envVarsFor(environment));
}
