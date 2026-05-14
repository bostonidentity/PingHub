import {
    randomBytes,
    pbkdf2Sync,
    createCipheriv,
    createDecipheriv,
    createHash,
} from "node:crypto";
import type { Environment } from "./fr-config-types";

// ── Schema ───────────────────────────────────────────────────────────────────

export const BUNDLE_SCHEMA = "pinghub-environments/v1";
export const REDACTED_SENTINEL = "<REDACTED>";

export type SecretsMode = "exclude" | "plain" | "encrypted";

export interface EncryptedValue {
    _enc: "aes-256-gcm";
    iv: string; // base64
    tag: string; // base64
    ct: string; // base64
}

export interface BundleEnvEntry {
    meta: Environment;
    envVars: Record<string, string | EncryptedValue>;
    files?: Record<string, unknown>;
}

export interface BundleV1 {
    $schema: typeof BUNDLE_SCHEMA;
    exportedAt: string;
    exportedBy?: string;
    appVersion?: string;
    secretsIncluded: boolean;
    secretsEncryption: "none" | "passphrase-aes-256-gcm";
    kdf?: { algo: "pbkdf2"; hash: "sha256"; iter: number; salt: string };
    environments: BundleEnvEntry[];
}

// ── Secret keys ──────────────────────────────────────────────────────────────

/** Exact-match secret keys from known fr-config-manager .env files. */
export const SECRET_KEYS = new Set<string>([
    "SERVICE_ACCOUNT_KEY",
    "SERVICE_ACCOUNT_CLIENT_SECRET",
    "RCS_PRIVATE_KEY",
    "FRODO_SA_JWK",
    "FRODO_PASSWORD",
    "LOG_API_KEY",
    "LOG_API_SECRET",
]);

/** Heuristic: name suffixes that strongly indicate a secret. */
const SECRET_SUFFIXES = ["_SECRET", "_PASSWORD", "_TOKEN", "_PRIVATE_KEY", "_API_KEY"];

export function isSecretKey(name: string): boolean {
    if (SECRET_KEYS.has(name)) return true;
    const upper = name.toUpperCase();
    return SECRET_SUFFIXES.some((s) => upper.endsWith(s));
}

// ── Redact / restore ─────────────────────────────────────────────────────────

export function redactSecrets(vars: Record<string, string>): {
    vars: Record<string, string>;
    secretCount: number;
} {
    const out: Record<string, string> = {};
    let secretCount = 0;
    for (const [k, v] of Object.entries(vars)) {
        if (isSecretKey(k) && v) {
            out[k] = REDACTED_SENTINEL;
            secretCount++;
        } else {
            out[k] = v;
        }
    }
    return { vars: out, secretCount };
}

/**
 * Merge an imported var map into a live one, preserving any existing live secret
 * when the imported value is empty or `<REDACTED>`. Non-secret keys are taken
 * from the imported side.
 */
export function mergePreservingLiveSecrets(
    liveVars: Record<string, string>,
    importedVars: Record<string, string>,
): Record<string, string> {
    const out: Record<string, string> = { ...importedVars };
    for (const [k, v] of Object.entries(importedVars)) {
        if (!isSecretKey(k)) continue;
        const looksRedacted = !v || v === REDACTED_SENTINEL;
        if (looksRedacted && liveVars[k]) out[k] = liveVars[k];
    }
    return out;
}

// ── Encryption ───────────────────────────────────────────────────────────────

const PBKDF2_ITER = 200_000;
const KEY_LEN = 32; // AES-256
const IV_LEN = 12; // GCM standard

function deriveKey(passphrase: string, salt: Buffer): Buffer {
    return pbkdf2Sync(passphrase, salt, PBKDF2_ITER, KEY_LEN, "sha256");
}

function encryptOne(value: string, key: Buffer): EncryptedValue {
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ct = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
        _enc: "aes-256-gcm",
        iv: iv.toString("base64"),
        tag: tag.toString("base64"),
        ct: ct.toString("base64"),
    };
}

function decryptOne(payload: EncryptedValue, key: Buffer): string {
    const iv = Buffer.from(payload.iv, "base64");
    const tag = Buffer.from(payload.tag, "base64");
    const ct = Buffer.from(payload.ct, "base64");
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const out = Buffer.concat([decipher.update(ct), decipher.final()]);
    return out.toString("utf8");
}

export interface EncryptedSecretsResult {
    vars: Record<string, string | EncryptedValue>;
    kdf: NonNullable<BundleV1["kdf"]>;
}

export function encryptSecrets(
    vars: Record<string, string>,
    passphrase: string,
    saltOverride?: Buffer,
): EncryptedSecretsResult {
    if (!passphrase || passphrase.length < 12) {
        throw new Error("passphrase must be at least 12 characters");
    }
    const salt = saltOverride ?? randomBytes(16);
    const key = deriveKey(passphrase, salt);
    const out: Record<string, string | EncryptedValue> = {};
    for (const [k, v] of Object.entries(vars)) {
        if (isSecretKey(k) && v) out[k] = encryptOne(v, key);
        else out[k] = v;
    }
    return {
        vars: out,
        kdf: { algo: "pbkdf2", hash: "sha256", iter: PBKDF2_ITER, salt: salt.toString("base64") },
    };
}

export function decryptSecrets(
    vars: Record<string, string | EncryptedValue>,
    passphrase: string,
    kdf: NonNullable<BundleV1["kdf"]>,
): Record<string, string> {
    const salt = Buffer.from(kdf.salt, "base64");
    const key = pbkdf2Sync(passphrase, salt, kdf.iter, KEY_LEN, "sha256");
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(vars)) {
        if (typeof v === "string") {
            out[k] = v;
        } else if (v && v._enc === "aes-256-gcm") {
            out[k] = decryptOne(v, key);
        }
    }
    return out;
}

/** True if any value in the map is an encrypted envelope. */
export function hasEncryptedValues(vars: Record<string, string | EncryptedValue>): boolean {
    return Object.values(vars).some((v) => typeof v !== "string" && v?._enc === "aes-256-gcm");
}

// ── Bundle utilities ─────────────────────────────────────────────────────────

export function bundleSha256(bundle: BundleV1): string {
    const json = JSON.stringify(bundle);
    return createHash("sha256").update(json).digest("hex");
}

/**
 * Quick structural check used by the import API before doing real work.
 * Throws with a user-readable message on mismatch.
 */
export function validateBundle(input: unknown): asserts input is BundleV1 {
    if (!input || typeof input !== "object") throw new Error("bundle is not an object");
    const b = input as Partial<BundleV1>;
    if (b.$schema !== BUNDLE_SCHEMA) {
        throw new Error(`unsupported bundle schema: ${String(b.$schema)} (expected ${BUNDLE_SCHEMA})`);
    }
    if (!Array.isArray(b.environments)) throw new Error("bundle.environments missing or not an array");
    for (const e of b.environments) {
        if (!e || typeof e !== "object") throw new Error("bundle entry is not an object");
        if (!e.meta || typeof e.meta.name !== "string") throw new Error("bundle entry missing meta.name");
        if (!e.envVars || typeof e.envVars !== "object") {
            throw new Error(`bundle entry "${e.meta?.name}" missing envVars`);
        }
    }
    if (b.secretsEncryption === "passphrase-aes-256-gcm" && !b.kdf) {
        throw new Error("encrypted bundle missing kdf parameters");
    }
}

/**
 * Convert all envVars in a bundle entry to a plain string map by decrypting
 * any encrypted values. Throws if values are encrypted but no passphrase given.
 */
export function materializeEnvVars(
    entry: BundleEnvEntry,
    bundle: BundleV1,
    passphrase?: string,
): Record<string, string> {
    if (!hasEncryptedValues(entry.envVars)) {
        // All values are already plain strings (or were redacted to a string)
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(entry.envVars)) {
            if (typeof v === "string") out[k] = v;
        }
        return out;
    }
    if (!passphrase) throw new Error("bundle has encrypted secrets — passphrase required");
    if (!bundle.kdf) throw new Error("bundle has encrypted secrets but no kdf");
    return decryptSecrets(entry.envVars, passphrase, bundle.kdf);
}
