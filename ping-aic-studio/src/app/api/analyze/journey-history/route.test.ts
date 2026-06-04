import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the config layer so the route doesn't touch the filesystem.
vi.mock("@/lib/fr-config", () => ({
    getLogApiCredentials: () => ({ apiKey: "k", apiSecret: "s" }),
    getEnvFileContent: () => "TENANT_BASE_URL=https://tenant.example.com",
}));
vi.mock("@/lib/env-parser", () => ({
    parseEnvFile: () => ({ TENANT_BASE_URL: "https://tenant.example.com" }),
}));

import { POST } from "./route";

function req(body: unknown) {
    return { json: async () => body } as unknown as Parameters<typeof POST>[0];
}

function completedEvent(txn: string, result: "SUCCESSFUL" | "FAILED") {
    return {
        timestamp: "2026-06-02T17:02:00Z",
        payload: {
            eventName: "AM-TREE-LOGIN-COMPLETED",
            transactionId: txn,
            result,
            entries: [{ info: { treeName: "Login" } }],
        },
    };
}

describe("journey-history route pagination", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it("follows AIC's pagedResultsCookie across pages (CREST response field has no underscore)", async () => {
        // Page 1 returns a cookie under the CREST response field name
        // `pagedResultsCookie` (NO leading underscore — that's request-only).
        const page1 = {
            result: [completedEvent("p1a", "SUCCESSFUL"), completedEvent("p1b", "FAILED")],
            pagedResultsCookie: "COOKIE_2",
        };
        const page2 = {
            result: [completedEvent("p2a", "SUCCESSFUL")],
            pagedResultsCookie: null,
        };

        const fetchMock = vi.fn()
            .mockResolvedValueOnce({ ok: true, json: async () => page1 } as Response)
            .mockResolvedValueOnce({ ok: true, json: async () => page2 } as Response);
        vi.stubGlobal("fetch", fetchMock);

        const res = await POST(req({ env: "prod", from: "2026-06-02T00:00:00Z", to: "2026-06-03T00:00:00Z" }));
        const messages = await readNdjson(res);

        // Must have fetched BOTH pages, not stopped after page 1.
        expect(fetchMock).toHaveBeenCalledTimes(2);

        // One progress line per page, then a final done line.
        const progress = messages.filter((m) => m.type === "progress");
        expect(progress.length).toBe(2);
        expect(progress[0]).toMatchObject({ page: 1, rawFetched: 2 });
        expect(progress[1]).toMatchObject({ page: 2, rawFetched: 3 });

        const done = messages.find((m) => m.type === "done");
        expect(done).toBeDefined();
        expect(done).toMatchObject({
            pagesFetched: 2,
            rawFetched: 3,
            summary: expect.objectContaining({ attempts: 3 }),
        });
    });
});

/** Read an NDJSON streaming Response into an array of parsed messages. */
async function readNdjson(res: Response): Promise<Array<Record<string, unknown> & { type: string }>> {
    const text = await res.text();
    return text
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => JSON.parse(l));
}
