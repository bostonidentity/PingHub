// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ScheduleEditor } from "@/app/schedules/ScheduleEditor";

describe("ScheduleEditor", () => {
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
});
