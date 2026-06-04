import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/fr-config", () => ({
    getEnvironments: () => [{ name: "prod" }],
}));
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const queryArchiveMock = vi.fn((_a: unknown, _b: unknown) => ({ total: 2, rows: [{ id: "a" }, { id: "b" }], capped: false }));
vi.mock("@/lib/logs/log-query", () => ({ queryArchive: (a: unknown, b: unknown) => queryArchiveMock(a, b) }));

import { POST } from "./route";

function req(body: unknown) {
    return { json: async () => body } as unknown as Parameters<typeof POST>[0];
}

describe("archive query route", () => {
    it("400s on unknown environment", async () => {
        const res = await POST(req({ env: "nope", from: "2026-06-02T00:00:00Z", to: "2026-06-03T00:00:00Z" }));
        expect(res.status).toBe(400);
    });

    it("400s when from/to missing", async () => {
        const res = await POST(req({ env: "prod" }));
        expect(res.status).toBe(400);
    });

    it("runs queryArchive and returns its result", async () => {
        const res = await POST(req({
            env: "prod", from: "2026-06-02T00:00:00Z", to: "2026-06-03T00:00:00Z",
            sources: ["am-authentication"], eventName: "AM-TREE-LOGIN-COMPLETED", limit: 50,
        }));
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toMatchObject({ total: 2, capped: false });
        expect(body.rows).toHaveLength(2);
        // queryArchive received the filters
        const call = (queryArchiveMock.mock.calls[0] as unknown as unknown[])[1] as Record<string, unknown>;
        expect(call).toMatchObject({ sources: ["am-authentication"], eventName: "AM-TREE-LOGIN-COMPLETED", limit: 50 });
    });
});
