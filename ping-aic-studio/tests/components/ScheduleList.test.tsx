// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { cleanup } from "@testing-library/react";
import { ScheduleList } from "@/app/schedules/ScheduleList";

afterEach(() => { cleanup(); });

const baseSchedule = {
  id: "s1", name: "Nightly backup", enabled: true,
  trigger: { kind: "preset", preset: { every: "day", time: "02:00" }, timezone: "UTC" },
  steps: [{ type: "git-push" }], onError: "stop", catchUpIfMissed: true,
  nextRunAt: "2026-06-17T02:00:00.000Z", createdAt: "", updatedAt: "",
};

function mockFetch(schedules: object[]) {
  global.fetch = vi.fn(async (url: unknown) => {
    if (String(url).includes("/api/history")) return new Response(JSON.stringify([]));
    return new Response(JSON.stringify(schedules));
  }) as unknown as typeof fetch;
}

describe("ScheduleList", () => {
  beforeEach(() => {
    // Prevent setInterval from actually firing during tests
    vi.spyOn(globalThis, "setInterval").mockReturnValue(0 as unknown as ReturnType<typeof setInterval>);
    vi.spyOn(globalThis, "clearInterval").mockImplementation(() => {});
    mockFetch([baseSchedule]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders schedule names from the API", async () => {
    render(<ScheduleList />);
    expect(await screen.findByText("Nightly backup")).toBeInTheDocument();
  });

  it("shows Running indicator when schedule has running: true from server", async () => {
    mockFetch([{ ...baseSchedule, running: true }]);
    render(<ScheduleList />);
    expect(await screen.findByText(/Running…/)).toBeInTheDocument();
  });

  it("shows the moving progress bar when a schedule is running", async () => {
    mockFetch([{ ...baseSchedule, running: true }]);
    const { container } = render(<ScheduleList />);
    await screen.findByText("Nightly backup");
    expect(container.querySelector(".animate-progress-slide")).toBeTruthy();
  });

  it("does not show the moving progress bar when not running", async () => {
    mockFetch([{ ...baseSchedule, running: false }]);
    const { container } = render(<ScheduleList />);
    await screen.findByText("Nightly backup");
    expect(container.querySelector(".animate-progress-slide")).toBeNull();
  });

  it("shows a Pause control when running and not paused", async () => {
    mockFetch([{ ...baseSchedule, running: true, paused: false }]);
    render(<ScheduleList />);
    await screen.findByText("Nightly backup");
    expect(screen.getByRole("button", { name: /pause/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /stop/i })).toBeInTheDocument();
  });

  it("shows Resume + a Paused indicator and a static (non-animated) bar when paused", async () => {
    mockFetch([{ ...baseSchedule, running: true, paused: true }]);
    const { container } = render(<ScheduleList />);
    await screen.findByText("Nightly backup");
    expect(screen.getByRole("button", { name: /resume/i })).toBeInTheDocument();
    expect(screen.getByText(/Paused/)).toBeInTheDocument();
    expect(container.querySelector(".animate-progress-slide")).toBeNull();
  });

  it("keeps the live log collapsed when a schedule becomes running (no auto-expand)", async () => {
    mockFetch([{ ...baseSchedule, running: true }]);
    render(<ScheduleList />);
    await screen.findByText("Nightly backup");
    // The LogViewer is only rendered when the disclosure is open. It stays closed.
    expect(screen.queryByText(/exit code/i)).toBeNull();
    // Disclosure shows the collapsed chevron (ChevronRight), not the expanded view.
    expect(screen.getByText("Live log")).toBeInTheDocument();
  });

  it("renders a 'stopped' status pill in recent runs", async () => {
    mockFetch([{ ...baseSchedule, recentRuns: [
      { at: new Date().toISOString(), status: "stopped", durationMs: 500, summary: "1/2 steps ok" },
    ] }]);
    render(<ScheduleList />);
    await screen.findByText("Nightly backup");
    const disclosureBtn = screen.getByText(/Recent runs \(1\)/);
    await act(async () => { fireEvent.click(disclosureBtn); });
    expect(screen.getByText("stopped")).toBeInTheDocument();
  });

  it("shows recent runs when disclosure is expanded", async () => {
    const scheduleWithRuns = {
      ...baseSchedule,
      recentRuns: [
        { at: new Date().toISOString(), status: "success", durationMs: 1200, summary: "1/1 steps ok" },
      ],
    };
    mockFetch([scheduleWithRuns]);
    render(<ScheduleList />);

    // Wait for schedule to render
    await screen.findByText("Nightly backup");

    // Click the "Recent runs" disclosure
    const disclosureBtn = screen.getByText(/Recent runs \(1\)/);
    await act(async () => { fireEvent.click(disclosureBtn); });

    // The summary should now be visible
    expect(screen.getByText("1/1 steps ok")).toBeInTheDocument();
  });

  it("shows 'No runs yet.' when recentRuns is empty and disclosure is expanded", async () => {
    mockFetch([{ ...baseSchedule, recentRuns: [] }]);
    render(<ScheduleList />);

    await screen.findByText("Nightly backup");

    const disclosureBtn = screen.getByText(/Recent runs \(0\)/);
    await act(async () => { fireEvent.click(disclosureBtn); });

    expect(screen.getByText("No runs yet.")).toBeInTheDocument();
  });
});
