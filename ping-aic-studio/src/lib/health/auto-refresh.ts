import { parseEnvFile } from "@/lib/env-parser";
import { getEnvFileContent, getEnvironments } from "@/lib/fr-config";
import { readHealthInfo, writeHealthInfo } from "./persistence";
import { probeHealth } from "./probe";
import {
    DEFAULT_HEALTH_INTERVAL_MIN,
    MAX_HEALTH_INTERVAL_MIN,
    MIN_HEALTH_INTERVAL_MIN,
    type HealthCacheEntry,
} from "./types";

const KEY = "__healthInflight";
const globalRef = globalThis as unknown as Record<string, Set<string> | undefined>;

function inflight(): Set<string> {
    let set = globalRef[KEY];
    if (!set) {
        set = new Set<string>();
        globalRef[KEY] = set;
    }
    return set;
}

export function isAlreadyProbing(envName: string): boolean {
    return inflight().has(envName);
}

export function markProbing(envName: string): boolean {
    const set = inflight();
    if (set.has(envName)) return false;
    set.add(envName);
    return true;
}

export function markProbeDone(envName: string): void {
    inflight().delete(envName);
}

export function __resetInflightForTests(): void {
    inflight().clear();
}

export function clampInterval(min: number | undefined): number {
    if (typeof min !== "number" || !Number.isFinite(min)) return DEFAULT_HEALTH_INTERVAL_MIN;
    return Math.max(MIN_HEALTH_INTERVAL_MIN, Math.min(MAX_HEALTH_INTERVAL_MIN, Math.round(min)));
}

export function isStale(checkedAt: string | null | undefined, intervalMinutes: number, now: Date = new Date()): boolean {
    if (!checkedAt) return true;
    const t = Date.parse(checkedAt);
    if (Number.isNaN(t)) return true;
    const ageMs = now.getTime() - t;
    return ageMs >= clampInterval(intervalMinutes) * 60_000;
}

export async function refreshOne(envName: string): Promise<HealthCacheEntry> {
    const envContent = getEnvFileContent(envName);
    const envVars = parseEnvFile(envContent);
    const tenantUrl = envVars.TENANT_BASE_URL ?? "";
    const entry = await probeHealth(tenantUrl);
    writeHealthInfo(envName, entry);
    return entry;
}

/**
 * Fire-and-forget. For every configured env whose cached health is older
 * than its configured interval (or missing), trigger a probe in the
 * background.
 */
export function triggerStaleHealthRefreshAsync(): void {
    const envs = getEnvironments();
    for (const e of envs) {
        const cached = readHealthInfo(e.name);
        const interval = clampInterval(e.healthIntervalMinutes);
        if (cached && !isStale(cached.checkedAt, interval)) continue;
        if (!markProbing(e.name)) continue;
        refreshOne(e.name)
            .catch(() => {
                // probeHealth never throws, but be defensive.
            })
            .finally(() => markProbeDone(e.name));
    }
}
