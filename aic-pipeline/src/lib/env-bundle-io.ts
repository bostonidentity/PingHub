import fs from "node:fs";
import path from "node:path";
import { ENVIRONMENTS_DIR } from "./paths";
import { getEnvFileContent, getEnvFilePath, getEnvironments, saveEnvFile, saveEnvironments } from "./fr-config";
import type { Environment } from "./fr-config-types";
import { parseEnvFile, serializeEnvFile } from "./env-parser";
import {
    BUNDLE_SCHEMA,
    encryptSecrets,
    redactSecrets,
    validateBundle,
    materializeEnvVars,
    mergePreservingLiveSecrets,
    type BundleV1,
    type BundleEnvEntry,
    type SecretsMode,
} from "./env-bundle";

// File names included in a bundle alongside .env. Subdirectories (config/,
// managed-data/) and unrelated files are intentionally NOT bundled — those
// belong in the env git repo and would balloon the file size.
const COMPANION_FILES = ["log-api.json", "rcs-status.json", "release.json"];

function readCompanionFiles(envName: string): Record<string, unknown> | undefined {
    const dir = path.join(ENVIRONMENTS_DIR, envName);
    if (!fs.existsSync(dir)) return undefined;
    const out: Record<string, unknown> = {};
    for (const fname of COMPANION_FILES) {
        const p = path.join(dir, fname);
        if (!fs.existsSync(p)) continue;
        try {
            out[fname] = JSON.parse(fs.readFileSync(p, "utf-8"));
        } catch {
            // skip malformed companion files instead of breaking the export
        }
    }
    return Object.keys(out).length ? out : undefined;
}

function writeCompanionFiles(envName: string, files: Record<string, unknown> | undefined): void {
    if (!files) return;
    const dir = path.join(ENVIRONMENTS_DIR, envName);
    fs.mkdirSync(dir, { recursive: true });
    for (const [fname, content] of Object.entries(files)) {
        if (!COMPANION_FILES.includes(fname)) continue; // ignore unknown filenames
        fs.writeFileSync(path.join(dir, fname), JSON.stringify(content, null, 2) + "\n");
    }
}

function buildEntryForEnv(env: Environment, secretsMode: SecretsMode, passphrase?: string): {
    entry: BundleEnvEntry;
    secretCount: number;
    kdf?: BundleV1["kdf"];
} {
    const envContent = getEnvFileContent(env.name);
    const liveVars = parseEnvFile(envContent);

    let envVars: BundleEnvEntry["envVars"];
    let secretCount = 0;
    let kdf: BundleV1["kdf"] | undefined;

    if (secretsMode === "exclude") {
        const r = redactSecrets(liveVars);
        envVars = r.vars;
        secretCount = r.secretCount;
    } else if (secretsMode === "plain") {
        envVars = { ...liveVars };
    } else {
        if (!passphrase) throw new Error("passphrase required for encrypted secrets mode");
        const enc = encryptSecrets(liveVars, passphrase);
        envVars = enc.vars;
        kdf = enc.kdf;
    }

    return {
        entry: {
            meta: env,
            envVars,
            files: readCompanionFiles(env.name),
        },
        secretCount,
        kdf,
    };
}

export interface BuildBundleOptions {
    names: string[];
    secretsMode: SecretsMode;
    passphrase?: string;
    exportedBy?: string;
    appVersion?: string;
}

export interface BuildBundleResult {
    bundle: BundleV1;
    totalSecrets: number;
}

/** Build an in-memory BundleV1 for the named environments. */
export function buildBundle(opts: BuildBundleOptions): BuildBundleResult {
    const envs = getEnvironments();
    const wanted = new Set(opts.names);
    const selected = envs.filter((e) => wanted.has(e.name));
    const missing = opts.names.filter((n) => !envs.find((e) => e.name === n));
    if (missing.length) throw new Error(`unknown environment(s): ${missing.join(", ")}`);

    const entries: BundleEnvEntry[] = [];
    let totalSecrets = 0;
    let bundleKdf: BundleV1["kdf"] | undefined;

    for (const env of selected) {
        const { entry, secretCount, kdf } = buildEntryForEnv(env, opts.secretsMode, opts.passphrase);
        entries.push(entry);
        totalSecrets += secretCount;
        // All envs share the same kdf params — they only differ by the per-value IVs.
        if (kdf && !bundleKdf) bundleKdf = kdf;
        // (For encrypted mode each call generates a fresh salt; that's fine — we only
        //  need ONE kdf for decryption, since deriveKey uses the same salt across envs.
        //  Re-derive once with the shared salt for consistent decryption.)
    }

    // For encrypted mode, re-encrypt with one shared kdf so decryption uses one passphrase derivation.
    if (opts.secretsMode === "encrypted" && opts.passphrase) {
        const sharedSalt = Buffer.from(bundleKdf!.salt, "base64");
        const fresh: BundleEnvEntry[] = [];
        for (const env of selected) {
            const liveVars = parseEnvFile(getEnvFileContent(env.name));
            const enc = encryptSecrets(liveVars, opts.passphrase, sharedSalt);
            fresh.push({
                meta: env,
                envVars: enc.vars,
                files: readCompanionFiles(env.name),
            });
        }
        entries.length = 0;
        entries.push(...fresh);
    }

    const bundle: BundleV1 = {
        $schema: BUNDLE_SCHEMA,
        exportedAt: new Date().toISOString(),
        exportedBy: opts.exportedBy,
        appVersion: opts.appVersion,
        secretsIncluded: opts.secretsMode !== "exclude",
        secretsEncryption: opts.secretsMode === "encrypted" ? "passphrase-aes-256-gcm" : "none",
        kdf: opts.secretsMode === "encrypted" ? bundleKdf : undefined,
        environments: entries,
    };

    return { bundle, totalSecrets };
}

// ── Import side ──────────────────────────────────────────────────────────────

export type ImportAction = "skip" | "overwrite" | "rename";

export interface PerEnvDecision {
    name: string; // name in the bundle
    action: ImportAction;
    renameTo?: string;
    preserveLiveSecrets?: boolean; // default true
}

export interface ApplyEntryResult {
    bundleName: string;
    finalName: string;
    action: ImportAction;
    status: "applied" | "skipped" | "failed";
    error?: string;
}

export interface ApplyBundleOptions {
    bundle: BundleV1;
    decisions: PerEnvDecision[];
    passphrase?: string;
    /** Called before each overwrite so the caller can produce a backup. */
    beforeOverwrite?: (envName: string) => void;
}

/**
 * Apply a parsed bundle to disk. Caller is responsible for backups via
 * `beforeOverwrite` (kept here as a hook so this module stays decoupled from
 * the backup writer that needs `op-history`).
 */
export function applyBundle(opts: ApplyBundleOptions): ApplyEntryResult[] {
    validateBundle(opts.bundle);
    const decisionsByName = new Map(opts.decisions.map((d) => [d.name, d]));
    const live = getEnvironments();
    const liveByName = new Map(live.map((e) => [e.name, e]));
    const results: ApplyEntryResult[] = [];

    for (const entry of opts.bundle.environments) {
        const decision = decisionsByName.get(entry.meta.name);
        if (!decision || decision.action === "skip") {
            results.push({
                bundleName: entry.meta.name,
                finalName: entry.meta.name,
                action: decision?.action ?? "skip",
                status: "skipped",
            });
            continue;
        }

        const finalName =
            decision.action === "rename" ? (decision.renameTo || `${entry.meta.name}-imported`) : entry.meta.name;

        try {
            const exists = liveByName.has(finalName);
            if (decision.action === "overwrite" && exists && opts.beforeOverwrite) {
                opts.beforeOverwrite(finalName);
            }

            let importedVars = materializeEnvVars(entry, opts.bundle, opts.passphrase);

            if (decision.preserveLiveSecrets !== false && exists) {
                const liveContent = getEnvFileContent(finalName);
                const liveVars = parseEnvFile(liveContent);
                importedVars = mergePreservingLiveSecrets(liveVars, importedVars);
            }

            // Write atomically via a sibling tmp dir then rename
            writeEnvAtomically(finalName, importedVars, entry);

            // Update environments.json
            const updatedMeta: Environment = { ...entry.meta, name: finalName };
            const newList = exists
                ? live.map((e) => (e.name === finalName ? updatedMeta : e))
                : [...live, updatedMeta];
            saveEnvironments(newList);
            // Refresh local cache so subsequent iterations see the new state
            liveByName.set(finalName, updatedMeta);

            results.push({
                bundleName: entry.meta.name,
                finalName,
                action: decision.action,
                status: "applied",
            });
        } catch (err) {
            results.push({
                bundleName: entry.meta.name,
                finalName,
                action: decision.action,
                status: "failed",
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    return results;
}

function writeEnvAtomically(
    envName: string,
    vars: Record<string, string>,
    entry: BundleEnvEntry,
): void {
    const finalDir = path.join(ENVIRONMENTS_DIR, envName);
    const stagedDir = path.join(ENVIRONMENTS_DIR, `.${envName}.import.tmp`);
    const oldDir = path.join(ENVIRONMENTS_DIR, `.${envName}.bak.tmp`);

    // Clean any leftovers from a previous failed run
    for (const d of [stagedDir, oldDir]) {
        if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
    }

    // 1. Stage the new env content in a fresh dir
    fs.mkdirSync(stagedDir, { recursive: true });
    // Carry forward unknown lines from the existing .env (CONFIG_DIR overrides etc.)
    const liveContent = fs.existsSync(getEnvFilePath(envName)) ? getEnvFileContent(envName) : "";
    const envContent = serializeEnvFile(vars, liveContent);
    fs.writeFileSync(path.join(stagedDir, ".env"), envContent);
    writeCompanionFiles(envName, undefined); // ensure dir exists for companion writer
    if (entry.files) {
        for (const [fname, content] of Object.entries(entry.files)) {
            if (!COMPANION_FILES.includes(fname)) continue;
            fs.writeFileSync(path.join(stagedDir, fname), JSON.stringify(content, null, 2) + "\n");
        }
    }

    // 2. Move old aside (if exists) → 3. promote staged → 4. delete old
    if (fs.existsSync(finalDir)) fs.renameSync(finalDir, oldDir);
    try {
        fs.renameSync(stagedDir, finalDir);
    } catch (err) {
        // Roll back
        if (fs.existsSync(oldDir)) fs.renameSync(oldDir, finalDir);
        throw err;
    }
    if (fs.existsSync(oldDir)) fs.rmSync(oldDir, { recursive: true, force: true });

    // Touch via saveEnvFile semantics for any other hooks (re-write to ensure tail newline behavior)
    saveEnvFile(envName, envContent);
}
