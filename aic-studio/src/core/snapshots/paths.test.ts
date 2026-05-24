import { describe, it, expect } from "vitest";
import { snapshotRoot, envSnapshotDir, latestSnapshotDir, journeyFile, isoStamp } from "./paths";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("snapshot path helpers", () => {
  it("snapshotRoot returns globalStorage/snapshots", () => {
    expect(snapshotRoot("/var/store")).toBe("/var/store/snapshots");
  });

  it("envSnapshotDir returns snapshots/{env}", () => {
    expect(envSnapshotDir("/var/store", "prod")).toBe("/var/store/snapshots/prod");
  });

  it("isoStamp generates a filesystem-safe ISO timestamp", () => {
    const s = isoStamp(new Date("2026-05-24T15:30:00Z"));
    expect(s).toBe("2026-05-24T15-30-00Z");
  });

  it("journeyFile is realm/journeys/<id>.json under the snapshot dir", () => {
    expect(journeyFile("/snap/2026-05-24T15-30-00Z", "alpha", "Login")).toBe(
      "/snap/2026-05-24T15-30-00Z/alpha/journeys/Login.json"
    );
  });

  it("latestSnapshotDir returns the most recently mtime'd subdir, or undefined if none", () => {
    const root = mkdtempSync(join(tmpdir(), "snap-test-"));
    try {
      const envDir = join(root, "snapshots", "prod");
      mkdirSync(envDir, { recursive: true });
      expect(latestSnapshotDir(root, "prod")).toBeUndefined();
      const a = join(envDir, "2026-05-24T15-00-00Z");
      const b = join(envDir, "2026-05-24T16-00-00Z");
      mkdirSync(a);
      mkdirSync(b);
      expect(latestSnapshotDir(root, "prod")).toBe(b);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
