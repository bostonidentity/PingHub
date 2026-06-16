// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { ScheduleList } from "@/app/schedules/ScheduleList";

describe("ScheduleList", () => {
  beforeEach(() => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify([
      { id: "s1", name: "Nightly backup", enabled: true,
        trigger: { kind: "preset", preset: { every: "day", time: "02:00" }, timezone: "UTC" },
        steps: [{ type: "git-push" }], onError: "stop", catchUpIfMissed: true,
        nextRunAt: "2026-06-17T02:00:00.000Z", createdAt: "", updatedAt: "" },
    ]))) as unknown as typeof fetch;
  });

  it("renders schedule names from the API", async () => {
    render(<ScheduleList />);
    expect(await screen.findByText("Nightly backup")).toBeInTheDocument();
  });
});
