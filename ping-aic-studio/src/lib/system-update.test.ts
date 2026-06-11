import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getVersionStatus } from "./system-update";

// Source-dev mode: no PINGHUB_APP_DIR → resolveDistRoot() is null and the
// installed version comes from this package's package.json.

const ghRelease = (body: Record<string, unknown>) =>
    ({ ok: true, json: async () => body }) as unknown as Response;

describe("getVersionStatus (source-dev mode)", () => {
    const savedAppDir = process.env.PINGHUB_APP_DIR;
    beforeEach(() => { delete process.env.PINGHUB_APP_DIR; });
    afterEach(() => {
        if (savedAppDir !== undefined) process.env.PINGHUB_APP_DIR = savedAppDir;
        vi.unstubAllGlobals();
    });

    it("includes the latest release (with notes) but never offers an update", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => ghRelease({
            tag_name: "v9.9.9",
            published_at: "2026-06-11T00:00:00Z",
            html_url: "https://github.com/bostonidentity/PingHub/releases/tag/v9.9.9",
            body: "## Highlights\n- something new",
            assets: [],
        })));
        const status = await getVersionStatus(true); // force → bypass the module cache
        expect(status.installed.source).toBe("dev");
        expect(status.latest).not.toBeNull();
        expect(status.latest!.version).toBe("9.9.9");
        expect(status.latest!.notes).toBe("## Highlights\n- something new");
        // Source installs update via git, not self-update — even with a newer release.
        expect(status.newerAvailable).toBe(false);
        expect(status.canUpdate).toBe(false);
        expect(status.reason).toMatch(/running from source/);
    });

    it("degrades to latest: null when GitHub is unreachable", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
        const status = await getVersionStatus(true);
        expect(status.installed.source).toBe("dev");
        expect(status.latest).toBeNull();
        expect(status.newerAvailable).toBe(false);
        expect(status.canUpdate).toBe(false);
    });
});
