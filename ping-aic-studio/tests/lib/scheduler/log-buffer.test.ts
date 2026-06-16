import { describe, it, expect } from "vitest";
import { startLog, appendLog, endLog, getLog } from "@/lib/scheduler/log-buffer";

describe("scheduler log-buffer", () => {
  it("buffers events and tracks the cursor", () => {
    startLog("a");
    appendLog("a", { type: "stdout", data: "x" });
    appendLog("a", { type: "stdout", data: "y" });

    const all = getLog("a");
    expect(all).not.toBeNull();
    expect(all!.running).toBe(true);
    expect(all!.events).toHaveLength(2);
    expect(all!.cursor).toBe(2);

    const tail = getLog("a", 1);
    expect(tail!.events).toHaveLength(1);
    expect(tail!.events[0]).toEqual({ type: "stdout", data: "y" });
    expect(tail!.cursor).toBe(2);
  });

  it("records the exit code on endLog", () => {
    startLog("b");
    endLog("b", 0);
    const log = getLog("b");
    expect(log!.running).toBe(false);
    expect(log!.exitCode).toBe(0);
  });

  it("returns null for a missing buffer", () => {
    expect(getLog("missing")).toBeNull();
  });

  it("caps the buffer at MAX events", () => {
    startLog("cap");
    for (let i = 0; i < 2100; i++) appendLog("cap", { type: "stdout", data: String(i) });
    const log = getLog("cap")!;
    expect(log.events.length).toBe(2000);
    // Oldest events trimmed; newest retained.
    expect(log.events[log.events.length - 1]).toEqual({ type: "stdout", data: "2099" });
  });

  it("appendLog is a no-op when no buffer is active", () => {
    appendLog("never-started", { type: "stdout", data: "z" });
    expect(getLog("never-started")).toBeNull();
  });
});
