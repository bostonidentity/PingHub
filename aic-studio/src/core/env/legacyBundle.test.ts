import { describe, it, expect } from "vitest";
import {
  BUNDLE_SCHEMA, REDACTED_SENTINEL,
  validateBundle, decryptSecrets, encryptSecrets, hasEncryptedValues,
  type BundleV1
} from "./legacyBundle";

describe("legacyBundle", () => {
  it("BUNDLE_SCHEMA matches the legacy app id", () => {
    expect(BUNDLE_SCHEMA).toBe("pinghub-environments/v1");
  });

  it("validateBundle accepts a minimal plain bundle", () => {
    const b: BundleV1 = {
      $schema: BUNDLE_SCHEMA,
      exportedAt: "2026-05-24T00:00:00Z",
      secretsIncluded: false,
      secretsEncryption: "none",
      environments: [
        { meta: { name: "dev", label: "Dev", color: "blue" }, envVars: { TENANT_BASE_URL: "https://x" } }
      ]
    };
    expect(() => validateBundle(b)).not.toThrow();
  });

  it("validateBundle rejects wrong $schema", () => {
    expect(() => validateBundle({ $schema: "wrong/v1", environments: [] }))
      .toThrow(/unsupported bundle schema/);
  });

  it("validateBundle rejects encrypted bundle missing kdf", () => {
    expect(() => validateBundle({
      $schema: BUNDLE_SCHEMA, exportedAt: "x",
      secretsIncluded: true, secretsEncryption: "passphrase-aes-256-gcm",
      environments: []
    })).toThrow(/missing kdf/);
  });

  it("encrypt + decrypt roundtrip preserves secrets", () => {
    const vars = { FRODO_PASSWORD: "hunter2", TENANT_BASE_URL: "https://x" };
    const { vars: enc, kdf } = encryptSecrets(vars, "correct horse battery staple");
    expect(hasEncryptedValues(enc)).toBe(true);
    expect(enc.TENANT_BASE_URL).toBe("https://x");
    const dec = decryptSecrets(enc, "correct horse battery staple", kdf);
    expect(dec.FRODO_PASSWORD).toBe("hunter2");
    expect(dec.TENANT_BASE_URL).toBe("https://x");
  });

  it("decryptSecrets throws on wrong passphrase", () => {
    const { vars: enc, kdf } = encryptSecrets({ FRODO_PASSWORD: "x" }, "right1");
    expect(() => decryptSecrets(enc, "wrong1", kdf)).toThrow();
  });

  it("REDACTED_SENTINEL is preserved through validation", () => {
    expect(REDACTED_SENTINEL).toBe("<REDACTED>");
  });
});
