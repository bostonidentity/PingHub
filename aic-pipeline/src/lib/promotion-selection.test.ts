import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildNameToIdMap,
  copyDirSync,
  remapIds,
  resolveScopeDirs,
  stagingRelPath,
} from "./promotion-selection";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pinghub-promotion-selection-"));
  tempDirs.push(dir);
  return dir;
}

function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

describe("promotion-selection helpers", () => {
  it("resolves realm and global scope directories across supported layouts", () => {
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, "alpha", "journeys"), { recursive: true });
    fs.mkdirSync(path.join(dir, "realms", "bravo", "journeys"), { recursive: true });
    fs.mkdirSync(path.join(dir, "managed-objects"), { recursive: true });

    expect(resolveScopeDirs(dir, "journeys").map((p) => path.relative(dir, p).split(path.sep).join("/"))).toEqual([
      "realms/bravo/journeys",
      "alpha/journeys",
    ]);
    expect(resolveScopeDirs(dir, "managed-objects")).toEqual([path.join(dir, "managed-objects")]);
  });

  it("builds staging paths expected by realm-scoped push handlers", () => {
    const dir = tempDir();

    expect(stagingRelPath(dir, path.join(dir, "alpha", "journeys"), "journeys")).toBe("realms/alpha/journeys");
    expect(stagingRelPath(dir, path.join(dir, "realms", "alpha", "journeys"), "journeys")).toBe("realms/alpha/journeys");
    expect(stagingRelPath(dir, path.join(dir, "managed-objects"), "managed-objects")).toBe("managed-objects");
  });

  it("copies selected config directories recursively", () => {
    const dir = tempDir();
    const source = path.join(dir, "source");
    const target = path.join(dir, "target");
    fs.mkdirSync(path.join(source, "nested"), { recursive: true });
    fs.writeFileSync(path.join(source, "nested", "item.txt"), "value");

    copyDirSync(source, target);

    expect(fs.readFileSync(path.join(target, "nested", "item.txt"), "utf-8")).toBe("value");
  });

  it("maps script names to UUIDs from scripts-config files", () => {
    const dir = tempDir();
    const scriptsDir = path.join(dir, "alpha", "scripts");
    writeJson(path.join(scriptsDir, "scripts-config", "script-1.json"), {
      _id: "script-1",
      name: "CheckAccess",
    });

    expect(buildNameToIdMap([scriptsDir], "scripts")).toEqual(new Map([["CheckAccess", "script-1"]]));
  });

  it("remaps script config IDs and renames the config file", () => {
    const dir = tempDir();
    const scriptsDir = path.join(dir, "scripts");
    writeJson(path.join(scriptsDir, "scripts-config", "source-id.json"), {
      _id: "source-id",
      name: "CheckAccess",
    });
    const logs: string[] = [];

    remapIds(
      [scriptsDir],
      "scripts",
      new Map([["CheckAccess", "source-id"]]),
      new Map([["CheckAccess", "target-id"]]),
      logs,
    );

    expect(fs.existsSync(path.join(scriptsDir, "scripts-config", "source-id.json"))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(scriptsDir, "scripts-config", "target-id.json"), "utf-8"))).toMatchObject({
      _id: "target-id",
      name: "CheckAccess",
    });
  });

  it("keys directory-based generic scopes by folder name when remapping IDs", () => {
    const dir = tempDir();
    const scopeDir = path.join(dir, "email-templates");
    writeJson(path.join(scopeDir, "kyidEmailOtpCopy", "kyidEmailOtpCopy.json"), {
      _id: "source-copy-id",
      name: "kyidEmailOtp",
    });
    const logs: string[] = [];

    expect(buildNameToIdMap([scopeDir], "email-templates")).toEqual(new Map([["kyidEmailOtpCopy", "source-copy-id"]]));

    remapIds(
      [scopeDir],
      "email-templates",
      new Map([["kyidEmailOtpCopy", "source-copy-id"]]),
      new Map([["kyidEmailOtpCopy", "target-copy-id"]]),
      logs,
    );

    expect(JSON.parse(fs.readFileSync(path.join(scopeDir, "kyidEmailOtpCopy", "kyidEmailOtpCopy.json"), "utf-8"))).toMatchObject({
      _id: "target-copy-id",
      name: "kyidEmailOtp",
    });
  });
});
