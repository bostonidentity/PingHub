import { describe, it, expect } from "vitest";
import { parseArgv, resolveOpenCommand, waitForServer } from "./launcher.mjs";
import { createServer } from "node:http";

describe("parseArgv", () => {
  it("defaults are empty", () => {
    expect(parseArgv([])).toEqual({});
  });
  it("--port N captures port as number", () => {
    expect(parseArgv(["--port", "12345"])).toEqual({ port: 12345 });
  });
  it("--port=N also supported", () => {
    expect(parseArgv(["--port=12345"])).toEqual({ port: 12345 });
  });
  it("--data-dir captures path", () => {
    expect(parseArgv(["--data-dir", "/tmp/data"])).toEqual({ dataDir: "/tmp/data" });
  });
  it("--no-open is boolean true", () => {
    expect(parseArgv(["--no-open"])).toEqual({ noOpen: true });
  });
  it("--update is boolean true", () => {
    expect(parseArgv(["--update"])).toEqual({ update: true });
  });
  it("--uninstall is boolean true", () => {
    expect(parseArgv(["--uninstall"])).toEqual({ uninstall: true });
  });
  it("--version is boolean true", () => {
    expect(parseArgv(["--version"])).toEqual({ version: true });
  });
  it("multiple flags combine", () => {
    expect(parseArgv(["--port", "8080", "--no-open"])).toEqual({ port: 8080, noOpen: true });
  });
  it("rejects unknown flags", () => {
    expect(() => parseArgv(["--garbage"])).toThrow(/unknown/i);
  });
});

describe("resolveOpenCommand", () => {
  it("darwin uses open", () => {
    expect(resolveOpenCommand("darwin", "http://x")).toEqual({ cmd: "open", args: ["http://x"] });
  });
  it("linux uses xdg-open", () => {
    expect(resolveOpenCommand("linux", "http://x")).toEqual({ cmd: "xdg-open", args: ["http://x"] });
  });
  it("win32 uses cmd start", () => {
    expect(resolveOpenCommand("win32", "http://x")).toEqual({ cmd: "cmd", args: ["/c", "start", "", "http://x"] });
  });
  it("unknown platform throws", () => {
    expect(() => resolveOpenCommand("freebsd", "http://x")).toThrow();
  });
});

describe("waitForServer", () => {
  it("resolves quickly when server is up", async () => {
    const srv = createServer((_, res) => { res.writeHead(200); res.end("ok"); });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const port = srv.address().port;
    await waitForServer(`http://127.0.0.1:${port}`, { timeoutMs: 5000, intervalMs: 50 });
    srv.close();
  });

  it("rejects after timeout when server never responds", async () => {
    await expect(waitForServer("http://127.0.0.1:1", { timeoutMs: 500, intervalMs: 50 }))
      .rejects.toThrow(/timed out|timeout/i);
  });
});
