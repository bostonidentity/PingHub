import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Each test gets a fresh temp ENVIRONMENTS_DIR by setting PINGHUB_DATA_DIR
// BEFORE importing any module that resolves it.

let TMP_DIR: string;

beforeEach(() => {
    TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pinghub-env-test-"));
    process.env.PINGHUB_DATA_DIR = TMP_DIR;
    // Force module re-evaluation so paths.ts picks up the new env var
    vi.resetModules();
    // Seed two envs
    fs.writeFileSync(
        path.join(TMP_DIR, "environments.json"),
        JSON.stringify(
            [
                { name: "ide3", label: "ide3", color: "blue", type: "sandbox" },
                { name: "uat", label: "UAT", color: "purple", type: "controlled", devEnvironment: false },
            ],
            null,
            2,
        ),
    );
    fs.mkdirSync(path.join(TMP_DIR, "ide3"));
    fs.writeFileSync(
        path.join(TMP_DIR, "ide3", ".env"),
        "TENANT_BASE_URL=https://ide3.example.com\nSERVICE_ACCOUNT_ID=sa-ide3\nSERVICE_ACCOUNT_KEY='{\"kty\":\"RSA\",\"n\":\"abc\"}'\n",
    );
    fs.writeFileSync(path.join(TMP_DIR, "ide3", "log-api.json"), JSON.stringify({ apiKey: "k1" }));
    fs.mkdirSync(path.join(TMP_DIR, "uat"));
    fs.writeFileSync(
        path.join(TMP_DIR, "uat", ".env"),
        "TENANT_BASE_URL=https://uat.example.com\nSERVICE_ACCOUNT_ID=sa-uat\nSERVICE_ACCOUNT_KEY='{\"kty\":\"RSA\",\"n\":\"xyz\"}'\n",
    );
});

afterEach(() => {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
    delete process.env.PINGHUB_DATA_DIR;
    vi.resetModules();
});

describe("POST /api/environment-ops/export", () => {
    it("returns a redacted bundle for selected envs", async () => {
        const { POST } = await import("@/app/api/environment-ops/export/route");
        const req = new Request("http://x/api/environment-ops/export", {
            method: "POST",
            body: JSON.stringify({ names: ["ide3"], secretsMode: "exclude" }),
        });
        const res = await POST(req as unknown as Parameters<typeof POST>[0]);
        expect(res.status).toBe(200);
        const body = JSON.parse(await res.text());
        expect(body.$schema).toBe("pinghub-environments/v1");
        expect(body.environments).toHaveLength(1);
        expect(body.environments[0].meta.name).toBe("ide3");
        expect(body.environments[0].envVars.SERVICE_ACCOUNT_KEY).toBe("<REDACTED>");
        expect(body.environments[0].envVars.TENANT_BASE_URL).toBe("https://ide3.example.com");
        expect(body.environments[0].files["log-api.json"]).toEqual({ apiKey: "k1" });
    });

    it("includes plaintext secrets when requested", async () => {
        const { POST } = await import("@/app/api/environment-ops/export/route");
        const req = new Request("http://x/api/environment-ops/export", {
            method: "POST",
            body: JSON.stringify({ names: ["ide3"], secretsMode: "plain" }),
        });
        const res = await POST(req as unknown as Parameters<typeof POST>[0]);
        expect(res.status).toBe(200);
        const body = JSON.parse(await res.text());
        expect(body.environments[0].envVars.SERVICE_ACCOUNT_KEY).toContain("kty");
    });

    it("rejects encrypted mode without passphrase", async () => {
        const { POST } = await import("@/app/api/environment-ops/export/route");
        const req = new Request("http://x/api/environment-ops/export", {
            method: "POST",
            body: JSON.stringify({ names: ["ide3"], secretsMode: "encrypted" }),
        });
        const res = await POST(req as unknown as Parameters<typeof POST>[0]);
        expect(res.status).toBe(400);
    });

    it("encrypts secrets when passphrase given", async () => {
        const { POST } = await import("@/app/api/environment-ops/export/route");
        const req = new Request("http://x/api/environment-ops/export", {
            method: "POST",
            body: JSON.stringify({
                names: ["ide3", "uat"],
                secretsMode: "encrypted",
                passphrase: "correcthorsebattery",
            }),
        });
        const res = await POST(req as unknown as Parameters<typeof POST>[0]);
        expect(res.status).toBe(200);
        const body = JSON.parse(await res.text());
        expect(body.secretsEncryption).toBe("passphrase-aes-256-gcm");
        expect(body.kdf).toBeTruthy();
        expect(typeof body.environments[0].envVars.SERVICE_ACCOUNT_KEY).toBe("object");
        expect(body.environments[0].envVars.SERVICE_ACCOUNT_KEY._enc).toBe("aes-256-gcm");
    });
});

describe("POST /api/environment-ops/import", () => {
    it("creates a new env from a bundle", async () => {
        const { POST: exportPost } = await import("@/app/api/environment-ops/export/route");
        const { POST: importPost } = await import("@/app/api/environment-ops/import/route");

        // First export ide3 in plaintext
        const exportRes = await exportPost(
            new Request("http://x/api/environment-ops/export", {
                method: "POST",
                body: JSON.stringify({ names: ["ide3"], secretsMode: "plain" }),
            }) as unknown as Parameters<typeof exportPost>[0],
        );
        const bundle = JSON.parse(await exportRes.text());

        // Rename the env in the bundle so it imports as new
        bundle.environments[0].meta.name = "ide3-clone";
        bundle.environments[0].meta.label = "ide3-clone";

        const importRes = await importPost(
            new Request("http://x/api/environment-ops/import", {
                method: "POST",
                body: JSON.stringify({
                    bundle,
                    decisions: [{ name: "ide3-clone", action: "overwrite" }],
                }),
            }) as unknown as Parameters<typeof importPost>[0],
        );
        expect(importRes.status).toBe(200);
        const body = await importRes.json();
        expect(body.results[0].status).toBe("applied");
        expect(body.results[0].finalName).toBe("ide3-clone");

        // The new env folder + .env should exist on disk
        const envFile = path.join(TMP_DIR, "ide3-clone", ".env");
        expect(fs.existsSync(envFile)).toBe(true);
        const txt = fs.readFileSync(envFile, "utf-8");
        expect(txt).toContain("TENANT_BASE_URL=https://ide3.example.com");
        expect(txt).toContain('"kty":"RSA"');
    });

    it("auto-backs up before overwrite", async () => {
        const { POST: exportPost } = await import("@/app/api/environment-ops/export/route");
        const { POST: importPost } = await import("@/app/api/environment-ops/import/route");

        const exportRes = await exportPost(
            new Request("http://x/api/environment-ops/export", {
                method: "POST",
                body: JSON.stringify({ names: ["ide3"], secretsMode: "exclude" }),
            }) as unknown as Parameters<typeof exportPost>[0],
        );
        const bundle = JSON.parse(await exportRes.text());

        const importRes = await importPost(
            new Request("http://x/api/environment-ops/import", {
                method: "POST",
                body: JSON.stringify({
                    bundle,
                    decisions: [{ name: "ide3", action: "overwrite", preserveLiveSecrets: true }],
                }),
            }) as unknown as Parameters<typeof importPost>[0],
        );
        expect(importRes.status).toBe(200);
        const body = await importRes.json();
        expect(body.results[0].status).toBe("applied");
        expect(body.results[0].backupPath).toBeTruthy();
        expect(fs.existsSync(body.results[0].backupPath)).toBe(true);

        // Live secret preserved (bundle had REDACTED, live had real key)
        const liveAfter = fs.readFileSync(path.join(TMP_DIR, "ide3", ".env"), "utf-8");
        expect(liveAfter).toContain('"kty":"RSA"');
        expect(liveAfter).not.toContain("<REDACTED>");
    });

    it("imports many new envs and persists all of them in environments.json (regression)", async () => {
        const { POST: importPost } = await import("@/app/api/environment-ops/import/route");

        // Build a synthetic bundle with 5 brand-new envs (no overlap with seed).
        const bundle = {
            $schema: "pinghub-environments/v1",
            exportedAt: new Date().toISOString(),
            secretsIncluded: false,
            secretsEncryption: "none" as const,
            environments: ["alpha", "bravo", "charlie", "delta", "echo"].map((n) => ({
                meta: { name: n, label: n.toUpperCase(), color: "blue", type: "sandbox" },
                envVars: { TENANT_BASE_URL: `https://${n}.example.com` },
            })),
        };
        const decisions = bundle.environments.map((e) => ({
            name: e.meta.name,
            action: "overwrite" as const,
        }));

        const res = await importPost(
            new Request("http://x/api/environment-ops/import", {
                method: "POST",
                body: JSON.stringify({ bundle, decisions }),
            }) as unknown as Parameters<typeof importPost>[0],
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.results.every((r: { status: string }) => r.status === "applied")).toBe(true);

        // environments.json must contain seeds + all 5 new envs (BUG was: only the LAST one)
        const persisted = JSON.parse(
            fs.readFileSync(path.join(TMP_DIR, "environments.json"), "utf-8"),
        ) as Array<{ name: string }>;
        const names = persisted.map((e) => e.name).sort();
        expect(names).toEqual(["alpha", "bravo", "charlie", "delta", "echo", "ide3", "uat"]);
    });

    it("rejects encrypted bundle without passphrase", async () => {
        const { POST: exportPost } = await import("@/app/api/environment-ops/export/route");
        const { POST: importPost } = await import("@/app/api/environment-ops/import/route");

        const exportRes = await exportPost(
            new Request("http://x/api/environment-ops/export", {
                method: "POST",
                body: JSON.stringify({
                    names: ["ide3"],
                    secretsMode: "encrypted",
                    passphrase: "correcthorsebattery",
                }),
            }) as unknown as Parameters<typeof exportPost>[0],
        );
        const bundle = JSON.parse(await exportRes.text());

        const res = await importPost(
            new Request("http://x/api/environment-ops/import", {
                method: "POST",
                body: JSON.stringify({
                    bundle,
                    decisions: [{ name: "ide3", action: "overwrite" }],
                }),
            }) as unknown as Parameters<typeof importPost>[0],
        );
        expect(res.status).toBe(400);
    });
});
