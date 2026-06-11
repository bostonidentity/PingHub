import { describe, it, expect, vi, beforeEach } from "vitest";

const startJob = vi.fn();

vi.mock("@/lib/fr-config", () => ({
    getLogApiCredentials: () => ({ apiKey: "k", apiSecret: "s" }),
    getEnvFileContent: () => "TENANT_BASE_URL=https://tenant.example.com",
    getEnvironments: () => [{ name: "prod" }],
}));
vi.mock("@/lib/env-parser", () => ({ parseEnvFile: () => ({ TENANT_BASE_URL: "https://tenant.example.com" }) }));
vi.mock("@/lib/reports/journey-report-registry", () => ({
    getJourneyReportRegistry: () => ({ startJob, getJob: () => undefined }),
    JourneyJobConflictError: class extends Error {},
}));
vi.mock("@/lib/reports/journey-report-runner", () => ({ runJourneyReport: () => Promise.resolve() }));
vi.mock("../route-controllers", () => ({ setController: () => {}, deleteController: () => {} }));

import { POST } from "./route";

function req(body: unknown) {
    return { json: async () => body } as unknown as Parameters<typeof POST>[0];
}

const base = { env: "prod", from: "2026-06-02T00:00:00Z", to: "2026-06-03T00:00:00Z" };

describe("journey-history jobs POST", () => {
    beforeEach(() => {
        startJob.mockReset();
        startJob.mockReturnValue({ id: "job1", status: "running" });
    });

    it("forwards retainRaw to the job params", async () => {
        await POST(req({ ...base, retainRaw: true }));
        expect(startJob).toHaveBeenCalledWith("prod", expect.objectContaining({ retainRaw: true }));
    });

    it("defaults retainRaw to false when omitted", async () => {
        await POST(req(base));
        expect(startJob).toHaveBeenCalledWith("prod", expect.objectContaining({ retainRaw: false }));
    });
});
