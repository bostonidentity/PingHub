import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readSkiplist, setEnvSkipped } from "@/lib/rcs/env-skiplist";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rcs-skip-"));
  fs.mkdirSync(path.join(tmp, "environments"), { recursive: true });
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("readSkiplist", () => {
  it("returns [] when the file does not exist", () => {
    expect(readSkiplist({ rootDir: tmp })).toEqual([]);
  });

  it("parses and returns a stored skiplist", () => {
    fs.writeFileSync(
      path.join(tmp, "environments/rcs-env-skiplist.json"),
      JSON.stringify({ skip: ["dev", "temp-dcc"] }),
    );
    expect(readSkiplist({ rootDir: tmp })).toEqual(["dev", "temp-dcc"]);
  });

  it("returns [] on malformed JSON", () => {
    fs.writeFileSync(path.join(tmp, "environments/rcs-env-skiplist.json"), "{nope");
    expect(readSkiplist({ rootDir: tmp })).toEqual([]);
  });

  it("ignores non-string entries", () => {
    fs.writeFileSync(
      path.join(tmp, "environments/rcs-env-skiplist.json"),
      JSON.stringify({ skip: ["dev", 123, null, "prod"] }),
    );
    expect(readSkiplist({ rootDir: tmp })).toEqual(["dev", "prod"]);
  });
});

describe("setEnvSkipped", () => {
  it("adds an env to the skiplist when skip=true", () => {
    setEnvSkipped("dev", true, { rootDir: tmp });
    expect(readSkiplist({ rootDir: tmp })).toEqual(["dev"]);
  });

  it("removes an env from the skiplist when skip=false", () => {
    setEnvSkipped("dev", true, { rootDir: tmp });
    setEnvSkipped("sit", true, { rootDir: tmp });
    setEnvSkipped("dev", false, { rootDir: tmp });
    expect(readSkiplist({ rootDir: tmp })).toEqual(["sit"]);
  });

  it("is a no-op when re-adding an already-skipped env", () => {
    setEnvSkipped("dev", true, { rootDir: tmp });
    setEnvSkipped("dev", true, { rootDir: tmp });
    expect(readSkiplist({ rootDir: tmp })).toEqual(["dev"]);
  });

  it("is a no-op when un-skipping an env that wasn't in the list", () => {
    setEnvSkipped("sit", true, { rootDir: tmp });
    setEnvSkipped("never-skipped", false, { rootDir: tmp });
    expect(readSkiplist({ rootDir: tmp })).toEqual(["sit"]);
  });
});
