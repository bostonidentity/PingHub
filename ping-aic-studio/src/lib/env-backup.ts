import fs from "node:fs";
import path from "node:path";
import { ENVIRONMENTS_DIR } from "./paths";
import { buildBundle } from "./env-bundle-io";

export const BACKUP_DIR_NAME = ".backups";
export const BACKUP_DIR = path.join(ENVIRONMENTS_DIR, BACKUP_DIR_NAME);

export interface BackupFile {
    filename: string;
    path: string;
    envName: string;
    timestamp: string; // YYYYMMDD-HHMMSS portion
    size: number;
    mtime: string; // ISO
}

function ensureBackupDir(): void {
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

function tsForFilename(): string {
    return new Date()
        .toISOString()
        .replace(/[-:]/g, "")
        .replace(/\..+/, "")
        .replace("T", "-");
}

/**
 * Write a plaintext-secrets bundle of a single environment under
 * `environments/.backups/<env>-<timestamp>.json`. Returns the absolute path.
 */
export function snapshotEnv(envName: string): string {
    ensureBackupDir();
    const { bundle } = buildBundle({
        names: [envName],
        secretsMode: "plain",
        appVersion: undefined,
    });
    const filename = `${envName}-${tsForFilename()}.json`;
    const filePath = path.join(BACKUP_DIR, filename);
    fs.writeFileSync(filePath, JSON.stringify(bundle, null, 2));
    return filePath;
}

const BACKUP_FILE_RE = /^(.+)-(\d{8}-\d{6})\.json$/;

/** List all backup files, optionally filtered by env name. */
export function listBackups(envName?: string): BackupFile[] {
    if (!fs.existsSync(BACKUP_DIR)) return [];
    const files = fs.readdirSync(BACKUP_DIR);
    const out: BackupFile[] = [];
    for (const f of files) {
        const m = BACKUP_FILE_RE.exec(f);
        if (!m) continue;
        if (envName && m[1] !== envName) continue;
        const full = path.join(BACKUP_DIR, f);
        const stat = fs.statSync(full);
        out.push({
            filename: f,
            path: full,
            envName: m[1],
            timestamp: m[2],
            size: stat.size,
            mtime: stat.mtime.toISOString(),
        });
    }
    return out.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
}

export interface PruneOptions {
    keepN?: number; // keep the N newest per env (default 10)
    keepDays?: number; // additionally keep anything within last N days (default 7)
}

/** Delete backups beyond the keep policy. Returns the deleted file paths. */
export function pruneBackups(envName: string, opts: PruneOptions = {}): string[] {
    const keepN = opts.keepN ?? 10;
    const keepDays = opts.keepDays ?? 7;
    const cutoffMs = Date.now() - keepDays * 24 * 60 * 60 * 1000;
    const all = listBackups(envName);
    const deleted: string[] = [];
    for (let i = 0; i < all.length; i++) {
        const f = all[i];
        if (i < keepN) continue;
        if (new Date(f.mtime).getTime() >= cutoffMs) continue;
        try {
            fs.unlinkSync(f.path);
            deleted.push(f.path);
        } catch {
            /* ignore */
        }
    }
    return deleted;
}

/** Delete a specific backup file by filename (basename only, no traversal). */
export function deleteBackup(filename: string): boolean {
    if (!BACKUP_FILE_RE.test(filename)) return false;
    const full = path.join(BACKUP_DIR, filename);
    if (!full.startsWith(BACKUP_DIR)) return false;
    if (!fs.existsSync(full)) return false;
    fs.unlinkSync(full);
    return true;
}

/** Read a backup file's bundle contents. Returns null if not found. */
export function readBackup(filename: string): unknown {
    if (!BACKUP_FILE_RE.test(filename)) throw new Error("invalid backup filename");
    const full = path.join(BACKUP_DIR, filename);
    if (!full.startsWith(BACKUP_DIR)) throw new Error("path traversal blocked");
    if (!fs.existsSync(full)) return null;
    return JSON.parse(fs.readFileSync(full, "utf-8"));
}
