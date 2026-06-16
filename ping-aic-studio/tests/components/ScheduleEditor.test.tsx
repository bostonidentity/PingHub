// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { ScheduleEditor } from "@/app/schedules/ScheduleEditor";

function lastPostedBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
  return JSON.parse((init?.body as string) ?? "{}");
}

describe("ScheduleEditor", () => {
  afterEach(() => cleanup());

  it("POSTs a new schedule on save", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "s9" }), { status: 201 }));
    global.fetch = fetchMock as unknown as typeof fetch;
    const onSaved = vi.fn();
    render(<ScheduleEditor onClose={() => {}} onSaved={onSaved} />);
    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: "My schedule" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/schedules", expect.objectContaining({ method: "POST" })));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it("lets a sync step pick an environment and scopes, persisted in the payload", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "s9" }), { status: 201 }));
    global.fetch = fetchMock as unknown as typeof fetch;
    const environments = [{ name: "dev", label: "Development", color: "blue" as const }];
    render(<ScheduleEditor environments={environments} typesByEnv={{}} onClose={() => {}} onSaved={() => {}} />);

    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: "sync sched" } });
    // Default first step is git-push; switch it to sync.
    fireEvent.change(screen.getByLabelText("step-0-type"), { target: { value: "sync" } });
    // Environment select appears with the provided env option.
    fireEvent.change(screen.getByLabelText("step-0-environment"), { target: { value: "dev" } });
    // Pick a scope (Journeys is a CLI scope present in CONFIG_SCOPES).
    fireEvent.click(screen.getByRole("button", { name: "Journeys" }));

    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = lastPostedBody(fetchMock);
    expect((body.steps as unknown[])[0]).toEqual({ type: "sync", environment: "dev", scopes: ["journeys"] });
  });

  it("lets a pull-data step pick an environment and managed objects", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "s9" }), { status: 201 }));
    global.fetch = fetchMock as unknown as typeof fetch;
    const environments = [{ name: "dev", label: "Development", color: "blue" as const }];
    const typesByEnv = { dev: ["alpha_user", "alpha_role"] };
    render(<ScheduleEditor environments={environments} typesByEnv={typesByEnv} onClose={() => {}} onSaved={() => {}} />);

    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: "data sched" } });
    fireEvent.change(screen.getByLabelText("step-0-type"), { target: { value: "pull-data" } });
    fireEvent.change(screen.getByLabelText("step-0-environment"), { target: { value: "dev" } });
    fireEvent.click(screen.getByRole("button", { name: "alpha_user" }));

    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = lastPostedBody(fetchMock);
    expect((body.steps as unknown[])[0]).toEqual({ type: "pull-data", environment: "dev", managedObjects: ["alpha_user"] });
  });
});
