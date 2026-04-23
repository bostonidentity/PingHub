import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  filterConnectorsForProbe,
  readWatchlist,
  writeWatchlistEntry,
  type Watchlist,
} from "@/lib/rcs/watchlist";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rcs-watch-"));
  fs.mkdirSync(path.join(tmp, "environments/dev"), { recursive: true });
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("readWatchlist", () => {
  it("returns {} when the file does not exist", () => {
    expect(readWatchlist("dev", { rootDir: tmp })).toEqual({});
  });

  it("parses and returns a stored watchlist", () => {
    fs.writeFileSync(
      path.join(tmp, "environments/dev/rcs-watchlist.json"),
      JSON.stringify({ "rcs-cluster-external": ["ad-hr", "oracle-hr"] }),
    );
    expect(readWatchlist("dev", { rootDir: tmp })).toEqual({
      "rcs-cluster-external": ["ad-hr", "oracle-hr"],
    });
  });

  it("returns {} on malformed JSON instead of throwing", () => {
    fs.writeFileSync(path.join(tmp, "environments/dev/rcs-watchlist.json"), "{ bad json");
    expect(readWatchlist("dev", { rootDir: tmp })).toEqual({});
  });
});

describe("writeWatchlistEntry", () => {
  it("creates the file and writes a single cluster entry", () => {
    writeWatchlistEntry("dev", "rcs-cluster-external", ["ad-hr"], { rootDir: tmp });
    expect(readWatchlist("dev", { rootDir: tmp })).toEqual({ "rcs-cluster-external": ["ad-hr"] });
  });

  it("updates an existing entry without losing the other clusters", () => {
    writeWatchlistEntry("dev", "rcs-cluster-a", ["a1"], { rootDir: tmp });
    writeWatchlistEntry("dev", "rcs-cluster-b", ["b1", "b2"], { rootDir: tmp });
    writeWatchlistEntry("dev", "rcs-cluster-a", ["a1", "a2"], { rootDir: tmp });
    expect(readWatchlist("dev", { rootDir: tmp })).toEqual({
      "rcs-cluster-a": ["a1", "a2"],
      "rcs-cluster-b": ["b1", "b2"],
    });
  });

  it("removes the cluster entry entirely when include is null", () => {
    writeWatchlistEntry("dev", "rcs-cluster-a", ["a1"], { rootDir: tmp });
    writeWatchlistEntry("dev", "rcs-cluster-a", null, { rootDir: tmp });
    expect(readWatchlist("dev", { rootDir: tmp })).toEqual({});
  });

  it("deduplicates and preserves insertion order within a cluster", () => {
    writeWatchlistEntry("dev", "rcs-cluster-a", ["b", "a", "b", "c"], { rootDir: tmp });
    expect(readWatchlist("dev", { rootDir: tmp })["rcs-cluster-a"]).toEqual(["b", "a", "c"]);
  });
});

describe("filterConnectorsForProbe", () => {
  const allConnectors = ["ad-hr", "oracle-hr", "ldap-backup"];

  it("returns all connectors when no watchlist entry exists for the cluster", () => {
    const wl: Watchlist = {};
    expect(filterConnectorsForProbe(allConnectors, "rcs-cluster-a", wl)).toEqual(allConnectors);
  });

  it("returns only the intersection when a watchlist entry exists", () => {
    const wl: Watchlist = { "rcs-cluster-a": ["ad-hr", "ldap-backup"] };
    expect(filterConnectorsForProbe(allConnectors, "rcs-cluster-a", wl)).toEqual([
      "ad-hr",
      "ldap-backup",
    ]);
  });

  it("returns [] when the watchlist entry is an empty array (explicit skip)", () => {
    const wl: Watchlist = { "rcs-cluster-a": [] };
    expect(filterConnectorsForProbe(allConnectors, "rcs-cluster-a", wl)).toEqual([]);
  });

  it("drops watchlist names that are no longer in the cluster (stale entries)", () => {
    const wl: Watchlist = { "rcs-cluster-a": ["ad-hr", "deleted-long-ago"] };
    expect(filterConnectorsForProbe(allConnectors, "rcs-cluster-a", wl)).toEqual(["ad-hr"]);
  });
});
