import { describe, it, expect } from "vitest";
import { snapshotRoot, envSnapshotDir, latestSnapshotDir, journeyFile, isoStamp, listAllSnapshotsForEnv } from "./paths";
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

describe("listAllSnapshotsForEnv", () => {
  it("returns all snapshot dirs newest-first (by name desc)", () => {
    const root = mkdtempSync(join(tmpdir(), "snap-list-"));
    try {
      const envDir = join(root, "snapshots", "prod");
      mkdirSync(envDir, { recursive: true });
      mkdirSync(join(envDir, "2026-05-24T10-00-00Z"));
      mkdirSync(join(envDir, "2026-05-24T12-00-00Z"));
      mkdirSync(join(envDir, "2026-05-24T15-00-00Z"));
      const all = listAllSnapshotsForEnv(root, "prod");
      expect(all.map((p) => p.split("/").pop())).toEqual([
        "2026-05-24T15-00-00Z",
        "2026-05-24T12-00-00Z",
        "2026-05-24T10-00-00Z"
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns [] when env has no snapshots", () => {
    const root = mkdtempSync(join(tmpdir(), "snap-list-empty-"));
    try {
      expect(listAllSnapshotsForEnv(root, "prod")).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
