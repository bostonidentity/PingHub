// src/core/env/legacyBundle.ts
import {
  randomBytes, pbkdf2Sync, createCipheriv, createDecipheriv
} from "node:crypto";

export const BUNDLE_SCHEMA = "pinghub-environments/v1";
export const REDACTED_SENTINEL = "<REDACTED>";

export type SecretsMode = "exclude" | "plain" | "encrypted";

export interface EncryptedValue {
  _enc: "aes-256-gcm";
  iv: string;
  tag: string;
  ct: string;
}

export interface LegacyEnvMeta {
  name: string;
  label: string;
  color: string;
  type?: string;
  devEnvironment?: boolean;
  pageSize?: number;
  healthIntervalMinutes?: number;
}

export interface BundleEnvEntry {
  meta: LegacyEnvMeta;
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

export const SECRET_KEYS = new Set<string>([
  "SERVICE_ACCOUNT_KEY",
  "SERVICE_ACCOUNT_CLIENT_SECRET",
  "RCS_PRIVATE_KEY",
  "FRODO_SA_JWK",
  "FRODO_PASSWORD",
  "LOG_API_KEY",
  "LOG_API_SECRET"
]);

const SECRET_SUFFIXES = ["_SECRET", "_PASSWORD", "_TOKEN", "_PRIVATE_KEY", "_API_KEY"];

export function isSecretKey(name: string): boolean {
  if (SECRET_KEYS.has(name)) return true;
  const u = name.toUpperCase();
  return SECRET_SUFFIXES.some((s) => u.endsWith(s));
}

const PBKDF2_ITER = 200_000;
const KEY_LEN = 32;
const IV_LEN = 12;

function deriveKey(passphrase: string, salt: Buffer, iter = PBKDF2_ITER): Buffer {
  return pbkdf2Sync(passphrase, salt, iter, KEY_LEN, "sha256");
}

export function encryptSecrets(
  vars: Record<string, string>,
  passphrase: string,
  saltOverride?: Buffer
): { vars: Record<string, string | EncryptedValue>; kdf: NonNullable<BundleV1["kdf"]> } {
  if (!passphrase || passphrase.length < 6) {
    throw new Error("passphrase must be at least 6 characters");
  }
  const salt = saltOverride ?? randomBytes(16);
  const key = deriveKey(passphrase, salt);
  const out: Record<string, string | EncryptedValue> = {};
  for (const [k, v] of Object.entries(vars)) {
    if (isSecretKey(k) && v) {
      const iv = randomBytes(IV_LEN);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const ct = Buffer.concat([cipher.update(v, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      out[k] = {
        _enc: "aes-256-gcm",
        iv: iv.toString("base64"),
        tag: tag.toString("base64"),
        ct: ct.toString("base64")
      };
    } else {
      out[k] = v;
    }
  }
  return {
    vars: out,
    kdf: { algo: "pbkdf2", hash: "sha256", iter: PBKDF2_ITER, salt: salt.toString("base64") }
  };
}

export function decryptSecrets(
  vars: Record<string, string | EncryptedValue>,
  passphrase: string,
  kdf: NonNullable<BundleV1["kdf"]>
): Record<string, string> {
  const salt = Buffer.from(kdf.salt, "base64");
  const key = deriveKey(passphrase, salt, kdf.iter);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(vars)) {
    if (typeof v === "string") {
      out[k] = v;
      continue;
    }
    if (v && v._enc === "aes-256-gcm") {
      const iv = Buffer.from(v.iv, "base64");
      const tag = Buffer.from(v.tag, "base64");
      const ct = Buffer.from(v.ct, "base64");
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(tag);
      const plain = Buffer.concat([decipher.update(ct), decipher.final()]);
      out[k] = plain.toString("utf8");
    }
  }
  return out;
}

export function hasEncryptedValues(vars: Record<string, string | EncryptedValue>): boolean {
  return Object.values(vars).some((v) => typeof v !== "string" && v?._enc === "aes-256-gcm");
}

export function materializeEnvVars(
  entry: BundleEnvEntry,
  bundle: BundleV1,
  passphrase?: string
): Record<string, string> {
  if (!hasEncryptedValues(entry.envVars)) {
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
