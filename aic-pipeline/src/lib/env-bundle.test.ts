import { describe, it, expect } from "vitest";
import {
    isSecretKey,
    redactSecrets,
    mergePreservingLiveSecrets,
    encryptSecrets,
    decryptSecrets,
    validateBundle,
    hasEncryptedValues,
    bundleSha256,
    REDACTED_SENTINEL,
    BUNDLE_SCHEMA,
    type BundleV1,
} from "@/lib/env-bundle";
import { parseEnvFile, serializeEnvFile } from "@/lib/env-parser";

describe("isSecretKey", () => {
    it("matches known names", () => {
        expect(isSecretKey("SERVICE_ACCOUNT_KEY")).toBe(true);
        expect(isSecretKey("LOG_API_SECRET")).toBe(true);
    });
    it("matches by suffix heuristic", () => {
        expect(isSecretKey("MY_CUSTOM_TOKEN")).toBe(true);
        expect(isSecretKey("X_PRIVATE_KEY")).toBe(true);
        expect(isSecretKey("DB_PASSWORD")).toBe(true);
    });
    it("does not match plain config", () => {
        expect(isSecretKey("TENANT_BASE_URL")).toBe(false);
        expect(isSecretKey("SERVICE_ACCOUNT_ID")).toBe(false);
    });
});

describe("redactSecrets", () => {
    it("replaces secret values and counts them", () => {
        const { vars, secretCount } = redactSecrets({
            TENANT_BASE_URL: "https://x",
            SERVICE_ACCOUNT_ID: "sa",
            SERVICE_ACCOUNT_KEY: '{"kty":"RSA"}',
        });
        expect(secretCount).toBe(1);
        expect(vars.SERVICE_ACCOUNT_KEY).toBe(REDACTED_SENTINEL);
        expect(vars.SERVICE_ACCOUNT_ID).toBe("sa");
    });
});

describe("mergePreservingLiveSecrets", () => {
    it("keeps live secret when imported is redacted", () => {
        const live = { SERVICE_ACCOUNT_KEY: "live-jwk", TENANT_BASE_URL: "https://old" };
        const imp = { SERVICE_ACCOUNT_KEY: REDACTED_SENTINEL, TENANT_BASE_URL: "https://new" };
        const merged = mergePreservingLiveSecrets(live, imp);
        expect(merged.SERVICE_ACCOUNT_KEY).toBe("live-jwk");
        expect(merged.TENANT_BASE_URL).toBe("https://new");
    });
    it("uses imported secret when present", () => {
        const live = { SERVICE_ACCOUNT_KEY: "live" };
        const imp = { SERVICE_ACCOUNT_KEY: "new" };
        expect(mergePreservingLiveSecrets(live, imp).SERVICE_ACCOUNT_KEY).toBe("new");
    });
});

describe("encrypt/decrypt secrets", () => {
    it("round-trips with right passphrase", () => {
        const orig = { TENANT_BASE_URL: "https://x", SERVICE_ACCOUNT_KEY: "json-key-content" };
        const { vars, kdf } = encryptSecrets(orig, "correcthorsebattery");
        expect(hasEncryptedValues(vars)).toBe(true);
        expect(typeof vars.SERVICE_ACCOUNT_KEY === "object").toBe(true);
        const back = decryptSecrets(vars, "correcthorsebattery", kdf);
        expect(back).toEqual(orig);
    });

    it("rejects short passphrase", () => {
        expect(() => encryptSecrets({ X: "y" }, "short")).toThrow(/at least 12/);
    });

    it("fails on wrong passphrase", () => {
        const { vars, kdf } = encryptSecrets(
            { SERVICE_ACCOUNT_KEY: "secret-data" },
            "correcthorsebattery",
        );
        expect(() => decryptSecrets(vars, "wrongwrongwrong!", kdf)).toThrow();
    });
});

describe("validateBundle", () => {
    const ok: BundleV1 = {
        $schema: BUNDLE_SCHEMA,
        exportedAt: new Date().toISOString(),
        secretsIncluded: false,
        secretsEncryption: "none",
        environments: [
            {
                meta: { name: "ide3", label: "ide3", color: "blue", type: "sandbox" },
                envVars: { TENANT_BASE_URL: "https://x" },
            },
        ],
    };

    it("accepts a valid bundle", () => {
        expect(() => validateBundle(ok)).not.toThrow();
    });
    it("rejects wrong schema", () => {
        expect(() => validateBundle({ ...ok, $schema: "other" })).toThrow();
    });
    it("rejects missing envVars", () => {
        const bad = { ...ok, environments: [{ meta: ok.environments[0].meta }] };
        expect(() => validateBundle(bad)).toThrow();
    });
    it("rejects encrypted bundle without kdf", () => {
        expect(() =>
            validateBundle({ ...ok, secretsEncryption: "passphrase-aes-256-gcm" }),
        ).toThrow(/kdf/);
    });
});

describe("env-parser round-trip with bundle", () => {
    it("preserves multi-line JWK through serialize/parse", () => {
        const orig =
            'TENANT_BASE_URL=https://example.com\n' +
            "SERVICE_ACCOUNT_ID=abc\n" +
            "SERVICE_ACCOUNT_KEY='" +
            JSON.stringify({ kty: "RSA", n: "x".repeat(20) }, null, 2) +
            "'\n";
        const parsed = parseEnvFile(orig);
        const written = serializeEnvFile(parsed, orig);
        const reparsed = parseEnvFile(written);
        expect(reparsed).toEqual(parsed);
    });
});

describe("bundleSha256", () => {
    it("returns deterministic hex for identical bundles", () => {
        const b: BundleV1 = {
            $schema: BUNDLE_SCHEMA,
            exportedAt: "2026-05-14T00:00:00Z",
            secretsIncluded: false,
            secretsEncryption: "none",
            environments: [],
        };
        expect(bundleSha256(b)).toBe(bundleSha256({ ...b }));
        expect(bundleSha256(b)).toMatch(/^[0-9a-f]{64}$/);
    });
});
